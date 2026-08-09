'use strict';
/**
 * config/index.js — Bootstrap configuration.
 *
 * Every tunable lives in config/bell.conf (human-readable).
 * This file reads that, applies sensible defaults for anything missing,
 * and exports the final structured config.
 *
 * Paths are relative to the server-node directory (where bootstrap.js lives).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONF_PATH = path.join(__dirname, 'bell.conf');

// ── Parse bell.conf ────────────────────────────────────────────────────

/**
 * Read key=value pairs from a conf file.
 * Section headers [Section] scope subsequent keys: key becomes "section_key".
 * - # starts a comment (whole line or inline after whitespace)
 * - Numbers are auto-detected
 * Returns a flat object of { section_key: value }.
 */
function parseConf(filePath) {
  const out = Object.create(null);
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return out; }

  let section = '';
  for (let line of content.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;

    // Section header
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).trim();
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const rawKey = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();

    // Strip inline comment (space(s) then #)
    const ci = val.search(/\s+#/);
    if (ci !== -1) val = val.slice(0, ci).trim();

    // Auto-detect numbers
    if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);

    // Key: section_key (lowercase, spaces → underscores)
    const prefix = section ? section.toLowerCase().replace(/\s+/g, '_') + '_' : '';
    out[prefix + rawKey] = val;
  }
  return out;
}

const C = parseConf(CONF_PATH);

// ── Helpers ─────────────────────────────────────────────────────────────

function get(key, fallback) { return (key in C) ? C[key] : fallback; }
/** Read a conf value in milliseconds, where the conf key is in seconds. */
function ms(key, fallbackMs) { return get(key, fallbackMs / 1000) * 1000; }

// ── Export ──────────────────────────────────────────────────────────────

module.exports = {
  // ── Repository ─────────────────────────────────────────────────────
  repo: {
    /** GitHub remote URL. */
    url: get('repository_url', 'https://github.com/CoolNinja2009/Bell.git'),
    /** Remote name. */
    remote: get('repository_remote', 'origin'),
    /** Branch to track. */
    branch: get('repository_branch', 'main'),
    /** Retries for fetch operations. */
    fetchRetries: get('repository_fetch_retries', 3),
    /** Delay between fetch retries (ms). */
    fetchRetryDelayMs: ms('repository_fetch_retry_delay', 5000),
  },

  // ── PM2 ─────────────────────────────────────────────────────────────
  pm2: {
    /** Process name in PM2 (must match ecosystem.config.js). */
    processName: get('pm2_process_name', 'relay-server'),
    /** Path to the ecosystem config file. */
    ecosystemFile: get('pm2_ecosystem_file', 'ecosystem.config.js'),
    /** Time to wait after start/restart before health check (ms). */
    startupGraceMs: ms('pm2_startup_grace', 5000),
  },

  // ── Health check ────────────────────────────────────────────────────
  health: {
    /** URL to check (must return HTTP 200). */
    url: get('health_url', 'http://127.0.0.1:8080/health'),
    /** Request timeout per attempt (ms). */
    timeoutMs: ms('health_timeout', 10000),
    /** Number of health check attempts. */
    retries: get('health_retries', 10),
    /** Delay between retries (ms). */
    retryDelayMs: ms('health_retry_delay', 2000),
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
    maxLogSizeBytes: get('logging_max_log_size', 1 * 1024 * 1024),
    /** Number of rotated backup files to keep. */
    maxLogFiles: get('logging_max_log_files', 5),
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

  // ── Server ────────────────────────────────────────────────────────────
  server: {
    /** Bind address. */
    host: get('server_host', '0.0.0.0'),
    /** HTTP port. */
    port: get('server_port', 8080),
  },

  // ── UDP Beacon ────────────────────────────────────────────────────────
  beacon: {
    /** UDP broadcast port for ESP32 auto-discovery. */
    port: get('beacon_port', 9999),
    /** Broadcast interval in milliseconds. */
    intervalMs: get('beacon_interval_ms', 5000),
  },

  // ── Profile refresh ───────────────────────────────────────────────────
  profileRefresh: {
    /** Interval to check for midnight profile rollover (ms). */
    intervalMs: get('profilerefresh_interval_ms', 60000),
  },

  // ── Channels ──────────────────────────────────────────────────────────
  channels: {
    /** Maximum number of relay channels. */
    maxChannels: get('channels_max_channels', 24),
    /** Valid channel key pattern (must start with a letter). */
    keyPattern: get('channels_key_pattern', '^[a-zA-Z][a-zA-Z0-9_-]{0,19}$'),
  },

  // ── OTA Firmware ──────────────────────────────────────────────────────
  firmware: {
    /** GitHub repo for firmware releases. Override via FIRMWARE_REPO env. */
    repo: process.env.FIRMWARE_REPO || get('firmware_repo', 'CoolNinja2009/Bell'),
    /** Asset name in GitHub release. Override via FIRMWARE_ASSET_NAME env. */
    assetName: process.env.FIRMWARE_ASSET_NAME || get('firmware_asset_name', 'firmware.bin'),
    /** Local cache directory (relative to server-node root). */
    cacheDir: path.join(ROOT, '.firmware_cache'),
    /** Re-check GitHub (ms). Conf key is in minutes for readability. */
    ttlMs: get('firmware_cache_minutes', 30) * 60 * 1000,
  },

  // ── PWA assets ────────────────────────────────────────────────────────
  pwaAssets: {
    /** Web app manifest. */
    manifest: path.join(ROOT, 'manifest.json'),
    /** Service worker. */
    sw: path.join(ROOT, 'sw.js'),
    /** 192x192 app icon. */
    icon192: path.join(ROOT, 'icon-192.png'),
    /** 512x512 app icon. */
    icon512: path.join(ROOT, 'icon-512.png'),
    /** Bell SVG icon. */
    bellSvg: path.join(ROOT, 'bell.svg'),
  },

  // ── Cron ──────────────────────────────────────────────────────────────
  cron: {
    /** Daily restart cron schedule. */
    dailyCheckTime: get('cron_daily_check', '30 16 * * *'),
    /** Command template — {root} is replaced with config.paths.root. */
    updateCommandTemplate: get('cron_update_command', 'cd {root} && bash start.sh --update >> /tmp/bell-cron.log 2>&1'),
  },
};
