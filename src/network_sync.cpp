/*
 * network_sync.cpp  —  Network Synchronization Module implementation
 * ─────────────────────────────────────────────────────────────────
 * See network_sync.h for the public API.
 *
 * This module NEVER writes to Channel::cfg, never activates relays,
 * and never modifies scheduler state. All schedule updates go through
 * bell_core_apply_schedule(). All manual commands go through
 * bell_core_queue_command(). All execution reporting goes through
 * bell_core_pop_execution_report().
 *
 * If this entire module crashes, the Bell Management Core continues
 * ringing bells from NVS-stored schedules without interruption.
 */
#include "network_sync.h"
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "bell_core.h"
#include "wifi_provision.h"
#include "led_indicator.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiUdp.h>
#include <ArduinoJson.h>
#include <esp_sntp.h>

// BLE removed — not needed for this deployment
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

// Timing state
static uint32_t  g_wifi_last_attempt   = 0;
static uint32_t  g_last_poll           = 0;
static uint32_t  g_last_command_poll   = 0;

// ============================================================================
//  FreeRTOS TASK  (core 0 — runs independently so HTTP blocks never starve bell_core)
// ============================================================================
static TaskHandle_t g_net_task = nullptr;
static constexpr uint32_t NET_TASK_PERIOD_MS = 50;   // 20 Hz tick cadence

// Forward declaration — used by network_sync_init before full definition
static void network_sync_task_fn(void *param);
static uint32_t  g_last_heartbeat      = 0;
static uint32_t  g_last_hash_poll      = 0;
static uint32_t  g_fallback_attempt_ms = 0;  // throttle fallback HTTP attempts

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
    static char url[64];
    if (g_server_seen) {
        snprintf(url, sizeof(url), "http://%s:%u",
                 g_server_ip.toString().c_str(), g_server_port);
    } else {
        snprintf(url, sizeof(url), "http://%s:%u",
                 FALLBACK_SERVER_IP, SERVER_PORT);
    }
    return url;
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
    g_server_seen    = true;
    g_last_beacon_ms = millis();
}

// ============================================================================
//  HTTP HELPERS
// ============================================================================

static bool fetch_schedule() {
    if (WiFi.status() != WL_CONNECTED || !g_server_seen) return false;
    for (int attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) delay(attempt * 500);  // backoff: 500ms, 1000ms

        WiFiClient client;
        HTTPClient http;
        http.setTimeout(POLL_TIMEOUT_MS);

        const String url = server_base_url() + "/api/schedule";
        if (!http.begin(client, url)) continue;

        const int code = http.GET();
        if (code != 200) {
            http.end();
            if (code > 0 && code < 500) return false;  // client error — don't retry
            continue;
        }

        String body = http.getString();
        http.end();

        // Validate: must be non-empty JSON object
        body.trim();
        if (body.length() < 2 || body[0] != '{') continue;

        // Get hash for dedup check — also used for Bell Core if schedule changed
        const char *current_hash = bell_core_schedule_hash();
        String server_hash = "________";
        bool hash_unchanged = false;
        {
            WiFiClient hc;
            HTTPClient hh;
            hh.setTimeout(3000);
            String hurl = server_base_url() + "/api/schedule/hash";
            if (hh.begin(hc, hurl) && hh.GET() == 200) {
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
                StaticJsonDocument<64> hdoc;
#pragma GCC diagnostic pop
                if (!deserializeJson(hdoc, hh.getStream())) {
                    const char *h = hdoc["h"] | "";
                    if (strlen(h) == 8) {
                        server_hash = h;
                        if (strlen(current_hash) == 8 && strcmp(h, current_hash) == 0) {
                            hash_unchanged = true;
                        }
                    }
                }
            }
            hh.end();
        }
        if (hash_unchanged) return true;  // already current

        // Validate JSON structure before handing to Bell Core
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
        StaticJsonDocument<2048> doc;
#pragma GCC diagnostic pop
        const DeserializationError err = deserializeJson(doc, body);
        if (err) {
            DBGF("[NET] JSON parse error: %s\n", err.c_str());
            continue;
        }
        if (!doc.is<JsonObject>()) continue;

        // Hand off to Bell Core for atomic application (reuses server_hash)
        if (bell_core_apply_schedule(body.c_str(), server_hash.c_str())) {
            if (!g_server_config_loaded) {
                Serial.println(F("NET: first server config loaded"));
                g_server_config_loaded = true;
            } else {
                Serial.println(F("NET: schedule updated from server"));
            }
            return true;
        }
        DBGLN(F("NET: bell core rejected schedule"));
        return false;  // don't retry if core rejected it
    }
    return false;
}

