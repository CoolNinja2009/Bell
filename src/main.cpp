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

// ============================================================================
// 0.  SERIAL OUTPUT  (always on for production visibility)
// ============================================================================
#define DEBUG_SERIAL

// ============================================================================
// 1.  PIN MAP
// ============================================================================
constexpr uint8_t  CH1_RELAY_PIN     = 26;
constexpr uint8_t  CH2_RELAY_PIN     = 27;
constexpr bool     RELAY_ACTIVE_HIGH = true;   // true  → HIGH = relay closed
                                                // false → LOW  = relay closed

// ============================================================================
// 2.  WIFI
// ============================================================================
constexpr char     WIFI_SSID[]       = "chitkala";
constexpr char     WIFI_PASS[]       = "Ksabh279";
constexpr uint32_t WIFI_RETRY_MS     = 30000;
constexpr uint32_t WIFI_CONNECT_MS   = 15000;

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

// ============================================================================
// 4.  TIMEZONE & NTP
// ============================================================================
constexpr char TZ_STRING[] = "UTC0";
//   "EST5EDT,M3.2.0/2,M11.1.0/2"    US Eastern
//   "CET-1CEST,M3.5.0/2,M10.5.0/3"   Central Europe
//   "PST8PDT,M3.2.0/2,M11.1.0/2"    US Pacific
//   "IST-5:30"                        India  (no DST)

constexpr char     NTP_SERVER1[]     = "pool.ntp.org";
constexpr char     NTP_SERVER2[]     = "time.nist.gov";
constexpr char     NTP_SERVER3[]     = "time.google.com";
constexpr uint32_t SNTP_SYNC_INTERVAL_MS = 900000;  // 15 min

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
    ChannelCfg    cfg;
    Phase         phase       = Phase::IDLE;
    time_t        pulse_start = 0;
    time_t        next_fire   = 0;

    explicit Channel(uint8_t p) : pin(p) {}
};

static ChannelCfg g_fallback_ch1;
static ChannelCfg g_fallback_ch2;
static Channel    g_ch1{ CH1_RELAY_PIN };
static Channel    g_ch2{ CH2_RELAY_PIN };
static bool       g_server_config_loaded = false;

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

// == NVS helpers ==============================================================
static void nvs_save_config() {
    Preferences prefs;
    prefs.begin(NVS_NS, false);
    prefs.putString("hash", g_cfg_hash);
    prefs.putString("cfg",  g_raw_config);
    prefs.end();
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
    if (h[0] == '\0') return false;
    const bool changed = (strcmp(h, g_cfg_hash) != 0);
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
    if (root["ch1"].isNull() || root["ch2"].isNull()) {
        DBGLN(F("[JSON] missing ch1/ch2 keys"));
        return false;
    }

    parse_channel_cfg(root["ch1"], g_ch1.cfg);
    parse_channel_cfg(root["ch2"], g_ch2.cfg);

    DBGF("[JSON] ch1=%u slots %u skips  ch2=%u slots %u skips\n",
         static_cast<unsigned>(g_ch1.cfg.schedule_len),
         static_cast<unsigned>(g_ch1.cfg.skip_count),
         static_cast<unsigned>(g_ch2.cfg.schedule_len),
         static_cast<unsigned>(g_ch2.cfg.skip_count));

    // Persist to NVS so ESP32 survives server outages
    nvs_save_config();

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
    ch.next_fire   = 0;
}

