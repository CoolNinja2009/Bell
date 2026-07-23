/*
 * main.cpp  —  ESP32 Dual‑Channel Relay Controller
 * ─────────────────────────────────────────────────────────────────
 * Minimal glue. Initialises the Bell Management Core first (so bells
 * can ring from NVS immediately), then starts network synchronisation.
 *
 * Architecture:
 *   bell_core.h/cpp   — Relay control, schedule execution, RTC, NVS
 *   network_sync.h/cpp — WiFi, HTTP, schedule download, heartbeats
 *
 * These modules are independent. The Bell Core never touches WiFi.
 * If the network module crashes, bells continue ringing.
 */
#include <Arduino.h>
#include "bell_core.h"
#include "network_sync.h"

void setup() {
    // 1. Bell Core first — relays off, NVS loaded, RTC seeded
    bell_core_init();

    // 2. Network second — WiFi, NTP, server discovery
    //    Bells are already operational from NVS at this point
    network_sync_init();

    Serial.println(F("=== CONTROLLER READY ==="));
}

void loop() {
    // Bell Core ticks first — highest priority
    bell_core_tick();

    // Network sync ticks second — can fail freely
    network_sync_tick();
}
