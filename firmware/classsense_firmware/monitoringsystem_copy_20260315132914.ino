#include <Wire.h>
#include <Adafruit_BME680.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

Adafruit_BME680 bme;

#define MIC_PIN    4
#define LED_RED    15
#define LED_YELLOW 19
#define LED_GREEN  5
#define BUZZER     18

// supabase config
const char* SUPABASE_URL = "https://dnvrhloomkjkownjohpv.supabase.co";
const char* SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRudnJobG9vbWtqa293bmpvaHB2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1ODMxOTUsImV4cCI6MjA4OTE1OTE5NX0.d_17mkOSDqy0ZtBTETYzCrGTRiPb1ybOPgfW5LYk3tQ";

void postToSupabase(float temp, float humidity, float airQual, int noise) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(SUPABASE_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  http.addHeader("Prefer", "return=minimal");

  // build json
  StaticJsonDocument<200> doc;
  doc["temperature"] = temp;
  doc["humidity"]    = humidity;
  doc["air_quality"] = airQual;
  doc["noise"]       = noise;

  String body;
  serializeJson(doc, body);

  int code = http.POST(body);
  Serial.print("supabase response: "); Serial.println(code);
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(LED_GREEN,  OUTPUT);
  pinMode(LED_YELLOW, OUTPUT);
  pinMode(LED_RED,    OUTPUT);
  pinMode(BUZZER,     OUTPUT);

  // wifi setup — creates hotspot "ClassSense Setup" if no wifi saved
  WiFiManager wm;
  wm.autoConnect("ClassSense Setup");
  Serial.println("wifi connected!");

  if (!bme.begin(0x76)) {
    Serial.println("cant find the sensor");
    while (1);
  }
  Serial.println("sensor found, lets go");
}

void loop() {
  if (!bme.performReading()) {
    Serial.println("read failed, trying again...");
    return;
  }

  int micValue = analogRead(MIC_PIN);
  int airQual  = bme.gas_resistance / 1000;

  if (airQual > 50) {
    digitalWrite(LED_GREEN,  HIGH);
    digitalWrite(LED_YELLOW, LOW);
    digitalWrite(LED_RED,    LOW);
    digitalWrite(BUZZER,     LOW);
  } else if (airQual > 20) {
    digitalWrite(LED_GREEN,  LOW);
    digitalWrite(LED_YELLOW, HIGH);
    digitalWrite(LED_RED,    LOW);
    digitalWrite(BUZZER,     LOW);
  } else {
    digitalWrite(LED_GREEN,  LOW);
    digitalWrite(LED_YELLOW, LOW);
    digitalWrite(LED_RED,    HIGH);
    digitalWrite(BUZZER,     HIGH);
    delay(200);
    digitalWrite(BUZZER,     LOW);
  }

  // post to supabase every reading
  postToSupabase(bme.temperature, bme.humidity, airQual, micValue);

  Serial.println("--- reading ---");
  Serial.print("temp      : "); Serial.print(bme.temperature); Serial.println(" c");
  Serial.print("humidity  : "); Serial.print(bme.humidity);    Serial.println(" %");
  Serial.print("air qual  : "); Serial.print(airQual); Serial.println(" kohms");
  Serial.print("noise     : "); Serial.print(micValue); Serial.println();
  Serial.println();

  delay(3000);
}