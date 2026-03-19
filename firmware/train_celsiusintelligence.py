#!/usr/bin/env python3
"""
CelsiusIntelligence — TinyML Training Script
=============================================
Fetches all sensor readings from Supabase, auto-labels them,
trains a small MLP, quantizes to TFLite int8, and exports:
  - celsiusintelligence.tflite
  - celsiusintelligence_model.h  (C header for ESP32)

Requirements:
    pip install requests numpy scikit-learn tensorflow matplotlib

Run:
    python train_celsiusintelligence.py
"""

import os
import sys
import json
import subprocess
import struct

import requests
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.metrics import confusion_matrix, classification_report
import matplotlib.pyplot as plt

# ── Supabase config ───────────────────────────────────────────────────────────
SUPABASE_URL = "https://dnvrhloomkjkownjohpv.supabase.co"
SUPABASE_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRudnJobG9vbWtqa293bmpvaHB2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1ODMxOTUsImV4cCI6MjA4OTE1OTE5NX0."
    "d_17mkOSDqy0ZtBTETYzCrGTRiPb1ybOPgfW5LYk3tQ"
)

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
}

# ── Label thresholds (must match the app and firmware) ───────────────────────
# 0 = Good, 1 = Moderate, 2 = Poor
def label_row(temp: float, hum: float, aq: float) -> int:
    out = 0
    if not (18 <= temp <= 28): out += 1
    if not (15 <= hum  <= 65): out += 1
    if aq <= 45:               out += 1
    if out == 0: return 0   # Good
    if out == 1: return 1   # Moderate
    return 2                # Poor

CLASS_NAMES = ["Good", "Moderate", "Poor"]

# ── Normalisation ranges (must match firmware runInference()) ─────────────────
TEMP_MIN, TEMP_MAX = 10.0, 45.0
HUM_MIN,  HUM_MAX  =  0.0, 100.0
AQ_MIN,   AQ_MAX   =  0.0, 200.0


def fetch_all_rows() -> list[dict]:
    """Paginate through sensor_readings and return all rows."""
    rows = []
    limit = 1000
    offset = 0
    print("Fetching data from Supabase...")
    while True:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/sensor_readings",
            headers=HEADERS,
            params={
                "select": "temperature,humidity,air_quality",
                "order":  "created_at.asc",
                "limit":  limit,
                "offset": offset,
            },
            timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        print(f"  fetched {len(rows)} rows...", end="\r")
        if len(batch) < limit:
            break
        offset += limit
    print(f"\nTotal rows fetched: {len(rows)}")
    return rows


def build_dataset(rows: list[dict]):
    X, y = [], []
    skipped = 0
    for r in rows:
        try:
            temp = float(r["temperature"])
            hum  = float(r["humidity"])
            aq   = float(r["air_quality"])
        except (TypeError, KeyError, ValueError):
            skipped += 1
            continue
        if not (-20 <= temp <= 60 and 0 <= hum <= 100 and 0 <= aq <= 500):
            skipped += 1
            continue
        # Normalise
        t_n = (temp - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)
        h_n = (hum  - HUM_MIN)  / (HUM_MAX  - HUM_MIN)
        a_n = (aq   - AQ_MIN)   / (AQ_MAX   - AQ_MIN)
        X.append([t_n, h_n, a_n])
        y.append(label_row(temp, hum, aq))

    if skipped:
        print(f"Skipped {skipped} rows with missing/invalid values.")
    return np.array(X, dtype=np.float32), np.array(y, dtype=np.int32)


def build_model(n_classes: int = 3):
    import tensorflow as tf
    model = tf.keras.Sequential([
        tf.keras.layers.Input(shape=(3,)),
        tf.keras.layers.Dense(16, activation="relu"),
        tf.keras.layers.Dense(16, activation="relu"),
        tf.keras.layers.Dense(n_classes, activation="softmax"),
    ], name="CelsiusIntelligence")
    model.compile(
        optimizer="adam",
        loss="sparse_categorical_crossentropy",
        metrics=["accuracy"],
    )
    return model


def convert_to_tflite_int8(model, X_train):
    import tensorflow as tf

    def representative_dataset():
        for i in range(min(200, len(X_train))):
            yield [X_train[i:i+1]]

    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    converter.optimizations = [tf.lite.Optimize.DEFAULT]
    converter.representative_dataset = representative_dataset
    converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
    converter.inference_input_type  = tf.int8
    converter.inference_output_type = tf.int8
    return converter.convert()


