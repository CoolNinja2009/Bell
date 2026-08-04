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

// ── Timing ─────────────────────────────────────────────────────────
// Morning check: every day at or after 3 AM local time (uses NTP).
// Falls back to 24h millis-based interval when NTP is unavailable.
constexpr uint32_t OTA_FALLBACK_INTERVAL_MS = 86400000; // 24h — used when NTP is down
constexpr uint32_t OTA_MORNING_HOUR         = 3;        // check at/after 3 AM local
constexpr uint32_t OTA_FIRST_CHECK_DELAY_MS = 60000;    // wait 60s after boot before 1st check
constexpr uint32_t OTA_TIME_POLL_MS         = 5000;     // re-check time every 5s in IDLE
constexpr uint32_t OTA_RETRY_INTERVAL_MS    = 1800000;  // 30 min between retries
constexpr uint32_t OTA_BELL_SAFE_WINDOW_S   = 600;      // pause OTA if bell within 10 min
constexpr uint32_t OTA_CHUNK_TIMEOUT_MS     = 15000;    // HTTP timeout per chunk
constexpr uint32_t OTA_CHUNK_SIZE           = 4096;     // bytes per loop tick
constexpr uint32_t OTA_RESUME_RETRY_MS      = 5000;     // backoff after a failed chunk

// ── NVS keys ───────────────────────────────────────────────────────
static const char OTA_NVS_NS[]      = "ota";
static const char OTA_KEY_VER[]     = "version";
static const char OTA_KEY_SHA[]     = "sha256";
static const char OTA_KEY_LAST_DAY[] = "last_day"; // YYYYMMDD packed as uint32_t

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
static uint32_t      g_last_check_ms      = 0;
static uint32_t      g_error_until_ms     = 0;
static uint32_t      g_dl_retry_at_ms     = 0;
static uint32_t      g_last_time_poll_ms  = 0;
static uint32_t      g_last_check_day     = 0;   // packed YYYYMMDD, persisted in NVS
static uint32_t      g_retry_until_ms     = 0;   // when to attempt next retry
static bool          g_check_requested    = false;
// ── Version tracking ───────────────────────────────────────────────
static char          g_current_ver[32]    = FIRMWARE_VERSION;
static char          g_server_ver[32]     = "";
static char          g_server_sha256[65]  = "";
static char          g_last_sha256[65]    = "";
static uint32_t      g_server_size        = 0;
static uint32_t      g_bytes_written      = 0;
static bool          g_version_known      = false;

// ── HTTP client (recreated per chunk) ──────────────────────────────
static WiFiClient    g_tcp;
static HTTPClient    g_http;
static uint8_t       g_chunk_buf[OTA_CHUNK_SIZE];

// ── Forward decls ──────────────────────────────────────────────────
static void enter_state(OtaState next);
static void tick_check_version();
static void tick_download();
static void tick_verify();
static void tick_apply();
static void tick_error();
static void tick_retry();

// ── Helpers ────────────────────────────────────────────────────────

static void load_nvs() {
    Preferences prefs;
    if (prefs.begin(OTA_NVS_NS, true)) {
        String v = prefs.getString(OTA_KEY_VER, "");
        if (v.length() > 0) {
            strncpy(g_current_ver, v.c_str(), sizeof(g_current_ver) - 1);
            g_current_ver[sizeof(g_current_ver) - 1] = '\0';
        }
        String s = prefs.getString(OTA_KEY_SHA, "");
        if (s.length() > 0) {
            strncpy(g_last_sha256, s.c_str(), sizeof(g_last_sha256) - 1);
            g_last_sha256[sizeof(g_last_sha256) - 1] = '\0';
        }
        g_last_check_day = prefs.getUInt(OTA_KEY_LAST_DAY, 0);
        prefs.end();
    }
}

static void save_nvs_version() {
    Preferences prefs;
    if (prefs.begin(OTA_NVS_NS, false)) {
        prefs.putString(OTA_KEY_VER, g_current_ver);
        prefs.putString(OTA_KEY_SHA, g_last_sha256);
        prefs.end();
    }
}

