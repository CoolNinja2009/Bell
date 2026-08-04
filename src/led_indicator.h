/*
 * led_indicator.h  —  RGB LED Status Indicator (declarations)
 * ─────────────────────────────────────────────────────────────────
 * Wiring (common-anode):  LOW = ON, HIGH = OFF
 *   R → GPIO 25   G → GPIO 33   B → GPIO 32
 *
 * HEALTHY: green breathing (~3s).  OFFLINE_MODE: orange breathing (~3s).
 * SETUP_MODE: white breathing (~2s).  Bell ring: yellow flash.
 * CONNECTING_WIFI / SCHEDULE_SYNC / CRITICAL_ERROR: blink patterns.
 */
#pragma once

#include <Arduino.h>

// ============================================================================
//  PIN MAP  (override with #define BEFORE including)
// ============================================================================
#ifndef LED_R_PIN
constexpr uint8_t LED_R_PIN = 25;
#endif
#ifndef LED_G_PIN
constexpr uint8_t LED_G_PIN = 33;
#endif
#ifndef LED_B_PIN
constexpr uint8_t LED_B_PIN = 32;
#endif

// ============================================================================
//  LED STATES  — highest numeric = highest priority
// ============================================================================
enum class LedState : uint8_t {
    HEALTHY          = 0,
    OFFLINE_MODE     = 1,
    CONNECTING_WIFI  = 2,
    BOOTING          = 3,
    SCHEDULE_SYNC    = 4,
    SETUP_MODE       = 5,
    CRITICAL_ERROR   = 6,
    OTA_DOWNLOADING  = 7,
    OTA_VERIFYING    = 8,
    OTA_APPLYING     = 9,
    OTA_FAILED       = 10,
};

// ============================================================================
//  PUBLIC API
// ============================================================================
void led_indicator_init();
void led_request_state(LedState state);
void led_release_state(LedState state);
void led_pulse_ack();
void led_pulse_bell(uint32_t duration_ms);
void led_indicator_tick();
