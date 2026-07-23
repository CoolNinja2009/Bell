/*
 * bell_core.cpp  —  Bell Management Core implementation
 * ─────────────────────────────────────────────────────────────────
 * See bell_core.h for the public API and design rationale.
 *
 * Internal architecture:
 *   - Relay I/O is the only hardware dependency (digitalWrite on GPIO pins).
 *   - Time comes from the ESP32 system clock (set via NTP or RTC externally).
 *   - Schedules are stored in NVS (Preferences) and loaded at init.
 *   - The schedule state machine runs entirely from tick_channel().
 *   - This file has ZERO WiFi, HTTP, or JSON dependencies.
 */
#include "bell_core.h"
#include <Wire.h>
#include <sys/time.h>
#include <esp_sntp.h>
// ============================================================================
//  SERIAL DEBUG MACROS
// ============================================================================
// #define DEBUG_SERIAL   // uncomment to enable verbose serial output

#ifdef DEBUG_SERIAL
  #define DBG(...)    Serial.print(__VA_ARGS__)
  #define DBGLN(...)  Serial.println(__VA_ARGS__)
  #define DBGF(...)   Serial.printf(__VA_ARGS__)
#else
  #define DBG(...)    ((void)0)
  #define DBGLN(...)  ((void)0)
  #define DBGF(...)   ((void)0)
#endif

// ============================================================================
//  CHANNEL KEY MAPPINGS  (which JSON keys map to which GPIO pin)
// ============================================================================
static const char *CH1_SERVER_KEYS[] = { "ch1", "bell" };
static const char *CH2_SERVER_KEYS[] = { "ch2" };

// ============================================================================
//  GLOBAL STATE
// ============================================================================
static ChannelCfg g_fallback_ch1;
static ChannelCfg g_fallback_ch2;
static Channel    g_ch1{ CH1_RELAY_PIN, CH1_SERVER_KEYS, sizeof(CH1_SERVER_KEYS) / sizeof(CH1_SERVER_KEYS[0]) };
static Channel    g_ch2{ CH2_RELAY_PIN, CH2_SERVER_KEYS, sizeof(CH2_SERVER_KEYS) / sizeof(CH2_SERVER_KEYS[0]) };

// NVS
static const char NVS_NS[] = "relay";
static char       g_cfg_hash[9] = {0};
static String     g_raw_config;
static bool       g_nvs_has_config = false;

// RTC
static bool       g_rtc_present = false;

// Timing state
static time_t     g_last_known_time       = 0;
static uint32_t   g_time_stall_since      = 0;
static uint32_t   g_last_schedule_refresh = 0;
static uint32_t   g_last_rtc_sync         = 0;
static bool       s_schedules_seeded      = false;
static bool       s_ntp_confirmed         = false;

// ============================================================================
//  PENDING COMMANDS  (ring buffer — network writes, bell core reads)
// ============================================================================
struct PendingCommand {
    char     ch_key[MAX_CH_KEY];
    uint32_t pulse_ms;
    bool     pending;
};
static PendingCommand g_pending_cmds[4];  // small ring buffer
static uint8_t g_cmd_write = 0;
static uint8_t g_cmd_read  = 0;

// ============================================================================
//  PENDING EXECUTION REPORTS  (bell core writes, network reads)
// ============================================================================
struct ExecReport {
    char     ch_key[MAX_CH_KEY];
    uint32_t pulse_ms;
    char     trigger[16];
    bool     pending;
};
static ExecReport g_exec_reports[8];
static uint8_t g_report_write = 0;
static uint8_t g_report_read  = 0;

// ============================================================================
//  LOG BUFFER  (bell core writes, network drains)
// ============================================================================
static constexpr size_t LOG_BUF_SIZE = 32;
static char g_log_buf[LOG_BUF_SIZE][128];
static uint8_t g_log_write = 0;
static uint8_t g_log_read  = 0;

// ============================================================================
//  INTERNAL HELPERS
// ============================================================================

static inline uint32_t elapsed_since(uint32_t t0) {
    return millis() - t0;
}

static inline void relay_write(uint8_t pin, bool on) {
    digitalWrite(pin, on == RELAY_ACTIVE_HIGH ? HIGH : LOW);
}

static bool time_is_valid() {
    return time(nullptr) > 1000000000UL;
}

