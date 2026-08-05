'use strict';
/**
 * lib/config.js — Central configuration for the relay controller server.
 * ─────────────────────────────────────────────────────────────────────
 * Every tunable lives here. No magic values scattered across modules.
 */
const path = require('path');

module.exports = {
  // ── Server ─────────────────────────────────────────────────────────
  server: {
    host: '0.0.0.0',
    port: 8080,
  },

  // ── Updater ────────────────────────────────────────────────────────
  updater: {
    /** Git remote name (almost always "origin"). */
    remote: 'origin',

    /** Branch to track. */
    branch: 'main',

    /** How often to check GitHub for new commits (ms). */
    checkIntervalMs: 60 * 60 * 1000, // 1 hour

    /** How long to wait for the server to start before health check (ms). */
    restartTimeoutMs: 15 * 1000,

    /** Max time to block waiting for active OTA downloads to finish (ms). */
    downloadDrainTimeoutMs: 5 * 60 * 1000, // 5 minutes

    /** Delay between retries when waiting for downloads to drain (ms). */
    downloadDrainRetryMs: 5 * 1000,

    /** Path to persisted update state. */
    stateFile: path.join(__dirname, '..', 'update-state.json'),

    /** Path to updater log. */
    logFile: path.join(__dirname, '..', 'logs', 'updater.log'),

    /** Health check URL (relative — server is localhost). */
    healthUrl: 'http://127.0.0.1:8080/health',
  },

  // ── Firmware cache ──────────────────────────────────────────────────
  firmware: {
    /** GitHub owner/repo for firmware releases. */
    repo: process.env.FIRMWARE_REPO || 'CoolNinja2009/Bell',

    /** Asset name in the release. */
    assetName: process.env.FIRMWARE_ASSET_NAME || 'firmware.bin',

    /** Local cache directory. */
    cacheDir: path.join(__dirname, '..', '.firmware_cache'),

    /** Re-check GitHub for new releases (ms). */
    ttlMs: 30 * 60 * 1000,
  },
};
