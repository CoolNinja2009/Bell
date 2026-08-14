/*
 * led_indicator.cpp  —  RGB LED Status Indicator (implementation)
 * ─────────────────────────────────────────────────────────────────
 * Single translation unit — state is NOT duplicated across TUs.
 */
#include "led_indicator.h"
#include "bell_logger.h"

// ============================================================================
//  PWM CONFIG
// ============================================================================
static constexpr uint32_t LED_PWM_FREQ = 1000;
static constexpr uint8_t  LED_PWM_RES  = 8;
static uint8_t s_ledc_r = 0, s_ledc_g = 1, s_ledc_b = 2;

// ============================================================================
//  SERIAL LOGGING
// ============================================================================
#ifndef LED_SERIAL_LOG
#define LED_SERIAL_LOG false
#endif

// ============================================================================
//  STATE  (single copy — shared by all callers)
// ============================================================================
static uint8_t  s_active_mask    = 0;
static LedState s_current_state  = LedState::HEALTHY;
static uint32_t s_last_blink_ms  = 0;
static bool     s_blink_on       = false;

// Override flash
static uint32_t s_ack_end_ms     = 0;
static uint8_t  s_ack_r = 0, s_ack_g = 0, s_ack_b = 0;
// Breathing timer
static uint32_t s_breath_start   = 0;

// ============================================================================
//  GPIO HELPERS  (common-anode via LEDC PWM: 0=ON, 255=OFF)
// ============================================================================
static inline void led_write(uint8_t r, uint8_t g, uint8_t b) {
    ledcWrite(s_ledc_r, r);
    ledcWrite(s_ledc_g, g);
    ledcWrite(s_ledc_b, b);
}

static inline void led_all_off() {
    ledcWrite(s_ledc_r, 255);
    ledcWrite(s_ledc_g, 255);
    ledcWrite(s_ledc_b, 255);
}

// ============================================================================
//  COLOUR + BLINK PATTERNS
// ============================================================================
struct BlinkPattern { uint32_t on_ms; uint32_t off_ms; };

static BlinkPattern led_pattern_for(LedState s) {
    switch (s) {
    case LedState::HEALTHY:          return {0, 0};
    case LedState::OFFLINE_MODE:     return {0, 0};
    case LedState::CONNECTING_WIFI:  return {500, 500};
    case LedState::BOOTING:          return {0, 0};
    case LedState::SCHEDULE_SYNC:    return {250, 250};
    case LedState::SETUP_MODE:       return {0, 0};
    case LedState::CRITICAL_ERROR:   return {120, 120};
    case LedState::OTA_DOWNLOADING:  return {0, 0};   // breathing
    case LedState::OTA_VERIFYING:    return {250, 250}; // blink
    case LedState::OTA_APPLYING:     return {0, 0};   // solid
    case LedState::OTA_FAILED:       return {120, 120}; // fast red blink
    default:                         return {0, 0};
    }
}
static void led_apply_color(LedState s) {
    switch (s) {
    case LedState::HEALTHY:          led_write(255, 0,   255); break;  // green
    case LedState::OFFLINE_MODE:     led_write(0,   155, 255); break;  // orange
    case LedState::CONNECTING_WIFI:  led_write(0,   155, 255); break;  // orange
    case LedState::BOOTING:          led_write(255, 0,   0);   break;  // cyan
    case LedState::SCHEDULE_SYNC:    led_write(255, 255, 0);   break;  // blue
    case LedState::SETUP_MODE:       led_write(0,   0,   0);   break;  // white
    case LedState::CRITICAL_ERROR:   led_write(0,   255, 255); break;  // red
    case LedState::OTA_DOWNLOADING:  led_write(255, 255, 0);   break;  // blue
    case LedState::OTA_VERIFYING:    led_write(255, 255, 0);   break;  // blue
    case LedState::OTA_APPLYING:     led_write(255, 255, 0);   break;  // blue
    case LedState::OTA_FAILED:       led_write(0,   255, 255); break;  // red
    default:                         led_all_off();             break;
    }
}

// ============================================================================
//  PRIORITY LOGIC
// ============================================================================
static LedState led_highest_active() {
    if (s_active_mask == 0) return LedState::HEALTHY;
    uint8_t idx = static_cast<uint8_t>(31 - __builtin_clz(s_active_mask));
    return static_cast<LedState>(idx);
}

static const char *led_state_name(LedState s) {
    switch (s) {
    case LedState::HEALTHY:          return "HEALTHY";
    case LedState::OFFLINE_MODE:     return "OFFLINE_MODE";
    case LedState::CONNECTING_WIFI:  return "CONNECTING_WIFI";
    case LedState::BOOTING:          return "BOOTING";
    case LedState::SCHEDULE_SYNC:    return "SCHEDULE_SYNC";
    case LedState::SETUP_MODE:       return "SETUP_MODE";
    case LedState::CRITICAL_ERROR:   return "CRITICAL_ERROR";
    case LedState::OTA_DOWNLOADING:  return "OTA_DOWNLOADING";
    case LedState::OTA_VERIFYING:    return "OTA_VERIFYING";
    case LedState::OTA_APPLYING:     return "OTA_APPLYING";
    case LedState::OTA_FAILED:       return "OTA_FAILED";
    default:                         return "?";
    }
}

