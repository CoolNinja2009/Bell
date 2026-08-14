/*
 * ota_update.cpp  —  Failproof OTA implementation
 * ─────────────────────────────────────────────────────────────────
 * See ota_update.h for the design contract and safety guarantees.
 *
 * Download flow:
 *   IDLE → CHECK_VERSION → DOWNLOAD → VERIFY → APPLY → REBOOT
 *     ↑         ↓              ↓         ↓
 *     │    ┌── no-update       └─ resume └─ failed → ERROR → IDLE
 *     │    │
 *     │    └── unreachable → RETRY (30 min) → CHECK_VERSION
 *     │
 *     └── morning check: 3 AM daily (NTP) or 24h fallback
 *
 * RETRY: when the server can't be reached, retry every 30 minutes
 * until we get a definitive answer (update available or not).
 *
 * Bell‑aware pausing: download pauses automatically when a
 * scheduled bell is within 10 minutes. Relays always win.
 */

#include "ota_update.h"
#include "bell_core.h"
#include "led_indicator.h"
#include "network_sync.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <Update.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <mbedtls/sha256.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <sys/time.h>

// ── Compile‑time identity ──────────────────────────────────────────
#ifndef FIRMWARE_VERSION
  #define FIRMWARE_VERSION "0.0.0-dev"
#endif
#ifndef GITHUB_REPO
  #define GITHUB_REPO "CoolNinja2009/Bell"
#endif
#ifndef FIRMWARE_BUILD_STAMP
  #define FIRMWARE_BUILD_STAMP "1970-01-01T00:00:00Z"
#endif
#ifndef OTA_PROTOCOL_VERSION
  #define OTA_PROTOCOL_VERSION 2
#endif
#ifndef OTA_MIN_PROTOCOL
  #define OTA_MIN_PROTOCOL 1
#endif
#define OTA_STRINGIFY_INNER(value) #value
#define OTA_STRINGIFY(value) OTA_STRINGIFY_INNER(value)
// Deliberately embedded in the image so the server can verify its build time.
static const char FIRMWARE_BUILD_MARKER[] = "BELL_BUILD:" FIRMWARE_BUILD_STAMP;
static const char FIRMWARE_OTA_PROTOCOL_MARKER[] __attribute__((used)) = "BELL_OTA_PROTOCOL:" OTA_STRINGIFY(OTA_PROTOCOL_VERSION);
static const char FIRMWARE_OTA_MIN_PROTOCOL_MARKER[] __attribute__((used)) = "BELL_OTA_MIN_PROTOCOL:" OTA_STRINGIFY(OTA_MIN_PROTOCOL);
#define FIRMWARE_COMPILED_AT FIRMWARE_BUILD_STAMP

// ── Timing ─────────────────────────────────────────────────────────
// Check on every boot: after WiFi connects + 60s delay, poll server.
// If up-to-date → done until next boot. If unreachable → retry 30 min.
constexpr uint32_t OTA_FIRST_CHECK_DELAY_MS = 60000;    // wait 60s after boot
constexpr uint32_t OTA_RETRY_INTERVAL_MS    = 1800000;  // 30 min between retries
constexpr uint32_t OTA_BELL_SAFE_WINDOW_S   = 600;      // pause OTA if bell within 10 min
constexpr uint32_t OTA_BELL_CHECK_SAFE_S    = 120;      // defer version check if bell within 2 min
constexpr uint32_t OTA_CHUNK_TIMEOUT_MS     = 500;      // HTTP timeout per chunk (was 15s — blocked core 1!)
constexpr uint32_t OTA_CHUNK_SIZE           = 4096;     // bytes per loop tick
constexpr uint32_t OTA_TICK_WINDOW_MS       = 200;      // max time ota_tick() may block per call
constexpr uint32_t OTA_RESUME_RETRY_MS      = 5000;     // backoff after a failed chunk
constexpr uint32_t OTA_DAILY_CHECK_INTERVAL_MS = 86400000;  // 24 h between periodic checks
constexpr uint32_t OTA_CONTROL_POLL_MS      = 5000;       // fast dashboard acknowledgement without persistent sockets
constexpr uint32_t OTA_BOOT_CONFIRM_DELAY_MS = 90000;   // 90 s — defer rollback cancel until this much stable uptime
static const char OTA_NVS_NS[]       = "ota";
static const char OTA_KEY_VER[]      = "version";
static const char OTA_KEY_SHA[]      = "sha256";
static const char OTA_KEY_FORCE_ID[] = "force_id";
static const char OTA_KEY_UPLOADED[] = "uploaded_at";
static const char OTA_KEY_COMPILED[] = "compiled_at";
// Flash marker for "uploaded at" — written to the coredump partition by
// post_upload.py (USB) and tick_apply() (OTA). Magic "UPTS". Stored at a
// 16 KB offset so it never collides with the coredump header at offset 0.
static const uint32_t UPLOAD_TS_MAGIC       = 0x53545055;
static const uint32_t UPLOAD_TS_PART_OFFSET = 0x4000;
// ── State machine ──────────────────────────────────────────────────
enum class OtaState : uint8_t {
    IDLE,
    CHECK_VERSION,
    DOWNLOAD,
    VERIFY,
    APPLY,
    ERROR,
    RETRY,         // waiting 30 min before re-checking server
};

