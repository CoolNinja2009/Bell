/*
 * watchdog.cpp  —  Independent Relay Watchdog implementation
 * ─────────────────────────────────────────────────────────────────
 * COMPLETELY INDEPENDENT of bell_core and network_sync.
 * If bell_core crashes, stalls, or misses pulses — the watchdog
 * forces the correct relay state based on NVS schedule + wall clock.
 *
 * Safety guards:
 *   1. Maximum pulse duration: if a relay is ON longer than its
 *      configured pulse_ms + 2000ms margin, forced OFF.
 *   2. Heartbeat stall detection: if bell_core_tick stops calling
 *      watchdog_heartbeat() for 10 seconds, takeover mode activates.
 *   3. Time validity: only acts when system clock is valid
 *      (time(nullptr) > 1000000000UL).
 */
#ifdef WATCHDOG_ENABLED
#include <Preferences.h>
#include <ArduinoJson.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

// ============================================================================
//  PIN MAP  (duplicated from bell_core.h — independence guarantee)
// ============================================================================
static constexpr uint8_t  CH1_PIN = 26;
static constexpr uint8_t  CH2_PIN = 27;
static constexpr bool     ACTIVE_HIGH = false;   // LOW = relay active
static constexpr uint8_t  CHANNEL_COUNT = 2;

// ============================================================================
//  WATCHDOG CONFIGURATION
// ============================================================================
static constexpr uint32_t POLL_MS             = 250;    // 4 Hz — fast enough for any pulse
static constexpr uint32_t STALL_TIMEOUT_MS    = 10000;  // bell_core heartbeat timeout
static constexpr uint32_t MAX_PULSE_MARGIN_MS = 2000;   // safety margin beyond pulse_ms
static constexpr uint32_t NVS_RELOAD_MS       = 300000; // re-read NVS every 5 min
static constexpr size_t   MAX_SCHEDULE        = 24;
static constexpr size_t   MAX_SKIP_DATES      = 32;

// ============================================================================
//  NVS KEYS  (must match bell_core NVS namespace)
// ============================================================================
static const char NVS_NS[]   = "relay";
static const char NVS_HASH[] = "hash";
static const char NVS_CFG[]  = "cfg";

// ============================================================================
//  CHANNEL STATE  (per-channel, watchdog-owned)
// ============================================================================
struct WdChannel {
    uint8_t  gpio;
    uint32_t schedule[MAX_SCHEDULE];          // seconds from midnight
    uint32_t pulse_ms[MAX_SCHEDULE];          // per-slot pulse duration
    size_t   schedule_len;
    char     skip_dates[MAX_SKIP_DATES][11];
    size_t   skip_count;
    uint32_t forced_on_ms;                    // millis() when watchdog turned relay ON
    uint32_t active_pulse_ms;                 // pulse duration watchdog applied
};

static WdChannel g_ch[CHANNEL_COUNT] = {
    { CH1_PIN, {}, {}, 0, {}, 0, 0, 0 },
    { CH2_PIN, {}, {}, 0, {}, 0, 0, 0 },
};

// ============================================================================
//  GLOBAL WATCHDOG STATE
// ============================================================================
static volatile uint32_t g_heartbeat_ms = 0;  // last heartbeat from loop()
static char     g_nvs_hash[9]   = {0};        // cached NVS hash for change detection
static uint32_t g_nvs_reload_at = 0;          // next NVS re-read time
static bool     g_taken_over    = false;       // true when bell_core is stalled
static TaskHandle_t g_task = nullptr;

// ============================================================================
//  HELPERS
// ============================================================================

static inline uint32_t elapsed_since(uint32_t t0) {
    return millis() - t0;
}

static bool time_valid() {
    return time(nullptr) > 1000000000UL;
}

/** Parse "HH:MM" → seconds since midnight. Returns 0xFFFFFFFF on error. */
static uint32_t parse_hhmm(const char *s) {
    if (!s || s[2] != ':' || s[5] != '\0') return 0xFFFFFFFF;
    if (!isdigit(s[0]) || !isdigit(s[1]) || !isdigit(s[3]) || !isdigit(s[4]))
        return 0xFFFFFFFF;
    uint32_t h = (static_cast<uint32_t>(s[0] - '0') * 10U)
               +  static_cast<uint32_t>(s[1] - '0');
    uint32_t m = (static_cast<uint32_t>(s[3] - '0') * 10U)
               +  static_cast<uint32_t>(s[4] - '0');
    if (h > 23 || m > 59) return 0xFFFFFFFF;
    return h * 3600U + m * 60U;
}

