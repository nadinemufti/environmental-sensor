/*
 * Celsius -- Classroom Air Quality Monitor
 * =========================================
 * Hardware : ESP32 + BME680 (I2C) + MAX9814 (GPIO34 ADC)
 * Libraries: Bosch BSEC2, TensorFlow Lite Micro, WiFiManager,
 *            WiFiClientSecure, HTTPClient, ArduinoJson
 *
 * CelsiusIntelligence -- on-device TinyML air quality classifier
 *   Input  : [1, 3] float32  (temp_norm, hum_norm, aq_norm)
 *   Output : [1, 3] float32  softmax  (Good, Moderate, Poor)
 *
 * Status logic:
 *   GREEN  -- all 3 sensors (temp, hum, IAQ) in good range
 *   YELLOW -- any sensor moderate, OR exactly 1 sensor bad
 *   RED    -- 2+ sensors bad, OR any extreme reading (IAQ>=400, temp<10/>38, hum<5/>85%)
 *             + siren (800-2500 Hz sweep, 10 Hz steps, 5 ms delay)
 *   ALARM  -- 5 consecutive RED readings latch a continuous buzzer loop (power-cycle to reset)
 *
 * WiFi: WiFiManager captive portal ("Celsius-Setup" AP on first boot).
 *       Credentials saved to NVS flash. eduroam not supported -- use hotspot.
 *
 * PCB pinout:
 *   BME680  SDA=GPIO21, SCL=GPIO22
 *   MAX9814 OUT=GPIO34
 *   LED_RED=GPIO15, LED_YELLOW=GPIO5, LED_GREEN=GPIO19, BUZZER=GPIO18
 */

#include <Wire.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// BSEC2 -- Bosch Sensortec Environmental Cluster
#include <bsec2.h>

// CelsiusIntelligence -- TFLite Micro
#include <TensorFlowLite_ESP32.h>
#include "tensorflow/lite/micro/all_ops_resolver.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/schema/schema_generated.h"

// ── CelsiusIntelligence model weights ────────────────────────────────────────
// Run train_celsiusintelligence.py to generate celsiusintelligence_model.h,
// then uncomment and replace the stub below:
//
// #include "celsiusintelligence_model.h"
// #define CI_MODEL_DATA celsiusintelligence_model_data
// #define CI_MODEL_LEN  celsiusintelligence_model_data_len
//
// Stub -- schema check fails gracefully; falls back to rule-based classifier.
const unsigned char g_model[] = {
  0x1c, 0x00, 0x00, 0x00, 0x54, 0x46, 0x4c, 0x33,
};
const unsigned int g_model_len = sizeof(g_model);

#ifndef CI_MODEL_DATA
#define CI_MODEL_DATA g_model
#define CI_MODEL_LEN  g_model_len
#endif

// ── Pin definitions ───────────────────────────────────────────────────────────
#define MIC_PIN    34   // MAX9814 OUT -- GPIO34 (ADC1_CH6, input-only, no pull)
#define LED_RED    15
#define LED_YELLOW 5    // swapped: yellow is now GPIO5
#define LED_GREEN  19   // swapped: green is now GPIO19
#define BUZZER     18

// ── Timing ────────────────────────────────────────────────────────────────────
#define PUSH_INTERVAL_MS 10000   // Supabase POST every 10 s

// ── Supabase ──────────────────────────────────────────────────────────────────
#define SUPABASE_URL "https://dnvrhloomkjkownjohpv.supabase.co/rest/v1/sensor_readings"
#define SUPABASE_KEY \
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." \
  "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRudnJobG9vbWtqa293bmpvaHB2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1ODMxOTUsImV4cCI6MjA4OTE1OTE5NX0." \
  "d_17mkOSDqy0ZtBTETYzCrGTRiPb1ybOPgfW5LYk3tQ"

// ── BSEC2 ─────────────────────────────────────────────────────────────────────
Bsec2 envSensor;

bsec_virtual_sensor_t sensorList[] = {
  BSEC_OUTPUT_RAW_TEMPERATURE,
  BSEC_OUTPUT_RAW_HUMIDITY,
  BSEC_OUTPUT_RAW_GAS,    // gas resistance in Ohm
  BSEC_OUTPUT_IAQ,        // calibrated IAQ 0-500
  BSEC_OUTPUT_STATIC_IAQ,
};