static bool sntp_sync_done() {
    return sntp_get_sync_status() == SNTP_SYNC_STATUS_COMPLETED;
}

static time_t tm_to_epoch(struct tm &t) {
    t.tm_isdst = -1;  // let system determine DST
    const time_t e = mktime(&t);
    return (e < 0) ? 0 : static_cast<time_t>(e);
}

static time_t midnight_of(time_t epoch) {
    struct tm t;
    if (!localtime_r(&epoch, &t)) return 0;
    t.tm_hour = 0; t.tm_min = 0; t.tm_sec = 0;
    return tm_to_epoch(t);
}

static bool today_str(char buf[11]) {
    const time_t now = time(nullptr);
    struct tm t;
    if (!localtime_r(&now, &t)) return false;
    snprintf(buf, 11, "%04d-%02d-%02d", t.tm_year + 1900, t.tm_mon + 1, t.tm_mday);
    return true;
}

// ============================================================================
//  RTC DRIVER  (DS1307 / DS3231 / DS3232 compatible)
// ============================================================================

static uint8_t bcd2dec(uint8_t v) { return static_cast<uint8_t>((v / 16) * 10 + (v % 16)); }
static uint8_t dec2bcd(uint8_t v) { return static_cast<uint8_t>((v / 10) * 16 + (v % 10)); }

static bool rtc_detect() {
    Wire.beginTransmission(RTC_I2C_ADDR);
    return Wire.endTransmission() == 0;
}

static bool rtc_read_time(struct tm &out) {
    Wire.beginTransmission(RTC_I2C_ADDR);
    Wire.write(static_cast<uint8_t>(0x00));
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom(static_cast<int>(RTC_I2C_ADDR), 7) != 7) return false;

    const uint8_t sec   = Wire.read();
    const uint8_t min_  = Wire.read();
    const uint8_t hour  = Wire.read();
    Wire.read();  // day-of-week — unused
    const uint8_t mday  = Wire.read();
    const uint8_t month = Wire.read();
    const uint8_t year  = Wire.read();

    out = {};
    out.tm_sec  = bcd2dec(sec  & 0x7F);
    out.tm_min  = bcd2dec(min_ & 0x7F);
    out.tm_hour = bcd2dec(hour & 0x3F);
    out.tm_mday = bcd2dec(mday & 0x3F);
    out.tm_mon  = bcd2dec(month & 0x1F) - 1;
    out.tm_year = bcd2dec(year) + 100;
    out.tm_isdst = 0;

    if (out.tm_mon < 0 || out.tm_mon > 11 || out.tm_mday < 1 || out.tm_mday > 31
        || out.tm_hour > 23 || out.tm_min > 59 || out.tm_sec > 59) {
        return false;
    }
    return true;
}

static void rtc_write_time(const struct tm &t) {
    Wire.beginTransmission(RTC_I2C_ADDR);
    Wire.write(static_cast<uint8_t>(0x00));
    Wire.write(dec2bcd(static_cast<uint8_t>(t.tm_sec)));
    Wire.write(dec2bcd(static_cast<uint8_t>(t.tm_min)));
    Wire.write(dec2bcd(static_cast<uint8_t>(t.tm_hour)));
    Wire.write(dec2bcd(static_cast<uint8_t>(t.tm_wday + 1)));
    Wire.write(dec2bcd(static_cast<uint8_t>(t.tm_mday)));
    Wire.write(dec2bcd(static_cast<uint8_t>(t.tm_mon + 1)));
    Wire.write(dec2bcd(static_cast<uint8_t>(t.tm_year - 100)));
    Wire.endTransmission();
}

static bool rtc_seed_system_clock() {
    struct tm t;
    if (!rtc_read_time(t)) return false;
    const time_t epoch = tm_to_epoch(t);
    if (epoch <= 0) return false;
    struct timeval tv = { epoch, 0 };
    settimeofday(&tv, nullptr);
    DBGF("[RTC] system clock set: %04d-%02d-%02d %02d:%02d:%02d\n",
         t.tm_year + 1900, t.tm_mon + 1, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec);
    return true;
}

static void rtc_sync_from_system() {
    const time_t now = time(nullptr);
    struct tm t;
    if (!localtime_r(&now, &t)) return;
    rtc_write_time(t);
    DBGLN(F("[RTC] resynced from system clock"));
}