static OtaState      g_state              = OtaState::IDLE;
static uint32_t      g_error_until_ms     = 0;
static uint32_t      g_dl_retry_at_ms     = 0;
static uint32_t      g_retry_until_ms     = 0;
static bool          g_check_requested    = false;
static bool          g_boot_check_done    = false;  // true once server confirms up-to-date
static uint8_t       g_error_count        = 0;      // cap retries to prevent loops
static uint32_t      g_next_daily_check_ms = 0;     // 0 = no daily check scheduled
static char          g_current_ver[32]    = FIRMWARE_VERSION;
static char          g_server_ver[32]     = "";
static char          g_server_build[21]   = "";
static char          g_server_sha256[65]  = "";
static char          g_last_sha256[65]    = "";
static uint32_t      g_server_force_id    = 0;
static uint32_t      g_last_force_id      = 0;
static bool          g_force_update       = false;
static uint32_t      g_server_size        = 0;
static uint32_t      g_bytes_written      = 0;
static bool          g_version_known      = false;
static bool          g_auto_update_enabled = true;
static uint32_t      g_last_control_poll  = 0;
static uint32_t      g_last_control_request = 0;
static uint32_t      g_last_control_id    = 0;
// Upload timestamp (unix epoch; 0 = not yet recorded) and a flag set
// when the running firmware is freshly flashed (compile time changed).
static uint32_t      g_uploaded_at        = 0;
static bool          g_new_firmware       = false;

static uint8_t       g_chunk_buf[OTA_CHUNK_SIZE];

// ── Forward decls ──────────────────────────────────────────────────
static void enter_state(OtaState next);
static void tick_check_version();
static void tick_download();
static void tick_verify();
static void tick_apply();
static void poll_control();
// ── Helpers ────────────────────────────────────────────────────────

static uint32_t read_flash_upload_ts() {
    const esp_partition_t* p = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "coredump");
    if (!p) return 0;
    uint8_t buf[8] = {0};
    if (esp_partition_read(p, UPLOAD_TS_PART_OFFSET, buf, 8) != ESP_OK) return 0;
    uint32_t magic;
    memcpy(&magic, buf, 4);
    if (magic != UPLOAD_TS_MAGIC) return 0;
    uint32_t ts;
    memcpy(&ts, buf + 4, 4);
    if (ts < 1000000000UL || ts > 0x7FFFFFFFUL) return 0;
    return ts;
}

// Persist the "uploaded at" timestamp to the coredump partition.
// Used by tick_apply() so OTA updates also refresh the upload time.
static void write_flash_upload_ts(uint32_t ts) {
    const esp_partition_t* p = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "coredump");
    if (!p) return;
    uint8_t buf[8];
    uint32_t magic = UPLOAD_TS_MAGIC;
    memcpy(buf, &magic, 4);
    memcpy(buf + 4, &ts, 4);
    esp_partition_erase_range(p, UPLOAD_TS_PART_OFFSET, 4096);
    esp_partition_write(p, UPLOAD_TS_PART_OFFSET, buf, 8);
}
static void load_nvs() {
    // Prefer the flash "uploaded at" marker — written on every USB flash by
    // post_upload.py and on every OTA by tick_apply(). Most accurate.
    uint32_t flash_ts = read_flash_upload_ts();

    Preferences prefs;
    if (prefs.begin(OTA_NVS_NS, true)) {
        // Load SHA-256 of the last applied firmware (for diagnostics)
        String s = prefs.getString(OTA_KEY_SHA, "");
        if (s.length() > 0) {
            strncpy(g_last_sha256, s.c_str(), sizeof(g_last_sha256) - 1);
            g_last_sha256[sizeof(g_last_sha256) - 1] = '\0';
        }
        g_last_force_id = prefs.getUInt(OTA_KEY_FORCE_ID, 0);
        if (flash_ts != 0) {
            g_uploaded_at  = flash_ts;
            g_new_firmware = false;
        } else {
            // Fallback: detect a freshly flashed firmware via compile
            // timestamp, then record upload time once the clock is valid.
            String compiled = prefs.getString(OTA_KEY_COMPILED, "");
            if (compiled != FIRMWARE_COMPILED_AT) {
                g_new_firmware = true;
                g_uploaded_at  = 0;
            } else {
                g_uploaded_at = prefs.getUInt(OTA_KEY_UPLOADED, 0);
            }
        }
        prefs.end();
    }
}
static void save_nvs_version() {
    Preferences prefs;
    if (prefs.begin(OTA_NVS_NS, false)) {
        prefs.putString(OTA_KEY_VER, g_current_ver);
        prefs.putString(OTA_KEY_SHA, g_last_sha256);
        prefs.putUInt(OTA_KEY_FORCE_ID, g_last_force_id);
        prefs.end();
    }
}

