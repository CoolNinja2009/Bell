/*
 * network_sync.cpp  —  Network Synchronization Module
 * ─────────────────────────────────────────────────────────────────
 * Handles all network operations: WiFi, HTTP, schedule downloads,
 * heartbeats, command polling, and server discovery.
 *
 * DESIGN — Fully non-blocking:
 *   - At most ONE HTTP call per tick. Each call has a short timeout
 *     (1–5 seconds). If the server is unreachable, exponential
 *     backoff kicks in and all HTTP stops until the backoff expires.
 *   - Server detection: UDP beacon (primary) + fallback HTTP probe
 *     (when beacon is lost). Consecutive HTTP failures also mark the
 *     server as unseen — no waiting 20 seconds for the beacon timer.
 *   - This module NEVER directly controls relays. Its only job is to
 *     fetch data and hand it to the Bell Core via its API.
 */

#include "network_sync.h"
#include "bell_core.h"
#include "led_indicator.h"
#include "wifi_provision.h"

#include <WiFi.h>
#include <WiFiUdp.h>
#include <HTTPClient.h>
#include <esp_sntp.h>

// ============================================================================
//  SERIAL DEBUG MACROS
// ============================================================================
// #define DEBUG_SERIAL

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
//  CONSTANTS — HTTP timeouts (kept SHORT to limit main-loop blocking)
// ============================================================================
constexpr uint32_t HTTP_TO_CMD       = 1500;   // command poll
constexpr uint32_t HTTP_TO_HASH      = 2000;   // schedule hash check
constexpr uint32_t HTTP_TO_FULL      = 5000;   // full schedule fetch (bigger payload)
constexpr uint32_t HTTP_TO_HB        = 2000;   // heartbeat
constexpr uint32_t HTTP_TO_EXEC      = 2000;   // execution report
constexpr uint32_t HTTP_TO_LOG       = 1500;   // log drain
constexpr uint32_t HTTP_TO_FALLBACK  = 3000;   // fallback server probe

// Backoff: after N consecutive failures, wait 1s,2s,4s,8s,16s,32s (capped)
constexpr uint8_t  MAX_FAIL_BACKOFF  = 6;      // 2^6 * 1000 = 64s max
// After this many consecutive failures, mark server as lost
constexpr uint8_t  SERVER_LOST_FAILS = 4;

// ============================================================================
//  INTERNAL STATE
// ============================================================================
static IPAddress g_server_ip;
static uint16_t  g_server_port    = SERVER_PORT;
static bool      g_server_seen    = false;
static uint32_t  g_last_beacon_ms = 0;
static WiFiUDP   g_udp;

static bool      s_was_server_seen    = false;
static bool      g_server_config_loaded = false;
static bool      s_was_connected       = false;

// Timing state — each operation has its own "next allowed at" timer
static uint32_t  g_wifi_last_attempt   = 0;
static uint32_t  g_next_cmd_poll       = 0;
static uint32_t  g_next_hash_poll      = 0;
static uint32_t  g_next_full_poll      = 0;
static uint32_t  g_next_heartbeat      = 0;
static uint32_t  g_fallback_attempt_ms = 0;

// HTTP failure tracking
static uint8_t   g_http_failures    = 0;
static uint32_t  g_backoff_until_ms = 0;

// ============================================================================
//  INTERNAL HELPERS
// ============================================================================

static inline uint32_t elapsed_since(uint32_t t0) {
    return millis() - t0;
}

static String server_base_url() {
    if (g_server_seen) {
        return "http://" + g_server_ip.toString() + ":" + String(g_server_port);
    }
    return "http://" + String(FALLBACK_SERVER_IP) + ":" + String(SERVER_PORT);
}

const char* network_server_base_url() {
    if (!g_server_seen) return nullptr;
    static char url[64];
    snprintf(url, sizeof(url), "http://%s:%u",
             g_server_ip.toString().c_str(), g_server_port);
    return url;
}

// ============================================================================
//  HTTP FAILURE TRACKING  — exponential backoff + server-lost detection
// ============================================================================