// ============================================================================
//  SCHEDULE HELPERS
// ============================================================================

static uint32_t parse_hhmm(const char *s) {
    if (!s || s[2] != ':' || s[5] != '\0') return 0xFFFFFFFF;
    if (!isdigit(s[0]) || !isdigit(s[1]) || !isdigit(s[3]) || !isdigit(s[4]))
        return 0xFFFFFFFF;
    const uint32_t h = (static_cast<uint32_t>(s[0] - '0') * 10U)
                     +  static_cast<uint32_t>(s[1] - '0');
    const uint32_t m = (static_cast<uint32_t>(s[3] - '0') * 10U)
                     +  static_cast<uint32_t>(s[4] - '0');
    if (h > 23 || m > 59) return 0xFFFFFFFF;
    return h * 3600U + m * 60U;
}

static bool is_skip_day(const ChannelCfg &cfg) {
    char today[11];
    if (!today_str(today)) return false;
    for (size_t i = 0; i < cfg.skip_count; ++i) {
        if (strcmp(cfg.skip_dates[i], today) == 0) return true;
    }
    return false;
}

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

static const char *primary_channel_key(const Channel &ch) {
    if (ch.schedule_key[0] != '\0') return ch.schedule_key;
    return (ch.server_key_count > 0 && ch.server_keys[0]) ? ch.server_keys[0] : "unknown";
}

// ============================================================================
//  NVS HELPERS  (schedule persistence — no JSON dependency)
// ============================================================================

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
    DBGF("[NVS] loaded config  hash=%s  bytes=%u\n", g_cfg_hash,
         static_cast<unsigned>(g_raw_config.length()));
    return true;
}

// ============================================================================
//  BELL STATE MACHINE
// ============================================================================

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

static void channel_init(Channel &ch) {
    relay_write(ch.pin, false);
    ch.phase       = Phase::IDLE;
    ch.pulse_start = 0;
    ch.active_pulse_ms = 0;
    ch.next_fire   = 0;
}

static void trigger_channel_now(Channel &ch, uint32_t pulse_ms,
                                 const char *ch_key, const char *trigger) {
    if (pulse_ms < 100) pulse_ms = 100;
    // If already active, end the current pulse cleanly before starting a new one
    if (ch.phase == Phase::ACTIVE) {
        relay_write(ch.pin, false);
        ch.phase = Phase::IDLE;
        ch.active_pulse_ms = 0;
    }
    relay_write(ch.pin, true);
    ch.phase = Phase::ACTIVE;
    ch.pulse_start = millis();
    ch.active_pulse_ms = pulse_ms;

    // Log locally
    char logmsg[128];
    snprintf(logmsg, sizeof(logmsg), "%s ON (%lums, %s)", ch_key,
             static_cast<unsigned long>(pulse_ms), trigger);
    bell_core_log(logmsg);

    // Queue execution report for network module
    uint8_t next = (g_report_write + 1) % 8;
    if (next != g_report_read) {  // not full
        ExecReport &r = g_exec_reports[g_report_write];
        strncpy(r.ch_key, ch_key, MAX_CH_KEY - 1);
        r.ch_key[MAX_CH_KEY - 1] = '\0';
        r.pulse_ms = pulse_ms;
        strncpy(r.trigger, trigger, 15);
        r.trigger[15] = '\0';
        r.pending = true;
        g_report_write = next;
    }
}

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
            char logmsg[64];
            snprintf(logmsg, sizeof(logmsg), "%s OFF", primary_channel_key(ch));
            bell_core_log(logmsg);
            recompute_next_fire(ch, now + 1);
        }
    }
    return false;
}

// ============================================================================
//  INTERNAL: parse channel config from JSON object
//  (JSON parsing is the ONLY place where ArduinoJson is used in this file)
// ============================================================================
#include <ArduinoJson.h>

static JsonObject find_channel_object(JsonObject root, const Channel &ch,
                                       const char **matched_key) {
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
            // Insertion sort into schedule array
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
            // Validate it's a real date
            int y, m, day;
            if (sscanf(d, "%d-%d-%d", &y, &m, &day) != 3) continue;
            if (m < 1 || m > 12 || day < 1 || day > 31) continue;
            strncpy(cfg.skip_dates[cfg.skip_count], d, 10);
            cfg.skip_dates[cfg.skip_count][10] = '\0';
            ++cfg.skip_count;
        }
    }

    return true;
}