// Record the upload timestamp once the system clock is valid (NTP/RTC).
// Called every loop tick while g_new_firmware is set; writes NVS exactly once.
static void record_upload_time() {
    time_t now = time(nullptr);
    if (now <= 1000000000UL) return;   // clock not valid yet — try next tick

    g_uploaded_at = (uint32_t)now;
    Preferences prefs;
    if (prefs.begin(OTA_NVS_NS, false)) {
        prefs.putUInt(OTA_KEY_UPLOADED, g_uploaded_at);
        prefs.putString(OTA_KEY_COMPILED, FIRMWARE_COMPILED_AT);
        prefs.end();
    }
    g_new_firmware = false;

    struct tm t;
    if (localtime_r(&now, &t)) {
        Serial.printf("[OTA] Uploaded at: %04d-%02d-%02d %02d:%02d:%02d\n",
                      t.tm_year + 1900, t.tm_mon + 1, t.tm_mday,
                      t.tm_hour, t.tm_min, t.tm_sec);
    }
}

static bool valid_build_stamp(const char* stamp) {
    if (!stamp || strlen(stamp) != 20
        || stamp[4] != '-' || stamp[7] != '-' || stamp[10] != 'T'
        || stamp[13] != ':' || stamp[16] != ':' || stamp[19] != 'Z') return false;
    for (size_t i = 0; i < 20; ++i) {
        if (i == 4 || i == 7 || i == 10 || i == 13 || i == 16 || i == 19) continue;
        if (stamp[i] < '0' || stamp[i] > '9') return false;
    }
    const int month = (stamp[5] - '0') * 10 + stamp[6] - '0';
    const int day = (stamp[8] - '0') * 10 + stamp[9] - '0';
    const int hour = (stamp[11] - '0') * 10 + stamp[12] - '0';
    const int minute = (stamp[14] - '0') * 10 + stamp[15] - '0';
    const int second = (stamp[17] - '0') * 10 + stamp[18] - '0';
    return month >= 1 && month <= 12 && day >= 1 && day <= 31
        && hour <= 23 && minute <= 59 && second <= 59;
}

static bool valid_sha256(const char* value) {
    if (!value || strlen(value) != 64) return false;
    for (size_t i = 0; i < 64; ++i) {
        if (!isxdigit(static_cast<unsigned char>(value[i]))) return false;
    }
    return true;
}

static int build_stamp_cmp(const char* a, const char* b) {
    // ISO-8601 UTC timestamps sort lexicographically and represent the exact
    // compilation date and time. Versions and commit hashes never decide OTA.
    return strcmp(a, b);
}

// ── State entry ────────────────────────────────────────────────────

static void enter_state(OtaState next) {
    g_state = next;
    switch (next) {
    case OtaState::IDLE:
        g_version_known = false;
        g_bytes_written = 0;
        g_server_size   = 0;
        g_server_ver[0] = '\0';
        g_server_build[0] = '\0';
        g_server_sha256[0] = '\0';
        g_server_force_id = 0;
        g_force_update = false;
        break;
    case OtaState::CHECK_VERSION:
        // nothing to init — done in tick
        break;
    case OtaState::DOWNLOAD:
        led_request_state(LedState::OTA_DOWNLOADING);
        g_bytes_written = 0;
        g_dl_retry_at_ms = 0;
        break;
    case OtaState::VERIFY:
        led_release_state(LedState::OTA_DOWNLOADING);
        led_request_state(LedState::OTA_VERIFYING);
        break;
    case OtaState::APPLY:
        led_release_state(LedState::OTA_VERIFYING);
        // Solid blue while committing — brief
        led_request_state(LedState::OTA_APPLYING);
        break;
    case OtaState::ERROR:
        led_release_state(LedState::OTA_DOWNLOADING);
        led_release_state(LedState::OTA_VERIFYING);
        led_release_state(LedState::OTA_APPLYING);
        led_request_state(LedState::OTA_FAILED);
        g_error_until_ms = millis() + 10000;
        g_error_count++;  // cap retries — give up after 3 failures
        break;
    case OtaState::RETRY:
        g_retry_until_ms = millis() + OTA_RETRY_INTERVAL_MS;
        Serial.printf("[OTA] Server unreachable — retrying in %u min\n",
                      OTA_RETRY_INTERVAL_MS / 60000);
        break;
    }
}

