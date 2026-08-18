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
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include <RTClib.h>
#include <Wire.h>
#include <sys/time.h>
#include <esp_sntp.h>
#include "led_indicator.h"
#include "bell_logger.h"
#include "time_fmt.h"
// ============================================================================
//  SERIAL DEBUG MACROS
// ============================================================================
// #define DEBUG_SERIAL   // uncomment to enable verbose serial output

#ifdef DEBUG_SERIAL
  #define DBG(...)    bell_serial.print(__VA_ARGS__)
  #define DBGLN(...)  bell_serial.println(__VA_ARGS__)
  #define DBGF(...)   bell_serial.printf(__VA_ARGS__)
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

// ============================================================================
//  CROSS-TASK SYNCHRONIZATION
// ============================================================================
static SemaphoreHandle_t g_mutex = nullptr;
static bool s_schedule_dirty = false;  // set by apply_schedule, cleared by bell_core_tick
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

// Cached per second — called from is_skip_day (twice per tick)
static bool today_str(char buf[11]) {
    static char   s_cached[11] = {0};
    static time_t s_cached_at  = 0;
    const time_t now = time(nullptr);
    if (now == s_cached_at && s_cached[0]) {
        memcpy(buf, s_cached, 11);

        return true;
    }
    s_cached_at = now;
    struct tm t;
    if (!localtime_r(&now, &t)) return false;
    snprintf(s_cached, 11, "%04d-%02d-%02d", t.tm_year + 1900, t.tm_mon + 1, t.tm_mday);
    memcpy(buf, s_cached, 11);
    return true;
}
// ============================================================================
//  MUTEX IMPLEMENTATION
// ============================================================================

void bell_core_lock() {
    if (g_mutex) xSemaphoreTake(g_mutex, portMAX_DELAY);
}

void bell_core_unlock() {
    if (g_mutex) xSemaphoreGive(g_mutex);
}

// Forward declaration — used by trigger_channel_now / tick_channel (above its definition)
static void log_to_buffer_locked(const char *msg);

// ============================================================================
//  RTC DRIVER  (DS1307 / DS3231 / DS3232 compatible)
// ============================================================================
//  RTC DRIVER  (DS3231 via RTClib)
// ============================================================================
static RTC_DS3231 g_rtc;

static bool rtc_i2c_probe(uint8_t address) {
    Wire.beginTransmission(address);
    return Wire.endTransmission() == 0;
}

static void rtc_print_i2c_diagnostics() {
    pinMode(RTC_SDA_PIN, INPUT_PULLUP);
    pinMode(RTC_SCL_PIN, INPUT_PULLUP);
    delay(2);
    const int sdaLevel = digitalRead(RTC_SDA_PIN);
    const int sclLevel = digitalRead(RTC_SCL_PIN);
    const bool rtcAck = rtc_i2c_probe(RTC_I2C_ADDRESS);
    bell_serial.printf("RTC: I2C SDA=%d SCL=%d address 0x%02X %s\n",
                  sdaLevel, sclLevel, RTC_I2C_ADDRESS, rtcAck ? "ACK" : "NACK");
    if (!rtcAck) {
        bell_serial.println(F("RTC: check 3.3V/GND and that SDA/SCL reach GPIO21/GPIO22"));
    }
}

static bool rtc_seed_system_clock() {
    if (!g_rtc_present) return false;
    DateTime now = g_rtc.now();
    if (!now.isValid()) return false;

    struct tm t = {};
    t.tm_sec  = now.second();
    t.tm_min  = now.minute();
    t.tm_hour = now.hour();
    t.tm_mday = now.day();
    t.tm_mon  = now.month() - 1;
    t.tm_year = now.year() - 1900;

    const time_t epoch = tm_to_epoch(t);
    if (epoch <= 0) return false;

    struct timeval tv = { epoch, 0 };
    settimeofday(&tv, nullptr);

    static bool s_first_seed = true;
    if (s_first_seed) {
        struct tm ft = {};
        ft.tm_year = now.year() - 1900;
        ft.tm_mon  = now.month() - 1;
        ft.tm_mday = now.day();
        ft.tm_hour = now.hour();
        ft.tm_min  = now.minute();
        ft.tm_sec  = now.second();
        char ts[24];
        time_fmt_datetime(ts, sizeof(ts), &ft);
        bell_serial.printf("RTC: clock seeded — %s\n", ts);
        s_first_seed = false;
    }
    return true;
}

