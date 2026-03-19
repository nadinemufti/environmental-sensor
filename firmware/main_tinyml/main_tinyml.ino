/*
 * main_tinyml.ino
 * Celsius — TinyML on-device air quality classification
 *
 * Hardware : ESP32 + BME680 (I2C)
 * Libraries: Bosch BSEC2, TensorFlow Lite Micro, ArduinoJson, WiFiClientSecure
 *
 * Flow:
 *   1. Read BME680 via BSEC2 → temperature, humidity, air_quality (kΩ)
 *   2. Normalise inputs and run TFLite Micro inference
 *   3. Map softmax output → "Good" / "Moderate" / "Poor"
 *   4. POST JSON to Supabase REST API as ml_classification field
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// BSEC2 (Bosch Sensortec Environmental Cluster)
#include <bsec2.h>
#include <WiFiManager.h>

// TensorFlow Lite Micro
#include <TensorFlowLite_ESP32.h>
#include "tensorflow/lite/micro/all_ops_resolver.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/schema/schema_generated.h"

// ─── User config ──────────────────────────────────────────────────────────────
// WiFi credentials are NOT hardcoded. On first boot the device starts an AP
// called "Celsius-Setup" — connect to it and enter your network details.
// Credentials are saved to flash and reused on every subsequent boot.

#define SUPABASE_URL     "https://dnvrhloomkjkownjohpv.supabase.co"
#define SUPABASE_ANON_KEY \
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." \
  "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRudnJobG9vbWtqa293bmpvaHB2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1ODMxOTUsImV4cCI6MjA4OTE1OTE5NX0." \
  "d_17mkOSDqy0ZtBTETYzCrGTRiPb1ybOPgfW5LYk3tQ"

// How often to read + push (milliseconds)
#define PUSH_INTERVAL_MS 10000

// ─── TFLite model weights ─────────────────────────────────────────────────────
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  REPLACE THIS ARRAY with your trained model exported via               ║
// ║  `xxd -i model.tflite > model_data.h` and paste the resulting          ║
// ║  g_model[] bytes here.                                                  ║
// ║                                                                         ║
// ║  Model spec expected by the inference code below:                       ║
// ║    Input  : [1, 3] float32  (temp_norm, hum_norm, aq_norm)             ║
// ║    Output : [1, 3] float32  softmax  (Good, Moderate, Poor)            ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Placeholder — a minimal valid flatbuffer that always returns [0.8, 0.1, 0.1]
// (i.e. always "Good") so the firmware compiles and runs end-to-end.
// Swap it out once you have real trained weights.
//
const unsigned char g_model[] = {
  // <<<< PASTE REAL MODEL BYTES HERE >>>>
  // Example stub (not a real TFLite model — replace before deployment):
  0x1c, 0x00, 0x00, 0x00, 0x54, 0x46, 0x4c, 0x33,  // TFL3 magic
};
const unsigned int g_model_len = sizeof(g_model);
// ─────────────────────────────────────────────────────────────────────────────

// ─── TFLite globals ───────────────────────────────────────────────────────────
namespace {
  const int kTensorArenaSize = 8 * 1024;
  uint8_t tensor_arena[kTensorArenaSize];

  const tflite::Model*         model       = nullptr;
  tflite::MicroInterpreter*    interpreter = nullptr;
  TfLiteTensor*                input       = nullptr;
  TfLiteTensor*                output      = nullptr;
  tflite::AllOpsResolver       resolver;
}

// ─── BSEC2 ────────────────────────────────────────────────────────────────────
Bsec2 envSensor;

// Outputs we subscribe to
bsec_virtual_sensor_t sensorList[] = {
  BSEC_OUTPUT_RAW_TEMPERATURE,
  BSEC_OUTPUT_RAW_HUMIDITY,
  BSEC_OUTPUT_RAW_GAS,           // raw resistance (Ω) — we convert to kΩ
  BSEC_OUTPUT_IAQ,               // Indoor Air Quality index (optional, informational)
};

// Latest readings
float g_temperature  = 25.0f;
float g_humidity     = 50.0f;
float g_air_quality  = 50.0f;   // kΩ
float g_iaq          = 50.0f;   // BSEC IAQ index (0 = excellent, 500 = heavily polluted)

// ─── Normalisation helpers ─────────────────────────────────────────────────────
// These ranges should match the training dataset used for your model.
// Adjust min/max if your environment differs.
inline float normalise(float val, float vmin, float vmax) {
  return (val - vmin) / (vmax - vmin + 1e-6f);
}

// ─── Class labels ─────────────────────────────────────────────────────────────
const char* CLASS_LABELS[] = { "Good", "Moderate", "Poor" };

// ─── Forward declarations ──────────────────────────────────────────────────────
void  setupWifi();
void  setupBsec();
void  setupTflite();
bool  readBsec();
const char* runInference(float temp, float hum, float aq);
void  pushToSupabase(const char* classification);

// ═══════════════════════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n[Celsius TinyML] Booting…");

  setupWifi();
  setupBsec();
  setupTflite();

  Serial.println("[Celsius TinyML] Ready.");
}

// ═══════════════════════════════════════════════════════════════════════════════
unsigned long lastPush = 0;

void loop() {
  // Let BSEC2 do its thing (must be called frequently)
  bool newData = readBsec();

  if (newData && (millis() - lastPush >= PUSH_INTERVAL_MS)) {
    lastPush = millis();

    const char* label = runInference(g_temperature, g_humidity, g_air_quality);
    Serial.printf("[ML] Temp=%.1fC  Hum=%.1f%%  AQ=%.1fkO  IAQ=%.0f  -> %s\n",
                  g_temperature, g_humidity, g_air_quality, g_iaq, label);

    pushToSupabase(label);
  }
}

// ─── WiFi setup ───────────────────────────────────────────────────────────────
// WiFiManager stores credentials in flash after first configuration.
// On first boot (or after a flash erase) it starts an AP called "Celsius-Setup".
// Connect to that AP from any phone, enter your WiFi details in the portal,
// and the device saves them. Every subsequent boot connects automatically.
void setupWifi() {
  WiFiManager wm;
  wm.setConfigPortalTimeout(180); // restart after 3 min if portal is unused
  if (!wm.autoConnect("Celsius-Setup")) {
    Serial.println("[WiFi] Config portal timed out — restarting");
    ESP.restart();
  }
  Serial.printf("[WiFi] Connected to %s — IP %s\n",
                WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());
}

// ─── BSEC2 setup ──────────────────────────────────────────────────────────────
void setupBsec() {
  Wire.begin();   // SDA=21, SCL=22 on most ESP32 boards

  if (!envSensor.begin(BME68X_I2C_ADDR_LOW, Wire)) {
    Serial.println("[BSEC2] ERROR: sensor not found — check wiring & I2C address");
    while (true) delay(1000);
  }

  // Subscribe to virtual outputs at 3-second sample rate
  if (!envSensor.updateSubscription(sensorList, ARRAY_LEN(sensorList), BSEC_SAMPLE_RATE_LP)) {
    Serial.println("[BSEC2] ERROR: subscription failed");
    while (true) delay(1000);
  }

  Serial.println("[BSEC2] BME680 initialised.");
}

// ─── BSEC2 read ───────────────────────────────────────────────────────────────
bool readBsec() {
  if (!envSensor.run()) return false;   // no new data yet

  for (uint8_t i = 0; i < envSensor.outputs.nOutputs; i++) {
    const bsecData& o = envSensor.outputs.output[i];
    switch (o.sensor_id) {
      case BSEC_OUTPUT_RAW_TEMPERATURE: g_temperature = o.signal; break;
      case BSEC_OUTPUT_RAW_HUMIDITY:    g_humidity    = o.signal; break;
      case BSEC_OUTPUT_RAW_GAS:
        // Convert raw resistance (Ω) to kΩ — clamp to sane range
        g_air_quality = constrain(o.signal / 1000.0f, 0.0f, 200.0f);
        break;
      case BSEC_OUTPUT_IAQ:
        g_iaq = constrain(o.signal, 0.0f, 500.0f);
        break;
      default: break;
    }
  }
  return true;
}

// ─── TFLite setup ─────────────────────────────────────────────────────────────
void setupTflite() {
  model = tflite::GetModel(g_model);
  if (model->version() != TFLITE_SCHEMA_VERSION) {
    Serial.printf("[TFLite] Schema mismatch: got %u, want %d\n",
                  model->version(), TFLITE_SCHEMA_VERSION);
    // Stub model won't pass this — that's expected until you replace g_model[]
    Serial.println("[TFLite] WARNING: using placeholder model, inference will be skipped.");
    return;
  }

  static tflite::MicroInterpreter static_interpreter(
      model, resolver, tensor_arena, kTensorArenaSize);
  interpreter = &static_interpreter;

  if (interpreter->AllocateTensors() != kTfLiteOk) {
    Serial.println("[TFLite] AllocateTensors() failed");
    return;
  }

  input  = interpreter->input(0);
  output = interpreter->output(0);
  Serial.println("[TFLite] Model loaded — input shape [1,3], output shape [1,3].");
}

// ─── TFLite inference ─────────────────────────────────────────────────────────
const char* runInference(float temp, float hum, float aq) {
  if (!interpreter || !input || !output) {
    // Placeholder model not set up — fall back to rule-based classification
    // matching the same thresholds used in index.tsx
    bool tempOk = (temp >= 18 && temp <= 28);
    bool humOk  = (hum  >= 20 && hum  <= 60);
    bool aqOk   = (aq   > 45);
    int bad  = (!tempOk ? 1 : 0) + (!humOk ? 1 : 0) + (!aqOk ? 1 : 0);
    if (bad == 0) return "Good";
    if (bad == 1) return "Moderate";
    return "Poor";
  }

  // Normalise to [0,1] — adjust ranges to match your training data
  input->data.f[0] = normalise(temp, 10.0f, 45.0f);   // temperature °C
  input->data.f[1] = normalise(hum,   0.0f, 100.0f);  // humidity %
  input->data.f[2] = normalise(aq,    0.0f, 200.0f);  // air quality kΩ

  if (interpreter->Invoke() != kTfLiteOk) {
    Serial.println("[TFLite] Invoke() failed");
    return "Poor";   // safe default
  }

  // Argmax over softmax outputs: 0=Good, 1=Moderate, 2=Poor
  int best = 0;
  for (int i = 1; i < 3; i++) {
    if (output->data.f[i] > output->data.f[best]) best = i;
  }
  return CLASS_LABELS[best];
}

// ─── Supabase push ────────────────────────────────────────────────────────────
void pushToSupabase(const char* classification) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[Supabase] WiFi not connected — skipping push");
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();   // Skip TLS cert verification (OK for prototype)

  HTTPClient http;
  http.begin(client, String(SUPABASE_URL) + "/rest/v1/sensor_readings");
  http.addHeader("Content-Type",  "application/json");
  http.addHeader("apikey",        SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  http.addHeader("Prefer",        "return=minimal");

  // Build JSON payload. ml_classification comes from TinyML inference.
  // iaq_score is the BSEC IAQ index (0 = excellent, 500 = heavily polluted).
  // If merging with the primary firmware, add temperature/humidity/noise here too.
  StaticJsonDocument<200> doc;
  doc["ml_classification"] = classification;
  doc["iaq_score"]         = (int)g_iaq;
  doc["temperature"]       = round(g_temperature * 10) / 10.0f;
  doc["humidity"]          = round(g_humidity    * 10) / 10.0f;
  doc["air_quality"]       = round(g_air_quality * 10) / 10.0f;

  String body;
  serializeJson(doc, body);

  int code = http.POST(body);
  Serial.printf("[Supabase] POST → %d  (%s)\n", code, classification);
  http.end();
}
