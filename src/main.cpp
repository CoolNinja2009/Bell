/*
 * main.cpp  —  ESP32 Dual‑Channel Relay Controller
 * ─────────────────────────────────────────────────────────────────
 * Minimal glue. Initialises the Bell Management Core first (so bells
 * can ring from NVS immediately), then starts network synchronisation.
 *
 * Architecture:
 *   bell_core.h/cpp     — Relay control, schedule execution, RTC, NVS
 *   network_sync.h/cpp  — WiFi, HTTP, schedule download, heartbeats
 *   led_indicator.h     — RGB LED status (standalone, no network deps)
 *
 * These modules are independent. The Bell Core never touches WiFi.
 * If the network module crashes, bells continue ringing.
 *
 * LED lifecycle:
 *   BOOTING → requested before any init, released when scheduler ready
 *   HEALTHY → default fallback when no other state is active
 */
#include <Arduino.h>
#include "bell_core.h"
#include "network_sync.h"
#include "led_indicator.h"

void setup() {
    // 1. LED first — shows BOOTING (solid cyan) during init
    led_indicator_init();
    led_request_state(LedState::BOOTING);

    // 2. Bell Core — relays off, NVS loaded, RTC seeded
    bell_core_init();

    // 3. Network — WiFi, NTP, server discovery
    network_sync_init();

    Serial.println(F("=== CONTROLLER READY ==="));
}

void loop() {
    // Bell Core ticks first — highest priority
    bell_core_tick();

    // Network sync ticks second — can fail freely
    network_sync_tick();

    // Release BOOTING once scheduler has valid time + computed next_fire
    static bool s_booting_released = false;
    if (!s_booting_released && bell_core_is_scheduler_ready()) {
        led_release_state(LedState::BOOTING);
        s_booting_released = true;
    }

    // LED tick last — applies blink patterns for current state
    led_indicator_tick();
}
