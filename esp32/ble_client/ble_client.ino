#include <WiFi.h>
#include <HTTPClient.h>
#include <BLEDevice.h>
#include <ArduinoJson.h>

// Replace with your Wi-Fi credentials (ESP32 must be on same Wi-Fi)
const char* WIFI_SSID = "YOUR_SSID";
const char* WIFI_PASS = "YOUR_PASS";

// BLE service/characteristic UUIDs (must match the RPi advertiser)
static BLEUUID serviceUUID("12345678-1234-5678-1234-56789abcdef0");
static BLEUUID charUUID("abcdef01-1234-5678-1234-56789abcdef0");

// Fallback if BLE fails — keep reverse compatible with previous static config
String fallbackServer = "http://192.168.0.100:8080"; // change as needed

void setupWiFi() {
  Serial.print("Connecting to WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    Serial.print('.');
    delay(500);
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi connected: "+WiFi.localIP().toString());
  } else {
    Serial.println("WiFi connection failed");
  }
}

String readServerInfoOverBLE() {
  BLEDevice::init("");
  BLEScan* pScan = BLEDevice::getScan();
  pScan->setActiveScan(true);
  Serial.println("Scanning for BLE advertiser...");
  BLEScanResults results = pScan->start(5);
  for (int i = 0; i < results.getCount(); ++i) {
    BLEAdvertisedDevice adv = results.getDevice(i);
    if (adv.haveServiceUUID() && adv.isAdvertisingService(serviceUUID)) {
      Serial.println("Found advertiser: " + adv.toString().c_str());
      BLEAddress addr = adv.getAddress();
      BLEClient* pClient = BLEDevice::createClient();
      if (pClient->connect(addr)) {
        BLERemoteService* pService = pClient->getService(serviceUUID);
        if (pService) {
          BLERemoteCharacteristic* pChar = pService->getCharacteristic(charUUID);
          if (pChar && pChar->canRead()) {
            std::string val = pChar->readValue();
            String s(val.c_str());
            pClient->disconnect();
            return s;
          }
        }
      }
      pClient->disconnect();
    }
  }
  return String();
}

void fetchSchedule(const String &baseUrl) {
  String url = baseUrl + "/api/schedule";
  Serial.println("Fetching schedule: " + url);
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("No WiFi — aborting HTTP request");
    return;
  }
  HTTPClient http;
  http.begin(url);
  int code = http.GET();
  if (code == 200) {
    String body = http.getString();
    Serial.println("Schedule: " + body);
  } else {
    Serial.println("HTTP error " + String(code));
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  setupWiFi();

  String payload = readServerInfoOverBLE();
  if (payload.length()) {
    Serial.println("BLE payload: " + payload);
    StaticJsonDocument<256> doc;
    DeserializationError err = deserializeJson(doc, payload);
    if (!err) {
      const char* ip = doc["ip"] | "";
      int port = doc["port"] | 0;
      if (ip && port) {
        String base = "http://" + String(ip) + ":" + String(port);
        fetchSchedule(base);
        return;
      }
    }
    Serial.println("BLE payload parse failed, falling back");
  } else {
    Serial.println("No BLE payload found, using fallback");
  }

  fetchSchedule(fallbackServer);
}

void loop() {
  // Optionally poll periodically
  delay(60000);
}
