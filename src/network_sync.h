/*
 * network_sync.h  —  Network Synchronization Module
 * ─────────────────────────────────────────────────────────────────
 * Handles all network operations: WiFi, HTTP, schedule downloads,
 * heartbeats, command polling, and server discovery.
 *
 * This module NEVER directly controls relays or modifies scheduler
 * state. Its only job is to fetch validated data and hand it to
 * the Bell Management Core via bell_core_apply_schedule() and
 * bell_core_queue_command().
 */
#pragma once

#include <Arduino.h>

// ============================================================================
//  CONFIGURATION
// ============================================================================
constexpr uint16_t BEACON_PORT         = 9999;
constexpr uint32_t BEACON_TIMEOUT_MS   = 45000;
constexpr char     FALLBACK_SERVER_IP[] = "192.168.1.100";
constexpr uint16_t SERVER_PORT         = 8080;
constexpr uint32_t HASH_POLL_MS        = 5000;
constexpr uint32_t FULL_POLL_MS        = 30000;
constexpr uint32_t POLL_TIMEOUT_MS     = 8000;
constexpr uint32_t COMMAND_POLL_MS     = 1000;

constexpr char     NTP_SERVER1[] = "pool.ntp.org";
constexpr char     NTP_SERVER2[] = "time.nist.gov";
constexpr char     NTP_SERVER3[] = "time.google.com";
constexpr uint32_t SNTP_SYNC_INTERVAL_MS = 900000;


// ============================================================================
//  PUBLIC API
// ============================================================================

/** Initialise WiFi, NTP, beacon listener, and server discovery.
 *  Must be called AFTER bell_core_init(). */
void network_sync_init();

/** Main tick — must be called every loop() iteration.
 *  Polls for schedule changes, heartbeats, commands, and
 *  drains execution reports / log buffer. */
void network_sync_tick();