static void tick_check_version() {
    // ── Bell-safe: defer if a bell is imminent ─────────────
    int32_t next_s = bell_core_next_fire_s();
    if (next_s >= 0 && next_s < (int32_t)OTA_BELL_CHECK_SAFE_S) {
        // A bell fires soon — don't risk blocking core 1 with HTTP
        g_next_daily_check_ms = millis() + 300000;  // retry in 5 min
        enter_state(OtaState::IDLE);
        return;
    }

    if (WiFi.status() != WL_CONNECTED) {
        enter_state(OtaState::RETRY);
        return;
    }

    WiFiClient client;
    HTTPClient http;
    http.setTimeout(2000);  // was 8000 — fast fail if server unreachable

    String url = String(network_server_base_url()) + "/api/firmware/version";
    if (!http.begin(client, url)) {
        http.end();
        enter_state(OtaState::RETRY);
        return;
    }
    http.addHeader("X-Bell-OTA-Protocol", String(OTA_PROTOCOL_VERSION));

    int code = http.GET();
    if (code != 200) {
        http.end();
        // 4xx client errors are definitive — no retry
        if (code >= 400 && code < 500 && code != 429) {
            Serial.printf("[OTA] Server returned %d — will retry tomorrow\n", code);
            g_next_daily_check_ms = millis() + OTA_DAILY_CHECK_INTERVAL_MS;
            enter_state(OtaState::IDLE);
        } else {
            enter_state(OtaState::RETRY);
        }
        return;
    }

    String body = http.getString();
    http.end();

    JsonDocument doc;
    if (deserializeJson(doc, body)) { enter_state(OtaState::RETRY); return; }
    const char* version = doc["version"] | "";
    const char* compiledAt = doc["compiled_at"] | "";
    const char* sha256 = doc["sha256"] | "";
    strncpy(g_server_ver, version, sizeof(g_server_ver) - 1);
    g_server_ver[sizeof(g_server_ver) - 1] = '\0';
    strncpy(g_server_build, compiledAt, sizeof(g_server_build) - 1);
    g_server_build[sizeof(g_server_build) - 1] = '\0';
    strncpy(g_server_sha256, sha256, sizeof(g_server_sha256) - 1);
    g_server_sha256[sizeof(g_server_sha256) - 1] = '\0';
    g_server_size = doc["size"] | 0U;
    g_server_force_id = doc["force_id"] | 0U;
    const bool serverForce = doc["force"] | false;
    g_force_update = serverForce && g_server_force_id != 0 && g_server_force_id != g_last_force_id;
    g_version_known = true;

    const uint32_t minimumProtocol = doc["min_ota_protocol"] | 1U;
    if (minimumProtocol > OTA_PROTOCOL_VERSION && !g_force_update) {
        Serial.printf("[OTA] Firmware requires OTA protocol %u; device supports %u - skipped\n",
                      minimumProtocol, OTA_PROTOCOL_VERSION);
        g_boot_check_done = true;
        g_next_daily_check_ms = millis() + OTA_DAILY_CHECK_INTERVAL_MS;
        enter_state(OtaState::IDLE);
        return;
    }

    if (!valid_build_stamp(g_server_build) && !g_force_update) {
        Serial.println(F("[OTA] Server firmware has no trusted compilation timestamp - skipped"));
        g_boot_check_done = true;
        g_next_daily_check_ms = millis() + OTA_DAILY_CHECK_INTERVAL_MS;
        enter_state(OtaState::IDLE);
        return;
    }

    const bool already_applied = g_last_sha256[0] && strcasecmp(g_server_sha256, g_last_sha256) == 0;
    if (already_applied || (!g_force_update && build_stamp_cmp(g_server_build, FIRMWARE_BUILD_STAMP) <= 0)) {
        Serial.printf("[OTA] Up to date (compiled current=%s, server=%s)\n",
                      FIRMWARE_BUILD_STAMP, g_server_build);
        g_boot_check_done = true;
        g_error_count = 0;
        g_next_daily_check_ms = millis() + OTA_DAILY_CHECK_INTERVAL_MS;
        enter_state(OtaState::IDLE);
        return;
    }

    if (g_force_update) {
        Serial.printf("[OTA] WARNING: forced firmware install #%u requested by dashboard\n", g_server_force_id);
    } else {
        Serial.printf("[OTA] New firmware compiled %s is newer than %s (%u bytes)\n",
                      g_server_build, FIRMWARE_BUILD_STAMP, g_server_size);
    }
    const esp_partition_t* next_ota = esp_ota_get_next_update_partition(nullptr);
    const uint32_t max_ota_size = next_ota ? next_ota->size : 0;
    if (g_server_size == 0 || g_server_size > max_ota_size) {
        Serial.println(F("[OTA] Invalid firmware size - aborting"));
        enter_state(OtaState::ERROR);
        return;
    }
    if (!valid_sha256(g_server_sha256)) {
        Serial.println(F("[OTA] Invalid SHA-256 provided by server - aborting"));
        enter_state(OtaState::ERROR);
        return;
    }
    enter_state(OtaState::DOWNLOAD);
}

