'use strict';
/**
 * config/index.js — Bootstrap configuration.
 *
 * Every tunable lives here. Nothing is scattered across modules.
 * Paths are relative to the server-node directory (where bootstrap.js lives).
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

module.exports = {
  // ── Repository ─────────────────────────────────────────────────────
  repo: {
    /** GitHub remote URL. */
    url: 'https://github.com/CoolNinja2009/Bell.git',
    /** Remote name. */
    remote: 'origin',
    /** Branch to track. */
    branch: 'main',
    /** Retries for fetch operations. */
    fetchRetries: 3,
    /** Delay between fetch retries (ms). */
    fetchRetryDelayMs: 5000,
  },

  // ── PM2 ─────────────────────────────────────────────────────────────
  pm2: {
    /** Process name in PM2 (must match ecosystem.config.js). */
    processName: 'relay-server',
    /** Path to the ecosystem config file. */
    ecosystemFile: 'ecosystem.config.js',
    /** Time to wait after start/restart before health check (ms). */
    startupGraceMs: 5000,
  },

  // ── Health check ────────────────────────────────────────────────────
  health: {
    /** URL to check (must return HTTP 200). */
    url: 'http://127.0.0.1:80/health',
    /** Request timeout per attempt (ms). */
    timeoutMs: 10000,
    /** Number of health check attempts. */
    retries: 10,
    /** Delay between retries (ms). */
    retryDelayMs: 2000,
  },

  // ── Network / mDNS ─────────────────────────────────────────────────
  network: {
    /** Desired mDNS hostname — must match the Pi's system hostname. */
    hostname: 'bell-server',
  },

  // ── Paths (relative to server-node root) ────────────────────────────
  paths: {
    root: ROOT,
    stateFile: path.join(ROOT, 'state', 'update_state.json'),
    bootstrapLog: path.join(ROOT, 'logs', 'bootstrap.log'),
    updateLog: path.join(ROOT, 'logs', 'update.log'),
    healthLog: path.join(ROOT, 'logs', 'health.log'),
  },

  // ── Logging ─────────────────────────────────────────────────────────
  logging: {
    /** Maximum size per log file before rotation (bytes). */
    maxLogSizeBytes: 1 * 1024 * 1024, // 1 MB
    /** Number of rotated backup files to keep. */
    maxLogFiles: 5,
  },

  // ── Required files (verified at startup) ────────────────────────────
  required: {
    serverScript: 'server.js',
    ecosystemConfig: 'ecosystem.config.js',
    packageJson: 'package.json',
  },

  // ── Commands ─────────────────────────────────────────────────────────
  commands: {
    node: 'node',
    npm: 'npm',
    git: 'git',
    pm2: 'pm2',
  },
};
