/*
 * watchdog.h  —  Independent Relay Watchdog
 * ─────────────────────────────────────────────────────────────────
 * Runs as a high-priority FreeRTOS task completely independent of
 * bell_core and network_sync. Reads NVS directly, checks GPIO state
 * directly.
 *
 * TWO MODES:
 *   NORMAL   — heartbeat alive: only SAFETY OFF for stuck relays.
 *              Never fights with bell_core.
 *   TAKEOVER — heartbeat stale >10s: actively force-drives relays
 *              from NVS schedule.
 *
 * Enable with build flag:  -D WATCHDOG_ENABLED
 * (enabled by default in platformio.ini)
 */
#pragma once

#include <Arduino.h>

#ifdef WATCHDOG_ENABLED

/** Spawn the watchdog FreeRTOS task. Call once during setup(),
 *  after bell_core_init() and network_sync_init(). */
void watchdog_init();

/** Heartbeat — call from loop() on every iteration. */
void watchdog_heartbeat();

/** True if the watchdog has detected a bell_core stall. */
bool watchdog_has_taken_over();

#else

inline void watchdog_init() {}
inline void watchdog_heartbeat() {}
inline bool watchdog_has_taken_over() { return false; }

#endif