def generate_c_header(tflite_bytes: bytes, out_path: str):
    """Write a C header without relying on xxd being available everywhere."""
    var_name = "celsiusintelligence_model_data"
    lines = [
        "// CelsiusIntelligence — auto-generated TFLite model",
        "// DO NOT EDIT — regenerate with train_celsiusintelligence.py",
        "#pragma once",
        "#include <stdint.h>",
        "",
        f"const unsigned char {var_name}[] = {{",
    ]
    hex_vals = [f"0x{b:02x}" for b in tflite_bytes]
    # 12 bytes per line
    for i in range(0, len(hex_vals), 12):
        chunk = ", ".join(hex_vals[i:i+12])
        lines.append(f"  {chunk},")
    lines.append("};")
    lines.append(f"const unsigned int {var_name}_len = {len(tflite_bytes)};")
    lines.append("")
    with open(out_path, "w") as f:
        f.write("\n".join(lines))
    print(f"C header written: {out_path}")


def main():
    try:
        import tensorflow as tf
    except ImportError:
        print("ERROR: tensorflow not installed.")
        print("Run: pip install tensorflow")
        sys.exit(1)

    # 1. Fetch data
    rows = fetch_all_rows()
    if len(rows) < 100:
        print(f"WARNING: only {len(rows)} rows — model quality may be poor.")

    # 2. Build dataset
    X, y = build_dataset(rows)
    print(f"\nDataset: {len(X)} samples")
    for i, name in enumerate(CLASS_NAMES):
        count = np.sum(y == i)
        print(f"  {name}: {count} ({100*count/len(y):.1f}%)")

    if len(X) < 50:
        print("Not enough data to train. Collect more readings and retry.")
        sys.exit(1)

    # 3. Train/test split
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    # 4. Train
    print(f"\nTraining CelsiusIntelligence on {len(X_train)} samples...")
    model = build_model()
    model.summary()
    history = model.fit(
        X_train, y_train,
        epochs=60,
        batch_size=32,
        validation_data=(X_test, y_test),
        verbose=1,
    )

    # 5. Evaluate
    _, acc = model.evaluate(X_test, y_test, verbose=0)
    y_pred = np.argmax(model.predict(X_test, verbose=0), axis=1)
    print(f"\nTest accuracy: {acc*100:.1f}%")
    print("\nClassification report:")
    print(classification_report(y_test, y_pred, target_names=CLASS_NAMES))
    print("Confusion matrix (rows=actual, cols=predicted):")
    print(confusion_matrix(y_test, y_pred))

    # 6. Convert to TFLite int8
    print("\nConverting to TFLite int8...")
    tflite_bytes = convert_to_tflite_int8(model, X_train)
    tflite_path = "celsiusintelligence.tflite"
    with open(tflite_path, "wb") as f:
        f.write(tflite_bytes)
    print(f"TFLite model saved: {tflite_path} ({len(tflite_bytes)} bytes)")

    # 7. Generate C header
    header_path = os.path.join(
        "classsense_firmware",
        "monitoringsystem_copy_20260315132914",
        "celsiusintelligence_model.h",
    )
    os.makedirs(os.path.dirname(header_path), exist_ok=True)
    generate_c_header(tflite_bytes, header_path)

    # 8. Training curve plot (optional, won't block if display unavailable)
    try:
        fig, axes = plt.subplots(1, 2, figsize=(10, 4))
        axes[0].plot(history.history["accuracy"],     label="train")
        axes[0].plot(history.history["val_accuracy"], label="val")
        axes[0].set_title("Accuracy"); axes[0].legend()
        axes[1].plot(history.history["loss"],     label="train")
        axes[1].plot(history.history["val_loss"], label="val")
        axes[1].set_title("Loss"); axes[1].legend()
        plt.tight_layout()
        plt.savefig("celsiusintelligence_training.png")
        print("Training curve saved: celsiusintelligence_training.png")
        plt.close()
    except Exception:
        pass

    print("\nDone. Next steps:")
    print("  1. Copy celsiusintelligence_model.h into your firmware sketch folder")
    print("  2. In monitoringsystem_copy_20260315132914.ino, uncomment:")
    print('       #include "celsiusintelligence_model.h"')
    print("     and replace g_model[] / g_model_len with:")
    print("       celsiusintelligence_model_data / celsiusintelligence_model_data_len")
    print("  3. Flash the firmware")


if __name__ == "__main__":
    main()