static void send_heartbeats() {
    if (WiFi.status() != WL_CONNECTED) return;
    for (uint8_t i = 0; i < 2; i++) {
        const char *key = bell_core_channel_key(i);
        if (!key) continue;
        WiFiClient client;
        HTTPClient http;
        http.setTimeout(4000);
        String url = server_base_url() + "/api/heartbeat?ch=" + String(key);
        if (http.begin(client, url)) {
            http.POST("");
            http.end();
        }
    }
}

static void drain_execution_reports() {
    if (WiFi.status() != WL_CONNECTED) return;
    char ch_key[32];
    uint32_t pulse_ms;
    const char *trigger;
    while (bell_core_pop_execution_report(ch_key, sizeof(ch_key), &pulse_ms, &trigger)) {
        WiFiClient client;
        HTTPClient http;
        http.setTimeout(3000);
        String url = server_base_url() + "/api/execution";
        if (http.begin(client, url)) {
            http.addHeader("Content-Type", "application/json");
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
            StaticJsonDocument<128> doc;
#pragma GCC diagnostic pop
            doc["ch"] = ch_key;
            doc["pulse_ms"] = pulse_ms;
            doc["trigger"] = trigger;
            String body;
            serializeJson(doc, body);
            http.POST(body);
            http.end();
        }
    }
}

static void drain_log_buffer() {
    if (WiFi.status() != WL_CONNECTED) return;
    char msg[128];
    while (bell_core_pop_log(msg, sizeof(msg))) {
        WiFiClient client;
        HTTPClient http;
        http.setTimeout(2000);
        String url = server_base_url() + "/api/log";
        if (http.begin(client, url)) {
            http.addHeader("Content-Type", "application/json");
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
            StaticJsonDocument<256> doc;
#pragma GCC diagnostic pop
            doc["msg"] = msg;
            String body;
            serializeJson(doc, body);
            http.POST(body);
            http.end();
        }
    }
}

static void poll_commands() {
    if (WiFi.status() != WL_CONNECTED) return;
    for (uint8_t i = 0; i < 2; i++) {
        const char *key = bell_core_channel_key(i);
        if (!key) continue;
        WiFiClient client;
        HTTPClient http;
        http.setTimeout(3000);
        String url = server_base_url() + "/api/commands?ch=" + String(key);
        if (!http.begin(client, url)) continue;
        int code = http.GET();
        if (code != 200) { http.end(); continue; }
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
        StaticJsonDocument<128> doc;
#pragma GCC diagnostic pop
        const DeserializationError err = deserializeJson(doc, http.getStream());
        http.end();
        if (err || !(doc["pending"] | false)) continue;
        uint32_t pulse_ms = doc["pulse_ms"] | 2000;
        if (pulse_ms < 100) pulse_ms = 100;
        bell_core_queue_command(key, pulse_ms);
    }
}

