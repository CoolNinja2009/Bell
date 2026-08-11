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
 *
 * ARCHITECTURE (dual-core FreeRTOS):
 *   network_sync_init() spawns a task pinned to core 0 that runs
 *   all HTTP I/O independently. The Bell Core (on core 1 / Arduino
 *   loop) is never blocked by network operations — relay timing
 *   remains accurate even when the server is unreachable.
 */

#include <Arduino.h>

// ============================================================================
//  CONFIGURATION
// ============================================================================
constexpr uint16_t BEACON_PORT         = 9999;
constexpr uint32_t BEACON_TIMEOUT_MS   = 20000;
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

/** Initialise WiFi, NTP, beacon listener, and spawn the network I/O
 *  task on core 0. Must be called AFTER bell_core_init().
 *  The task runs independently — no tick function needed in loop(). */
void network_sync_init();

/** Current server base URL "http://<ip>:<port>", or nullptr if offline.
 *  Callers (OTA, diagnostics) can use this without knowing internals. */
const char* network_server_base_url();