/** Fill buf with "YYYY-MM-DD" for today. Returns false if time invalid. */
static bool today_str(char buf[11]) {
    time_t now = time(nullptr);
    if (now <= 1000000000UL) return false;
    struct tm t;
    if (!localtime_r(&now, &t)) return false;
    snprintf(buf, 11, "%04d-%02d-%02d", t.tm_year + 1900, t.tm_mon + 1, t.tm_mday);
    return true;
}

/** True if today is in the skip_dates list. */
static bool is_skip_day(const WdChannel &ch) {
    char today[11];
    if (!today_str(today)) return false;
    for (size_t i = 0; i < ch.skip_count; ++i) {
        if (strcmp(ch.skip_dates[i], today) == 0) return true;
    }
    return false;
}

static inline void relay_write(uint8_t pin, bool on) {
    digitalWrite(pin, on == ACTIVE_HIGH ? HIGH : LOW);
}

static inline bool relay_read(uint8_t pin) {
    int level = digitalRead(pin);
    return ACTIVE_HIGH ? (level == HIGH) : (level == LOW);
}

// ============================================================================
//  NVS LOAD  (independent — no bell_core dependency)
// ============================================================================

/** Read NVS "relay" namespace, parse JSON, populate g_ch[].
 *  Returns true if config was loaded successfully. */
static bool watchdog_load_nvs() {
    Preferences prefs;
    if (!prefs.begin(NVS_NS, true)) return false;

    String hash = prefs.getString(NVS_HASH, "");
    String cfg  = prefs.getString(NVS_CFG, "");
    prefs.end();

    if (hash.length() == 0 || cfg.length() == 0) return false;

    // Skip re-parse if hash hasn't changed
    if (strncmp(g_nvs_hash, hash.c_str(), 8) == 0 && g_nvs_hash[0] != '\0')
        return true;

    // Parse JSON
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
    StaticJsonDocument<2048> doc;
    DeserializationError err = deserializeJson(doc, cfg);
#pragma GCC diagnostic pop
    if (err) {
        Serial.printf("[WATCHDOG] NVS JSON parse error: %s\n", err.c_str());
        return false;
    }
    JsonObject root = doc.as<JsonObject>();
    if (!root) return false;

    // Channel key mappings (same as bell_core server_keys)
    static const char *ch1_keys[] = { "ch1", "bell" };
    static const char *ch2_keys[] = { "ch2" };
    struct { const char **keys; size_t count; } keymaps[CHANNEL_COUNT] = {
        { ch1_keys, 2 },
        { ch2_keys, 1 },
    };

    for (int ci = 0; ci < CHANNEL_COUNT; ++ci) {
        WdChannel &ch = g_ch[ci];

        // Find the matching JSON object for this channel
        JsonObject ch_obj;
        for (size_t ki = 0; ki < keymaps[ci].count; ++ki) {
            JsonVariant v = root[keymaps[ci].keys[ki]];
            if (v.is<JsonObject>()) {
                ch_obj = v.as<JsonObject>();
                break;
            }
        }
        if (!ch_obj) continue;  // channel not in config — keep previous

        // Parse enabled
        bool enabled = ch_obj["enabled"] | true;
        if (!enabled) {
            ch.schedule_len = 0;
            ch.skip_count = 0;
            continue;
        }

        // Parse pulse_ms
        uint32_t default_pulse = ch_obj["pulse_ms"] | 2000U;
        if (default_pulse < 100) default_pulse = 100;

        // Parse schedule
        JsonArray sched = ch_obj["schedule"];
        ch.schedule_len = 0;
        if (sched) {
            for (JsonVariant v : sched) {
                if (ch.schedule_len >= MAX_SCHEDULE) break;
                const char *t = nullptr;
                uint32_t entry_pulse = default_pulse;

                if (v.is<const char*>()) {
                    t = v.as<const char*>();
                } else if (v.is<JsonObject>()) {
                    JsonObject obj = v.as<JsonObject>();
                    t = obj["time"];
                    uint32_t p = obj["pulse_ms"] | 0;
                    if (p >= 100) entry_pulse = p;
                }
                if (!t) continue;
                uint32_t sm = parse_hhmm(t);
                if (sm == 0xFFFFFFFF) continue;

                // Insertion sort
                size_t pos = ch.schedule_len;
                while (pos > 0 && ch.schedule[pos - 1] > sm) {
                    ch.schedule[pos] = ch.schedule[pos - 1];
                    ch.pulse_ms[pos] = ch.pulse_ms[pos - 1];
                    --pos;
                }
                ch.schedule[pos] = sm;
                ch.pulse_ms[pos] = entry_pulse;
                ++ch.schedule_len;
            }
        }

        // Parse skip_dates
        JsonArray skips = ch_obj["skip_dates"];
        ch.skip_count = 0;
        if (skips) {
            for (JsonVariant v : skips) {
                if (ch.skip_count >= MAX_SKIP_DATES) break;
                const char *d = v.as<const char*>();
                if (!d || strlen(d) != 10 || d[4] != '-' || d[7] != '-') continue;
                int y, m, day;
                if (sscanf(d, "%d-%d-%d", &y, &m, &day) != 3) continue;
                if (m < 1 || m > 12 || day < 1 || day > 31) continue;
                strncpy(ch.skip_dates[ch.skip_count], d, 10);
                ch.skip_dates[ch.skip_count][10] = '\0';
                ++ch.skip_count;
            }
        }
    }

    // Cache hash for change detection
    strncpy(g_nvs_hash, hash.c_str(), 8);
    g_nvs_hash[8] = '\0';

    Serial.printf("[WATCHDOG] NVS loaded (hash=%s, ch1_slots=%u, ch2_slots=%u)\n",
                  g_nvs_hash,
                  static_cast<unsigned>(g_ch[0].schedule_len),
                  static_cast<unsigned>(g_ch[1].schedule_len));
    return true;
}