// == Tick one channel; returns true when relay toggles ========================
static bool tick_channel(Channel &ch, const time_t now) {
    if (!time_is_valid() || ch.next_fire == 0) return false;

    if (!ch.cfg.enabled || is_skip_day(ch.cfg)) {
        if (ch.phase == Phase::ACTIVE) {
            relay_write(ch.pin, false);
            ch.phase = Phase::IDLE;
        }
        return false;
    }

    if (ch.phase == Phase::IDLE) {
        if (now >= ch.next_fire) {
            relay_write(ch.pin, true);
            ch.phase       = Phase::ACTIVE;
            ch.pulse_start = now;
            DBGF("CH%u  ON\n", ch.pin);
            return true;
        }
    } else {
        const uint32_t elapsed_s = static_cast<uint32_t>(now - ch.pulse_start);
        if (elapsed_s * 1000U >= ch.cfg.pulse_ms) {
            relay_write(ch.pin, false);
            ch.phase = Phase::IDLE;
            DBGF("CH%u  OFF\n", ch.pin);
            recompute_next_fire(ch, ch.pulse_start + 1);
            return true;
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
static uint32_t g_last_heartbeat         = 0;

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
            if (!root["ch1"].isNull() && !root["ch2"].isNull()) {
                parse_channel_cfg(root["ch1"], g_ch1.cfg);
                parse_channel_cfg(root["ch2"], g_ch2.cfg);
                Serial.println(F("NVS: booted from stored config"));
            }
        }
    }

    // --- Serial (always on) ---
    Serial.begin(115200);
    delay(100);
    Serial.println(F("\n=== RELAY CONTROLLER BOOT ==="));

    // --- WiFi ---
    WiFi.setAutoReconnect(true);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASS);

    Serial.printf("WiFi: connecting to %s", WIFI_SSID);
    const uint32_t wifi_start = millis();
    while (WiFi.status() != WL_CONNECTED
           && elapsed_since(wifi_start) < WIFI_CONNECT_MS) {
        delay(250);
        Serial.print(".");
    }
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println(F(" connected"));
        Serial.print(F("WiFi: IP = "));
        Serial.println(WiFi.localIP());
    } else {
        Serial.println(F(" TIMEOUT — will retry"));
    }

    // --- UDP beacon listener ---
    g_udp.begin(BEACON_PORT);
    // Seed with fallback IP so server_base_url() works before first beacon
    g_server_ip.fromString(FALLBACK_SERVER_IP);
    Serial.printf("Beacon: listening on UDP/%u  (fallback %s:%u)\n",
                  BEACON_PORT, FALLBACK_SERVER_IP, SERVER_PORT);

    // --- Timezone ---
    setenv("TZ", TZ_STRING, 1);
    tzset();

    // --- NTP ---
    sntp_set_sync_mode(SNTP_SYNC_MODE_IMMED);
    sntp_set_sync_interval(SNTP_SYNC_INTERVAL_MS);
    configTime(0, 0, NTP_SERVER1, NTP_SERVER2, NTP_SERVER3);

    // Seed timers
    g_wifi_last_attempt     = millis();
    g_last_schedule_refresh = millis();
    g_last_poll             = millis();
    g_last_heartbeat        = millis();

    Serial.println(F("Setup done — waiting for NTP sync…"));
}

void loop() {
    const time_t   now      = time(nullptr);
    const uint32_t now_ms   = millis();

    // ── 10a.  UDP beacon listener ──────────────────────────────────────
    check_beacon();

    // ── 10b.  Beacon timeout — revert to fallback IP ───────────────────
    if (g_server_seen && elapsed_since(g_last_beacon_ms) >= BEACON_TIMEOUT_MS) {
        DBGLN(F("[BEACON] lost — reverting to fallback IP"));
        g_server_seen = false;
        g_server_ip.fromString(FALLBACK_SERVER_IP);
        g_server_port = SERVER_PORT;
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

    // ── 10e.  Seed schedules on first valid NTP time ───────────────────
    static bool s_schedules_seeded = false;
    if (!s_schedules_seeded && time_is_valid() && sntp_sync_done()) {
        recompute_next_fire(g_ch1, now);
        recompute_next_fire(g_ch2, now);
        s_schedules_seeded = true;
        Serial.printf("NTP: synced  CH1 next=%lu  CH2 next=%lu\n",
                      static_cast<unsigned long>(g_ch1.next_fire),
                      static_cast<unsigned long>(g_ch2.next_fire));
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
                g_last_poll = now_ms;  // reset full poll timer too
            }
        }
        g_last_hash_poll = now_ms;
    }

    // ── 10g.  Full schedule fetch — safety net every FULL_POLL_MS ──────
    if (WiFi.status() == WL_CONNECTED
        && elapsed_since(g_last_poll) >= FULL_POLL_MS) {
        Serial.printf("Full poll: %s\n", server_base_url().c_str());
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

    // ── 10g.  Send heartbeat ───────────────────────────────────────────
    if (WiFi.status() == WL_CONNECTED
        && elapsed_since(g_last_heartbeat) >= 5000U) {
        send_heartbeat("ch1");
        send_heartbeat("ch2");
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