static void led_apply_transition(LedState state) {
    if (LED_SERIAL_LOG && state != s_current_state) {
        bell_serial.print(F("LED: "));
        bell_serial.println(led_state_name(state));
    }
    s_current_state = state;
    s_blink_on      = true;
    s_last_blink_ms = millis();
    if (state == LedState::HEALTHY || state == LedState::OFFLINE_MODE
        || state == LedState::SETUP_MODE) {
        s_breath_start = 0;
    }
    led_apply_color(state);
}

// ============================================================================
//  PUBLIC API
// ============================================================================
void led_indicator_init() {
    ledcSetup(s_ledc_r, LED_PWM_FREQ, LED_PWM_RES);
    ledcSetup(s_ledc_g, LED_PWM_FREQ, LED_PWM_RES);
    ledcSetup(s_ledc_b, LED_PWM_FREQ, LED_PWM_RES);
    ledcAttachPin(LED_R_PIN, s_ledc_r);
    ledcAttachPin(LED_G_PIN, s_ledc_g);
    ledcAttachPin(LED_B_PIN, s_ledc_b);
    led_all_off();
}

void led_request_state(LedState state) {
    const uint8_t bit = static_cast<uint8_t>(1U << static_cast<uint8_t>(state));
    if (s_active_mask & bit) return;
    s_active_mask |= bit;
    const LedState highest = led_highest_active();
    if (highest != s_current_state) led_apply_transition(highest);
}

void led_release_state(LedState state) {
    const uint8_t bit = static_cast<uint8_t>(1U << static_cast<uint8_t>(state));
    if (!(s_active_mask & bit)) return;
    s_active_mask &= ~bit;
    const LedState highest = led_highest_active();
    if (highest != s_current_state) led_apply_transition(highest);
}

void led_pulse_ack() {
    s_ack_end_ms    = millis() + 1000;
    s_ack_r = 0;  s_ack_g = 0;  s_ack_b = 0;  // white
    s_blink_on      = true;
    s_last_blink_ms = millis();
    led_write(s_ack_r, s_ack_g, s_ack_b);
}

void led_pulse_bell(uint32_t duration_ms) {
    if (duration_ms < 50) duration_ms = 50;
    s_ack_end_ms    = millis() + duration_ms;
    s_ack_r = 0;  s_ack_g = 0;  s_ack_b = 255;  // yellow
    s_blink_on      = true;
    s_last_blink_ms = millis();
    led_write(s_ack_r, s_ack_g, s_ack_b);
}

// ============================================================================
//  TICK
// ============================================================================
void led_indicator_tick() {
    if (s_ack_end_ms != 0) {
        if (millis() >= s_ack_end_ms) {
            s_ack_end_ms = 0;
            led_apply_transition(s_current_state);
            return;
        }
        const uint32_t elapsed = millis() - s_last_blink_ms;
        if (elapsed >= 100) {
            s_blink_on = !s_blink_on;
            s_last_blink_ms = millis();
            if (s_blink_on) led_write(s_ack_r, s_ack_g, s_ack_b);
            else            led_all_off();
        }
        return;
    }

    if (s_current_state == LedState::HEALTHY
        || s_current_state == LedState::OFFLINE_MODE
        || s_current_state == LedState::SETUP_MODE
        || s_current_state == LedState::OTA_DOWNLOADING) {
        if (s_breath_start == 0) s_breath_start = millis();
        const uint32_t cycle_ms =
            (s_current_state == LedState::SETUP_MODE) ? 2000 : 3000;
        const float phase =
            (float)(millis() - s_breath_start) / (float)cycle_ms * 2.0f * PI;
        const uint8_t bright =
            (uint8_t)((sinf(phase) + 1.0f) * 127.5f);
        switch (s_current_state) {
        case LedState::HEALTHY:
            ledcWrite(s_ledc_r, 255);
            ledcWrite(s_ledc_g, 255 - bright);
            ledcWrite(s_ledc_b, 255);
            break;
        case LedState::OFFLINE_MODE:
            ledcWrite(s_ledc_r, 255 - bright);
            ledcWrite(s_ledc_g, 255 - bright / 3);
            ledcWrite(s_ledc_b, 255);
            break;
        case LedState::SETUP_MODE:
            ledcWrite(s_ledc_r, 255 - bright);
            ledcWrite(s_ledc_g, 255 - bright);
            ledcWrite(s_ledc_b, 255 - bright);
            break;
        case LedState::OTA_DOWNLOADING:
            ledcWrite(s_ledc_r, 255);
            ledcWrite(s_ledc_g, 255);
            ledcWrite(s_ledc_b, 255 - bright);  // blue breathing
            break;
        default: break;
        }
        return;
    }

    // Solid states — just show the color
    if (s_current_state == LedState::BOOTING
        || s_current_state == LedState::OTA_APPLYING) {
        led_apply_color(s_current_state);
        return;
    }

    const BlinkPattern pat = led_pattern_for(s_current_state);
    if (pat.off_ms == 0) return;

    const uint32_t now_ms  = millis();
    const uint32_t elapsed = now_ms - s_last_blink_ms;
    const uint32_t half    = s_blink_on ? pat.on_ms : pat.off_ms;

    if (elapsed >= half) {
        s_blink_on = !s_blink_on;
        s_last_blink_ms = now_ms;
        if (s_blink_on) led_apply_color(s_current_state);
        else            led_all_off();
    }
}