static void note_http_success() {
    if (g_http_failures > 0) {
        DBGF("[NET] HTTP recovered after %u failures\n", g_http_failures);
    }
    g_http_failures   = 0;
    g_backoff_until_ms = 0;
    // If we were marked offline due to HTTP failures, re-mark as seen
    if (!g_server_seen && WiFi.status() == WL_CONNECTED) {
        g_server_seen = true;
        Serial.println(F("NET: server reachable again via HTTP"));
    }
}

static void note_http_failure() {
    g_http_failures++;
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, then stays at ~64s
    const uint8_t exp = (g_http_failures > MAX_FAIL_BACKOFF)
                        ? MAX_FAIL_BACKOFF : g_http_failures;
    g_backoff_until_ms = millis() + (1000UL << (exp - 1));

    DBGF("[NET] HTTP failure #%u — backoff %lu ms\n",
         g_http_failures, 1000UL << (exp - 1));

    // Mark server as lost after enough consecutive failures
    if (g_server_seen && g_http_failures >= SERVER_LOST_FAILS) {
        g_server_seen = false;
        Serial.println(F("NET: server unreachable — marking offline"));
    }
}

static bool http_allowed() {
    if (!g_server_seen)                     return false;
    if (WiFi.status() != WL_CONNECTED)      return false;
    if (g_backoff_until_ms > millis())      return false;
    return true;
}

// ============================================================================
//  UDP BEACON
// ============================================================================

static void check_beacon() {
    const int sz = g_udp.parsePacket();
    if (sz <= 0) return;

    char buf[64] = {0};
    const int n = g_udp.read(buf, sizeof(buf) - 1);
    if (n <= 0) return;
    buf[n] = '\0';

    // Expected: RELAY_CTRL:<port>\n
    if (strncmp(buf, "RELAY_CTRL:", 11) != 0) return;

    const int port = atoi(buf + 11);
    if (port < 1 || port > 65535) return;

    const IPAddress ip = g_udp.remoteIP();

    if (!g_server_seen || g_server_ip != ip || g_server_port != static_cast<uint16_t>(port)) {
        g_server_ip   = ip;
        g_server_port = static_cast<uint16_t>(port);
        DBGF("[BEACON] Server discovered at %s:%u\n",
             g_server_ip.toString().c_str(), g_server_port);
    }
    g_server_seen     = true;
    g_last_beacon_ms  = millis();
    g_http_failures   = 0;        // beacon = server is alive, reset failure count
    g_backoff_until_ms = 0;
}

// ============================================================================
//  HTTP OPERATIONS  — each is self-contained, returns true if it did work
// ============================================================================

static bool http_get_json(const char *path, uint32_t timeout_ms,
                          String &out_body, int *out_code = nullptr) {
    if (!http_allowed()) return false;

    WiFiClient client;
    HTTPClient http;
    http.setTimeout(timeout_ms);
    String url = server_base_url() + path;

    if (!http.begin(client, url)) {
        http.end();
        note_http_failure();
        return false;
    }

    int code = http.GET();
    if (out_code) *out_code = code;

    if (code == 200) {
        out_body = http.getString();
        http.end();
        note_http_success();
        return true;
    }

    http.end();
    if (code <= 0 || code >= 500) {
        note_http_failure();  // timeout or server error
    }
    // 4xx = client error — don't count as server failure
    return false;
}

static bool http_post_json(const char *path, const String &body,
                           uint32_t timeout_ms) {
    if (!http_allowed()) return false;

    WiFiClient client;
    HTTPClient http;
    http.setTimeout(timeout_ms);
    String url = server_base_url() + path;

    if (!http.begin(client, url)) {
        http.end();
        note_http_failure();
        return false;
    }
    http.addHeader("Content-Type", "application/json");

    int code = http.POST(body);
    http.end();

    if (code == 200) {
        note_http_success();
        return true;
    }
    if (code <= 0 || code >= 500) {
        note_http_failure();
    }
    return false;
}

// ── Command poll ─────────────────────────────────────────