float g_temperature = 22.0f;
float g_humidity    = 45.0f;
float g_air_quality = 50.0f;  // kOhm (raw gas / 1000)
float g_iaq         = 50.0f;  // BSEC2 IAQ (0=excellent, 500=heavily polluted)
int   g_noise       = 0;

// ── TFLite runtime ────────────────────────────────────────────────────────────
namespace {
  const int kTensorArenaSize = 8 * 1024;
  uint8_t tensor_arena[kTensorArenaSize];

  const tflite::Model*      ciModel     = nullptr;
  tflite::MicroInterpreter* interpreter = nullptr;
  TfLiteTensor*             ciInput     = nullptr;
  TfLiteTensor*             ciOutput    = nullptr;
  tflite::AllOpsResolver    resolver;
}

const char* CLASS_LABELS[] = { "Good", "Moderate", "Poor" };

inline float normalise(float v, float vmin, float vmax) {
  return (v - vmin) / (vmax - vmin + 1e-6f);
}

// ── Forward declarations ──────────────────────────────────────────────────────
void        setupWifi();
void        setupBsec();
void        setupCelsiusIntelligence();
bool        readBsec();
const char* runCelsiusIntelligence(float temp, float hum, float aq);
void        soundSiren();
void        postToSupabase(float temp, float hum, float aq, int noise,
                           const char* status, const char* mlLabel, int iaq);

// ── setup() ──────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n[Celsius] booting...");

  pinMode(LED_GREEN,  OUTPUT);
  pinMode(LED_YELLOW, OUTPUT);
  pinMode(LED_RED,    OUTPUT);
  // BUZZER: tone() manages pinMode internally

  // Startup blink
  digitalWrite(LED_GREEN, HIGH); delay(200); digitalWrite(LED_GREEN, LOW);
  tone(BUZZER, 1000, 100); delay(150); noTone(BUZZER);

  setupWifi();
  setupBsec();
  setupCelsiusIntelligence();

  Serial.println("[Celsius] ready\n");
}

// ── loop() ────────────────────────────────────────────────────────────────────
static unsigned long lastPush       = 0;
static const char*   cachedStatus   = "";
static const char*   cachedLabel    = "Good";
static int           consecutiveRed = 0;   // counts back-to-back POOR readings
static bool          alarmActive    = false; // latched: buzzer loops until reset

