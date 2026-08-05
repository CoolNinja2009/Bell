/*
 * storage.h  —  LittleFS Persistent Storage
 * ─────────────────────────────────────────────────────────────────
 * Provides a mounted LittleFS filesystem on the "littlefs" partition
 * for logs, configuration, and web assets.
 *
 * Usage:
 *   storage_init()          — mount (auto-formats on first boot)
 *   LittleFS.open(...)      — standard FS API (File read/write/append)
 *   storage_total_bytes()   — partition capacity
 *   storage_used_bytes()    — bytes currently occupied
 */
#pragma once

#include <Arduino.h>

/** Mount the LittleFS partition. Auto-formats on first boot.
 *  Must be called AFTER bell_core_init() (logging is ready). */
void storage_init();

/** True if the filesystem mounted successfully. */
bool storage_ready();

/** Total capacity of the LittleFS partition (bytes). */
size_t storage_total_bytes();

/** Bytes currently used in the LittleFS partition. */
size_t storage_used_bytes();