// Pack today's local date as YYYYMMDD (e.g. 20260804).
// Returns 0 if NTP hasn't synced yet (year < 2024).
static uint32_t pack_today() {
    time_t now;
    time(&now);
    if (now < 1704067200) return 0; // before 2024-01-01 = NTP not synced
    struct tm ti;
    localtime_r(&now, &ti);
    return (uint32_t)(ti.tm_year + 1900) * 10000U
         + (uint32_t)(ti.tm_mon + 1) * 100U
         + (uint32_t)ti.tm_mday;
}

// Check if it's "morning" — hour >= OTA_MORNING_HOUR local time.
// Returns false if NTP not synced.
static bool is_morning() {
    time_t now;
    time(&now);
    if (now < 1704067200) return false;
    struct tm ti;
    localtime_r(&now, &ti);
    return ti.tm_hour >= (int)OTA_MORNING_HOUR;
}

static void persist_last_check_day() {
    Preferences prefs;
    if (prefs.begin(OTA_NVS_NS, false)) {
        prefs.putUInt(OTA_KEY_LAST_DAY, g_last_check_day);
        prefs.end();
    }
}

static int version_cmp(const char* a, const char* b) {
    // Semantic version compare: major.minor.patch
    int ma = 0, mi = 0, pa = 0;
    int mb = 0, mj = 0, pb = 0;
    sscanf(a, "%d.%d.%d", &ma, &mi, &pa);
    sscanf(b, "%d.%d.%d", &mb, &mj, &pb);
    if (ma != mb) return ma - mb;
    if (mi != mj) return mi - mj;
    return pa - pb;
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
        g_server_sha256[0] = '\0';
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
        break;
    case OtaState::RETRY:
        g_retry_until_ms = millis() + OTA_RETRY_INTERVAL_MS;
        Serial.printf("[OTA] Server unreachable — retrying in %u min\n",
                      OTA_RETRY_INTERVAL_MS / 60000);
        break;
    }
}

// ── Tick functions ─────────────────────────────────────────────────

static void tick_check_version() {
    if (WiFi.status() != WL_CONNECTED) {
        enter_state(OtaState::RETRY);
        return;
    }

    WiFiClient client;
    HTTPClient http;
    http.setTimeout(8000);

    String url = String(network_server_base_url()) + "/api/firmware/version";
    if (!http.begin(client, url)) {
        http.end();
        enter_state(OtaState::RETRY);
        return;
    }

    int code = http.GET();
    if (code != 200) {
        http.end();
        // 4xx client errors are definitive — no retry
        if (code >= 400 && code < 500 && code != 429) {
            Serial.printf("[OTA] Server returned %d — will retry tomorrow\n", code);
            enter_state(OtaState::IDLE);
        } else {
            enter_state(OtaState::RETRY);
        }
        return;
    }

    String body = http.getString();
    http.end();

    // Parse: {"version":"1.2.3","size":786432,"sha256":"abc...64 hex chars"}
    const char* p = body.c_str();

    // Extract version
    const char* vtag = strstr(p, "\"version\"");
    if (!vtag) { enter_state(OtaState::RETRY); return; }
    vtag = strchr(vtag, ':');
    if (!vtag) { enter_state(OtaState::RETRY); return; }
    vtag++; while (*vtag == ' ' || *vtag == '"') vtag++;
    size_t vlen = 0;
    while (vtag[vlen] && vtag[vlen] != '"' && vlen < sizeof(g_server_ver) - 1) vlen++;
    memcpy(g_server_ver, vtag, vlen);
    g_server_ver[vlen] = '\0';

    // Extract size
    const char* stag = strstr(p, "\"size\"");
    if (stag) {
        stag = strchr(stag, ':');
        if (stag) { stag++; g_server_size = atol(stag); }
    }

    // Extract sha256
    const char* htag = strstr(p, "\"sha256\"");
    if (htag) {
        htag = strchr(htag, ':');
        if (htag) {
            htag++; while (*htag == ' ' || *htag == '"') htag++;
            size_t hlen = 0;
            while (htag[hlen] && htag[hlen] != '"' && hlen < 64) hlen++;
            memcpy(g_server_sha256, htag, hlen);
            g_server_sha256[hlen] = '\0';
        }
    }

    g_version_known = true;

    // Compare versions — this is a definitive answer
    if (version_cmp(g_server_ver, g_current_ver) <= 0) {
        Serial.printf("[OTA] Up to date (current=%s, server=%s)\n",
                      g_current_ver, g_server_ver);
        enter_state(OtaState::IDLE);  // definitive — wait until tomorrow
        return;
    }

    Serial.printf("[OTA] New version available: %s -> %s (%u bytes)\n",
                  g_current_ver, g_server_ver, g_server_size);

    if (g_server_size == 0 || g_server_size > 0x180000) {
        Serial.println(F("[OTA] Invalid firmware size — aborting"));
        enter_state(OtaState::ERROR);
        return;
    }

    if (g_server_sha256[0] == '\0') {
        Serial.println(F("[OTA] No SHA‑256 provided by server — aborting"));
        enter_state(OtaState::ERROR);
        return;
    }

    enter_state(OtaState::DOWNLOAD);
}