static bool parse_channel_cfg_from_keys(JsonObject root, Channel &ch) {
    const char *matched_key = nullptr;
    JsonObject obj = find_channel_object(root, ch, &matched_key);
    if (obj.isNull()) return false;
    parse_channel_cfg(obj, ch.cfg);
    strncpy(ch.schedule_key, matched_key, MAX_CH_KEY - 1);
    ch.schedule_key[MAX_CH_KEY - 1] = '\0';
    return true;
}

// ============================================================================
//  INTERNAL: atomic schedule swap
// ============================================================================

static bool apply_raw_schedule(const char *raw_json, const char *hash_8chars) {
    if (!raw_json || !hash_8chars || strlen(hash_8chars) != 8) return false;

    // Parse into a temporary document — never touch live configs until validated
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
    StaticJsonDocument<2048> doc;
#pragma GCC diagnostic pop
    const DeserializationError err = deserializeJson(doc, raw_json);
    if (err) {
        DBGF("[CORE] apply_schedule: JSON parse error: %s\n", err.c_str());
        return false;
    }

    JsonObject root = doc.as<JsonObject>();

    // Parse into temporary configs
    ChannelCfg tmp_cfg1, tmp_cfg2;
    Channel tmp_ch1{ g_ch1.pin, g_ch1.server_keys, g_ch1.server_key_count };
    Channel tmp_ch2{ g_ch2.pin, g_ch2.server_keys, g_ch2.server_key_count };
    tmp_ch1.cfg = g_ch1.cfg;
    tmp_ch2.cfg = g_ch2.cfg;

    const bool ch1_ok = parse_channel_cfg_from_keys(root, tmp_ch1);
    const bool ch2_ok = parse_channel_cfg_from_keys(root, tmp_ch2);

    if (!ch1_ok && !ch2_ok) {
        DBGLN(F("[CORE] apply_schedule: no matching channel keys found"));
        return false;
    }

    // Validate schedule entries
    if (ch1_ok && tmp_ch1.cfg.schedule_len > 0) {
        for (size_t i = 0; i < tmp_ch1.cfg.schedule_len; ++i) {
            if (tmp_ch1.cfg.schedule[i] >= 86400) {
                DBGLN(F("[CORE] apply_schedule: invalid time in ch1 schedule"));
                return false;
            }
        }
    }
    if (ch2_ok && tmp_ch2.cfg.schedule_len > 0) {
        for (size_t i = 0; i < tmp_ch2.cfg.schedule_len; ++i) {
            if (tmp_ch2.cfg.schedule[i] >= 86400) {
                DBGLN(F("[CORE] apply_schedule: invalid time in ch2 schedule"));
                return false;
            }
        }
    }

    // ATOMIC SWAP — all validation passed, now apply
    g_ch1.cfg = tmp_ch1.cfg;
    g_ch2.cfg = tmp_ch2.cfg;
    if (ch1_ok) {
        strncpy(g_ch1.schedule_key, tmp_ch1.schedule_key, MAX_CH_KEY - 1);
        g_ch1.schedule_key[MAX_CH_KEY - 1] = '\0';
    }
    if (ch2_ok) {
        strncpy(g_ch2.schedule_key, tmp_ch2.schedule_key, MAX_CH_KEY - 1);
        g_ch2.schedule_key[MAX_CH_KEY - 1] = '\0';
    }

    // Update hash and persist
    strncpy(g_cfg_hash, hash_8chars, 8);
    g_cfg_hash[8] = '\0';
    g_raw_config = raw_json;

    // Persist to NVS
    {
        Preferences prefs;
        prefs.begin(NVS_NS, false);
        prefs.putString("hash", g_cfg_hash);
        prefs.putString("cfg",  g_raw_config);
        prefs.end();
        g_nvs_has_config = true;
    }

    // Recompute next fire times
    const time_t now = time(nullptr);
    if (time_is_valid()) {
        recompute_next_fire(g_ch1, now);
        recompute_next_fire(g_ch2, now);
        s_schedules_seeded = true;
        g_last_schedule_refresh = millis();
    }

    DBGF("[CORE] schedule applied — hash=%s  ch1_ok=%d  ch2_ok=%d\n",
         g_cfg_hash, ch1_ok, ch2_ok);
    return true;
}

