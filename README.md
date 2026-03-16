# classsense

A React Native (Expo) app for monitoring classroom air quality in real time. Connects to an ESP32 sensor node via Supabase.

## Screens

**Live** — displays the latest sensor reading, refreshing every 3 seconds. Shows temperature, humidity, air quality (kohms), and noise level with colour-coded status indicators.

**History** — shows all readings from the last 7 days grouped by day. Each day is expandable. Pull down to refresh.

## Sensors

| Field | Unit | Description |
|---|---|---|
| `temperature` | °C | Ambient temperature |
| `humidity` | % | Relative humidity |
| `air_quality` | kohms | MQ-series gas sensor resistance |
| `noise` | 0–4095 | Raw ADC noise level |

## Stack

- React Native + Expo (SDK 54)
- Expo Router (file-based navigation)
- Supabase (`sensor_readings` table)

## Setup

1. Install dependencies

   ```bash
   npm install
   ```

2. Add your Supabase anon key to `lib/supabase.ts`

3. Start the app

   ```bash
   npx expo start
   ```

## Project structure

```
app/
  (tabs)/
    _layout.tsx     # bottom tab navigator
    index.tsx       # Live screen
    history.tsx     # History screen
  _layout.tsx       # root stack layout
  index.tsx         # redirects to tabs
lib/
  supabase.ts       # shared Supabase client
firmware/
  classsense_firmware/  # ESP32 Arduino sketch
```