static void tick_download() {
    if (WiFi.status() != WL_CONNECTED) {
        // WiFi dropped — will resume on reconnect
        g_dl_retry_at_ms = millis() + OTA_RESUME_RETRY_MS;
        return;
    }

    if (millis() < g_dl_retry_at_ms) return;

    // ── Bell‑aware pause: don't download when a bell is imminent ──
    int32_t next_s = bell_core_next_fire_s();
    if (next_s >= 0 && next_s < (int32_t)OTA_BELL_SAFE_WINDOW_S) {
        // Bell within 10 minutes — pause, retry in 30s
        g_dl_retry_at_ms = millis() + 30000;
        return;
    }
    // First chunk: begin Update
    if (g_bytes_written == 0) {
        if (!Update.begin(g_server_size, U_FLASH)) {
            Serial.printf("[OTA] Update.begin() failed: %s\n", Update.errorString());
            enter_state(OtaState::ERROR);
            return;
        }
    }

    // Build URL — append ?v= to bust any proxy cache
    String url = String(network_server_base_url()) + "/api/firmware/download?v=" + g_server_ver;

    // New connection per chunk (allows server to handle Range independently)
    WiFiClient client;
    HTTPClient http;
    http.setTimeout(OTA_CHUNK_TIMEOUT_MS);

    if (!http.begin(client, url)) {
        g_dl_retry_at_ms = millis() + OTA_RESUME_RETRY_MS;
        http.end();
        return;
    }

    // Add Range header for resume
    if (g_bytes_written > 0) {
        http.addHeader("Range", String("bytes=") + g_bytes_written + "-");
    }

    int code = http.GET();
    if (code != 200 && code != 206) {
        Serial.printf("[OTA] Download HTTP %d\n", code);
        http.end();
        g_dl_retry_at_ms = millis() + OTA_RESUME_RETRY_MS;
        return;
    }

    // Read one chunk
    WiFiClient* stream = http.getStreamPtr();
    if (!stream || !stream->connected()) {
        http.end();
        g_dl_retry_at_ms = millis() + OTA_RESUME_RETRY_MS;
        return;
    }

    // Wait up to OTA_CHUNK_TIMEOUT_MS for data
    uint32_t chunk_start = millis();
    size_t chunk_read = 0;
    while (chunk_read < OTA_CHUNK_SIZE &&
           (millis() - chunk_start) < OTA_CHUNK_TIMEOUT_MS) {
        int avail = stream->available();
        if (avail <= 0) {
            if (!stream->connected()) break;
            delay(10);
            continue;
        }
        size_t to_read = (size_t)avail < (OTA_CHUNK_SIZE - chunk_read)
                       ? (size_t)avail : (OTA_CHUNK_SIZE - chunk_read);
        int n = stream->read(g_chunk_buf + chunk_read, to_read);
        if (n <= 0) break;
        chunk_read += n;
    }

    if (chunk_read > 0) {
        size_t written = Update.write(g_chunk_buf, chunk_read);
        if (written != chunk_read) {
            Serial.printf("[OTA] Flash write error: %s\n", Update.errorString());
            http.end();
            Update.abort();
            enter_state(OtaState::ERROR);
            return;
        }
        g_bytes_written += written;
    }

    // Check if we're done
    bool done = (g_bytes_written >= g_server_size);
    // Also check Content-Length from the response if available
    if (!done && code == 200) {
        int cl = http.getSize();
        if (cl > 0 && g_bytes_written >= (size_t)cl) done = true;
    }

    http.end();

    if (!done && chunk_read == 0) {
        // No data — server might be slow; back off
        g_dl_retry_at_ms = millis() + OTA_RESUME_RETRY_MS;
        return;
    }

    if (done) {
        Serial.printf("[OTA] Download complete: %u bytes\n", g_bytes_written);
        enter_state(OtaState::VERIFY);
    }
    // else: continue next tick
}