// ============================================================================
//  CORE LOGIC: check one channel, force-correct if wrong
// ============================================================================

/** Returns true if channel should currently be ON based on schedule + time. */
static bool channel_should_be_on(const WdChannel &ch, uint32_t sec_of_day) {
    for (size_t i = 0; i < ch.schedule_len; ++i) {
        uint32_t start = ch.schedule[i];
        // Round pulse_ms up to next whole second
        uint32_t pulse_sec = (ch.pulse_ms[i] + 999U) / 1000U;
        if (pulse_sec == 0) pulse_sec = 1;
        uint32_t end = start + pulse_sec;

        if (sec_of_day >= start && sec_of_day < end) {
            return true;
        }
    }
    return false;
}

static void watchdog_check_channel(WdChannel &ch, uint32_t now_ms, bool taken_over) {
    if (ch.schedule_len == 0) return;

    // Current time
    time_t now = time(nullptr);
    if (now <= 1000000000UL) return;

    struct tm t;
    if (!localtime_r(&now, &t)) return;
    uint32_t sec_of_day = t.tm_hour * 3600U + t.tm_min * 60U + t.tm_sec;

    bool is_on = relay_read(ch.gpio);

    // ── SAFETY OFF (always active, even in normal mode) ──
    // If a relay is ON but no schedule slot covers this moment, or the
    // pulse has exceeded its max margin, force it OFF.
    if (is_on) {
        bool skip = is_skip_day(ch);
        bool should_on = !skip && channel_should_be_on(ch, sec_of_day);

        if (!should_on) {
            // Relay ON but schedule says OFF — stuck relay
            relay_write(ch.gpio, false);
            if (ch.forced_on_ms != 0) {
                uint32_t duration = now_ms - ch.forced_on_ms;
                Serial.printf("[WATCHDOG] GPIO%u SAFETY OFF (was on %lums, schedule says off)\n",
                              ch.gpio, static_cast<unsigned long>(duration));
            } else {
                Serial.printf("[WATCHDOG] GPIO%u SAFETY OFF (stuck relay)\n", ch.gpio);
            }
            ch.forced_on_ms = 0;
            ch.active_pulse_ms = 0;
        } else if (ch.forced_on_ms != 0) {
            // Relay ON, schedule says ON, but check max pulse duration
            uint32_t limit = ch.active_pulse_ms + MAX_PULSE_MARGIN_MS;
            if (elapsed_since(ch.forced_on_ms) > limit) {
                relay_write(ch.gpio, false);
                Serial.printf("[WATCHDOG] GPIO%u SAFETY OFF (pulse exceeded %lums limit)\n",
                              ch.gpio, static_cast<unsigned long>(limit));
                ch.forced_on_ms = 0;
                ch.active_pulse_ms = 0;
            }
        }
        return;  // normal mode: done after safety check
    }

    // ── TAKEOVER MODE: actively force relays ────────────────
    if (!taken_over) return;  // normal mode, relay is OFF — nothing to do

    // Relay is OFF, schedule says it should be ON → FORCE ON
    bool skip = is_skip_day(ch);
    if (!skip && channel_should_be_on(ch, sec_of_day)) {
        ch.forced_on_ms = now_ms;
        ch.active_pulse_ms = 0;

        for (size_t i = 0; i < ch.schedule_len; ++i) {
            uint32_t start = ch.schedule[i];
            uint32_t pulse_sec = (ch.pulse_ms[i] + 999U) / 1000U;
            if (pulse_sec == 0) pulse_sec = 1;
            uint32_t end = start + pulse_sec;
            if (sec_of_day >= start && sec_of_day < end) {
                ch.active_pulse_ms = ch.pulse_ms[i];
                break;
            }
        }

        relay_write(ch.gpio, true);
        Serial.printf("[WATCHDOG] GPIO%u TAKEOVER ON  (schedule %02u:%02u:%02u, pulse %lums)\n",
                      ch.gpio, t.tm_hour, t.tm_min, t.tm_sec,
                      static_cast<unsigned long>(ch.active_pulse_ms));
    }
}