static void tick_download() {
    if (WiFi.status() != WL_CONNECTED) {
        g_dl_retry_at_ms = millis() + OTA_RESUME_RETRY_MS;
        return;
    }
    if (millis() < g_dl_retry_at_ms) return;

    int32_t next_s = bell_core_next_fire_s();
    if (next_s >= 0 && next_s < (int32_t)OTA_BELL_SAFE_WINDOW_S) {
        g_dl_retry_at_ms = millis() + 30000;
        return;
    }

    if (g_bytes_written == 0) {
        Update.abort();
        if (!Update.begin(g_server_size, U_FLASH)) {
            Serial.printf("[OTA] Update.begin() failed: %s\n", Update.errorString());
            enter_state(OtaState::ERROR);
            return;
        }
        Serial.printf("[OTA] Downloading %u bytes...\n", g_server_size);
    }

    String url = String(network_server_base_url()) + "/api/firmware/download?v=" + g_server_ver
               + "&sha=" + g_server_sha256;
    WiFiClient client;
    HTTPClient http;
    http.setTimeout(OTA_CHUNK_TIMEOUT_MS);
    if (!http.begin(client, url)) {
        g_dl_retry_at_ms = millis() + OTA_RESUME_RETRY_MS;
        http.end();
        return;
    }
    const char* responseHeaders[] = { "Content-Range" };
    http.collectHeaders(responseHeaders, 1);
    if (g_bytes_written > 0) {
        http.addHeader("Range", String("bytes=") + g_bytes_written + "-");
    }

    int code = http.GET();
    if (code == 409) {
        Serial.println(F("[OTA] Firmware artifact changed; restarting with fresh metadata"));
        http.end();
        Update.abort();
        g_bytes_written = 0;
        enter_state(OtaState::CHECK_VERSION);
        return;
    }
    if (code != 200 && code != 206) {
        http.end();
        g_dl_retry_at_ms = millis() + OTA_RESUME_RETRY_MS;
        return;
    }
    if (g_bytes_written > 0 && code != 206) {
        // Never append a full-file response to a partial OTA image.
        Serial.println(F("[OTA] Server ignored resume range; restarting download"));
        http.end();
        Update.abort();
        g_bytes_written = 0;
        g_dl_retry_at_ms = millis() + OTA_RESUME_RETRY_MS;
        return;
    }

    if (g_bytes_written > 0) {
        const String expectedRange = String("bytes ") + g_bytes_written + "-";
        if (!http.header("Content-Range").startsWith(expectedRange)) {
            Serial.println(F("[OTA] Invalid resume range; restarting download"));
            http.end();
            Update.abort();
            g_bytes_written = 0;
            g_dl_retry_at_ms = millis() + OTA_RESUME_RETRY_MS;
            return;
        }
    }

    WiFiClient* stream = http.getStreamPtr();
    if (!stream || !stream->connected()) {
        http.end();
        g_dl_retry_at_ms = millis() + OTA_RESUME_RETRY_MS;
        return;
    }

    uint32_t chunk_start = millis();
    size_t chunk_read = 0;
    while (chunk_read < OTA_CHUNK_SIZE && (millis() - chunk_start) < OTA_TICK_WINDOW_MS) {
        int avail = stream->available();
        if (avail <= 0) { if (!stream->connected()) break; delay(10); continue; }
        size_t to_read = (size_t)avail < (OTA_CHUNK_SIZE - chunk_read) ? (size_t)avail : (OTA_CHUNK_SIZE - chunk_read);
        int n = stream->read(g_chunk_buf + chunk_read, to_read);
        if (n <= 0) break;
        chunk_read += n;
    }

    if (chunk_read > 0) {
        size_t written = Update.write(g_chunk_buf, chunk_read);
        if (written != chunk_read) {
            Serial.printf("[OTA] Write error at %u: %s\n", g_bytes_written, Update.errorString());
            http.end();
            Update.abort();
            enter_state(OtaState::ERROR);
            return;
        }
        g_bytes_written += written;
        if (g_bytes_written > g_server_size) {
            Serial.println(F("[OTA] Download exceeded declared size; discarding"));
            http.end();
            Update.abort();
            enter_state(OtaState::ERROR);
            return;
        }
        if (g_bytes_written % 65536 == 0 || g_bytes_written >= g_server_size) {
            Serial.printf("[OTA] Progress: %u / %u bytes\n", g_bytes_written, g_server_size);
        }
    }

    bool done = (g_bytes_written >= g_server_size);
    if (!done && code == 200) {
        int cl = http.getSize();
        if (cl > 0 && g_bytes_written >= (size_t)cl) done = true;
    }
    http.end();

    if (!done && chunk_read == 0) {
        g_dl_retry_at_ms = millis() + OTA_RESUME_RETRY_MS;
        return;
    }
    if (done) {
        Serial.printf("[OTA] Download complete: %u bytes\n", g_bytes_written);
        enter_state(OtaState::VERIFY);
    }
}