static bool poll_one_command(const char *ch_key) {
    String body;
    int code = 0;
    String path = "/api/commands?ch=" + String(ch_key);
    if (!http_get_json(path.c_str(), HTTP_TO_CMD, body, &code))
        return false;
    if (code != 200) return false;

    // Parse: {"pending":true, "pulse_ms":2000}
    // Minimal manual parse — avoid ArduinoJson overhead for tiny payload
    const char *p = body.c_str();

    // Check "pending":true
    const char *ptag = strstr(p, "\"pending\"");
    if (!ptag) return false;
    ptag = strchr(ptag, ':');
    if (!ptag) return false;
    ptag++;
    while (*ptag == ' ' || *ptag == '\t') ptag++;
    if (strncmp(ptag, "true", 4) != 0) return false;

    // Extract pulse_ms (optional, default 2000)
    uint32_t pulse_ms = 2000;
    const char *mtag = strstr(p, "\"pulse_ms\"");
    if (mtag) {
        mtag = strchr(mtag, ':');
        if (mtag) {
            mtag++;
            while (*mtag == ' ' || *mtag == '\t') mtag++;
            pulse_ms = atol(mtag);
        }
    }
    if (pulse_ms < 100) pulse_ms = 100;

    bell_core_queue_command(ch_key, pulse_ms);
    return true;
}

static void poll_commands() {
    for (uint8_t i = 0; i < 2; i++) {
        const char *key = bell_core_channel_key(i);
        if (!key) continue;
        poll_one_command(key);
    }
}

// ── Heartbeats ───────────────────────────────────────────

static void send_heartbeats() {
    for (uint8_t i = 0; i < 2; i++) {
        const char *key = bell_core_channel_key(i);
        if (!key) continue;
        String path = "/api/heartbeat?ch=" + String(key);
        http_post_json(path.c_str(), "", HTTP_TO_HB);
    }
}

// ── Schedule hash poll ───────────────────────────────────

static bool poll_schedule_hash() {
    String body;
    if (!http_get_json("/api/schedule/hash", HTTP_TO_HASH, body))
        return false;

    // Parse: {"h":"a1b2c3d4"}
    const char *p = strstr(body.c_str(), "\"h\"");
    if (!p) return false;
    p = strchr(p, ':');
    if (!p) return false;
    p++;
    while (*p == ' ' || *p == '"') p++;
    if (strlen(p) < 8) return false;

    const char *current = bell_core_schedule_hash();
    if (strlen(current) != 8 || strncmp(p, current, 8) != 0) {
        DBGLN(F("NET: hash changed — fetching schedule"));
        return true;  // caller should fetch full schedule
    }
    return false;
}

// ── Full schedule fetch ──────────────────────────────────

static bool fetch_schedule() {
    String body;
    if (!http_get_json("/api/schedule", HTTP_TO_FULL, body))
        return false;

    body.trim();
    if (body.length() < 2 || body[0] != '{') {
        note_http_failure();
        return false;
    }

    // Get server hash for dedup
    String hash_body;
    String server_hash = "________";
    if (http_get_json("/api/schedule/hash", HTTP_TO_HASH, hash_body)) {
        const char *p = strstr(hash_body.c_str(), "\"h\"");
        if (p) {
            p = strchr(p, ':');
            if (p) {
                p++;
                while (*p == ' ' || *p == '"') p++;
                if (strlen(p) >= 8) server_hash = String(p).substring(0, 8);
            }
        }
    }

    // Dedup check
    const char *current = bell_core_schedule_hash();
    if (strlen(current) == 8 && server_hash.length() == 8
        && strcmp(server_hash.c_str(), current) == 0) {
        return true;  // no change needed
    }

    // Validate JSON structure before handing to Bell Core
    // (Bell Core will re-parse with ArduinoJson for full validation)
    if (bell_core_apply_schedule(body.c_str(), server_hash.c_str())) {
        if (!g_server_config_loaded) {
            Serial.println(F("NET: first server config"));
            g_server_config_loaded = true;
        } else {
            Serial.println(F("NET: schedule updated from server"));
        }
        return true;
    }
    DBGLN(F("NET: bell core rejected schedule"));
    return false;
}