// ============================================================================
//  FreeRTOS TASK
// ============================================================================

static void watchdog_task_fn(void *param) {
    (void)param;
    TickType_t xLastWakeTime = xTaskGetTickCount();

    // Initial delay — let bell_core and NTP settle
    vTaskDelay(pdMS_TO_TICKS(5000));

    // Load NVS on first iteration
    watchdog_load_nvs();
    g_nvs_reload_at = millis() + NVS_RELOAD_MS;

    Serial.println(F("[WATCHDOG] task started — monitoring relay pins"));

    for (;;) {
        uint32_t now_ms = millis();

        // ── Reload NVS if hash changed or periodic refresh ──
        if (elapsed_since(g_nvs_reload_at) >= NVS_RELOAD_MS) {
            watchdog_load_nvs();
            g_nvs_reload_at = now_ms;
        }

        // ── Heartbeat check ──────────────────────────────────
        bool stall = (g_heartbeat_ms != 0 && elapsed_since(g_heartbeat_ms) > STALL_TIMEOUT_MS);
        if (stall && !g_taken_over) {
            Serial.println(F("[WATCHDOG] CRITICAL: bell_core stalled — TAKING OVER relay control"));
            g_taken_over = true;
        } else if (!stall && g_taken_over) {
            Serial.println(F("[WATCHDOG] bell_core recovered — releasing takeover"));
            g_taken_over = false;
        }

        // ── Check each channel ───────────────────────────────
        if (time_valid()) {
            for (int i = 0; i < CHANNEL_COUNT; ++i) {
                watchdog_check_channel(g_ch[i], now_ms, g_taken_over);
            }
        }

        vTaskDelayUntil(&xLastWakeTime, pdMS_TO_TICKS(POLL_MS));
    }
}

// ============================================================================
//  PUBLIC API
// ============================================================================

void watchdog_init() {
    // Configure GPIOs as output (same as bell_core, but independent)
    pinMode(CH1_PIN, OUTPUT);
    pinMode(CH2_PIN, OUTPUT);
    digitalWrite(CH1_PIN, ACTIVE_HIGH ? LOW : HIGH);  // relays OFF
    digitalWrite(CH2_PIN, ACTIVE_HIGH ? LOW : HIGH);

    BaseType_t rc = xTaskCreatePinnedToCore(
        watchdog_task_fn,
        "watchdog",
        8192,        // stack — needs room for ArduinoJson + Preferences
        nullptr,
        3,           // priority 3 — above network task (1) and Arduino loop (1)
        &g_task,
        0            // core 0
    );
    if (rc != pdPASS) {
        Serial.println(F("[WATCHDOG] FATAL: task creation failed"));
    }
}

void watchdog_heartbeat() {
    g_heartbeat_ms = millis();
}

bool watchdog_has_taken_over() {
    return g_taken_over;
}

#endif  // WATCHDOG_ENABLED