void loop() {
  // ── Continuous alarm latch ─────────────────────────────────────────────────
  // Once triggered (5 consecutive POOR), buzzer loops forever until power cycle.
  if (alarmActive) {
    digitalWrite(LED_GREEN,  LOW);
    digitalWrite(LED_YELLOW, LOW);
    digitalWrite(LED_RED,    HIGH);
    soundSiren();
    return; // skip normal logic while alarm is active
  }

  bool newData = readBsec();

  if (newData) {
    g_noise = analogRead(MIC_PIN);

    // ── Per-sensor classification ───────────────────────────────────────────
    // IAQ 0-500 (lower = better)
    bool aqGood     = g_iaq < 100;
    bool aqModerate = g_iaq >= 100 && g_iaq < 200;
    bool aqBad      = g_iaq >= 200;

    // Temperature
    bool tempGood     = g_temperature >= 18 && g_temperature <= 28;
    bool tempModerate = (g_temperature >= 15 && g_temperature < 18) ||
                        (g_temperature > 28  && g_temperature <= 32);
    bool tempBad      = g_temperature < 15 || g_temperature > 32;

    // Humidity
    bool humGood     = g_humidity >= 15 && g_humidity <= 65;
    bool humModerate = (g_humidity >= 10 && g_humidity < 15) ||
                       (g_humidity > 65  && g_humidity <= 75);
    bool humBad      = g_humidity < 10 || g_humidity > 75;

    // ── Multi-sensor danger formula ─────────────────────────────────────────
    // Rule: 1 bad sensor alone = WARNING (yellow).
    //       2+ bad sensors     = POOR (red).
    //       Extreme readings   = POOR regardless of count.
    //       5 consecutive POOR = continuous alarm latch.
    int badCount =  (aqBad   ? 1 : 0)
                  + (tempBad ? 1 : 0)
                  + (humBad  ? 1 : 0);

    bool extremeCritical = (g_iaq          >= 400)
                        || (g_temperature  <  10.0f || g_temperature > 38.0f)
                        || (g_humidity     <   5.0f || g_humidity    > 85.0f);

    bool anyModerate = aqModerate || tempModerate || humModerate;

    bool isPoor    = (badCount >= 2) || extremeCritical;
    bool isWarning = !isPoor && (badCount == 1 || anyModerate);

    // ── Consecutive POOR counter ────────────────────────────────────────────
    if (isPoor) {
      consecutiveRed++;
      Serial.printf("[alarm] consecutive POOR count: %d/5\n", consecutiveRed);
      if (consecutiveRed >= 5) {
        alarmActive = true;
        Serial.println("[alarm] DANGER ZONE -- continuous alarm activated");
      }
    } else {
      consecutiveRed = 0;
    }

    // ── LEDs + buzzer ───────────────────────────────────────────────────────
    if (isPoor) {
      digitalWrite(LED_GREEN,  LOW);
      digitalWrite(LED_YELLOW, LOW);
      digitalWrite(LED_RED,    HIGH);
      soundSiren();
    } else if (isWarning) {
      digitalWrite(LED_GREEN,  LOW);
      digitalWrite(LED_YELLOW, HIGH);
      digitalWrite(LED_RED,    LOW);
      tone(BUZZER, 1000, 100); delay(150); noTone(BUZZER);
    } else {
      digitalWrite(LED_GREEN,  HIGH);
      digitalWrite(LED_YELLOW, LOW);
      digitalWrite(LED_RED,    LOW);
      noTone(BUZZER);
    }

    // ── CelsiusIntelligence inference ───────────────────────────────────────
    cachedLabel = runCelsiusIntelligence(g_temperature, g_humidity, g_air_quality);

    if (isPoor)       cachedStatus = "poor";
    else if (isWarning) cachedStatus = "warning";
    else              cachedStatus = "good";

    Serial.printf(
      "[reading] temp=%.1fC  hum=%.1f%%  aq=%.1fkO  iaq=%.0f  noise=%d  "
      "bad=%d  status=%s  CI=%s\n",
      g_temperature, g_humidity, g_air_quality, g_iaq, g_noise,
      badCount, cachedStatus, cachedLabel
    );
  }

  // ── POST to Supabase ────────────────────────────────────────────────────────
  unsigned long now = millis();
  if (now - lastPush >= PUSH_INTERVAL_MS && strlen(cachedStatus) > 0) {
    lastPush = now;
    postToSupabase(
      g_temperature, g_humidity, g_air_quality, g_noise,
      cachedStatus, cachedLabel, (int)g_iaq
    );
  }
}

// ── Siren: aggressive sweep 800-2500 Hz, fast ────────────────────────────────
void soundSiren() {
  // Rising sweep
  for (int freq = 800; freq <= 2500; freq += 10) {
    tone(BUZZER, freq);
    delay(5);
  }
  // Falling sweep
  for (int freq = 2500; freq >= 800; freq -= 10) {
    tone(BUZZER, freq);
    delay(5);
  }
  noTone(BUZZER);
}

// ── WiFi (WiFiManager captive portal) ────────────────────────────────────────
void setupWifi() {
  WiFiManager wm;
  wm.setConfigPortalTimeout(180);
  if (!wm.autoConnect("Celsius-Setup")) {
    Serial.println("[WiFi] portal timed out -- restarting");
    ESP.restart();
  }
  Serial.printf("[WiFi] connected: %s  IP: %s\n",
                WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());
}

// ── BSEC2 setup ───────────────────────────────────────────────────────────────
void setupBsec() {
  Wire.begin();  // SDA=GPIO21, SCL=GPIO22

  if (!envSensor.begin(BME68X_I2C_ADDR_LOW, Wire)) {
    Serial.println("[BSEC2] sensor not found -- check wiring (SDA=21, SCL=22, addr=0x76)");
    while (true) delay(1000);
  }

  if (!envSensor.updateSubscription(sensorList, ARRAY_LEN(sensorList), BSEC_SAMPLE_RATE_LP)) {
    Serial.println("[BSEC2] subscription failed");
    while (true) delay(1000);
  }

  Serial.println("[BSEC2] BME680 ready (3 s sample rate via BSEC2)");
}