static void rtc_sync_from_system() {
    if (!g_rtc_present) return;
    const time_t now = time(nullptr);
    struct tm t;
    if (!localtime_r(&now, &t)) return;

    g_rtc.adjust(DateTime(t.tm_year + 1900, t.tm_mon + 1, t.tm_mday,
                          t.tm_hour, t.tm_min, t.tm_sec));

    // Read-back verify
    DateTime verify = g_rtc.now();
    static bool s_first_sync = true;
    if (s_first_sync) {
        struct tm ft = {};
        ft.tm_year = verify.year() - 1900;
        ft.tm_mon  = verify.month() - 1;
        ft.tm_mday = verify.day();
        ft.tm_hour = verify.hour();
        ft.tm_min  = verify.minute();
        ft.tm_sec  = verify.second();
        char ts[24];
        time_fmt_datetime(ts, sizeof(ts), &ft);
        bell_serial.printf("RTC: synced & verified — %s\n", ts);
        s_first_sync = false;
    }
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
        cfg.schedule_pulse_ms[i] = pulse_ms;
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

static bool nvs_load_config() {
    Preferences prefs;
    if (!prefs.begin(NVS_NS, true)) {
        bell_serial.println(F("NVS: failed to open stored config"));
        return false;
    }
    String hash = prefs.getString("hash", "");
    g_raw_config = prefs.getString("cfg", "");
    prefs.end();
    if (hash.length() != 8 || g_raw_config.length() == 0) return false;
    for (size_t i = 0; i < 8; ++i) {
        if (!isxdigit(static_cast<unsigned char>(hash[i]))) return false;
    }
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

static void recompute_next_fire(Channel &ch, const time_t after_epoch,
                                bool allow_apply_grace = false) {
    struct tm t;
    if (!localtime_r(&after_epoch, &t)) {
        ch.next_fire = 0;
        ch.next_fire_idx = 0;
        return;
    }
    const uint32_t now_sm = static_cast<uint32_t>(t.tm_hour) * 3600U
                          + static_cast<uint32_t>(t.tm_min)  * 60U
                          + static_cast<uint32_t>(t.tm_sec);

    const uint32_t *sched = ch.cfg.schedule;
    const size_t    n     = ch.cfg.schedule_len;
    if (n == 0 || !ch.cfg.enabled) {
        ch.next_fire = 0;
        ch.next_fire_idx = 0;
        return;
    }

    const time_t midnight = midnight_of(after_epoch);
    if (midnight == 0) { ch.next_fire = 0; ch.next_fire_idx = 0; return; }

    size_t i = 0;
    while (i < n && sched[i] <= now_sm) { ++i; }

    // Schedules are minute-precision. A network or NTP update at 08:55:01
    // must not silently skip the 08:55 bell, but an already-fired slot must
    // never be armed again.
    if (allow_apply_grace && i > 0 && now_sm - sched[i - 1] <= SCHEDULE_APPLY_GRACE_S
        && !(ch.last_fire_day == midnight && ch.last_fire_idx == i - 1)) {
        ch.next_fire = midnight + static_cast<time_t>(sched[i - 1]);
        ch.next_fire_idx = i - 1;
        return;
    }

    if (i < n) {
        ch.next_fire     = midnight + static_cast<time_t>(sched[i]);
        ch.next_fire_idx = i;
    } else {
        ch.next_fire     = midnight + 86400 + static_cast<time_t>(sched[0]);
        ch.next_fire_idx = 0;
    }
}

static void channel_init(Channel &ch) {
    relay_write(ch.pin, false);
    ch.phase       = Phase::IDLE;
    ch.pulse_start = 0;
    ch.active_pulse_ms = 0;
    ch.next_fire   = 0;
    ch.last_fire_day = 0;
    ch.last_fire_idx = static_cast<size_t>(-1);
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
    led_pulse_bell(pulse_ms);
    ch.active_pulse_ms = pulse_ms;

    // Log locally (caller holds g_mutex; use internal helper)
    {
        char logmsg[128];
        snprintf(logmsg, sizeof(logmsg), "%s ON (%lums, %s)", ch_key,
                 static_cast<unsigned long>(pulse_ms), trigger);
        // bell_serial output
        time_t n = time(nullptr);
        struct tm t;
        if (localtime_r(&n, &t))
            bell_serial.printf("[%02d:%02d:%02d] %s\n", t.tm_hour, t.tm_min, t.tm_sec, logmsg);
        else
            bell_serial.println(logmsg);
        log_to_buffer_locked(logmsg);
    }

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
    // ── Always process active pulse expiry — manual triggers
    //     bypass schedule; relay MUST turn off after pulse_ms ──
    if (ch.phase == Phase::ACTIVE) {
        const uint32_t pulse_ms = ch.active_pulse_ms ? ch.active_pulse_ms
                                   : ch.cfg.schedule_pulse_ms[ch.next_fire_idx];
        if (elapsed_since(ch.pulse_start) >= pulse_ms) {
            relay_write(ch.pin, false);
            ch.phase       = Phase::IDLE;
            ch.active_pulse_ms = 0;
            // Log locally (caller holds g_mutex; use internal helper)
            {
                char logmsg[64];
                snprintf(logmsg, sizeof(logmsg), "%s OFF", primary_channel_key(ch));
                time_t n = time(nullptr);
                struct tm t;
                if (localtime_r(&n, &t))
                    bell_serial.printf("[%02d:%02d:%02d] %s\n", t.tm_hour, t.tm_min, t.tm_sec, logmsg);
                else
                    bell_serial.println(logmsg);
                log_to_buffer_locked(logmsg);
            }
            if (time_is_valid() && ch.next_fire > 0) {
                recompute_next_fire(ch, now + 1);
            }
        }
        return true;
    }

    // ── Schedule-driven activation requires valid time & next_fire ──
    if (!time_is_valid() || ch.next_fire == 0) return false;

    if (!ch.cfg.enabled || is_skip_day(ch.cfg)) {
        if (ch.next_fire <= now) {
            const time_t midnight = midnight_of(now);
            recompute_next_fire(ch, midnight ? midnight + 86400 : now + 86400);
        }
        return false;
    }

    if (now >= ch.next_fire) {
        ch.last_fire_day = midnight_of(now);
        ch.last_fire_idx = ch.next_fire_idx;
        trigger_channel_now(ch, ch.cfg.schedule_pulse_ms[ch.next_fire_idx],
                            primary_channel_key(ch), "schedule");
        return true;
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
            const char *t = nullptr;
            uint32_t    sm = 0xFFFFFFFF;
            uint32_t    entry_pulse = cfg.pulse_ms;  // default to channel pulse

            if (v.is<const char*>()) {
                // Plain "HH:MM" string — use channel pulse_ms
                t = v.as<const char*>();
            } else if (v.is<JsonObject>()) {
                // Object {"time":"HH:MM", "pulse_ms": N}
                JsonObject obj = v.as<JsonObject>();
                t = obj["time"];
                uint32_t p = obj["pulse_ms"] | 0;
                if (p >= 100) entry_pulse = p;
            }
            if (!t) continue;
            sm = parse_hhmm(t);
            if (sm == 0xFFFFFFFF) continue;

            // Insertion sort into schedule array
            size_t pos = cfg.schedule_len;
            while (pos > 0 && cfg.schedule[pos - 1] > sm) {
                cfg.schedule[pos] = cfg.schedule[pos - 1];
                cfg.schedule_pulse_ms[pos] = cfg.schedule_pulse_ms[pos - 1];
                --pos;
            }
            cfg.schedule[pos] = sm;
            cfg.schedule_pulse_ms[pos] = entry_pulse;
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
    const String raw_config(raw_json);
    char hash_copy[9];
    strncpy(hash_copy, hash_8chars, 8);
    hash_copy[8] = '\0';

    // Parse into a temporary document — never touch live configs until validated
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
    JsonDocument doc;
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

    if (!ch1_ok || !ch2_ok) {
        DBGLN(F("[CORE] apply_schedule: both ch1 and ch2 are required"));
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

    // ATOMIC SWAP under mutex — all validation passed, now apply
    bell_core_lock();
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
    strncpy(g_cfg_hash, hash_copy, 8);
    g_cfg_hash[8] = '\0';
    g_raw_config = raw_config;

    // Defer next_fire recompute to bell_core_tick — avoids cross-task race
    s_schedule_dirty = true;
    bell_core_unlock();

    // Flash I/O can block. Keep it outside the scheduler mutex so a due
    // bell is never delayed by an NVS write from the network task.
    bool persisted = false;
    Preferences prefs;
    if (prefs.begin(NVS_NS, false)) {
        // Invalidate the commit marker before replacing the body. A power
        // loss then selects the known fallback rather than a mixed schedule.
        prefs.remove("hash");
        persisted = prefs.putString("cfg", raw_config) > 0
                 && prefs.putString("hash", hash_copy) > 0;
        prefs.end();
    }
    g_nvs_has_config = persisted;
    if (!persisted) bell_serial.println(F("NVS: failed to persist schedule update"));

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

    // --- 3. bell_serial ---
    bell_serial.begin(115200);
    delay(100);
    bell_serial.println(F("\n=== BELL CORE BOOT ==="));

    // --- 4. Load NVS schedule (if available) ---
    if (nvs_load_config()) {
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
        JsonDocument doc;
#pragma GCC diagnostic pop
        const DeserializationError err = deserializeJson(doc, g_raw_config);
        if (!err && doc.is<JsonObject>()) {
            JsonObject root = doc.as<JsonObject>();
            Channel stored_ch1{ g_ch1.pin, g_ch1.server_keys, g_ch1.server_key_count };
            Channel stored_ch2{ g_ch2.pin, g_ch2.server_keys, g_ch2.server_key_count };
            stored_ch1.cfg = g_ch1.cfg;
            stored_ch2.cfg = g_ch2.cfg;
            const bool ch1_loaded = parse_channel_cfg_from_keys(root, stored_ch1);
            const bool ch2_loaded = parse_channel_cfg_from_keys(root, stored_ch2);
            if (ch1_loaded && ch2_loaded) {
                g_ch1.cfg = stored_ch1.cfg;
                g_ch2.cfg = stored_ch2.cfg;
                strncpy(g_ch1.schedule_key, stored_ch1.schedule_key, MAX_CH_KEY - 1);
                g_ch1.schedule_key[MAX_CH_KEY - 1] = '\0';
                strncpy(g_ch2.schedule_key, stored_ch2.schedule_key, MAX_CH_KEY - 1);
                g_ch2.schedule_key[MAX_CH_KEY - 1] = '\0';
                bell_serial.println(F("NVS: booted from stored config"));
            } else {
                g_nvs_has_config = false;
                bell_serial.println(F("NVS: incomplete stored config ignored; using fallback"));
            }
        } else {
            g_nvs_has_config = false;
            bell_serial.println(F("NVS: invalid stored config ignored; using fallback"));
        }
    }

    // --- 5. RTC detection ---
    Wire.begin(RTC_SDA_PIN, RTC_SCL_PIN);
    Wire.setTimeOut(50);
    Wire.setClock(100000);
    rtc_print_i2c_diagnostics();
    if (rtc_i2c_probe(RTC_I2C_ADDRESS) && g_rtc.begin()) {
        g_rtc_present = true;
        bell_serial.println(F("RTC: module detected"));
        if (g_rtc.lostPower()) {
            bell_serial.println(F("RTC: lost power — setting to compile time"));
            g_rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
        }
        rtc_seed_system_clock();
    } else {
        bell_serial.println(F("RTC: DS3231 not detected"));
    }
    g_last_rtc_sync = millis();

    bell_serial.println(F("Bell Core ready."));

    // --- 6. Cross-task mutex ---
    g_mutex = xSemaphoreCreateMutex();
    if (!g_mutex) bell_serial.println(F("FATAL: mutex creation failed"));
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
                bell_serial.println(F("CRITICAL: system clock stalled — restarting SNTP"));
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

    // ── Shared-state section: everything below touches cfg or ring buffers ──
    bell_core_lock();

    // ── Deferred schedule recompute (from network task) ─────────
    if (s_schedule_dirty) {
        const time_t now2 = time(nullptr);
        if (time_is_valid()) {
            recompute_next_fire(g_ch1, now2, true);
            recompute_next_fire(g_ch2, now2, true);
            s_schedules_seeded = true;
            g_last_schedule_refresh = now_ms;
        }
        s_schedule_dirty = false;
    }

    // ── NTP first-sync correction ───────────────────────────────
    if (!s_ntp_confirmed && sntp_sync_done()) {
        s_ntp_confirmed = true;
        recompute_next_fire(g_ch1, now, true);
        recompute_next_fire(g_ch2, now, true);
        g_last_schedule_refresh = now_ms;
        if (g_rtc_present) {
            rtc_sync_from_system();
            g_last_rtc_sync = now_ms;
        }
        bell_serial.println(F("NTP: first sync confirmed"));
    }

    // ── Initial schedule seeding ────────────────────────────────
    if (time_is_valid()) {
        if (!s_schedules_seeded) {
            recompute_next_fire(g_ch1, now, true);
            recompute_next_fire(g_ch2, now, true);
            s_schedules_seeded = true;
        }
        // Safety net: if next_fire is 0, retry
        if (g_ch1.next_fire == 0 && g_ch1.cfg.schedule_len > 0)
            recompute_next_fire(g_ch1, now, true);
        if (g_ch2.next_fire == 0 && g_ch2.cfg.schedule_len > 0)
            recompute_next_fire(g_ch2, now, true);
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

    bell_core_unlock();
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
    bell_core_lock();
    uint8_t next = (g_cmd_write + 1) % 4;
    if (next == g_cmd_read) { bell_core_unlock(); return; }  // buffer full — drop command
    PendingCommand &cmd = g_pending_cmds[g_cmd_write];
    strncpy(cmd.ch_key, ch_key, MAX_CH_KEY - 1);
    cmd.ch_key[MAX_CH_KEY - 1] = '\0';
    cmd.pulse_ms = pulse_ms;
    cmd.pending = true;
    g_cmd_write = next;
    bell_core_unlock();
}

void bell_core_discard_commands() {
    bell_core_lock();
    g_cmd_read  = g_cmd_write;
    bell_core_unlock();
}

// ============================================================================
//  PUBLIC API — Status
// ============================================================================

const char *bell_core_channel_key(uint8_t ch_index) {
    if (ch_index == 0) return primary_channel_key(g_ch1);
    if (ch_index == 1) return primary_channel_key(g_ch2);
    return nullptr;
}

void bell_core_copy_schedule_hash(char *out, size_t out_size) {
    if (!out || out_size == 0) return;
    bell_core_lock();
    strncpy(out, g_cfg_hash, out_size - 1);
    out[out_size - 1] = '\0';
    bell_core_unlock();
}

bool bell_core_pop_execution_report(char *ch_key_out, size_t ch_key_max,
                                     uint32_t *pulse_ms_out, const char **trigger_out) {
    bell_core_lock();
    if (g_report_read == g_report_write) { bell_core_unlock(); return false; }
    ExecReport &r = g_exec_reports[g_report_read];
    if (!r.pending) { bell_core_unlock(); return false; }
    strncpy(ch_key_out, r.ch_key, ch_key_max - 1);
    ch_key_out[ch_key_max - 1] = '\0';
    *pulse_ms_out = r.pulse_ms;
    *trigger_out = r.trigger;
    r.pending = false;
    g_report_read = (g_report_read + 1) % 8;
    bell_core_unlock();
    return true;
}

// ============================================================================
//  PUBLIC API — Logging
// ============================================================================

// Internal: push a log message to the ring buffer. Caller MUST hold g_mutex.
static void log_to_buffer_locked(const char *msg) {
    uint8_t next = (g_log_write + 1) % LOG_BUF_SIZE;
    if (next != g_log_read) {  // not full
        strncpy(g_log_buf[g_log_write], msg, 127);
        g_log_buf[g_log_write][127] = '\0';
        g_log_write = next;
    }
}

void bell_core_log(const char *msg) {
    // bell_serial output (always) — no lock needed
    time_t now = time(nullptr);
    struct tm t;
    if (localtime_r(&now, &t)) {
        bell_serial.printf("[%02d:%02d:%02d] %s\n", t.tm_hour, t.tm_min, t.tm_sec, msg);
    } else {
        bell_serial.println(msg);
    }

    // Ring buffer for network module — protect with mutex
    bell_core_lock();
    log_to_buffer_locked(msg);
    bell_core_unlock();
}

bool bell_core_pop_log(char *msg_out, size_t msg_max) {
    bell_core_lock();
    if (g_log_read == g_log_write) { bell_core_unlock(); return false; }
    strncpy(msg_out, g_log_buf[g_log_read], msg_max - 1);
    msg_out[msg_max - 1] = '\0';
    g_log_read = (g_log_read + 1) % LOG_BUF_SIZE;
    bell_core_unlock();
    return true;
}

bool bell_core_is_scheduler_ready() {
    return time_is_valid() && s_schedules_seeded;
}

int32_t bell_core_next_fire_s() {
    if (!time_is_valid()) return INT32_MAX;
    time_t now = time(nullptr);
    int32_t best = INT32_MAX;
    bell_core_lock();
    if (g_ch1.next_fire > 0 && g_ch1.cfg.enabled) {
        time_t raw = g_ch1.next_fire - now;
        if (raw >= 0 && raw <= INT32_MAX) {
            int32_t d = (int32_t)raw;
            if (d < best) best = d;
        }
    }
    if (g_ch2.next_fire > 0 && g_ch2.cfg.enabled) {
        time_t raw = g_ch2.next_fire - now;
        if (raw >= 0 && raw <= INT32_MAX) {
            int32_t d = (int32_t)raw;
            if (d < best) best = d;
        }
    }
    bell_core_unlock();
    return best;
}