// ── Execution report drain ───────────────────────────────

static void drain_execution_reports() {
    char ch_key[32];
    uint32_t pulse_ms;
    const char *trigger;

    if (!bell_core_pop_execution_report(ch_key, sizeof(ch_key), &pulse_ms, &trigger))
        return;
    if (!http_allowed()) return;  // drop report if server unreachable

    // Build JSON manually to avoid ArduinoJson overhead
    char body[128];
    snprintf(body, sizeof(body),
             "{\"ch\":\"%s\",\"pulse_ms\":%lu,\"trigger\":\"%s\"}",
             ch_key, (unsigned long)pulse_ms, trigger);

    http_post_json("/api/execution", body, HTTP_TO_EXEC);
}

// ── Log drain ────────────────────────────────────────────

static void drain_log_buffer() {
    char msg[128];
    if (!bell_core_pop_log(msg, sizeof(msg))) return;
    if (!http_allowed()) return;

    char body[256];
    snprintf(body, sizeof(body), "{\"msg\":\"%s\"}", msg);

    http_post_json("/api/log", body, HTTP_TO_LOG);
}

// ── Fallback server probe ────────────────────────────────

static void probe_fallback_server() {
    // Only probe when we don't have a known server
    if (g_server_seen) return;
    if (WiFi.status() != WL_CONNECTED) return;
    if (elapsed_since(g_fallback_attempt_ms) < 10000U) return;

    g_fallback_attempt_ms = millis();

    WiFiClient fc;
    HTTPClient hc;
    hc.setTimeout(HTTP_TO_FALLBACK);
    String url = server_base_url() + "/api/schedule/hash";

    if (hc.begin(fc, url) && hc.GET() == 200) {
        g_server_seen = true;
        g_http_failures = 0;
        g_backoff_until_ms = 0;
        Serial.printf("NET: server reachable at fallback %s:%u\n",
                      g_server_ip.toString().c_str(), g_server_port);
    }
    hc.end();
}

// ── Schedule update gate ─────────────────────────────────

static void check_schedule_update() {
    if (!http_allowed()) return;

    const uint32_t now_ms = millis();

    // Hash poll — quick, runs frequently
    if (elapsed_since(g_next_hash_poll) >= HASH_POLL_MS) {
        if (poll_schedule_hash()) {
            // Hash changed — fetch full schedule immediately
            // (bypasses the FULL_POLL_MS interval gate)
            fetch_schedule();
        }
        g_next_hash_poll = now_ms;
        return;  // one HTTP op per tick — skip full poll this round
    }

    // Full poll — heavier, runs less frequently
    if (elapsed_since(g_next_full_poll) >= FULL_POLL_MS) {
        fetch_schedule();
        g_next_full_poll = now_ms;
    }
}

// ============================================================================
//  PUBLIC API
// ============================================================================

void network_sync_init() {
    // --- WiFi Provisioning ---
    checkBootButtonReset();

    char ssid[32] = {0};
    char pass[64] = {0};

    if (!loadCredentials(ssid, sizeof(ssid), pass, sizeof(pass))) {
        // No saved credentials — first-time provisioning
        startSetupMode();  // never returns
    }

    // Non-blocking WiFi start — the tick watchdog retries every WIFI_RETRY_MS
    WiFi.setAutoReconnect(true);
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, pass);
    Serial.printf("WiFi: connecting to %s...\n", ssid);

    // --- UDP beacon ---
    g_udp.begin(BEACON_PORT);
    g_server_ip.fromString(FALLBACK_SERVER_IP);
    Serial.printf("Beacon: listening on UDP/%u  (fallback %s:%u)\n",
                  BEACON_PORT, FALLBACK_SERVER_IP, SERVER_PORT);

    // --- NTP ---
    sntp_set_sync_mode(SNTP_SYNC_MODE_IMMED);
    sntp_set_sync_interval(SNTP_SYNC_INTERVAL_MS);
    configTime(GMT_OFFSET_SEC, DAYLIGHT_SEC, NTP_SERVER1, NTP_SERVER2, NTP_SERVER3);

    // Seed all timers so nothing fires immediately on first tick
    const uint32_t now = millis();
    g_wifi_last_attempt   = now;
    g_next_cmd_poll       = now + 2000;   // wait 2s before first command poll
    g_next_hash_poll      = now + 3000;   // wait 3s before first hash poll
    g_next_full_poll      = now + 5000;   // wait 5s before first full poll
    g_next_heartbeat      = now + 4000;   // wait 4s before first heartbeat
    g_fallback_attempt_ms = now;          // give beacon 10s head start

    led_request_state(LedState::OFFLINE_MODE);  // server not yet discovered

    Serial.println(F("Network Sync ready."));
}