// ── BSEC2 read ────────────────────────────────────────────────────────────────
bool readBsec() {
  if (!envSensor.run()) return false;

  for (uint8_t i = 0; i < envSensor.outputs.nOutputs; i++) {
    const bsecData& o = envSensor.outputs.output[i];
    switch (o.sensor_id) {
      case BSEC_OUTPUT_RAW_TEMPERATURE:
        g_temperature = o.signal;
        break;
      case BSEC_OUTPUT_RAW_HUMIDITY:
        g_humidity = o.signal;
        break;
      case BSEC_OUTPUT_RAW_GAS:
        g_air_quality = constrain(o.signal / 1000.0f, 0.0f, 500.0f);
        break;
      case BSEC_OUTPUT_IAQ:
      case BSEC_OUTPUT_STATIC_IAQ:
        g_iaq = constrain(o.signal, 0.0f, 500.0f);
        break;
      default: break;
    }
  }
  return true;
}

// ── CelsiusIntelligence setup ─────────────────────────────────────────────────
void setupCelsiusIntelligence() {
  ciModel = tflite::GetModel(CI_MODEL_DATA);
  if (ciModel->version() != TFLITE_SCHEMA_VERSION) {
    Serial.printf("[CelsiusIntelligence] schema mismatch (got %u, want %d)\n",
                  ciModel->version(), TFLITE_SCHEMA_VERSION);
    Serial.println("[CelsiusIntelligence] using rule-based fallback -- run train_celsiusintelligence.py");
    return;
  }

  static tflite::MicroInterpreter static_interp(
      ciModel, resolver, tensor_arena, kTensorArenaSize);
  interpreter = &static_interp;

  if (interpreter->AllocateTensors() != kTfLiteOk) {
    Serial.println("[CelsiusIntelligence] AllocateTensors failed -- using fallback");
    interpreter = nullptr;
    return;
  }

  ciInput  = interpreter->input(0);
  ciOutput = interpreter->output(0);
  Serial.println("[CelsiusIntelligence] model loaded -- input [1,3], output [1,3]");
}

// ── CelsiusIntelligence inference ─────────────────────────────────────────────
const char* runCelsiusIntelligence(float temp, float hum, float aq) {
  if (!interpreter || !ciInput || !ciOutput) {
    // Rule-based fallback matching app thresholds
    int out = 0;
    if (!(temp >= 18 && temp <= 28)) out++;
    if (!(hum  >= 15 && hum  <= 65)) out++;
    if (!(aq   >  45))               out++;
    if (out == 0) return "Good";
    if (out == 1) return "Moderate";
    return "Poor";
  }

  ciInput->data.f[0] = normalise(temp, 10.0f,  45.0f);
  ciInput->data.f[1] = normalise(hum,   0.0f, 100.0f);
  ciInput->data.f[2] = normalise(aq,    0.0f, 200.0f);

  if (interpreter->Invoke() != kTfLiteOk) {
    Serial.println("[CelsiusIntelligence] Invoke failed");
    return "Poor";
  }

  int best = 0;
  for (int i = 1; i < 3; i++) {
    if (ciOutput->data.f[i] > ciOutput->data.f[best]) best = i;
  }
  return CLASS_LABELS[best];
}

// ── Supabase POST ─────────────────────────────────────────────────────────────
void postToSupabase(float temp, float hum, float aq, int noise,
                    const char* status, const char* mlLabel, int iaq) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[Supabase] WiFi not connected -- skipping");
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.begin(client, SUPABASE_URL);
  http.addHeader("Content-Type",  "application/json");
  http.addHeader("apikey",        SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  http.addHeader("Prefer",        "return=minimal");

  StaticJsonDocument<256> doc;
  doc["temperature"]       = round(temp * 10) / 10.0f;
  doc["humidity"]          = round(hum  * 10) / 10.0f;
  doc["air_quality"]       = round(aq   * 10) / 10.0f;
  doc["noise"]             = noise;
  doc["status"]            = status;
  doc["ml_classification"] = mlLabel;
  doc["iaq_score"]         = iaq;

  String body;
  serializeJson(doc, body);

  int code = http.POST(body);
  Serial.printf("[Supabase] POST -> %d  (CI=%s  status=%s  iaq=%d)\n",
                code, mlLabel, status, iaq);
  http.end();
}