static void check_schedule_update() {
    if (WiFi.status() != WL_CONNECTED) return;
    // ── Quick hash poll (only when we have a real server) ──
    if (g_server_seen && elapsed_since(g_last_hash_poll) >= HASH_POLL_MS) {
        WiFiClient client;
        HTTPClient http;
        http.setTimeout(3000);
        String url = server_base_url() + "/api/schedule/hash";
        if (http.begin(client, url) && http.GET() == 200) {
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
            StaticJsonDocument<64> doc;
#pragma GCC diagnostic pop
            if (!deserializeJson(doc, http.getStream())) {
                const char *h = doc["h"] | "";
                const char *current = bell_core_schedule_hash();
                if (strlen(h) == 8 && (strlen(current) != 8 || strcmp(h, current) != 0)) {
                    DBGLN(F("NET: hash changed — fetching schedule"));
                    if (fetch_schedule()) {
                        g_last_poll = millis();
                    }
                }
            }
        }
        http.end();
        g_last_hash_poll = millis();
    }

    if (g_server_seen && elapsed_since(g_last_poll) >= FULL_POLL_MS) {
        if (fetch_schedule()) {
            if (!g_server_config_loaded) {
                Serial.println(F("NET: first server config"));
                g_server_config_loaded = true;
            }
        } else {
            DBGLN(F("NET: full poll failed"));
        }
        g_last_poll = millis();
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
    // so a slow-booting router after a power outage is handled gracefully
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

    // Seed timers
    g_wifi_last_attempt   = millis();
    g_last_poll           = millis();
    g_last_command_poll   = millis();
    g_last_heartbeat      = millis();
    g_last_hash_poll      = millis();
    g_fallback_attempt_ms = millis();  // give beacon 10s head start
    led_request_state(LedState::OFFLINE_MODE);  // server not yet discovered

    // --- Spawn network I/O task on core 0 (keeps HTTP blocks off the bell core's core 1) ---
    BaseType_t rc = xTaskCreatePinnedToCore(
        network_sync_task_fn,      // entry point
        "netSync",                 // debug name
        10240,                     // stack (bytes) — needs room for HTTPClient + JSON docs
        nullptr,                   // no parameter
        1,                         // priority (same as Arduino loop)
        &g_net_task,               // handle
        0                          // core 0 — protocol core, away from Arduino loop on core 1
    );
    if (rc != pdPASS) {
        Serial.println(F("FATAL: network task creation failed"));
    }

    Serial.println(F("Network Sync ready (task on core 0)."));
}

// ── FreeRTOS task: runs on core 0, never blocks the Bell Core on core 1 ──
static void network_sync_task_fn(void *param) {
    (void)param;
    TickType_t xLastWakeTime = xTaskGetTickCount();

    for (;;) {
        const uint32_t now_ms = millis();

        // ── BOOT button watchdog ──────────────────────────
        checkBootButtonReset();

        // ── UDP beacon ─────────────────────────────────────
        check_beacon();

        // ── Beacon timeout → keep g_server_seen true so HTTP polling
        //    continues against the fallback IP. check_beacon() will
        //    update to the real server IP when the beacon returns.
        if (g_server_seen && elapsed_since(g_last_beacon_ms) >= BEACON_TIMEOUT_MS) {
            DBGLN(F("[BEACON] lost — switching to fallback IP"));
            g_server_ip.fromString(FALLBACK_SERVER_IP);
            g_server_port = SERVER_PORT;
        }

        // ── Server online/offline LED transitions ───────────
        if (g_server_seen && !s_was_server_seen) {
            led_release_state(LedState::OFFLINE_MODE);
            s_was_server_seen = true;
        } else if (!g_server_seen && s_was_server_seen) {
            led_request_state(LedState::OFFLINE_MODE);
            bell_core_discard_commands();  // safety: no stale run-now survives server loss
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

        // ── Schedule sync ──────────────────────────────────
        // ── Initial fallback: no beacon after 10s → try HTTP against fallback IP ──
        if (!g_server_seen && WiFi.status() == WL_CONNECTED
            && elapsed_since(g_fallback_attempt_ms) >= 10000U) {
            g_fallback_attempt_ms = now_ms;
            WiFiClient fc;
            HTTPClient hc;
            hc.setTimeout(3000);
            String url = server_base_url() + "/api/schedule/hash";
            if (hc.begin(fc, url) && hc.GET() == 200) {
                g_server_seen = true;
                Serial.printf("NET: server reachable at fallback %s:%u\n",
                              g_server_ip.toString().c_str(), g_server_port);
            }
            hc.end();
        }

        // ── Schedule sync (runs immediately if fallback just discovered server) ──
        check_schedule_update();

        // ── Everything below requires a known server ────────
        if (g_server_seen) {
            // ── Manual command poll ────────────────────────────
            if (WiFi.status() == WL_CONNECTED
                && elapsed_since(g_last_command_poll) >= COMMAND_POLL_MS) {
                poll_commands();
                g_last_command_poll = now_ms;
            }

            // ── Heartbeats ─────────────────────────────────────
            if (WiFi.status() == WL_CONNECTED
                && elapsed_since(g_last_heartbeat) >= 5000U) {
                send_heartbeats();
                g_last_heartbeat = now_ms;
            }

            // ── Drain execution reports → server ───────────────
            drain_execution_reports();

            // ── Drain log buffer → server ──────────────────────
            drain_log_buffer();
        }

        // ── Yield to other tasks for NET_TASK_PERIOD_MS ────────
        vTaskDelayUntil(&xLastWakeTime, pdMS_TO_TICKS(NET_TASK_PERIOD_MS));
    }
}
