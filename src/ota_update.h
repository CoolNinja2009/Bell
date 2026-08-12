/*
 * ota_update.h  —  Failproof Over‑the‑Air Firmware Update
 * ─────────────────────────────────────────────────────────────────
 * Minimal, hard‑to‑break OTA client for the ESP32 relay controller.
 *
 * Safety guarantees:
 *   1. Dual OTA partition (ota_0 / ota_1) — one partition is always
 *      bootable, even when the other is mid‑write.
 *   2. SHA‑256 verified before commit. A corrupt download is caught
 *      and discarded; the device stays on the current firmware.
 *   3. Version delta — only updates when server version is strictly
 *      newer. Never downgrades (downgrade = lost safety patches).
 *   4. HTTP Range resume. An interrupted download picks up where it
 *      left off — no wasted bytes on slow / flaky WiFi.
 *   5. Factory partition is NEVER touched by OTA. If everything goes
 *      wrong, USB‑flash the factory image and you're back.
 *
 * Integration:
 *   Call ota_tick() once per loop() iteration. It is non‑blocking:
 *   download chunks are fetched in the background, each HTTP call
 *   has a short timeout, and the relay scheduler still runs.
 *
 *   The module uses LED overrides for progress feedback:
 *     - OTA_DOWNLOADING: blue breathing
 *     - OTA_VERIFYING:   blue blink
 *     - OTA_APPLYING:    blue solid → device reboots
 *     - OTA_FAILED:      red blink for 10 s, then clears
 */
#pragma once

#include <Arduino.h>

// ── API ────────────────────────────────────────────────────────────

/** One‑shot: call once during setup(). No WiFi / server dependency. */
void ota_init();

/** Call once per loop() iteration. Defers rollback-cancel until the
 *  scheduler is ready AND OTA_BOOT_CONFIRM_DELAY_MS has elapsed.
 *  Non‑blocking; becomes a no‑op after first confirmation. */
void ota_confirm_boot_if_stable();

/** Non‑blocking tick. Call every loop() iteration.
 *  Returns true while an update is in progress (caller may choose to
 *  suppress network poll timers to avoid contention). */
bool ota_tick();

/** Trigger a manual update check at the next tick (for command‑poll
 *  driven updates). Safe to call from any context. */
void ota_request_check();

/** True if an OTA update is currently downloading / verifying. */
bool ota_busy();

// ── Version helpers (persisted in NVS) ─────────────────────────────

/** Current firmware version string (NVS‑persisted, set at build time). */
const char* ota_current_version();

/** Latest server version string (set after a successful `/api/firmware/version` poll). */
const char* ota_server_version();

/** SHA‑256 of the last SUCCESSFULLY applied update (hex, 64 chars + null). */
const char* ota_last_sha256();

/** Formatted upload time "YYYY-MM-DD HH:MM:SS" of the current firmware,
 *  or "n/a" if not yet recorded (first boot before NTP sync). */
const char* ota_uploaded_at();