static void tick_verify() {
    if (!Update.end()) {
        Serial.printf("[OTA] Update.end() failed: %s\n", Update.errorString());
        enter_state(OtaState::ERROR);
        return;
    }

    // Compute SHA‑256 of the written partition
    const esp_partition_t* running = esp_ota_get_running_partition();
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

    const size_t part_size = update_part->size;
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
    save_nvs_version();

    Serial.printf("[OTA] Update committed — rebooting to %s\n", g_current_ver);
    Serial.flush();
    delay(500);
    ESP.restart();
}

static void tick_error() {
    // Hold ERROR LED state for cooldown, then clear
    if (millis() >= g_error_until_ms) {
        led_release_state(LedState::OTA_FAILED);
        enter_state(OtaState::IDLE);
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
    if (g_last_sha256[0]) {
        Serial.printf("[OTA] Last applied SHA‑256: %.16s...\n", g_last_sha256);
    }
    // Boot confirmation: tell ESP-IDF the current image is good
    // (this resets the rollback counter — if we booted, we're stable)
    esp_ota_mark_app_valid_cancel_rollback();
}

bool ota_tick() {
    switch (g_state) {
    case OtaState::IDLE: {
        uint32_t now = millis();

        // Manual trigger bypasses all scheduling
        if (g_check_requested) {
            g_check_requested = false;
            enter_state(OtaState::CHECK_VERSION);
            return true;
        }

        // Don't check during error cooldown
        if (now < g_error_until_ms) return false;

        // Must wait at least FIRST_CHECK_DELAY after boot (let WiFi/NTP settle)
        if (now < OTA_FIRST_CHECK_DELAY_MS) return false;

        // Re-evaluate time every OTA_TIME_POLL_MS
        if (now - g_last_time_poll_ms < OTA_TIME_POLL_MS) return false;
        g_last_time_poll_ms = now;

        uint32_t today = pack_today();

        if (today > 0 && today >= 20240101) {
            // ── NTP is synced: morning check ──
            if (today != g_last_check_day && is_morning()) {
                Serial.printf("[OTA] Morning check — day %u, new firmware?\n", today);
                g_last_check_day = today;
                persist_last_check_day();
                enter_state(OtaState::CHECK_VERSION);
                return true;
            }
        } else {
            // ── NTP not synced: fall back to 24h millis interval ──
            if (now - g_last_check_ms >= OTA_FALLBACK_INTERVAL_MS) {
                Serial.println(F("[OTA] 24h fallback check (NTP unavailable)"));
                g_last_check_ms = now;
                enter_state(OtaState::CHECK_VERSION);
                return true;
            }
        }
        return false;
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