void network_sync_tick() {
    const uint32_t now_ms = millis();

    // ── BOOT button watchdog ──────────────────────────
    checkBootButtonReset();

    // ── UDP beacon ─────────────────────────────────────
    check_beacon();

    // ── Beacon timeout → server lost ───────────────────
    if (g_server_seen && elapsed_since(g_last_beacon_ms) >= BEACON_TIMEOUT_MS) {
        DBGLN(F("[BEACON] lost — server may be offline"));
        g_server_seen = false;
    }

    // ── Server online/offline LED transitions ───────────
    if (g_server_seen && !s_was_server_seen) {
        led_release_state(LedState::OFFLINE_MODE);
        s_was_server_seen = true;
    } else if (!g_server_seen && s_was_server_seen) {
        led_request_state(LedState::OFFLINE_MODE);
        bell_core_discard_commands();
        s_was_server_seen = false;
    }

    // ── WiFi watchdog ──────────────────────────────────
    if (WiFi.status() != WL_CONNECTED) {
        s_was_connected = false;
        if (elapsed_since(g_wifi_last_attempt) >= WIFI_RETRY_MS) {
            static bool s_first_wifi_failure = true;
            if (s_first_wifi_failure) {
                Serial.println(F("WiFi: not connected — will keep retrying every 30s"));
                s_first_wifi_failure = false;
            }
            WiFi.reconnect();
            g_wifi_last_attempt = now_ms;
        }
    } else {
        if (!s_was_connected) {
            Serial.println(F("WiFi: connected"));
            s_was_connected = true;
        }
    }

    // ── Fallback server probe (only when server unseen) ──
    probe_fallback_server();

    // ── Schedule update (hash poll or full fetch) ─────
    //     Only if server is seen AND we're not in backoff.
    //     At most ONE HTTP call here (hash poll OR full fetch).
    check_schedule_update();

    // ── Everything below runs ONLY when server is known ──
    //     AND we're not in HTTP backoff.
    //     Each section does at most ONE HTTP call.
    if (!http_allowed()) return;

    // ── Command poll (one channel per tick max) ────────
    if (elapsed_since(g_next_cmd_poll) >= COMMAND_POLL_MS) {
        // Poll just one channel each time to limit HTTP calls
        static uint8_t s_cmd_chan = 0;
        const char *key = bell_core_channel_key(s_cmd_chan);
        if (key) poll_one_command(key);
        s_cmd_chan = (s_cmd_chan + 1) % 2;
        g_next_cmd_poll = now_ms;
        return;  // max 1 HTTP per tick
    }

    // ── Heartbeat (one channel per tick max) ───────────
    if (elapsed_since(g_next_heartbeat) >= 5000U) {
        static uint8_t s_hb_chan = 0;
        const char *key = bell_core_channel_key(s_hb_chan);
        if (key) {
            String path = "/api/heartbeat?ch=" + String(key);
            http_post_json(path.c_str(), "", HTTP_TO_HB);
        }
        s_hb_chan = (s_hb_chan + 1) % 2;
        g_next_heartbeat = now_ms;
        return;
    }

    // ── Drain execution reports (one per tick) ─────────
    drain_execution_reports();

    // ── Drain log buffer (one per tick) ────────────────
    drain_log_buffer();
}
