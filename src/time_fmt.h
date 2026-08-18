/*
 * time_fmt.h — Configurable date/time display formatting
 * ─────────────────────────────────────────────────────────
 * Single source of truth for how timestamps are shown. The server sends
 * `date_format` / `time_format` (Indian default: DD-MM-YYYY, HH:MM:SS)
 * alongside the schedule; network_sync calls time_fmt_set() and every
 * module formats display timestamps through these helpers.
 */
#pragma once

#include <Arduino.h>
#include <time.h>

/** Apply server-provided format strings. Unknown values fall back to the
 *  Indian default (DD-MM-YYYY, HH:MM:SS). Safe to call repeatedly. */
void time_fmt_set(const char* date_format, const char* time_format);

/** Format a struct tm into `buf` (NUL-terminated, max `size` bytes):
 *  - time_fmt_date:     "DD-MM-YYYY"            (configured order)
 *  - time_fmt_time:     "HH:MM:SS" or "HH:MM"   (per config)
 *  - time_fmt_datetime: "DD-MM-YYYY HH:MM:SS"   */
void time_fmt_date(char* buf, size_t size, const struct tm* t);
void time_fmt_time(char* buf, size_t size, const struct tm* t);
void time_fmt_datetime(char* buf, size_t size, const struct tm* t);
