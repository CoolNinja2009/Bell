#pragma once

// ============================================================================
//  DEBUG CONFIG  —  compile-time diagnostic toggles
// ============================================================================
//
//  These flags add extra boot/reset diagnostics to the serial monitor.
//
//  SECURITY NOTE: `bell_serial` mirrors every line to BOTH the physical USB
//  serial port AND the server log ring buffer (uploaded to /api/log). When
//  WIFI_PRINT_CREDENTIALS_ON_BOOT is enabled, the plaintext WiFi password is
//  therefore written into the server log/history too. Keep this at 0 for any
//  normal deployment; set it to 1 only while diagnosing a WiFi connection
//  problem, then set it back to 0 and rebuild.
//
#define WIFI_PRINT_CREDENTIALS_ON_BOOT 1