static void tick_verify() {
    if (!Update.end()) {
        Serial.printf("[OTA] Update.end() failed: %s\n", Update.errorString());
        enter_state(OtaState::ERROR);
        return;
    }

    // Compute SHA‑256 of the written partition
    const esp_partition_t* update_part = esp_ota_get_next_update_partition(nullptr);
    if (!update_part) {
        Serial.println(F("[OTA] No update partition found"));
        enter_state(OtaState::ERROR);
        return;
    }

    // Read the written firmware and hash it
    mbedtls_sha256_context ctx;
    mbedtls_sha256_init(&ctx);
    mbedtls_sha256_starts(&ctx, 0); // 0 = SHA‑256, not SHA‑224

    const size_t read_size = g_bytes_written; // only hash what we wrote
    uint8_t read_buf[256];
    size_t offset = 0;

    // Map the partition for reading (ESP32 can mmap flash)
    esp_err_t map_err;
    const void* map_ptr;
    spi_flash_mmap_handle_t map_handle;

    map_err = esp_partition_mmap(update_part, 0, read_size,
                                  SPI_FLASH_MMAP_DATA, &map_ptr, &map_handle);
    if (map_err == ESP_OK) {
        mbedtls_sha256_update(&ctx, (const uint8_t*)map_ptr, read_size);
        spi_flash_munmap(map_handle);
    } else {
        // Fallback: read in chunks
        for (offset = 0; offset < read_size; offset += sizeof(read_buf)) {
            size_t chunk = read_size - offset;
            if (chunk > sizeof(read_buf)) chunk = sizeof(read_buf);
            if (esp_partition_read(update_part, offset, read_buf, chunk) != ESP_OK) {
                Serial.println(F("[OTA] Flash read error during verify"));
                mbedtls_sha256_free(&ctx);
                enter_state(OtaState::ERROR);
                return;
            }
            mbedtls_sha256_update(&ctx, read_buf, chunk);
        }
    }

    uint8_t hash[32];
    mbedtls_sha256_finish(&ctx, hash);
    mbedtls_sha256_free(&ctx);

    // Convert to hex
    char computed_hex[65];
    for (int i = 0; i < 32; i++) {
        snprintf(computed_hex + i * 2, 3, "%02x", hash[i]);
    }
    computed_hex[64] = '\0';

    Serial.printf("[OTA] SHA‑256 computed:  %s\n", computed_hex);
    Serial.printf("[OTA] SHA‑256 expected: %s\n", g_server_sha256);

    if (strcasecmp(computed_hex, g_server_sha256) != 0) {
        Serial.println(F("[OTA] SHA‑256 MISMATCH — firmware corrupt, discarding"));
        enter_state(OtaState::ERROR);
        return;
    }

    Serial.println(F("[OTA] SHA‑256 verified — firmware is valid"));
    enter_state(OtaState::APPLY);
}

