/*
 * main.cpp  —  ESP32 Dual‑Channel Relay Controller
 * ─────────────────────────────────────────────────────────────────
 * Minimal glue. Initialises the Bell Management Core first (so bells
 * can ring from NVS immediately), then starts network synchronisation
 * on a dedicated FreeRTOS task (core 0).
 *
 * Architecture (dual-core):
 *   core 1 (loop):  bell_core_tick → ota_tick → led_indicator_tick
 *   core 0 (task):  network_sync_task_fn — all HTTP I/O
 *
 * The Bell Core never touches WiFi. Network I/O never blocks the Bell
 * Core. If the network module crashes, bells continue ringing.
 *
 * LED lifecycle:
 *   BOOTING → requested before any init, released when scheduler ready
 *   HEALTHY → default fallback when no other state is active
 */
#include <Arduino.h>
#include "bell_core.h"
#include "network_sync.h"
#include "led_indicator.h"
#include "ota_update.h"
#include "storage.h"

void setup() {
    // 1. LED first — shows BOOTING (solid cyan) during init
    led_indicator_init();
    led_request_state(LedState::BOOTING);

    // 2. Bell Core — relays off, NVS loaded, RTC seeded
    bell_core_init();

    // 3. Network — WiFi, NTP, server discovery
    network_sync_init();

    // 4. OTA — version tracking + update engine (idle until triggered)
    ota_init();

    // 5. Storage — LittleFS mount (auto-formats on first boot)
    storage_init();
}

void loop() {
    // Bell Core ticks first — highest priority, never blocked by network I/O
    bell_core_tick();

    // Network sync runs on its own FreeRTOS task (core 0) — no tick needed here

    // OTA tick — non-blocking; downloads firmware in background
    ota_tick();

    // Release BOOTING once scheduler has valid time + computed next_fire
    static bool s_booting_released = false;
    if (!s_booting_released && bell_core_is_scheduler_ready()) {
        led_release_state(LedState::BOOTING);
        s_booting_released = true;
    }

    // OTA boot confirmation — defers rollback cancel until scheduler ready + stable uptime
    ota_confirm_boot_if_stable();

    // LED tick last — applies blink patterns for current state
    led_indicator_tick();
}
