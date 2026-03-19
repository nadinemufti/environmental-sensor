# Celsius -- Classroom Air Quality Monitor

Real-time air quality monitoring for classrooms, built by a team of 5 uOttawa engineering students. An ESP32 reads temperature, humidity, VOC air quality (IAQ), and noise every 3 seconds, posts to Supabase, and a React Native app shows live status with alerts. Deploying to a real classroom after Design Day.

**Website:** https://celsius-monitor.vercel.app

---

## Hardware

| Component | Purpose | Interface |
|-----------|---------|-----------|
| ESP32 (DevKitC-VE) | Main MCU, WiFi | -- |
| BME680 | Temperature, Humidity, VOC gas | I2C (SDA=GPIO21, SCL=GPIO22) |
| MAX9814 | Microphone / noise level | ADC (GPIO34) |
| Custom PCB | Routes all components, milled at uOttawa CEED | -- |
| RGB LEDs | Green / Yellow / Red status | GPIO5, GPIO19, GPIO15 |
| Buzzer | Audible alert + siren | GPIO18 (tone/noTone) |

**PCB dimensions:** 100 x 60 mm, single-sided, CNC milled on campus.

---

## Firmware

**File:** `firmware/classsense_firmware/monitoringsystem_copy_20260315132914/`

### Libraries required (Arduino IDE)
- `Bosch BSEC2` -- calibrated IAQ from BME680 (install from Library Manager)
- `WiFiManager` by tzapu -- captive portal WiFi setup
- `ArduinoJson`
- `TensorFlowLite_ESP32` -- on-device ML inference

### WiFi setup
On first boot the ESP32 creates an access point called **Celsius-Setup**. Connect to it from any phone or laptop -- a captive portal opens automatically. Enter your WiFi credentials and hit Save. The device connects and saves credentials to flash. No reflash needed when the network changes.

> eduroam (WPA2-Enterprise) is not supported by WiFiManager. Use a phone hotspot or personal router instead.

### Status logic

| Status | LED | Buzzer | Condition |
|--------|-----|--------|-----------|
| GREEN | Green | Silent | All 3 sensors (temp, humidity, IAQ) in good range |
| YELLOW | Yellow | Single beep | Any sensor moderate, OR exactly 1 sensor bad |
| RED | Red | Fast siren (800-2500 Hz) | 2+ sensors bad, OR any extreme reading |
| ALARM | Red | Continuous loop | 5 consecutive RED readings -- power-cycle to reset |

**Extreme override thresholds** (auto-RED regardless of other sensors):
- IAQ >= 400
- Temperature < 10 C or > 38 C
- Humidity < 5% or > 85%

**Good ranges:**
- Temperature: 18-28 C
- Humidity: 15-65%
- IAQ: 0-100 (BSEC2 scale, 0 = excellent)

### CelsiusIntelligence (on-device ML)

A TensorFlow Lite int8 MLP runs on the ESP32 for secondary classification:
- Input: `[temp_norm, hum_norm, aq_norm]` (float32, normalised)
- Output: softmax over `[Good, Moderate, Poor]`
- Fallback: rule-based classifier if model not loaded

**To train and deploy the model:**
```bash
cd firmware
pip install requests numpy scikit-learn tensorflow matplotlib
python train_celsiusintelligence.py
```
This fetches all Supabase readings, trains a 2-layer MLP (16 neurons each), quantizes to int8 TFLite, and writes `celsiusintelligence_model.h`. Then uncomment lines 46-48 in the `.ino` and flash.

### Supabase schema

Run once in the Supabase SQL editor:
```sql
CREATE TABLE IF NOT EXISTS sensor_readings (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at        timestamptz DEFAULT now(),
  temperature       numeric,
  humidity          numeric,
  air_quality       numeric,
  noise             integer,
  status            text,
  ml_classification text,
  iaq_score         integer
);

-- If adding columns to an existing table:
ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS ml_classification text;
ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS iaq_score integer;
```

---

## Mobile App

**Stack:** React Native + Expo SDK 54, Expo Router, Supabase JS client

### Screens

**Dashboard (`index.tsx`)**
- Live readings every 5 seconds
- Full-screen color: white = good, amber = warning, solid red = poor
- 48px bold sensor numbers, anomaly warnings (2-sigma on last 50 readings)
- Vibration + flash animation + push notification on poor status
- Claude Haiku AI tip on status change (optional -- set `EXPO_PUBLIC_ANTHROPIC_API_KEY`)
- Offline banner after 2 missed fetches

**Teacher / Analytics (`learn.tsx`)**
- 24-hour hourly-average line charts for temperature, humidity, and VOC air quality
- Vivid gradient fill, min/avg/max/now stats, ideal range shown per sensor
- Pull to refresh

**History (`history.tsx`)**
- 7-day history grouped by day
- Sparklines per day, expandable reading list
- Color-coded chips for temperature, humidity, air quality, noise

### Setup

```bash
npm install
npx expo start
```

On a physical device (required for push notifications and vibration):
```bash
npx expo start --tunnel
```

**Optional environment variable:**
Create a `.env` in the project root (do not commit):
```
EXPO_PUBLIC_ANTHROPIC_API_KEY=sk-ant-...
```
This enables the Claude Haiku teacher tip that appears in the info bar on status change.

---

## Website

**Live:** https://celsius-monitor.vercel.app

Static site in `website/`. To redeploy:
```bash
cd website
npx vercel --prod --yes
```

---

## Project structure

```
app/
  (tabs)/
    _layout.tsx         -- bottom tab navigator (3 tabs)
    index.tsx           -- Dashboard: live sensor readings
    learn.tsx           -- Teacher: 24-hour analytics charts
    history.tsx         -- History: 7-day log
  _layout.tsx           -- root stack layout
firmware/
  classsense_firmware/
    monitoringsystem_copy_20260315132914/
      *.ino             -- ESP32 main sketch
  train_celsiusintelligence.py  -- TFLite training script
lib/
  supabase.ts           -- Supabase client
website/
  index.html            -- project landing page
  team.jpg              -- team photo
```

---

## Team

University of Ottawa -- Faculty of Engineering -- Design Day 2026

| Name | Role |
|------|------|
| Ben | Firmware / Systems |
| Maryan | Hardware / PCB |
| Nadine | Mobile / UX |
| Saaid | ML / Data |
| Charlie | Backend |