static void tick_apply() {
    // Commit the OTA partition — this tells the bootloader to
    // boot from the new partition on next reset.
    if (esp_ota_set_boot_partition(esp_ota_get_next_update_partition(nullptr)) != ESP_OK) {
        Serial.println(F("[OTA] Failed to set boot partition"));
        enter_state(OtaState::ERROR);
        return;
    }

    // Persist new version and SHA‑256 BEFORE reboot
    strncpy(g_current_ver, g_server_ver, sizeof(g_current_ver) - 1);
    g_current_ver[sizeof(g_current_ver) - 1] = '\0';
    strncpy(g_last_sha256, g_server_sha256, sizeof(g_last_sha256) - 1);
    g_last_sha256[sizeof(g_last_sha256) - 1] = '\0';
    if (g_force_update) g_last_force_id = g_server_force_id;
    save_nvs_version();

    // Record the OTA apply time so "uploaded at" reflects it (clock is valid
    // long after NTP syncs during download). Falls back to boot-time NTP.
    time_t now = time(nullptr);
    if (now > 1000000000UL) write_flash_upload_ts((uint32_t)now);

    Serial.printf("[OTA] Update committed — rebooting to %s\n", g_current_ver);
    Serial.flush();
    delay(500);
    ESP.restart();
}

static void tick_error() {
    // Hold ERROR LED state for cooldown, then clear
    if (millis() >= g_error_until_ms) {
        led_release_state(LedState::OTA_FAILED);
        // After 3 consecutive errors, back off until the next daily check
        // instead of giving up permanently.
        if (g_error_count >= 3) {
            g_next_daily_check_ms = millis() + OTA_DAILY_CHECK_INTERVAL_MS;
        }
        enter_state(OtaState::IDLE);
    }
}

static void acknowledge_control(uint32_t control_id, uint32_t request_id) {
    WiFiClient client;
    HTTPClient http;
    http.setTimeout(500);
    const String url = String(network_server_base_url()) + "/api/firmware/device-status";
    if (!http.begin(client, url)) return;
    http.addHeader("Content-Type", "application/json");
    JsonDocument doc;
    doc["control_id"] = control_id;
    doc["request_id"] = request_id;
    doc["auto_update"] = g_auto_update_enabled;
    doc["firmware_version"] = g_current_ver;
    doc["compiled_at"] = FIRMWARE_BUILD_STAMP;
    doc["ota_protocol"] = OTA_PROTOCOL_VERSION;
    String body;
    serializeJson(doc, body);
    http.POST(body);
    http.end();
}

static void poll_control() {
    const uint32_t now = millis();
    if (now - g_last_control_poll < OTA_CONTROL_POLL_MS) return;
    g_last_control_poll = now;
    if (WiFi.status() != WL_CONNECTED || !network_server_base_url()[0]) return;
    const int32_t next_bell_s = bell_core_next_fire_s();
    if (next_bell_s >= 0 && next_bell_s < (int32_t)OTA_BELL_CHECK_SAFE_S) return;

    WiFiClient client;
    HTTPClient http;
    http.setTimeout(1000);
    const String url = String(network_server_base_url()) + "/api/firmware/control";
    if (!http.begin(client, url)) return;
    if (http.GET() != 200) { http.end(); return; }

    JsonDocument doc;
    const DeserializationError err = deserializeJson(doc, http.getStream());
    http.end();
    if (err) return;

    const bool auto_update_enabled = doc["auto_update"] | true;
    const uint32_t control_id = doc["control_id"] | 0U;
    const uint32_t request_id = doc["request_id"] | 0U;
    if (auto_update_enabled && !g_auto_update_enabled) {
        g_boot_check_done = false;
        g_next_daily_check_ms = 0;
    }
    if (auto_update_enabled != g_auto_update_enabled) {
        Serial.printf("[OTA] Daily updates %s by dashboard\n", auto_update_enabled ? "enabled" : "disabled");
    }
    g_auto_update_enabled = auto_update_enabled;
    if (control_id != 0 && control_id != g_last_control_id) {
        g_last_control_id = control_id;
        acknowledge_control(control_id, request_id);
        Serial.printf("[OTA] Dashboard control #%u acknowledged\n", control_id);
    }
    if (request_id != 0 && request_id != g_last_control_request) {
        g_last_control_request = request_id;
        ota_request_check();
        Serial.printf("[OTA] Dashboard requested update check #%u\n", request_id);
    }
}

