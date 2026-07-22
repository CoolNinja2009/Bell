/*
 * ESP32 Dual‑Channel Relay Controller  —  WiFi + NTP + Auto‑Discovery
 * ──────────────────────────────────────────────────────────────────
 * Zero‑config deployment:
 *   • Server broadcasts a UDP beacon every 5 s
 *   • ESP32 listens, auto‑discovers server IP — no static IP, no mDNS
 *   • Falls back to compiled‑in FALLBACK_SERVER_IP if no beacon heard
 *
 * Hardened for 24/7 unattended operation — every failure mode recovers.
 *
 * CONFIGURATION — change the tables below, nothing else.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUDP.h>
#include <HTTPClient.h>
#include <time.h>
#include <esp_sntp.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <Wire.h>
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>
#include <BLEClient.h>

// ============================================================================
// 0.  SERIAL OUTPUT  (always on for production visibility)
// ============================================================================
#define DEBUG_SERIAL

// ============================================================================
// 1.  PIN MAP
// ============================================================================
constexpr uint8_t  CH1_RELAY_PIN     = 26;
constexpr uint8_t  CH2_RELAY_PIN     = 27;
constexpr bool     RELAY_ACTIVE_HIGH = false;  // false → LOW = relay closed (most modules)
                                                // false → LOW  = relay closed

// Server channel keys mapped to the two physical relay outputs. server-node
// can now create channels such as "bell"; the ESP32 still has two outputs.
static const char *CH1_SERVER_KEYS[] = { "ch1", "bell" };
static const char *CH2_SERVER_KEYS[] = { "ch2" };

#include "wifi_provision.h"

// ============================================================================
// 3.  SERVER DISCOVERY  (beacon + fallback)
// ============================================================================
constexpr uint16_t BEACON_PORT         = 9999;          // UDP port for discovery
constexpr uint32_t BEACON_TIMEOUT_MS   = 45000;         // mark server lost after 45 s
constexpr char     FALLBACK_SERVER_IP[] = "192.168.1.100"; // used until beacon found
constexpr uint16_t SERVER_PORT         = 8080;          // HTTP port
constexpr uint32_t HASH_POLL_MS      = 5000;          // quick change-detection poll
constexpr uint32_t FULL_POLL_MS      = 30000;         // full schedule fetch
constexpr uint32_t POLL_TIMEOUT_MS   = 8000;          // HTTP request timeout
constexpr uint32_t COMMAND_POLL_MS   = 1000;          // manual "run now" poll

// ---------------------------------------------------------------------------
// BLE discovery (optional) — scans for a BLE advertiser that provides the
// server IP/port as a small JSON payload. Falls back to UDP beacon if not
// available. These UUIDs must match whatever advertiser you run on the PC/RPi.
// ---------------------------------------------------------------------------
static const char BLE_SERVICE_UUID[] = "12345678-1234-5678-1234-56789abcdef0";
static const char BLE_CHAR_UUID[]    = "abcdef01-1234-5678-1234-56789abcdef0";
constexpr uint32_t BLE_SCAN_MS       = 5000;
constexpr uint32_t BLE_RETRY_MS      = 30000;

// Runtime — set by beacon, falls back to compiled constants
static IPAddress g_server_ip;
static uint16_t  g_server_port     = SERVER_PORT;
static bool      g_server_seen     = false;   // beacon ever received?
static uint32_t  g_last_beacon_ms  = 0;       // millis() of last beacon
static WiFiUDP   g_udp;

// NVS — non‑volatile storage for the last known config
static const char NVS_NS[]   = "relay";        // Preferences namespace
static char       g_cfg_hash[9] = {0};         // last known MD5 (8 hex + null)
static String     g_raw_config;                // last full server response
static bool       g_nvs_has_config = false;    // true when a valid config was loaded/saved
static bool       g_config_dirty = false;      // true -> needs NVS save

// ============================================================================
// 4.  TIMEZONE & NTP
// Timezone — seconds EAST of UTC (POSIX convention: minus = east)
// IST  = UTC+5:30 → 19800    EST  = UTC-5 → -18000    CET  = UTC+1 → 3600
constexpr long    GMT_OFFSET_SEC    = 19800;    // India (change for your TZ)
constexpr long    DAYLIGHT_SEC      = 0;        // 3600 if DST applies

constexpr char     NTP_SERVER1[]     = "pool.ntp.org";
constexpr char     NTP_SERVER2[]     = "time.nist.gov";
constexpr char     NTP_SERVER3[]     = "time.google.com";
constexpr uint32_t SNTP_SYNC_INTERVAL_MS = 900000;  // 15 min

// ============================================================================
// 4B.  REAL-TIME CLOCK  (OPTIONAL — AUTO-DETECTED, NO WIRING = NO CHANGE)
// ──────────────────────────────────────────────────────────────────────────
// Works with any DS1307 / DS3231 / DS3232-compatible I2C RTC breakout —
// these are by far the most common hobbyist RTC modules and all share the
// exact same clock/calendar register layout (0x00–0x06) at address 0x68,
// which is why one small driver here covers "any" of them without needing
// a chip-specific library.
//
// Purpose: keep real time running even when the schedule server / WiFi /
// internet is down for an extended period (or on every boot before NTP has
// had a chance to sync), instead of the controller sitting idle waiting
// for NTP. Also protects against RTC drift by periodically re-writing the
// RTC from NTP once NTP is available again.
//
// If no RTC module is wired up, rtc_detect() simply fails at boot and the
// whole feature is skipped — behavior falls back exactly to the original
// NTP-only setup, no other code path changes.
constexpr uint8_t  RTC_I2C_ADDR   = 0x68;  // DS1307 / DS3231 / DS3232 default address
constexpr int8_t   RTC_SDA_PIN    = 21;    // ESP32 default I2C pins — change if wired elsewhere
constexpr int8_t   RTC_SCL_PIN    = 22;
constexpr uint32_t RTC_RESYNC_MS  = 3600000; // push NTP time → RTC hourly once NTP is synced

// ============================================================================
// 5.  FALLBACK SCHEDULE  (used when server is unreachable)
// ============================================================================
constexpr uint32_t FALLBACK_CH1_PULSE_MS = 2000;
constexpr uint32_t FALLBACK_CH2_PULSE_MS = 2000;
constexpr uint32_t FALLBACK_CH1_SCHEDULE[] = {  8*3600, 20*3600       };
constexpr uint32_t FALLBACK_CH2_SCHEDULE[] = {  6*3600+30*60, 18*3600+45*60 };
constexpr size_t   FALLBACK_CH1_SLOTS = sizeof(FALLBACK_CH1_SCHEDULE) / sizeof(FALLBACK_CH1_SCHEDULE[0]);
constexpr size_t   FALLBACK_CH2_SLOTS = sizeof(FALLBACK_CH2_SCHEDULE) / sizeof(FALLBACK_CH2_SCHEDULE[0]);

// ============================================================================
// 6.  DYNAMIC CAPACITY
// ============================================================================
constexpr size_t MAX_SCHEDULE   = 24;
constexpr size_t MAX_SKIP_DATES = 32;

// ============================================================================
// 7.  HEALTH WATCHDOGS
// ============================================================================
constexpr uint32_t TIME_STALL_THRESHOLD_S  = 120;
constexpr uint32_t SCHEDULE_REFRESH_MS     = 3600000; // recompute schedules hourly

// ============================================================================
// 8.  STATE
// ============================================================================
enum class Phase : uint8_t { IDLE, ACTIVE };

struct ChannelCfg {
    bool     enabled       = true;
    uint32_t pulse_ms      = 2000;
    uint32_t schedule[MAX_SCHEDULE] = {0};
    size_t   schedule_len  = 0;
    char     skip_dates[MAX_SKIP_DATES][11] = {{0}};
    size_t   skip_count    = 0;
};

struct Channel {
    const uint8_t pin;
    const char *const *server_keys;
    const size_t server_key_count;
    ChannelCfg    cfg;
    char          schedule_key[21] = {0};
    Phase         phase       = Phase::IDLE;
    uint32_t      pulse_start = 0;  // millis() when current pulse began
    uint32_t      active_pulse_ms = 0;
    time_t        next_fire   = 0;

    Channel(uint8_t p, const char *const *keys, size_t key_count)
        : pin(p), server_keys(keys), server_key_count(key_count) {}
};

static ChannelCfg g_fallback_ch1;
static ChannelCfg g_fallback_ch2;
static Channel    g_ch1{ CH1_RELAY_PIN, CH1_SERVER_KEYS, sizeof(CH1_SERVER_KEYS) / sizeof(CH1_SERVER_KEYS[0]) };
static Channel    g_ch2{ CH2_RELAY_PIN, CH2_SERVER_KEYS, sizeof(CH2_SERVER_KEYS) / sizeof(CH2_SERVER_KEYS[0]) };
static bool       g_server_config_loaded = false;

// RTC (optional) — set once at boot by rtc_detect(); false if no module wired
static bool       g_rtc_present = false;

// ============================================================================
// 9.  HELPERS
// ============================================================================

// --- serial macros -----------------------------------------------------------
#ifdef DEBUG_SERIAL
  #define DBG(...)    Serial.print(__VA_ARGS__)
  #define DBGLN(...)  Serial.println(__VA_ARGS__)
  #define DBGF(...)   Serial.printf(__VA_ARGS__)
#else
  #define DBG(...)    ((void)0)
  #define DBGLN(...)  ((void)0)
  #define DBGF(...)   ((void)0)
#endif

// --- millis() wrap‑safe subtraction ------------------------------------------
inline uint32_t elapsed_since(const uint32_t t0) {
    return millis() - t0;
}

// --- set relay output --------------------------------------------------------
inline void relay_write(const uint8_t pin, const bool on) {
    digitalWrite(pin, on == RELAY_ACTIVE_HIGH ? HIGH : LOW);
}

// --- check whether NTP has delivered a plausible time ------------------------
inline bool time_is_valid() {
    return time(nullptr) > 1000000000UL;
}

// --- SNTP sync completed? ----------------------------------------------------
inline bool sntp_sync_done() {
    return sntp_get_sync_status() == SNTP_SYNC_STATUS_COMPLETED;
}

// --- convert a local‑time struct to epoch, or 0 on failure -------------------
static time_t tm_to_epoch(struct tm &t) {
    const time_t e = mktime(&t);
    return (e < 0) ? 0 : static_cast<time_t>(e);
}

// --- midnight epoch for the day that contains `epoch` ------------------------
static time_t midnight_of(const time_t epoch) {
    struct tm t;
    if (!localtime_r(&epoch, &t)) return 0;
    t.tm_hour = 0;
    t.tm_min  = 0;
    t.tm_sec  = 0;
    return tm_to_epoch(t);
}

// --- build today's date as "YYYY-MM-DD" into buf (11 bytes) -----------------
static bool today_str(char buf[11]) {
    const time_t now = time(nullptr);
    struct tm t;
    if (!localtime_r(&now, &t)) return false;
    snprintf(buf, 11, "%04d-%02d-%02d", t.tm_year + 1900, t.tm_mon + 1, t.tm_mday);
    return true;
}

// == Generic I2C RTC driver (DS1307 / DS3231 / DS3232 compatible) =============
// These chips share the same register layout for the clock/calendar
// registers (0x00-0x06), which is why one driver works for "any" common
// I2C RTC module without needing a chip-specific library. Times are kept
// in *local* time, matching how the rest of this file already treats
// time (see localtime_r / mktime usage above) — configTime()'s offset
// applies equally here.

static uint8_t bcd2dec(uint8_t v) { return static_cast<uint8_t>((v / 16) * 10 + (v % 16)); }
static uint8_t dec2bcd(uint8_t v) { return static_cast<uint8_t>((v / 10) * 16 + (v % 10)); }

// --- probe the I2C bus for an RTC at RTC_I2C_ADDR — false if nothing wired --
static bool rtc_detect() {
    Wire.beginTransmission(RTC_I2C_ADDR);
    return Wire.endTransmission() == 0;
}

// --- read current time from the RTC into a tm struct -------------------------
static bool rtc_read_time(struct tm &out) {
    Wire.beginTransmission(RTC_I2C_ADDR);
    Wire.write(static_cast<uint8_t>(0x00));
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom(static_cast<int>(RTC_I2C_ADDR), 7) != 7) return false;

    const uint8_t sec   = Wire.read();
    const uint8_t min_  = Wire.read();
    const uint8_t hour  = Wire.read();
    Wire.read();  // day-of-week register — unused, mktime() derives it
    const uint8_t mday  = Wire.read();
    const uint8_t month = Wire.read();
    const uint8_t year  = Wire.read();

    out = {};
    out.tm_sec  = bcd2dec(sec  & 0x7F);
    out.tm_min  = bcd2dec(min_ & 0x7F);
    out.tm_hour = bcd2dec(hour & 0x3F);       // masks 12h/AM-PM bits; module must be in 24h mode
    out.tm_mday = bcd2dec(mday & 0x3F);
    out.tm_mon  = bcd2dec(month & 0x1F) - 1;  // tm_mon is 0-11
    out.tm_year = bcd2dec(year) + 100;        // RTC stores 00-99 for 2000-2099; tm_year is since 1900
    out.tm_isdst = 0;

    // Sanity check — catches an uninitialised/dead RTC (e.g. battery just inserted)
    if (out.tm_mon < 0 || out.tm_mon > 11 || out.tm_mday < 1 || out.tm_mday > 31
        || out.tm_hour > 23 || out.tm_min > 59 || out.tm_sec > 59) {
        return false;
    }
    return true;
}

// --- write a tm struct to the RTC (used to correct RTC drift from NTP) ------
static void rtc_write_time(const struct tm &t) {
    Wire.beginTransmission(RTC_I2C_ADDR);
    Wire.write(static_cast<uint8_t>(0x00));
    Wire.write(dec2bcd(static_cast<uint8_t>(t.tm_sec)));
    Wire.write(dec2bcd(static_cast<uint8_t>(t.tm_min)));
    Wire.write(dec2bcd(static_cast<uint8_t>(t.tm_hour)));       // 24h mode
    Wire.write(dec2bcd(static_cast<uint8_t>(t.tm_wday + 1)));   // day-of-week, 1-7
    Wire.write(dec2bcd(static_cast<uint8_t>(t.tm_mday)));
    Wire.write(dec2bcd(static_cast<uint8_t>(t.tm_mon + 1)));
    Wire.write(dec2bcd(static_cast<uint8_t>(t.tm_year - 100)));
    Wire.endTransmission();
}

// --- seed the ESP32 system clock from the RTC --------------------------------
// Called at boot (before NTP has a chance to sync) and periodically while
// waiting for NTP, so the controller can run its schedule using RTC time
// alone whenever the server / WiFi / internet is unreachable.
static bool rtc_seed_system_clock() {
    struct tm t;
    if (!rtc_read_time(t)) return false;
    const time_t epoch = tm_to_epoch(t);
    if (epoch <= 0) return false;
    struct timeval tv = { epoch, 0 };
    settimeofday(&tv, nullptr);
    DBGF("[RTC] system clock set from RTC: %04d-%02d-%02d %02d:%02d:%02d\n",
         t.tm_year + 1900, t.tm_mon + 1, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec);
    return true;
}

// --- push the current (NTP-synced) system time to the RTC -------------------
// Called periodically once NTP is synced, so the RTC stays accurate long
// term and is ready to take over the next time the server/network is down.
static void rtc_sync_from_system() {
    const time_t now = time(nullptr);
    struct tm t;
    if (!localtime_r(&now, &t)) return;
    rtc_write_time(t);
    DBGLN(F("[RTC] resynced from NTP"));
}

// --- is today in the skip_dates list? ----------------------------------------
static bool is_skip_day(const ChannelCfg &cfg) {
    char today[11];
    if (!today_str(today)) return false;
    for (size_t i = 0; i < cfg.skip_count; ++i) {
        if (strcmp(cfg.skip_dates[i], today) == 0) return true;
    }
    return false;
}

// --- initialise fallback configs ---------------------------------------------
static void init_fallback(ChannelCfg &cfg, const uint32_t *sched, size_t n,
                          uint32_t pulse_ms) {
    cfg.enabled  = true;
    cfg.pulse_ms = pulse_ms;
    cfg.schedule_len = (n <= MAX_SCHEDULE) ? n : MAX_SCHEDULE;
    for (size_t i = 0; i < cfg.schedule_len; ++i) {
        cfg.schedule[i] = sched[i];
    }
    cfg.skip_count = 0;
}

// == Build the server base URL from discovered or fallback IP =================
static String server_base_url() {
    if (g_server_seen) {
        return "http://" + g_server_ip.toString() + ":" + String(g_server_port);
    }
    return "http://" + String(FALLBACK_SERVER_IP) + ":" + String(SERVER_PORT);
}

// --- Log to Serial and server (non‑blocking fire‑and‑forget) -----------------
static void esp_log(const char *msg) {
    time_t now = time(nullptr);
    struct tm t;
    if (localtime_r(&now, &t)) {
        Serial.printf("[%02d:%02d:%02d] %s\n", t.tm_hour, t.tm_min, t.tm_sec, msg);
    } else {
        Serial.println(msg);
    }
    if (WiFi.status() == WL_CONNECTED) {
        WiFiClient client;
        HTTPClient http;
        http.setTimeout(2000);
        String url = server_base_url() + "/api/log";
        if (http.begin(client, url)) {
            http.addHeader("Content-Type", "application/json");
            http.POST("{\"msg\":\"" + String(msg) + "\"}");
            http.end();
        }
    }
}

// == HH:MM string → seconds since midnight ====================================
static uint32_t parse_hhmm(const char *s) {
    if (!s || s[2] != ':') return 0xFFFFFFFF;
    const uint32_t h = (static_cast<uint32_t>(s[0] - '0') * 10U)
                     +  static_cast<uint32_t>(s[1] - '0');
    const uint32_t m = (static_cast<uint32_t>(s[3] - '0') * 10U)
                     +  static_cast<uint32_t>(s[4] - '0');
    if (h > 23 || m > 59) return 0xFFFFFFFF;
    return h * 3600U + m * 60U;
}

// == Parse server JSON into a ChannelCfg ======================================
static bool parse_channel_cfg(JsonObject root, ChannelCfg &cfg) {
    cfg.enabled  = root["enabled"]  | true;
    cfg.pulse_ms = root["pulse_ms"] | 2000U;
    if (cfg.pulse_ms < 100) cfg.pulse_ms = 100;

    JsonArray sched = root["schedule"];
    cfg.schedule_len = 0;
    if (sched) {
        for (JsonVariant v : sched) {
            if (cfg.schedule_len >= MAX_SCHEDULE) break;
            const char *t = v.as<const char*>();
            if (!t) continue;
            const uint32_t sm = parse_hhmm(t);
            if (sm == 0xFFFFFFFF) continue;
            size_t pos = cfg.schedule_len;
            while (pos > 0 && cfg.schedule[pos - 1] > sm) {
                cfg.schedule[pos] = cfg.schedule[pos - 1];
                --pos;
            }
            cfg.schedule[pos] = sm;
            ++cfg.schedule_len;
        }
    }

    JsonArray skips = root["skip_dates"];
    cfg.skip_count = 0;
    if (skips) {
        for (JsonVariant v : skips) {
            if (cfg.skip_count >= MAX_SKIP_DATES) break;
            const char *d = v.as<const char*>();
            if (!d || strlen(d) != 10 || d[4] != '-' || d[7] != '-') continue;
            strncpy(cfg.skip_dates[cfg.skip_count], d, 10);
            cfg.skip_dates[cfg.skip_count][10] = '\0';
            ++cfg.skip_count;
        }
    }

    return true;
}

static const char *primary_channel_key(const Channel &ch) {
    if (ch.schedule_key[0] != '\0') return ch.schedule_key;
    return (ch.server_key_count > 0 && ch.server_keys[0]) ? ch.server_keys[0] : "unknown";
}

static JsonObject find_channel_object(JsonObject root, const Channel &ch, const char **matched_key) {
    for (size_t i = 0; i < ch.server_key_count; ++i) {
        const char *key = ch.server_keys[i];
        if (!key) continue;
        JsonVariant v = root[key];
        if (v.is<JsonObject>()) {
            if (matched_key) *matched_key = key;
            return v.as<JsonObject>();
        }
    }
    if (matched_key) *matched_key = nullptr;
    return JsonObject();
}

static bool parse_channel_cfg_from_keys(JsonObject root, Channel &ch) {
    const char *matched_key = nullptr;
    JsonObject obj = find_channel_object(root, ch, &matched_key);
    if (obj.isNull()) return false;
    const bool mapping_changed = strncmp(ch.schedule_key, matched_key, sizeof(ch.schedule_key)) != 0;
    parse_channel_cfg(obj, ch.cfg);
    strncpy(ch.schedule_key, matched_key, sizeof(ch.schedule_key) - 1);
    ch.schedule_key[sizeof(ch.schedule_key) - 1] = '\0';
    if (mapping_changed) {
        DBGF("[JSON] %s mapped to GPIO%u\n", matched_key, ch.pin);
    }
    return true;
}

// == UDP beacon listener — call every loop iteration ==========================
static void check_beacon() {
    const int sz = g_udp.parsePacket();
    if (sz <= 0) return;

    // Read up to 64 bytes  (beacon is ~20 bytes)
    char buf[64] = {0};
    const int n = g_udp.read(buf, sizeof(buf) - 1);
    if (n <= 0) return;
    buf[n] = '\0';

    // Expected format:  RELAY_CTRL:<port>\n
    if (strncmp(buf, "RELAY_CTRL:", 11) != 0) return;

    const int port = atoi(buf + 11);
    if (port < 1 || port > 65535) return;

    const IPAddress ip = g_udp.remoteIP();

    // Only log on first discovery or IP/port change
    if (!g_server_seen || g_server_ip != ip || g_server_port != static_cast<uint16_t>(port)) {
        g_server_ip   = ip;
        g_server_port = static_cast<uint16_t>(port);
        DBGF("[BEACON] Server discovered at %s:%u\n",
             g_server_ip.toString().c_str(), g_server_port);
    }

    g_server_seen    = true;
    g_last_beacon_ms = millis();
}

// == BLE discovery: scan for advertiser, read JSON {ip,port[,token]} ========
static bool attempt_ble_discovery(uint32_t timeout_ms) {
    if (WiFi.status() != WL_CONNECTED) return false; // require WiFi so IP parsing makes sense

    BLEDevice::init("");
    BLEScan* pScan = BLEDevice::getScan();
    pScan->setActiveScan(true);
    const uint32_t seconds = (timeout_ms + 999) / 1000;
    BLEScanResults results = pScan->start(seconds, false);
    const int count = results.getCount();
    for (int i = 0; i < count; ++i) {
        BLEAdvertisedDevice adv = results.getDevice(i);
        if (!adv.haveServiceUUID()) continue;
        if (!adv.isAdvertisingService(BLEUUID(BLE_SERVICE_UUID))) continue;

        // Try to connect and read the characteristic
        BLEAddress addr = adv.getAddress();
        BLEClient* pClient = BLEDevice::createClient();
        if (!pClient) continue;
        bool connected = false;
        if (pClient->connect(addr)) {
            connected = true;
            BLERemoteService* svc = pClient->getService(BLEUUID(BLE_SERVICE_UUID));
            if (svc) {
                BLERemoteCharacteristic* ch = svc->getCharacteristic(BLEUUID(BLE_CHAR_UUID));
                if (ch && ch->canRead()) {
                    std::string val = ch->readValue();
                    if (!val.empty()) {
                        // parse JSON
                        #pragma GCC diagnostic push
                        #pragma GCC diagnostic ignored "-Wdeprecated-declarations"
                        StaticJsonDocument<256> doc;
                        #pragma GCC diagnostic pop
                        DeserializationError err = deserializeJson(doc, val.c_str());
                        if (!err) {
                            const char* ip = doc["ip"] | "";
                            int port = doc["port"] | 0;
                            if (ip && port > 0) {
                                IPAddress ipa;
                                if (ipa.fromString(ip)) {
                                    g_server_ip = ipa;
                                    g_server_port = static_cast<uint16_t>(port);
                                    g_server_seen = true;
                                    g_last_beacon_ms = millis();
                                    DBGF("[BLE] discovered server %s:%u\n",
                                         g_server_ip.toString().c_str(), g_server_port);
                                    pClient->disconnect();
                                    delete pClient;
                                    return true;
                                }
                            }
                        }
                    }
                }
            }
        }
        if (connected) pClient->disconnect();
        delete pClient;
    }
    return false;
}

// == NVS helpers ==============================================================
static void nvs_save_config() {
    Preferences prefs;
    prefs.begin(NVS_NS, false);
    prefs.putString("hash", g_cfg_hash);
    prefs.putString("cfg",  g_raw_config);
    prefs.end();
    g_nvs_has_config = true;
    DBGLN(F("[NVS] config saved"));
}

static bool nvs_load_config() {
    Preferences prefs;
    prefs.begin(NVS_NS, true);
    String hash = prefs.getString("hash", "");
    g_raw_config = prefs.getString("cfg", "");
    prefs.end();
    if (hash.length() == 0 || g_raw_config.length() == 0) return false;
    strncpy(g_cfg_hash, hash.c_str(), 8);
    g_cfg_hash[8] = '\0';
    g_nvs_has_config = true;
    g_config_dirty = false;
    DBGF("[NVS] loaded config  hash=%s  bytes=%u\n", g_cfg_hash,
         static_cast<unsigned>(g_raw_config.length()));
    return true;
}

// == Quick hash poll — returns true if changed ================================
static bool fetch_hash() {
    if (WiFi.status() != WL_CONNECTED) return false;
    WiFiClient client;
    HTTPClient http;
    http.setTimeout(3000);
    const String url = server_base_url() + "/api/schedule/hash";
    if (!http.begin(client, url)) return false;
    const int code = http.GET();
    if (code != 200) { http.end(); return false; }
    #pragma GCC diagnostic push
    #pragma GCC diagnostic ignored "-Wdeprecated-declarations"
    StaticJsonDocument<64> doc;
    #pragma GCC diagnostic pop
    const DeserializationError err = deserializeJson(doc, http.getStream());
    http.end();
    if (err) return false;
    const char *h = doc["h"] | "";
    if (strlen(h) != 8) return false;
    const bool changed = (strcmp(h, g_cfg_hash) != 0);
    if (changed || !g_nvs_has_config) g_config_dirty = true;
    strncpy(g_cfg_hash, h, 8);
    g_cfg_hash[8] = '\0';
    return changed;
}
// == Fetch schedule from server ===============================================
static bool fetch_schedule() {
    if (WiFi.status() != WL_CONNECTED) return false;

    WiFiClient client;
    HTTPClient http;
    http.setTimeout(POLL_TIMEOUT_MS);

    const String url = server_base_url() + "/api/schedule";
    if (!http.begin(client, url)) {
        DBGLN(F("[HTTP] begin failed"));
        return false;
    }
    const int code = http.GET();
    if (code != 200) {
        DBGF("[HTTP] GET %s → %d\n", url.c_str(), code);
        http.end();
        return false;
    }

    // Read entire body before parsing (needed for NVS persistence)
    g_raw_config = http.getString();
    http.end();

    // Parse JSON from the captured string
    #pragma GCC diagnostic push
    #pragma GCC diagnostic ignored "-Wdeprecated-declarations"
    StaticJsonDocument<2048> doc;
    #pragma GCC diagnostic pop
    const DeserializationError err = deserializeJson(doc, g_raw_config);

    if (err) {
        DBGF("[JSON] parse error: %s\n", err.c_str());
        return false;
    }

    JsonObject root = doc.as<JsonObject>();
    const bool ch1_loaded = parse_channel_cfg_from_keys(root, g_ch1);
    const bool ch2_loaded = parse_channel_cfg_from_keys(root, g_ch2);
    if (!ch1_loaded && !ch2_loaded) {
        DBGLN(F("[JSON] no configured relay channel keys found"));
        return false;
    }

    // Persist to NVS only when config actually changed
    if (g_config_dirty && strlen(g_cfg_hash) == 8) {
        nvs_save_config();
        g_config_dirty = false;
    }
    return true;
}

// == Send heartbeat to server =================================================
static void send_heartbeat(const char *ch) {
    if (WiFi.status() != WL_CONNECTED) return;

    WiFiClient client;
    HTTPClient http;
    http.setTimeout(4000);

    const String url = server_base_url() + "/api/heartbeat?ch=" + ch;
    if (http.begin(client, url)) {
        http.POST("");
        http.end();
    }
}

static void send_heartbeats(Channel &ch) {
    for (size_t i = 0; i < ch.server_key_count; ++i) {
        send_heartbeat(ch.server_keys[i]);
    }
}

static void report_execution(const char *ch_key, uint32_t pulse_ms, const char *trigger) {
    if (WiFi.status() != WL_CONNECTED) return;

    WiFiClient client;
    HTTPClient http;
    http.setTimeout(3000);

    const String url = server_base_url() + "/api/execution";
    if (http.begin(client, url)) {
        http.addHeader("Content-Type", "application/json");
        const String body = "{\"ch\":\"" + String(ch_key) + "\",\"pulse_ms\":" + String(pulse_ms)
                          + ",\"trigger\":\"" + String(trigger) + "\"}";
        http.POST(body);
        http.end();
    }
}

static void trigger_channel_now(Channel &ch, uint32_t pulse_ms, const char *ch_key, const char *trigger) {
    if (pulse_ms < 100) pulse_ms = 100;
    relay_write(ch.pin, true);
    ch.phase = Phase::ACTIVE;
    ch.pulse_start = millis();
    ch.active_pulse_ms = pulse_ms;

    const String msg = String(ch_key) + " ON (" + String(pulse_ms) + "ms, " + trigger + ")";
    esp_log(msg.c_str());
    report_execution(ch_key, pulse_ms, trigger);
}

static bool fetch_command_for_key(Channel &ch, const char *ch_key) {
    if (WiFi.status() != WL_CONNECTED || !ch_key) return false;

    WiFiClient client;
    HTTPClient http;
    http.setTimeout(3000);

    const String url = server_base_url() + "/api/commands?ch=" + String(ch_key);
    if (!http.begin(client, url)) return false;
    const int code = http.GET();
    if (code != 200) {
        http.end();
        return false;
    }

    #pragma GCC diagnostic push
    #pragma GCC diagnostic ignored "-Wdeprecated-declarations"
    StaticJsonDocument<128> doc;
    #pragma GCC diagnostic pop
    const DeserializationError err = deserializeJson(doc, http.getStream());
    http.end();
    if (err || !(doc["pending"] | false)) return false;

    const uint32_t pulse_ms = doc["pulse_ms"] | ch.cfg.pulse_ms;
    trigger_channel_now(ch, pulse_ms, ch_key, "manual");
    return true;
}

static void fetch_commands(Channel &ch) {
    for (size_t i = 0; i < ch.server_key_count; ++i) {
        if (fetch_command_for_key(ch, ch.server_keys[i])) return;
    }
}

// == Recompute the next scheduled fire time ===================================
static void recompute_next_fire(Channel &ch, const time_t after_epoch) {
    struct tm t;
    if (!localtime_r(&after_epoch, &t)) {
        ch.next_fire = 0;
        return;
    }
    const uint32_t now_sm = static_cast<uint32_t>(t.tm_hour) * 3600U
                          + static_cast<uint32_t>(t.tm_min)  * 60U
                          + static_cast<uint32_t>(t.tm_sec);

    const uint32_t *sched = ch.cfg.schedule;
    const size_t    n     = ch.cfg.schedule_len;
    if (n == 0 || !ch.cfg.enabled) {
        ch.next_fire = 0;
        return;
    }

    size_t i = 0;
    while (i < n && sched[i] <= now_sm) { ++i; }

    const time_t midnight = midnight_of(after_epoch);
    if (midnight == 0) { ch.next_fire = 0; return; }

    if (i < n) {
        ch.next_fire  = midnight + static_cast<time_t>(sched[i]);
    } else {
        ch.next_fire  = midnight + 86400 + static_cast<time_t>(sched[0]);
    }
}

// == Initialise one channel on cold boot ======================================
static void channel_init(Channel &ch) {
    relay_write(ch.pin, false);
    ch.phase       = Phase::IDLE;
    ch.pulse_start = 0;
    ch.active_pulse_ms = 0;
    ch.next_fire   = 0;
}

// == Tick one channel; returns true when relay toggles ========================
static bool tick_channel(Channel &ch, const time_t now) {
    if (!time_is_valid() || ch.next_fire == 0) return false;

    if (!ch.cfg.enabled || is_skip_day(ch.cfg)) {
        if (ch.phase == Phase::ACTIVE) {
            relay_write(ch.pin, false);
            ch.phase = Phase::IDLE;
            ch.active_pulse_ms = 0;
        }
        if (ch.next_fire <= now) {
            const time_t midnight = midnight_of(now);
            recompute_next_fire(ch, midnight ? midnight + 86400 : now + 86400);
        }
        return false;
    }

    if (ch.phase == Phase::IDLE) {
        if (now >= ch.next_fire) {
            trigger_channel_now(ch, ch.cfg.pulse_ms, primary_channel_key(ch), "schedule");
            return true;
        }
    } else {
        const uint32_t pulse_ms = ch.active_pulse_ms ? ch.active_pulse_ms : ch.cfg.pulse_ms;
        if (elapsed_since(ch.pulse_start) >= pulse_ms) {
            relay_write(ch.pin, false);
            ch.phase = Phase::IDLE;
            ch.active_pulse_ms = 0;
            esp_log((String(primary_channel_key(ch)) + " OFF").c_str());
            recompute_next_fire(ch, now + 1);
        }
    }
    return false;
}

// ============================================================================
// 10.  ARDUINO LIFECYCLE
// ============================================================================

static uint32_t g_wifi_last_attempt      = 0;
static time_t   g_last_known_time        = 0;
static uint32_t g_time_stall_since       = 0;
static uint32_t g_last_schedule_refresh  = 0;
static uint32_t g_last_poll              = 0;
static uint32_t g_last_command_poll      = 0;
static uint32_t g_last_heartbeat         = 0;
static uint32_t g_last_rtc_sync          = 0;

void setup() {
    // --- GPIO: relays OFF immediately (fail‑safe) ---
    pinMode(CH1_RELAY_PIN, OUTPUT);
    pinMode(CH2_RELAY_PIN, OUTPUT);
    channel_init(g_ch1);
    channel_init(g_ch2);

    // --- Fallback configs ---
    init_fallback(g_fallback_ch1, FALLBACK_CH1_SCHEDULE, FALLBACK_CH1_SLOTS,
                  FALLBACK_CH1_PULSE_MS);
    init_fallback(g_fallback_ch2, FALLBACK_CH2_SCHEDULE, FALLBACK_CH2_SLOTS,
                  FALLBACK_CH2_PULSE_MS);
    g_ch1.cfg = g_fallback_ch1;
    g_ch2.cfg = g_fallback_ch2;

    // --- Try NVS first (survives power cycles without server) ---
    if (nvs_load_config()) {
        #pragma GCC diagnostic push
        #pragma GCC diagnostic ignored "-Wdeprecated-declarations"
        StaticJsonDocument<2048> doc;
        #pragma GCC diagnostic pop
        const DeserializationError err = deserializeJson(doc, g_raw_config);
        if (!err) {
            JsonObject root = doc.as<JsonObject>();
            const bool ch1_loaded = parse_channel_cfg_from_keys(root, g_ch1);
            const bool ch2_loaded = parse_channel_cfg_from_keys(root, g_ch2);
            if (ch1_loaded || ch2_loaded) {
                Serial.println(F("NVS: booted from stored config"));
            }
        }
    }

    // --- Serial (always on) ---
    Serial.begin(115200);
    delay(100);
    Serial.println(F("\n=== RELAY CONTROLLER BOOT ==="));

    // --- Wi‑Fi Provisioning ---
    // The provisioning system replaces the original hardcoded WiFi connection.
    // It first checks for NVS‑saved credentials, then tries to connect.
    // If no credentials exist (or connection fails for 30s), it starts
    // the Setup Mode AP + web server so the user can configure WiFi.
    checkBootButtonReset();
    if (!connectSavedWiFi()) {
        startSetupMode();  // never returns — saves creds & restarts
    }
    Serial.print(F("WiFi: IP = "));
    Serial.println(WiFi.localIP());

    // --- UDP beacon listener ---
    g_udp.begin(BEACON_PORT);
    // Seed with fallback IP so server_base_url() works before first beacon
    g_server_ip.fromString(FALLBACK_SERVER_IP);
    Serial.printf("Beacon: listening on UDP/%u  (fallback %s:%u)\n",
                  BEACON_PORT, FALLBACK_SERVER_IP, SERVER_PORT);

    // --- Attempt BLE discovery once at boot (if WiFi available) ---
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println(F("BLE: attempting discovery at boot"));
        if (attempt_ble_discovery(BLE_SCAN_MS)) {
            Serial.println(F("BLE: server discovered via BLE"));
        } else {
            Serial.println(F("BLE: no advertiser found at boot"));
        }
    }

    // --- RTC (optional) — auto-detected, no wiring = no behavior change ---
    if (RTC_SDA_PIN >= 0 && RTC_SCL_PIN >= 0) {
        Wire.begin(RTC_SDA_PIN, RTC_SCL_PIN);
    } else {
        Wire.begin();
    }
    g_rtc_present = rtc_detect();
    if (g_rtc_present) {
        Serial.println(F("RTC: module detected — seeding system clock from it"));
        if (!rtc_seed_system_clock()) {
            Serial.println(F("RTC: detected but read failed (uninitialised?) — waiting for NTP instead"));
        }
    } else {
        Serial.println(F("RTC: none detected — using NTP-only time (original behavior)"));
    }

    // --- NTP with timezone offset ---
    sntp_set_sync_mode(SNTP_SYNC_MODE_IMMED);
    sntp_set_sync_interval(SNTP_SYNC_INTERVAL_MS);
    configTime(GMT_OFFSET_SEC, DAYLIGHT_SEC, NTP_SERVER1, NTP_SERVER2, NTP_SERVER3);

    // Seed timers
    g_wifi_last_attempt     = millis();
    g_last_schedule_refresh = millis();
    g_last_poll             = millis();
    g_last_command_poll     = millis();
    g_last_heartbeat        = millis();
    g_last_rtc_sync         = millis();

    Serial.println(F("Setup done — waiting for NTP sync…"));
}

void loop() {
    const time_t   now      = time(nullptr);
    const uint32_t now_ms   = millis();

    // ── 10a.  BOOT button watchdog (always-on WiFi factory reset) ──────
    checkBootButtonReset();

    // ── 10b.  UDP beacon listener ──────────────────────────────────────
    check_beacon();

    // ── 10b.  Beacon timeout — revert to fallback IP ───────────────────
    if (g_server_seen && elapsed_since(g_last_beacon_ms) >= BEACON_TIMEOUT_MS) {
        DBGLN(F("[BEACON] lost — reverting to fallback IP"));
        g_server_seen = false;
        g_server_ip.fromString(FALLBACK_SERVER_IP);
        g_server_port = SERVER_PORT;
    }

    // ── 10b2.  BLE retry (if no beacon seen yet) ───────────────────────
    static uint32_t s_last_ble_attempt = 0;
    if (!g_server_seen && elapsed_since(s_last_ble_attempt) >= BLE_RETRY_MS) {
        DBGLN(F("[BLE] retrying discovery"));
        attempt_ble_discovery(BLE_SCAN_MS);
        s_last_ble_attempt = now_ms;
    }

    // ── 10c.  Time‑stall detection ─────────────────────────────────────
    if (time_is_valid()) {
        if (now == g_last_known_time) {
            if (g_time_stall_since == 0) {
                g_time_stall_since = now_ms;
            } else if (elapsed_since(g_time_stall_since) >= TIME_STALL_THRESHOLD_S * 1000U) {
                DBGLN(F("CRITICAL: system clock stalled!"));
                sntp_restart();
                g_time_stall_since = now_ms;
            }
        } else {
            g_last_known_time  = now;
            g_time_stall_since = 0;
        }
    }

    // ── 10c2.  RTC (optional) ───────────────────────────────────────────
    // If a module is present but we still don't have a valid time (e.g. the
    // boot-time read failed, or NTP hasn't caught up yet), keep retrying
    // every few seconds — this is the path that keeps the controller
    // running its schedule even while the server/WiFi/internet is down.
    static uint32_t s_last_rtc_retry = 0;
    if (g_rtc_present && !time_is_valid()
        && elapsed_since(s_last_rtc_retry) >= 5000U) {
        rtc_seed_system_clock();
        s_last_rtc_retry = now_ms;
    }
    // Once NTP has actually synced, periodically push the corrected time
    // back to the RTC so it doesn't drift while waiting for the next
    // server/network outage.
    if (g_rtc_present && sntp_sync_done()
        && elapsed_since(g_last_rtc_sync) >= RTC_RESYNC_MS) {
        rtc_sync_from_system();
        g_last_rtc_sync = now_ms;
    }

    // ── 10c3.  NTP first-sync correction ────────────────────────────────
    // If schedules were already seeded from the RTC before NTP caught up,
    // force one recompute + RTC resync as soon as NTP actually completes,
    // so any RTC drift/error doesn't linger until the next hourly refresh.
    static bool s_ntp_confirmed = false;
    if (!s_ntp_confirmed && sntp_sync_done()) {
        s_ntp_confirmed = true;
        recompute_next_fire(g_ch1, now);
        recompute_next_fire(g_ch2, now);
        g_last_schedule_refresh = now_ms;
        if (g_rtc_present) {
            rtc_sync_from_system();
            g_last_rtc_sync = now_ms;
        }
        DBGLN(F("[NTP] first sync confirmed — schedules recomputed from accurate time"));
    }

    // ── 10d.  WiFi watchdog ────────────────────────────────────────────
    if (WiFi.status() != WL_CONNECTED) {
        if (elapsed_since(g_wifi_last_attempt) >= WIFI_RETRY_MS) {
            Serial.println(F("WiFi: down — reconnecting…"));
            WiFi.reconnect();
            g_wifi_last_attempt = now_ms;
        }
    } else {
        g_wifi_last_attempt = now_ms;
    }

    // ── 10e.  Seed / repair schedules whenever we have a valid time ────
    // Note: deliberately NOT gated on sntp_sync_done() — a valid time can
    // also come from the RTC while the server/NTP is unreachable, and the
    // schedule should still run in that case.
    static bool s_schedules_seeded = false;
    if (time_is_valid()) {
        if (!s_schedules_seeded) {
            recompute_next_fire(g_ch1, now);
            recompute_next_fire(g_ch2, now);
            s_schedules_seeded = true;
            Serial.printf("Time ready (%s)  CH1 next=%llu  CH2 next=%llu\n",
                          sntp_sync_done() ? "NTP" : (g_rtc_present ? "RTC" : "unknown"),
                          static_cast<unsigned long long>(g_ch1.next_fire),
                          static_cast<unsigned long long>(g_ch2.next_fire));
        }
        // Safety net: if next_fire is 0 (recompute failed earlier), retry
        if (g_ch1.next_fire == 0 && g_ch1.cfg.schedule_len > 0) {
            recompute_next_fire(g_ch1, now);
        }
        if (g_ch2.next_fire == 0 && g_ch2.cfg.schedule_len > 0) {
            recompute_next_fire(g_ch2, now);
        }
    }

    // ── 10f.  Fast hash poll — detects changes within 5 s ──────────────
    static uint32_t g_last_hash_poll = 0;
    if (WiFi.status() == WL_CONNECTED
        && elapsed_since(g_last_hash_poll) >= HASH_POLL_MS) {
        if (fetch_hash()) {
            Serial.println(F("Hash: changed → fetching full schedule"));
            if (fetch_schedule()) {
                if (!g_server_config_loaded) {
                    Serial.println(F("Poll: first server config"));
                    g_server_config_loaded = true;
                }
                recompute_next_fire(g_ch1, now);
                recompute_next_fire(g_ch2, now);
                g_last_schedule_refresh = now_ms;
                g_last_poll = now_ms;
                s_schedules_seeded = true;
            }
        }
        g_last_hash_poll = now_ms;
    }

    // ── 10g.  Full schedule fetch — safety net every FULL_POLL_MS ──────
    if (WiFi.status() == WL_CONNECTED
        && elapsed_since(g_last_poll) >= FULL_POLL_MS) {
        if (fetch_schedule()) {
            if (!g_server_config_loaded) {
                Serial.println(F("Poll: first server config"));
                g_server_config_loaded = true;
            }
            recompute_next_fire(g_ch1, now);
            recompute_next_fire(g_ch2, now);
            g_last_schedule_refresh = now_ms;
        } else {
            Serial.println(F("Full poll: failed"));
        }
        g_last_poll = now_ms;
    }

    // -- 10g2. Manual command poll ("Run Now" / Bell) ------------------------
    if (WiFi.status() == WL_CONNECTED
        && elapsed_since(g_last_command_poll) >= COMMAND_POLL_MS) {
        fetch_commands(g_ch1);
        fetch_commands(g_ch2);
        g_last_command_poll = now_ms;
    }

    // ── 10g.  Send heartbeat ───────────────────────────────────────────
    if (WiFi.status() == WL_CONNECTED
        && elapsed_since(g_last_heartbeat) >= 5000U) {
        send_heartbeats(g_ch1);
        send_heartbeats(g_ch2);
        g_last_heartbeat = now_ms;
    }

    // ── 10h.  Periodic schedule refresh (DST / drift) ──────────────────
    if (s_schedules_seeded
        && elapsed_since(g_last_schedule_refresh) >= SCHEDULE_REFRESH_MS) {
        recompute_next_fire(g_ch1, now);
        recompute_next_fire(g_ch2, now);
        g_last_schedule_refresh = now_ms;
    }

    // ── 10i.  Tick both channels ───────────────────────────────────────
    tick_channel(g_ch1, now);
    tick_channel(g_ch2, now);

    // ── 10j.  Yield to scheduler / feed WDT (uncomment if needed) ─────
    // vTaskDelay(1);
    // esp_task_wdt_reset();
}
