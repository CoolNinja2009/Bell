/*
 * bell_core.h  —  Bell Management Core
 * ─────────────────────────────────────────────────────────────────
 * Highest-priority subsystem. Controls relays, computes bell times,
 * manages the schedule state machine, and handles RTC timekeeping.
 *
 * This module NEVER depends on WiFi, HTTP, JSON parsing, or server
 * availability. It can run indefinitely with the network completely
 * disabled — bells will continue ringing from NVS-stored schedules.
 */
#pragma once

#include <Arduino.h>
#include <Preferences.h>
#include <cstring>

// ============================================================================
//  PIN MAP
// ============================================================================
constexpr uint8_t  CH1_RELAY_PIN     = 26;
constexpr uint8_t  CH2_RELAY_PIN     = 27;
constexpr bool     RELAY_ACTIVE_HIGH = false;  // false → LOW = relay closed

// ============================================================================
//  CAPACITY
// ============================================================================
constexpr size_t MAX_SCHEDULE   = 24;
constexpr size_t MAX_SKIP_DATES = 32;
constexpr size_t MAX_CH_KEY     = 21;  // channel key max length + null

// ============================================================================
//  FALLBACK SCHEDULE  (used when NVS has nothing)
// ============================================================================
constexpr uint32_t FALLBACK_CH1_PULSE_MS = 2000;
constexpr uint32_t FALLBACK_CH2_PULSE_MS = 2000;
constexpr uint32_t FALLBACK_CH1_SCHEDULE[] = {  8*3600, 20*3600       };
constexpr uint32_t FALLBACK_CH2_SCHEDULE[] = {  6*3600+30*60, 18*3600+45*60 };
constexpr size_t   FALLBACK_CH1_SLOTS = sizeof(FALLBACK_CH1_SCHEDULE) / sizeof(FALLBACK_CH1_SCHEDULE[0]);
constexpr size_t   FALLBACK_CH2_SLOTS = sizeof(FALLBACK_CH2_SCHEDULE) / sizeof(FALLBACK_CH2_SCHEDULE[0]);

// ============================================================================
//  TIME CONSTANTS
// ============================================================================
// Timezone — seconds EAST of UTC (POSIX convention: minus = east)
constexpr long    GMT_OFFSET_SEC    = 19800;    // India IST = UTC+5:30
constexpr long    DAYLIGHT_SEC      = 0;

// ============================================================================
//  HEALTH WATCHDOGS
// ============================================================================
constexpr uint32_t TIME_STALL_THRESHOLD_S  = 120;
constexpr uint32_t SCHEDULE_REFRESH_MS     = 3600000;  // hourly recompute

// ============================================================================
//  RTC CONFIGURATION
// ============================================================================
constexpr uint8_t  RTC_I2C_ADDR   = 0x68;
constexpr int8_t   RTC_SDA_PIN    = 21;
constexpr int8_t   RTC_SCL_PIN    = 22;
constexpr uint32_t RTC_RESYNC_MS  = 3600000;

// ============================================================================
//  STATE STRUCTURES
// ============================================================================
enum class Phase : uint8_t { IDLE, ACTIVE };

struct ChannelCfg {
    bool     enabled       = true;
    uint32_t pulse_ms      = 2000;
    uint32_t schedule[MAX_SCHEDULE] = {0};
    size_t   schedule_len  = 0;
    char     skip_dates[MAX_SKIP_DATES][11] = {{0}};
    size_t   skip_count    = 0;
};

struct Channel {
    const uint8_t pin;
    const char *const *server_keys;
    const size_t server_key_count;
    ChannelCfg    cfg;
    char          schedule_key[MAX_CH_KEY] = {0};
    Phase         phase           = Phase::IDLE;
    uint32_t      pulse_start     = 0;   // millis() when current pulse began
    uint32_t      active_pulse_ms = 0;
    time_t        next_fire       = 0;

    Channel(uint8_t p, const char *const *keys, size_t key_count)
        : pin(p), server_keys(keys), server_key_count(key_count) {}
};

// ============================================================================
//  CORE API  —  called from main.cpp
// ============================================================================

/** Initialise hardware, load NVS schedule, seed RTC time.
 *  Bells are ready to ring after this returns. */
void bell_core_init();

/** Main tick — must be called every loop() iteration.
 *  Handles relay state machine, time-stall detection,
 *  RTC resync, and schedule recomputation. */
void bell_core_tick();

// ============================================================================
//  SCHEDULE UPDATE API  —  called by the network module
// ============================================================================

/** Offer a validated raw JSON schedule string. The Bell Core will
 *  parse and atomically swap to the new schedule only after full
 *  validation. Returns true if the schedule was accepted. */
bool bell_core_apply_schedule(const char *raw_json, const char *hash_8chars);

// ============================================================================
//  COMMAND API  —  called by the network module
// ============================================================================

/** Queue a manual "run now" command for a channel.
 *  The Bell Core executes it on its next tick. */
void bell_core_queue_command(const char *ch_key, uint32_t pulse_ms);

// ============================================================================
//  STATUS API  —  read by the network module for heartbeats/reporting
// ============================================================================

/** Get the primary channel key for a given channel index (0 = ch1, 1 = ch2).
 *  Returns nullptr if index out of range. */
const char *bell_core_channel_key(uint8_t ch_index);

/** Get the currently loaded schedule hash (8 chars + null). */
const char *bell_core_schedule_hash();

/** Pop the next pending execution report (non-blocking).
 *  Returns true if a report was available, filling ch_key, pulse_ms, trigger.
 *  The network module should call this periodically and POST to /api/execution. */
bool bell_core_pop_execution_report(char *ch_key_out, size_t ch_key_max,
                                     uint32_t *pulse_ms_out, const char **trigger_out);

// ============================================================================
//  LOGGING  —  serial-only, no network dependency
// ============================================================================

/** Log a message to Serial (always) and the local ring buffer.
 *  The network module can drain the buffer and POST to /api/log. */
void bell_core_log(const char *msg);

/** Pop the next pending log message. Returns true if available. */
bool bell_core_pop_log(char *msg_out, size_t msg_max);