static void tick_retry() {
    if (millis() >= g_retry_until_ms) {
        Serial.println(F("[OTA] Retry timer expired — checking again"));
        enter_state(OtaState::CHECK_VERSION);
    }
}

// ── Public API ─────────────────────────────────────────────────────

void ota_init() {
    load_nvs();
    Serial.printf("[OTA] Firmware version: %s\n", g_current_ver);
    Serial.printf("[OTA] Compiled at: %s\n", FIRMWARE_BUILD_MARKER + 11);
    Serial.printf("[OTA] Protocol: %s (minimum device protocol: %s)\n",
                  FIRMWARE_OTA_PROTOCOL_MARKER + 18,
                  FIRMWARE_OTA_MIN_PROTOCOL_MARKER + 22);
    if (g_last_sha256[0]) {
        Serial.printf("[OTA] Last applied SHA‑256: %.16s...\n", g_last_sha256);
    }
}


void ota_confirm_boot_if_stable() {
    static bool confirmed = false;
    if (confirmed) return;

    if (!bell_core_is_scheduler_ready()) return;

    if (millis() < OTA_BOOT_CONFIRM_DELAY_MS) return;

    esp_ota_mark_app_valid_cancel_rollback();
    Serial.println("[OTA] Boot confirmed stable — rollback protection cancelled");
    confirmed = true;
}
bool ota_tick() {
    // Record the upload timestamp on the first boot of a new firmware,
    // once the system clock is valid. No-op after that.
    if (g_new_firmware) record_upload_time();

    if (!ota_busy()) poll_control();

    switch (g_state) {
    case OtaState::IDLE: {
        uint32_t now = millis();

        // Manual trigger bypasses all scheduling — cancel any pending daily timer
        if (g_check_requested) {
            g_check_requested = false;
            g_next_daily_check_ms = 0;
            enter_state(OtaState::CHECK_VERSION);
            return true;
        }

        if (!g_auto_update_enabled) return false;

        // Don't check during error cooldown
        if (now < g_error_until_ms) return false;

        // Daily check timer: block if not yet due, reset blockers if expired
        if (g_next_daily_check_ms) {
            if ((int32_t)(now - g_next_daily_check_ms) < 0) return false;  // not yet due
            g_boot_check_done = false;
            g_error_count    = 0;
            g_next_daily_check_ms = 0;
        }

        // Still blocked after any daily reset?
        if (g_boot_check_done) return false;
        if (g_error_count >= 3) return false;

        // Wait for WiFi to settle after boot (first 60 s only — irrelevant after that)
        if (now < OTA_FIRST_CHECK_DELAY_MS) return false;
        if (WiFi.status() != WL_CONNECTED) return false;
        // ── Bell-safe: don't start HTTP if a bell fires soon ──
        // (manual triggers via g_check_requested bypass this — they're explicit)
        {
            int32_t next_s = bell_core_next_fire_s();
            if (next_s >= 0 && next_s < (int32_t)OTA_BELL_CHECK_SAFE_S) {
                return false;  // defer — try again next tick
            }
        }

        Serial.println(F("[OTA] Checking for updates..."));
        enter_state(OtaState::CHECK_VERSION);
        return true;
    }
    case OtaState::CHECK_VERSION:
        tick_check_version();
        return true;
    case OtaState::DOWNLOAD:
        tick_download();
        return true;
    case OtaState::VERIFY:
        tick_verify();
        return true;
    case OtaState::APPLY:
        tick_apply();
        return true;
    case OtaState::ERROR:
        tick_error();
        return false;
    case OtaState::RETRY:
        tick_retry();
        return false;
    }
    return false;
}

void ota_request_check() {
    g_check_requested = true;
}

bool ota_busy() {
    return g_state != OtaState::IDLE && g_state != OtaState::ERROR && g_state != OtaState::RETRY;
}
const char* ota_current_version() { return g_current_ver; }
const char* ota_server_version()  { return g_version_known ? g_server_ver : ""; }
const char* ota_last_sha256()     { return g_last_sha256; }

const char* ota_uploaded_at() {
    static char buf[24];
    if (g_uploaded_at == 0) return "n/a";
    time_t tsec = (time_t)g_uploaded_at;
    struct tm t;
    if (!localtime_r(&tsec, &t)) return "n/a";
    snprintf(buf, sizeof(buf), "%04d-%02d-%02d %02d:%02d:%02d",
             t.tm_year + 1900, t.tm_mon + 1, t.tm_mday,
             t.tm_hour, t.tm_min, t.tm_sec);
    return buf;
}