// ============================================================================
//  PUBLIC API
// ============================================================================

void bell_core_init() {
    // --- 1. GPIO: relays OFF immediately (fail-safe) ---
    pinMode(CH1_RELAY_PIN, OUTPUT);
    pinMode(CH2_RELAY_PIN, OUTPUT);
    channel_init(g_ch1);
    channel_init(g_ch2);

    // --- 2. Fallback configs ---
    init_fallback(g_fallback_ch1, FALLBACK_CH1_SCHEDULE, FALLBACK_CH1_SLOTS, FALLBACK_CH1_PULSE_MS);
    init_fallback(g_fallback_ch2, FALLBACK_CH2_SCHEDULE, FALLBACK_CH2_SLOTS, FALLBACK_CH2_PULSE_MS);
    g_ch1.cfg = g_fallback_ch1;
    g_ch2.cfg = g_fallback_ch2;

    // --- 3. Serial ---
    Serial.begin(115200);
    delay(100);
    Serial.println(F("\n=== BELL CORE BOOT ==="));

    // --- 4. Load NVS schedule (if available) ---
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

    // --- 5. RTC detection ---
    if (RTC_SDA_PIN >= 0 && RTC_SCL_PIN >= 0) {
        Wire.begin(RTC_SDA_PIN, RTC_SCL_PIN);
    } else {
        Wire.begin();
    }
    g_rtc_present = rtc_detect();
    if (g_rtc_present) {
        Serial.println(F("RTC: module detected"));
        rtc_seed_system_clock();
    } else {
        Serial.println(F("RTC: none detected"));
    }

    // --- 6. Seed timers ---
    g_last_schedule_refresh = millis();
    g_last_rtc_sync = millis();

    Serial.println(F("Bell Core ready."));
}

void bell_core_tick() {
    const time_t   now    = time(nullptr);
    const uint32_t now_ms = millis();

    // ── Time-stall detection ────────────────────────────────────
    if (time_is_valid()) {
        if (now == g_last_known_time) {
            if (g_time_stall_since == 0) {
                g_time_stall_since = now_ms;
            } else if (elapsed_since(g_time_stall_since) >= TIME_STALL_THRESHOLD_S * 1000U) {
                Serial.println(F("CRITICAL: system clock stalled — restarting SNTP"));
                sntp_restart();
                g_time_stall_since = now_ms;
            }
        } else {
            g_last_known_time  = now;
            g_time_stall_since = 0;
        }
    }

    // ── RTC retry / resync ──────────────────────────────────────
    static uint32_t s_last_rtc_retry = 0;
    if (g_rtc_present && !time_is_valid()
        && elapsed_since(s_last_rtc_retry) >= 5000U) {
        rtc_seed_system_clock();
        s_last_rtc_retry = now_ms;
    }
    if (g_rtc_present && sntp_sync_done()
        && elapsed_since(g_last_rtc_sync) >= RTC_RESYNC_MS) {
        rtc_sync_from_system();
        g_last_rtc_sync = now_ms;
    }

    // ── NTP first-sync correction ───────────────────────────────
    if (!s_ntp_confirmed && sntp_sync_done()) {
        s_ntp_confirmed = true;
        recompute_next_fire(g_ch1, now);
        recompute_next_fire(g_ch2, now);
        g_last_schedule_refresh = now_ms;
        if (g_rtc_present) {
            rtc_sync_from_system();
            g_last_rtc_sync = now_ms;
        }
        Serial.println(F("NTP: first sync confirmed"));
    }

    // ── Initial schedule seeding ────────────────────────────────
    if (time_is_valid()) {
        if (!s_schedules_seeded) {
            recompute_next_fire(g_ch1, now);
            recompute_next_fire(g_ch2, now);
            s_schedules_seeded = true;
        }
        // Safety net: if next_fire is 0, retry
        if (g_ch1.next_fire == 0 && g_ch1.cfg.schedule_len > 0)
            recompute_next_fire(g_ch1, now);
        if (g_ch2.next_fire == 0 && g_ch2.cfg.schedule_len > 0)
            recompute_next_fire(g_ch2, now);
    }

    // ── Process pending commands ────────────────────────────────
    while (g_cmd_read != g_cmd_write) {
        PendingCommand &cmd = g_pending_cmds[g_cmd_read];
        if (cmd.pending) {
            // Find the right channel
            Channel *target = nullptr;
            for (size_t i = 0; i < g_ch1.server_key_count; ++i) {
                if (g_ch1.server_keys[i] && strcmp(g_ch1.server_keys[i], cmd.ch_key) == 0) {
                    target = &g_ch1; break;
                }
            }
            if (!target) {
                for (size_t i = 0; i < g_ch2.server_key_count; ++i) {
                    if (g_ch2.server_keys[i] && strcmp(g_ch2.server_keys[i], cmd.ch_key) == 0) {
                        target = &g_ch2; break;
                    }
                }
            }
            if (target) {
                trigger_channel_now(*target, cmd.pulse_ms, cmd.ch_key, "manual");
            }
            cmd.pending = false;
        }
        g_cmd_read = (g_cmd_read + 1) % 4;
    }

    // ── Hourly schedule recompute ───────────────────────────────
    if (s_schedules_seeded
        && elapsed_since(g_last_schedule_refresh) >= SCHEDULE_REFRESH_MS) {
        recompute_next_fire(g_ch1, now);
        recompute_next_fire(g_ch2, now);
        g_last_schedule_refresh = now_ms;
    }

    // ── Tick both channels ──────────────────────────────────────
    tick_channel(g_ch1, now);
    tick_channel(g_ch2, now);
}

// ============================================================================
//  PUBLIC API — Schedule Update
// ============================================================================

bool bell_core_apply_schedule(const char *raw_json, const char *hash_8chars) {
    return apply_raw_schedule(raw_json, hash_8chars);
}

// ============================================================================
//  PUBLIC API — Commands
// ============================================================================

void bell_core_queue_command(const char *ch_key, uint32_t pulse_ms) {
    if (!ch_key || pulse_ms < 100) return;
    uint8_t next = (g_cmd_write + 1) % 4;
    if (next == g_cmd_read) return;  // buffer full — drop command
    PendingCommand &cmd = g_pending_cmds[g_cmd_write];
    strncpy(cmd.ch_key, ch_key, MAX_CH_KEY - 1);
    cmd.ch_key[MAX_CH_KEY - 1] = '\0';
    cmd.pulse_ms = pulse_ms;
    cmd.pending = true;
    g_cmd_write = next;
}

// ============================================================================
//  PUBLIC API — Status
// ============================================================================

const char *bell_core_channel_key(uint8_t ch_index) {
    if (ch_index == 0) return primary_channel_key(g_ch1);
    if (ch_index == 1) return primary_channel_key(g_ch2);
    return nullptr;
}

const char *bell_core_schedule_hash() {
    return g_cfg_hash;
}

bool bell_core_pop_execution_report(char *ch_key_out, size_t ch_key_max,
                                     uint32_t *pulse_ms_out, const char **trigger_out) {
    if (g_report_read == g_report_write) return false;
    ExecReport &r = g_exec_reports[g_report_read];
    if (!r.pending) return false;
    strncpy(ch_key_out, r.ch_key, ch_key_max - 1);
    ch_key_out[ch_key_max - 1] = '\0';
    *pulse_ms_out = r.pulse_ms;
    *trigger_out = r.trigger;
    r.pending = false;
    g_report_read = (g_report_read + 1) % 8;
    return true;
}

// ============================================================================
//  PUBLIC API — Logging
// ============================================================================

void bell_core_log(const char *msg) {
    // Serial output (always)
    time_t now = time(nullptr);
    struct tm t;
    if (localtime_r(&now, &t)) {
        Serial.printf("[%02d:%02d:%02d] %s\n", t.tm_hour, t.tm_min, t.tm_sec, msg);
    } else {
        Serial.println(msg);
    }

    // Ring buffer for network module
    uint8_t next = (g_log_write + 1) % LOG_BUF_SIZE;
    if (next != g_log_read) {  // not full
        strncpy(g_log_buf[g_log_write], msg, 127);
        g_log_buf[g_log_write][127] = '\0';
        g_log_write = next;
    }
}

bool bell_core_pop_log(char *msg_out, size_t msg_max) {
    if (g_log_read == g_log_write) return false;
    strncpy(msg_out, g_log_buf[g_log_read], msg_max - 1);
    msg_out[msg_max - 1] = '\0';
    g_log_read = (g_log_read + 1) % LOG_BUF_SIZE;
    return true;
}
