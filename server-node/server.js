'use strict';
/**
 * Relay Controller Server (Node.js / Express)
 * ─────────────────────────────────────────────────────────────────────
 * Serves the schedule to the ESP32 and provides a password-protected
 * web dashboard for editing it.
 *
 * Quick start:
 *   npm install
 *   npm start
 *   → Dashboard at http://<host>:8080
 *   → ESP32 polls   http://<host>:8080/api/schedule
 *
 * Storage: schedule.json, history.jsonl, api_keys.json (all auto-created)
 *
 * Everything from the original build is unchanged: session auth, rate
 * limited login, the ch1/ch2 schedule API the ESP32 polls, the UDP
 * discovery beacon, structured logging, and the crash-proof error
 * handling. Everything below "NEW FEATURES" is additive.
 *
 * NEW FEATURES (all keep the original API/behavior intact):
 *   - Dynamic channels: add/rename/remove relay channels beyond ch1/ch2
 *   - Manual on/off: trigger a relay immediately from the dashboard or
 *     via API key, independent of its schedule (device polls for it)
 *   - History & analytics: persistent run history (schedule saves,
 *     manual triggers, device-confirmed executions), CSV export
 *   - Backup / restore: download/upload a full JSON snapshot
 *   - API keys: scoped tokens for external integrations (Home
 *     Assistant, cron jobs, shortcuts, ...) via the X-API-Key header
 *   - In-dashboard password change (no SSH/script needed anymore)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const http = require('http');
const os = require('os');

const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const auth = require('./auth');
const history = require('./lib/history');
const apikeys = require('./lib/apikeys');
const profiles = require('./lib/profiles');
const calendar = require('./lib/calendar');
const profileSettings = require('./lib/settings');
const profileScheduler = require('./lib/profile-scheduler');
const firmwareState = require('./lib/firmware-state');
const firmwareMetadata = require('./lib/firmware-metadata');
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const HOST = '0.0.0.0';
const PORT = 8080;
const SCHEDULE_FILE = path.join(__dirname, 'schedule.json'); // legacy — kept for migration
const DEFAULT_PROFILES_FILE = path.join(__dirname, 'defaults', 'profiles.json');
const DEFAULT_CALENDAR_FILE = path.join(__dirname, 'defaults', 'calendar.json');
const PROFILES_TPL = path.join(__dirname, 'templates', 'profiles.html');
const PROFILE_REFRESH_INTERVAL_MS = 60000; // check every minute for midnight rollover
const BEACON_PORT = 9999;
const BEACON_INTERVAL_MS = 5000;
const BEACON_MSG = Buffer.from(`RELAY_CTRL:${PORT}\n`);
const INDEX_TPL = path.join(__dirname, 'templates', 'index.html');
const LOGIN_TPL = path.join(__dirname, 'templates', 'login.html');

const MANIFEST_PATH = path.join(__dirname, 'manifest.json');
const SW_PATH = path.join(__dirname, 'sw.js');
const ICON_192_PATH = path.join(__dirname, 'icon-192.png');
const ICON_512_PATH = path.join(__dirname, 'icon-512.png');
const BELL_SVG_PATH = path.join(__dirname, 'bell.svg');

const CHANNEL_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/; // must start with a letter
const MAX_CHANNELS = 24;
const DEVICE_CHANNEL_KEYS = new Set(['ch1', 'ch2']);
const MAX_SCHEDULE_SLOTS = 24;
const MAX_SKIP_DATES = 32;
const MAX_PULSE_MS = 60000;

// ── OTA Firmware ───────────────────────────────────────────────────
// The server caches the latest firmware binary from GitHub Releases.
// Set FIRMWARE_REPO to your GitHub "owner/repo". On first request the
const FIRMWARE_REPO       = process.env.FIRMWARE_REPO       || 'CoolNinja2009/Bell';
// it locally. Subsequent requests serve the cached copy.
const FIRMWARE_ASSET_NAME  = process.env.FIRMWARE_ASSET_NAME  || 'firmware.bin';
const FIRMWARE_CACHE_DIR   = path.join(__dirname, '.firmware_cache');
const CUSTOM_FIRMWARE_DIR  = path.join(FIRMWARE_CACHE_DIR, 'custom');
const FIRMWARE_TTL_MS      = 30 * 60 * 1000; // re-check GitHub every 30 min
const GITHUB_RELEASE_TTL_MS = 10 * 60 * 1000;
const MAX_FIRMWARE_SIZE    = 0x150000; // must fit an ESP32 OTA slot
let   firmwareCache        = null; // { version, sha256, size, path, fetchedAt }
let   firmwareReleaseListCache = null;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}
function logError(context, err) {
  console.error(`[${new Date().toISOString()}] [ERROR] ${context}:`, err && err.stack ? err.stack : err);
}

async function githubClient() {
  const { Octokit } = await import('@octokit/rest');
  return new Octokit({
    auth: process.env.GITHUB_TOKEN || undefined,
    userAgent: 'relay-controller-ota/1.0',
  });
}

// ---------------------------------------------------------------------------
// Schedule helpers — now profile-aware. loadSchedule() returns the resolved
// active profile's channels; saveSchedule(data) writes into the active profile.
// ---------------------------------------------------------------------------
function loadSchedule() {
  const sched = profileScheduler.getActiveSchedule();
  if (sched) return sched;
  // Fallback: return a minimal default so the ESP32 never gets an empty response
  return {
    ch1: { enabled: true, pulse_ms: 2000, schedule: ['08:00', '20:00'], skip_dates: [], label: 'Channel 1' },
    ch2: { enabled: true, pulse_ms: 2000, schedule: ['06:30', '18:45'], skip_dates: [], label: 'Channel 2' },
  };
}

function saveSchedule(data) {
  profileScheduler.resolveAndApply();
  const s = profileSettings.getSettings();
  if (!s.active_profile) {
    // No active profile yet — auto-create a default one
    const created = profiles.createProfile('Regular Working Day', data);
    profileSettings.setDefaultProfile(created.id);
    profileSettings.setActiveProfile(created.id);
    return;
  }
  profiles.saveChannels(s.active_profile, data);
}

function isValidDateStr(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const dt = new Date(d + 'T00:00:00Z');
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
}

/** Throws a 400-tagged Error if the schedule is malformed. */
function validationError(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

// Validates a schedule object with ANY number of channels (originally
// hardcoded to exactly ch1/ch2 — now any channel key matching
// CHANNEL_KEY_RE is accepted, so the dashboard can add/remove channels).
function validateSchedule(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw validationError('Body must be a JSON object');
  const keys = Object.keys(data);
  if (keys.length !== DEVICE_CHANNEL_KEYS.size || !keys.every((key) => DEVICE_CHANNEL_KEYS.has(key))) {
    throw validationError('Schedule must contain exactly the device channels: ch1 and ch2');
  }

  for (const ch of keys) {
    if (!CHANNEL_KEY_RE.test(ch)) {
      throw validationError(`Invalid channel key '${ch}' — letters/numbers/_/-, must start with a letter, max 20 chars`);
    }
    const c = data[ch];
    if (!c || typeof c !== 'object') throw validationError(`${ch} must be an object`);
    if (typeof c.enabled !== 'boolean') throw validationError(`${ch}.enabled must be bool`);
    if (!Number.isInteger(c.pulse_ms) || c.pulse_ms < 100 || c.pulse_ms > MAX_PULSE_MS) {
      throw validationError(`${ch}.pulse_ms must be an integer from 100 to ${MAX_PULSE_MS}`);
    }
    if (c.label !== undefined && (typeof c.label !== 'string' || c.label.length > 40)) {
      throw validationError(`${ch}.label must be a string up to 40 chars`);
    }
    if (!Array.isArray(c.schedule)) throw validationError(`${ch}.schedule must be a list`);
    if (c.schedule.length > MAX_SCHEDULE_SLOTS) throw validationError(`${ch}.schedule supports at most ${MAX_SCHEDULE_SLOTS} times`);
    const seenTimes = new Set();
    for (const entry of c.schedule) {
      let timeStr;
      if (typeof entry === 'string') {
        timeStr = entry;
      } else if (entry && typeof entry === 'object' && typeof entry.time === 'string') {
        timeStr = entry.time;
        if (entry.pulse_ms !== undefined && (!Number.isInteger(entry.pulse_ms) || entry.pulse_ms < 100 || entry.pulse_ms > MAX_PULSE_MS)) {
          throw validationError(`${ch} schedule entry pulse_ms must be an integer from 100 to ${MAX_PULSE_MS}`);
        }
      } else {
        throw validationError(`${ch} schedule entry invalid — use "HH:MM" or {"time":"HH:MM","pulse_ms":N}`);
      }
      if (!/^\d{2}:\d{2}$/.test(timeStr)) throw validationError(`${ch} schedule time '${timeStr}' invalid`);
      const parts = timeStr.split(':');
      if (parts.length !== 2) throw validationError(`${ch} schedule time '${timeStr}' invalid — use HH:MM`);
      const hh = Number(parts[0]);
      const mm = Number(parts[1]);
      if (seenTimes.has(timeStr)) throw validationError(`${ch} schedule contains duplicate time '${timeStr}'`);
      seenTimes.add(timeStr);
      if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
        throw validationError(`${ch} schedule time '${timeStr}' invalid — use HH:MM`);
      }
    }
    if (!Array.isArray(c.skip_dates)) throw validationError(`${ch}.skip_dates must be a list`);
    if (c.skip_dates.length > MAX_SKIP_DATES) throw validationError(`${ch}.skip_dates supports at most ${MAX_SKIP_DATES} dates`);
    for (const d of c.skip_dates) {
      if (!isValidDateStr(d)) throw validationError(`${ch} skip_date '${d}' invalid — use YYYY-MM-DD`);
    }
  }
}

function scheduleHash() {
  const sorted = JSON.stringify(sortObjectDeep(loadSchedule()));
  return crypto.createHash('md5').update(sorted).digest('hex').slice(0, 8);
}

function validateProfileBundle(bundle) {
  if (!bundle || !bundle.profiles || typeof bundle.profiles !== 'object' || Array.isArray(bundle.profiles)) {
    throw validationError('Invalid profile import bundle');
  }
  for (const profile of Object.values(bundle.profiles)) {
    if (!profile || !profile.channels) throw validationError('Each imported profile must contain channels');
    validateSchedule(profile.channels);
  }
}

function validateCalendarSnapshot(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !data.dates || typeof data.dates !== 'object' || Array.isArray(data.dates)
    || !data.dow || typeof data.dow !== 'object' || Array.isArray(data.dow)) {
    throw validationError('Calendar must contain date and day-of-week assignment objects');
  }
  for (const [date, profileId] of Object.entries(data.dates)) {
    if (!calendar.isValidDate(date) || typeof profileId !== 'string' || !profiles.getProfile(profileId)) {
      throw validationError(`Invalid calendar date assignment '${date}'`);
    }
  }
  for (const [dow, profileId] of Object.entries(data.dow)) {
    if (!calendar.VALID_DOWS.includes(dow) || typeof profileId !== 'string' || !profiles.getProfile(profileId)) {
      throw validationError(`Invalid calendar day assignment '${dow}'`);
    }
  }
}

function validateSettingsSnapshot(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw validationError('Settings must be an object');
  for (const key of ['active_profile', 'default_profile', 'manual_override']) {
    if (data[key] !== undefined && data[key] !== null && (typeof data[key] !== 'string' || !profiles.getProfile(data[key]))) {
      throw validationError(`Invalid settings profile '${key}'`);
    }
  }
  if (data.override_until !== undefined && data.override_until !== null
    && (typeof data.override_until !== 'string' || Number.isNaN(Date.parse(data.override_until)))) {
    throw validationError('Invalid override_until timestamp');
  }
  if (data.override_until && !data.manual_override) throw validationError('override_until requires manual_override');
}

function sortObjectDeep(obj) {
  if (Array.isArray(obj)) return obj.map(sortObjectDeep);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortObjectDeep(obj[k]);
        return acc;
      }, {});
  }
  return obj;
}

function getLocalIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// ---------------------------------------------------------------------------
// In-memory state (heartbeats + log ring buffer + pending manual commands)
// ---------------------------------------------------------------------------
const heartbeats = new Map(); // ch -> timestamp (ms)
const HEARTBEAT_TTL_MS = 120000;

function cleanStaleHeartbeats() {
  const now = Date.now();
  for (const [k, v] of heartbeats) {
    if (now - v > HEARTBEAT_TTL_MS) heartbeats.delete(k);
  }
}

const MAX_LOG_ENTRIES = 300;
const logBuf = [];
let logSequence = 0;
function pushLog(msg) {
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  logBuf.push({ id: ++logSequence, t: `${hh}:${mm}:${ss}`, msg });
  while (logBuf.length > MAX_LOG_ENTRIES) logBuf.shift();
}

// NEW: pending manual-trigger commands, keyed by channel. The ESP32 already
// polls the server (for /api/schedule) so manual "run now" reuses that same
// pull model instead of requiring a push connection to the device: the
// dashboard queues a command, the device picks it up next time it polls
// GET /api/commands, and the command is cleared as soon as it's delivered.
const pendingCommands = new Map(); // ch -> { pulse_ms, issued_at }
const COMMAND_TTL_MS = 300000;     // 5 min — discard if ESP32 never picks it up

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        workerSrc: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
  })
);
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

class BoundedSessionStore extends session.Store {
  constructor(maxEntries = 1000) {
    super();
    this.maxEntries = maxEntries;
    this.sessions = new Map();
  }

  get(sid, callback) {
    const entry = this.sessions.get(sid);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.sessions.delete(sid);
      callback(null, null);
      return;
    }
    callback(null, entry.data);
  }

  set(sid, data, callback = () => {}) {
    const cookieExpiry = data.cookie && data.cookie.expires ? new Date(data.cookie.expires).getTime() : NaN;
    const expiresAt = Number.isFinite(cookieExpiry) ? cookieExpiry : Date.now() + 8 * 60 * 60 * 1000;
    this.sessions.set(sid, { data, expiresAt });
    while (this.sessions.size > this.maxEntries) this.sessions.delete(this.sessions.keys().next().value);
    callback(null);
  }

  destroy(sid, callback = () => {}) {
    this.sessions.delete(sid);
    callback(null);
  }
}

app.use(
  session({
    name: 'relay.sid',
    secret: auth.loadOrCreateSecretKey(),
    resave: false,
    saveUninitialized: false,
    store: new BoundedSessionStore(),
    cookie: {
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
    },
  })
);

// Lightweight request log (method, path, status, duration) — helps diagnose
// exactly which request triggered a 500 instead of guessing.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

/** Wrap an async route handler so rejected promises reach the error
 *  middleware instead of crashing the process or hanging the request. */
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function loginRequired(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'authentication required' });
  }
  const next_ = encodeURIComponent(req.originalUrl);
  return res.redirect(`/login?next=${next_}`);
}

// NEW: allow a valid X-API-Key header as an alternative to a browser
// session, for a small set of integration-friendly endpoints. Falls back
// to the normal session check so dashboard usage is completely unaffected.
function apiKeyOrLogin(req, res, next) {
  const key = req.get('X-API-Key');
  if (key) {
    const entry = apikeys.verifyKey(key);
    if (entry) {
      req.apiKey = entry;
      return next();
    }
    return res.status(401).json({ error: 'invalid API key' });
  }
  return loginRequired(req, res, next);
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a minute.' },
  handler: (req, res) => {
    const html = renderLogin('Too many attempts. Try again in a minute.');
    res.status(429).type('html').send(html);
  },
});

function renderLogin(errorMsg) {
  const raw = fs.readFileSync(LOGIN_TPL, 'utf8');
  const block = errorMsg
    ? `<div class="error">${escapeHtml(errorMsg)}</div>`
    : '';
  return raw.replace('<!--ERROR_BLOCK-->', block);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/');
  res.set('Cache-Control', 'no-store').type('html').send(renderLogin(null));
});

app.post('/login', loginLimiter, (req, res) => {
  const password = (req.body && req.body.password) || '';
  if (auth.verifyPassword(password)) {
    req.session.regenerate((err) => {
      if (err) {
        logError('session regenerate', err);
        return res.status(500).type('html').send(renderLogin('Session error. Please try again.'));
      }
      req.session.authenticated = true;
      const nextPath = (req.query.next && decodeURIComponent(req.query.next)) || '/';
      res.redirect(nextPath.startsWith('/') ? nextPath : '/');
    });
    return;
  }
  res.status(401).type('html').send(renderLogin('Incorrect password.'));
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------------------------------------------------------------------------
// REST API — consumed by the ESP32 (left open; the device can't log in)
// ---------------------------------------------------------------------------
app.get(
  '/api/schedule',
  asyncRoute(async (req, res) => {
    cleanStaleHeartbeats();
    // A profile can change at a day boundary. Never allow an intermediary or
    // a browser/device cache to hold the previous day's resolved schedule.
    res.set('Cache-Control', 'no-store').json(loadSchedule());
  })
);

app.get(
  '/api/schedule/hash',
  asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store').json({ h: scheduleHash() });
  })
);

app.post(
  '/api/heartbeat',
  asyncRoute(async (req, res) => {
    const ch = (req.query.ch && String(req.query.ch)) || 'unknown';
    heartbeats.set(ch, Date.now());
    res.json({ ok: true });
  })
);

app.post(
  '/api/log',
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    if (body.lines !== undefined) {
      if (!Array.isArray(body.lines) || body.lines.length > 8
        || body.lines.some((line) => typeof line !== 'string' || line.length > 191)) {
        throw validationError('Invalid device log batch');
      }
      for (const line of body.lines) {
        const msg = line.trim();
        if (msg) pushLog(msg);
      }
    } else {
      const msg = (body.msg || '').toString().trim();
      if (msg.length > 191) throw validationError('Device log message too long');
      if (msg) pushLog(msg);
    }
    res.json({ ok: true });
  })
);

// NEW — device-open: the device polls this (same pattern as /api/schedule)
// to pick up a queued manual "run now" command for a given channel. The
// command is cleared the moment it's handed out, so it fires exactly once.
app.get(
  '/api/commands',
  asyncRoute(async (req, res) => {
    const ch = (req.query.ch && String(req.query.ch)) || '';
    const cmd = pendingCommands.get(ch);
    if (!cmd) return res.json({ pending: false });
    // Discard commands older than TTL — ESP32 was offline too long
    if (Date.now() - cmd.issued_at > COMMAND_TTL_MS) {
      pendingCommands.delete(ch);
      return res.json({ pending: false });
    }
    pendingCommands.delete(ch);
    res.json({ pending: true, ch, pulse_ms: cmd.pulse_ms });
  })
);

// NEW — device-open: optional confirmation hook. If a device firmware is
// updated to report "I actually fired ch1 for 2000ms", it lands in history
// as a confirmed execution instead of just a "queued" entry. Entirely
// optional — nothing else depends on it.
app.post(
  '/api/execution',
  asyncRoute(async (req, res) => {
    const ch = (req.body && req.body.ch && String(req.body.ch)) || 'unknown';
    const pulseMs = Number(req.body && req.body.pulse_ms) || null;
    const trigger = (req.body && req.body.trigger === 'manual') ? 'manual' : 'schedule';
    history.appendHistory({ ch, trigger, status: 'executed', pulse_ms: pulseMs, note: 'confirmed by device' });
    pushLog(`${ch} executed (${trigger})`);
    res.json({ ok: true });
  })
);

// ── OTA Firmware endpoints ──────────────────────────────────────────

// Refresh the cached firmware from GitHub Releases.
// Returns the cache entry or null on failure (never throws).
async function refreshFirmwareCache() {
  if (firmwareCache && (Date.now() - firmwareCache.fetchedAt) < FIRMWARE_TTL_MS) {
    return firmwareCache;
  }
  try {
    const octokit = await githubClient();
    const [owner, repo] = FIRMWARE_REPO.split('/');
    if (!owner || !repo) { log('[firmware] Invalid FIRMWARE_REPO'); return firmwareCache; }

    // listReleases returns newest first (including prereleases).
    // getLatestRelease skips prereleases — would miss every branch build.
    const { data: releases } = await octokit.rest.repos.listReleases({ owner, repo, per_page: 1 });
    if (!releases || releases.length === 0) { log('[firmware] No releases found'); return firmwareCache; }
    const release = releases[0];
    const tag = release.tag_name.replace(/^v/, '');

    const asset = release.assets.find(a => a.name === FIRMWARE_ASSET_NAME);
    if (!asset) { log(`[firmware] Asset "${FIRMWARE_ASSET_NAME}" not found in release ${tag}`); return firmwareCache; }

    const binPath = path.join(FIRMWARE_CACHE_DIR, `${tag}_${FIRMWARE_ASSET_NAME}`);
    const shaPath = binPath + '.sha256';

    // Download if not cached locally
    if (!fs.existsSync(binPath)) {
      fs.mkdirSync(FIRMWARE_CACHE_DIR, { recursive: true });
      log(`[firmware] Downloading ${asset.name} (${(asset.size / 1024).toFixed(1)} KB) from release ${tag}...`);

      const resp = await fetch(asset.browser_download_url, {
        headers: { 'User-Agent': 'relay-controller-ota/1.0', 'Accept': 'application/octet-stream' }
      });
      if (!resp.ok) { log(`[firmware] Download failed: HTTP ${resp.status}`); return firmwareCache; }

      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(binPath, buf);

      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      fs.writeFileSync(shaPath, sha256);
    }

    const artifact = firmwareMetadata.inspectFirmware(binPath, MAX_FIRMWARE_SIZE);
    const recordedSha = fs.existsSync(shaPath) ? fs.readFileSync(shaPath, 'utf8').trim() : '';
    if (recordedSha && recordedSha !== artifact.sha256) {
      fs.rmSync(binPath, { force: true });
      fs.rmSync(shaPath, { force: true });
      throw new Error(`Cached firmware digest mismatch for ${tag}; cache entry discarded`);
    }
    fs.writeFileSync(shaPath, artifact.sha256);

    firmwareCache = {
      version: tag,
      sha256: artifact.sha256,
      size: artifact.size,
      path: binPath,
      compiled_at: artifact.compiled_at,
      ota_protocol: artifact.ota_protocol,
      min_ota_protocol: artifact.min_ota_protocol,
      fetchedAt: Date.now(),
    };
    log(`[firmware] Cached v${tag} (${(artifact.size / 1024).toFixed(1)} KB, compiled=${firmwareCache.compiled_at || 'unverified'}, sha256=${artifact.sha256.substring(0, 16)}...)`);
    return firmwareCache;
  } catch (err) {
    logError('[firmware] refreshFirmwareCache', err);
    return firmwareCache; // serve stale cache if available
  }
}

async function listFirmwareReleases() {
  if (firmwareReleaseListCache
    && Date.now() - firmwareReleaseListCache.fetchedAt < GITHUB_RELEASE_TTL_MS) {
    return firmwareReleaseListCache.releases;
  }
  const [owner, repo] = FIRMWARE_REPO.split('/');
  if (!owner || !repo) throw new Error('Invalid FIRMWARE_REPO');
  const octokit = await githubClient();
  const { data } = await octokit.rest.repos.listReleases({ owner, repo, per_page: 20 });
  const releases = data.map((release) => ({
    tag: release.tag_name.replace(/^v/, ''),
    api_tag: release.tag_name,
    title: release.name || release.tag_name,
    published_at: release.published_at,
    prerelease: !!release.prerelease,
    draft: !!release.draft,
    url: release.html_url,
    asset: release.assets.find((asset) => asset.name === FIRMWARE_ASSET_NAME)
      ? { name: FIRMWARE_ASSET_NAME, size: release.assets.find((asset) => asset.name === FIRMWARE_ASSET_NAME).size }
      : null,
  }));
  firmwareReleaseListCache = { releases, fetchedAt: Date.now() };
  return releases;
}

async function cacheReleaseAsset(tag) {
  if (typeof tag !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(tag)) {
    throw validationError('Invalid firmware release tag');
  }
  const binPath = path.join(FIRMWARE_CACHE_DIR, `${tag}_${FIRMWARE_ASSET_NAME}`);
  const shaPath = `${binPath}.sha256`;
  if (!fs.existsSync(binPath)) {
    const releases = await listFirmwareReleases();
    const release = releases.find((item) => item.tag === tag && item.asset);
    if (!release) throw validationError(`Release '${tag}' has no ${FIRMWARE_ASSET_NAME} asset`);
    const [owner, repo] = FIRMWARE_REPO.split('/');
    const octokit = await githubClient();
    const { data } = await octokit.rest.repos.getReleaseByTag({ owner, repo, tag: release.api_tag });
    const asset = data.assets.find((item) => item.name === FIRMWARE_ASSET_NAME);
    if (!asset) throw validationError(`Release '${tag}' has no ${FIRMWARE_ASSET_NAME} asset`);
    const response = await fetch(asset.browser_download_url, {
      headers: { 'User-Agent': 'relay-controller-ota/1.0', Accept: 'application/octet-stream' },
    });
    if (!response.ok) throw new Error(`Firmware download failed: HTTP ${response.status}`);
    const binary = Buffer.from(await response.arrayBuffer());
    if (binary.length === 0 || binary.length > MAX_FIRMWARE_SIZE) throw new Error('Release firmware exceeds the OTA partition size');
    fs.mkdirSync(FIRMWARE_CACHE_DIR, { recursive: true });
    fs.writeFileSync(binPath, binary);
    fs.writeFileSync(shaPath, crypto.createHash('sha256').update(binary).digest('hex'));
  }
  const artifact = firmwareMetadata.inspectFirmware(binPath, MAX_FIRMWARE_SIZE);
  const recordedSha = fs.existsSync(shaPath) ? fs.readFileSync(shaPath, 'utf8').trim() : '';
  if (recordedSha && recordedSha !== artifact.sha256) {
    throw new Error(`Cached firmware digest mismatch for release ${tag}`);
  }
  fs.writeFileSync(shaPath, artifact.sha256);
  return {
    version: tag,
    sha256: artifact.sha256,
    size: artifact.size,
    path: binPath,
    compiled_at: artifact.compiled_at,
    ota_protocol: artifact.ota_protocol,
    min_ota_protocol: artifact.min_ota_protocol,
    source: 'release',
  };
}

async function resolveActiveFirmware() {
  const state = firmwareState.load();
  if (state.source === 'custom' && state.custom) {
    const fileName = path.basename(state.custom.file || '');
    const filePath = path.join(CUSTOM_FIRMWARE_DIR, fileName);
    if (fileName && fs.existsSync(filePath)) {
      const artifact = firmwareMetadata.inspectFirmware(filePath, MAX_FIRMWARE_SIZE);
      if (artifact.sha256 !== state.custom.sha256) {
        throw new Error('Selected custom firmware digest no longer matches its upload record');
      }
      return {
        version: state.custom.version,
        sha256: artifact.sha256,
        size: artifact.size,
        path: filePath,
        compiled_at: state.custom.compiled_at || artifact.compiled_at,
        ota_protocol: Number.isSafeInteger(state.custom.ota_protocol)
          ? state.custom.ota_protocol : artifact.ota_protocol,
        min_ota_protocol: Number.isSafeInteger(state.custom.min_ota_protocol)
          ? state.custom.min_ota_protocol : artifact.min_ota_protocol,
        source: 'custom',
      };
    }
    throw new Error('Selected custom firmware file is missing');
  }
  if (state.source === 'release' && state.release_tag) return cacheReleaseAsset(state.release_tag);
  const latest = await refreshFirmwareCache();
  return latest ? { ...latest, source: 'latest' } : null;
}

function firmwareSelectionMatches(state, active) {
  if (!active || state.source !== active.source) return false;
  if (state.source === 'release') return active.version === state.release_tag;
  if (state.source === 'custom') return !!state.custom && active.sha256 === state.custom.sha256;
  return state.source === 'latest';
}

app.get(
  '/api/firmware/control',
  asyncRoute(async (req, res) => {
    const state = firmwareState.load();
    res.json({
      auto_update: state.auto_update,
      control_id: state.control_id,
      request_id: state.request_id,
    });
  })
);

app.get(
  '/api/firmware',
  loginRequired,
  asyncRoute(async (req, res) => {
    const state = firmwareState.load();
    let releases = [];
    try {
      releases = await listFirmwareReleases();
    } catch (err) {
      logError('[firmware] list releases for dashboard', err);
    }
    let active = null;
    try {
      active = await resolveActiveFirmware();
    } catch (err) {
      logError('[firmware] resolve active manager firmware', err);
    }
    res.json({
      repo: FIRMWARE_REPO,
      asset_name: FIRMWARE_ASSET_NAME,
      max_size: MAX_FIRMWARE_SIZE,
      state,
      active: active && {
        version: active.version,
        sha256: active.sha256,
        size: active.size,
        compiled_at: active.compiled_at || null,
        ota_protocol: active.ota_protocol,
        min_ota_protocol: active.min_ota_protocol,
        source: active.source,
      },
      selection_in_sync: firmwareSelectionMatches(state, active),
      releases,
    });
  })
);

app.put(
  '/api/firmware/settings',
  loginRequired,
  asyncRoute(async (req, res) => {
    if (!req.body || typeof req.body.auto_update !== 'boolean') throw validationError('auto_update must be boolean');
    const state = firmwareState.update({ auto_update: req.body.auto_update });
    history.appendHistory({ ch: '*', trigger: 'edit', status: 'firmware_auto_update', note: state.auto_update ? 'enabled' : 'disabled' });
    res.json(state);
  })
);

app.post(
  '/api/firmware/device-status',
  express.json({ limit: '2kb' }),
  asyncRoute(async (req, res) => {
    const status = req.body || {};
    if (!Number.isSafeInteger(status.control_id) || status.control_id < 1
      || !Number.isSafeInteger(status.request_id) || status.request_id < 0
      || typeof status.auto_update !== 'boolean'
      || typeof status.firmware_version !== 'string' || status.firmware_version.length > 31
      || (status.compiled_at !== null && typeof status.compiled_at !== 'string')
      || (status.ota_protocol !== undefined && (!Number.isSafeInteger(status.ota_protocol)
        || status.ota_protocol < 1 || status.ota_protocol > 99))
      || (status.ota_status !== undefined && (typeof status.ota_status !== 'string' || status.ota_status.length > 48))
      || (status.ota_detail !== undefined && (typeof status.ota_detail !== 'string' || status.ota_detail.length > 160))) {
      throw validationError('Invalid firmware device status');
    }
    const state = firmwareState.acknowledgeDevice(status);
    res.json({ ok: true, control_id: state.control_id });
  })
);

app.put(
  '/api/firmware/source',
  loginRequired,
  asyncRoute(async (req, res) => {
    const source = req.body && req.body.source;
    if (source === 'latest') {
      const state = firmwareState.update({ source: 'latest', release_tag: null, force: null }, true);
      return res.json(state);
    }
    if (source !== 'release' || typeof req.body.tag !== 'string') throw validationError('Source must be latest or a release tag');
    if (req.body.force !== undefined && typeof req.body.force !== 'boolean') throw validationError('force must be boolean');
    const release = await cacheReleaseAsset(req.body.tag);
    const force = req.body.force === true;
    const current = firmwareState.load();
    const forceRequest = force ? {
      id: (current.force && current.force.id ? current.force.id : 0) + 1,
      sha256: release.sha256,
      requested_at: new Date().toISOString(),
    } : null;
    const state = firmwareState.update({ source: 'release', release_tag: req.body.tag, force: forceRequest }, true);
    history.appendHistory({ ch: '*', trigger: 'edit', status: force ? 'firmware_release_forced' : 'firmware_source', note: `release ${req.body.tag}${force ? ' FORCE BYPASS' : ''}` });
    res.json(state);
  })
);

app.post(
  '/api/firmware/check',
  loginRequired,
  asyncRoute(async (req, res) => {
    const state = firmwareState.update({}, true);
    history.appendHistory({ ch: '*', trigger: 'edit', status: 'firmware_check_requested' });
    res.json({ ok: true, control_id: state.control_id, request_id: state.request_id });
  })
);

app.post(
  '/api/firmware/custom',
  loginRequired,
  express.raw({ type: 'application/octet-stream', limit: MAX_FIRMWARE_SIZE }),
  asyncRoute(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 4096 || req.body.length > MAX_FIRMWARE_SIZE || req.body[0] !== 0xe9) {
      throw validationError('Upload must be a valid ESP32 firmware binary that fits the OTA partition');
    }
    const force = req.get('X-Firmware-Force') === 'true';
    const compiledAt = firmwareMetadata.readBuildStamp(req.body);
    if (!compiledAt && !force) {
      throw validationError('Firmware is missing the trusted BELL_BUILD compilation timestamp. Build it with this project before uploading.');
    }
    const version = compiledAt ? `custom-${compiledAt.replace(/[-:TZ]/g, '')}` : `forced-custom-${Date.now()}`;
    const sha256 = crypto.createHash('sha256').update(req.body).digest('hex');
    // Preserve each upload even when multiple builds share one compilation second.
    const fileName = `${version}-${crypto.randomUUID()}-${sha256.slice(0, 12)}.bin`;
    const filePath = path.join(CUSTOM_FIRMWARE_DIR, fileName);
    const tmpPath = `${filePath}.tmp`;
    fs.mkdirSync(CUSTOM_FIRMWARE_DIR, { recursive: true });
    fs.writeFileSync(tmpPath, req.body);
    fs.renameSync(tmpPath, filePath);
    const custom = {
      file: fileName,
      version,
      sha256,
      size: req.body.length,
      compiled_at: compiledAt,
      ota_protocol: firmwareMetadata.readOtaProtocol(req.body),
      min_ota_protocol: firmwareMetadata.readMinimumOtaProtocol(req.body),
      uploaded_at: new Date().toISOString(),
    };
    const current = firmwareState.load();
    const forceRequest = force ? {
      id: (current.force && current.force.id ? current.force.id : 0) + 1,
      sha256,
      requested_at: new Date().toISOString(),
    } : null;
    const state = firmwareState.update({ source: 'custom', release_tag: null, custom, force: forceRequest }, true);
    history.appendHistory({
      ch: '*',
      trigger: 'edit',
      status: force ? 'firmware_custom_forced' : 'firmware_custom_uploaded',
      note: `${version} (${custom.size} bytes)${force ? ' FORCE BYPASS' : ''}`,
    });
    res.status(201).json({ state, custom, forced: force });
  })
);

// Serve firmware version info — ESP32 polls this to decide whether to update.
// Public: no auth required (ESP32 has no interactive login).
app.get(
  '/api/firmware/version',
  asyncRoute(async (req, res) => {
    const info = await resolveActiveFirmware();
    if (!info) return res.status(503).json({ error: 'no firmware available' });
    const deviceProtocol = firmwareMetadata.parseDeviceOtaProtocol(req.get('X-Bell-OTA-Protocol'));
    const minimumProtocol = info.min_ota_protocol || firmwareMetadata.LEGACY_OTA_PROTOCOL;
    if (deviceProtocol < minimumProtocol) {
      return res.status(426).json({
        error: 'firmware requires a newer OTA protocol',
        min_ota_protocol: minimumProtocol,
      });
    }
    const state = firmwareState.load();
    const force = state.force && state.force.sha256 === info.sha256 ? state.force : null;
    res.json({
      version: info.version,
      size: info.size,
      sha256: info.sha256,
      artifact_sha256: info.sha256,
      compiled_at: info.compiled_at || null,
      ota_protocol: info.ota_protocol || firmwareMetadata.LEGACY_OTA_PROTOCOL,
      min_ota_protocol: minimumProtocol,
      source: info.source,
      force: !!force,
      force_id: force ? force.id : 0,
    });
  })
);

// Serve firmware binary with Range support for resume.
// Public: no auth required.
app.get(
  '/api/firmware/download',
  asyncRoute(async (req, res) => {
    const info = await resolveActiveFirmware();
    if (!info || !fs.existsSync(info.path)) {
      return res.status(503).json({ error: 'firmware not available' });
    }

    const requestedSha = typeof req.query.sha === 'string' ? req.query.sha.toLowerCase() : '';
    if (requestedSha && !/^[a-f0-9]{64}$/.test(requestedSha)) {
      return res.status(400).json({ error: 'invalid firmware artifact SHA-256' });
    }
    if (requestedSha && requestedSha !== info.sha256.toLowerCase()) {
      return res.status(409).json({ error: 'firmware artifact changed; request fresh metadata' });
    }

    const stat = fs.statSync(info.path);
    const totalSize = stat.size;
    if (totalSize === 0) {
      return res.status(500).json({ error: 'firmware file is empty' });
    }

    // Parse Range header
    const range = req.headers.range;
    let start = 0;
    let end = totalSize - 1;

    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) {
        res.set('Content-Range', `bytes */${totalSize}`);
        return res.status(416).end();
      }
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : totalSize - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= totalSize || start > end) {
        res.set('Content-Range', `bytes */${totalSize}`);
        return res.status(416).end();
      }
      if (end >= totalSize) end = totalSize - 1;
    }

    const chunkSize = (end - start) + 1;
    const status = (range && start > 0) ? 206 : 200;

    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': chunkSize,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'ETag': `"${info.sha256}"`,
    };
    if (status === 206) {
      headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
    }

    const stream = fs.createReadStream(info.path, { start, end });
    res.writeHead(status, headers);
    stream.pipe(res);
    stream.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ error: 'stream error' });
      logError('[firmware] download stream', err);
    });
  })
);

// ── Health check — public endpoint for updater / monitoring ──────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    node: process.version,
  });
});

// ---------------------------------------------------------------------------
// REST API — consumed by the dashboard (requires login)
// ---------------------------------------------------------------------------
app.get(
  '/api/log',
  loginRequired,
  asyncRoute(async (req, res) => {
    res.json(logBuf);
  })
);

app.post(
  '/api/schedule',
  loginRequired,
  asyncRoute(async (req, res) => {
    validateSchedule(req.body); // throws -> caught by asyncRoute -> error middleware -> 500 w/ message
    saveSchedule(req.body);
    profileScheduler.resolveAndApply();
    history.appendHistory({ ch: '*', trigger: 'edit', status: 'schedule_saved', note: `${Object.keys(req.body).length} channel(s)` });
    res.json({ ok: true });
  })
);

app.get(
  '/api/status',
  apiKeyOrLogin,
  asyncRoute(async (req, res) => {
    cleanStaleHeartbeats();
    const now = Date.now();
    const hb = {};
    for (const [k, v] of heartbeats) hb[k] = Math.round((now - v) / 100) / 10;
    res.json({
      heartbeats: hb,
      server_uptime: Math.round((now - startTime) / 100) / 10,
    });
  })
);

// ---------------------------------------------------------------------------
// NEW — Channel management (add / rename / remove relay channels)
// ---------------------------------------------------------------------------
app.get(
  '/api/channels',
  loginRequired,
  asyncRoute(async (req, res) => {
    const sch = loadSchedule();
    res.json(
      Object.entries(sch).map(([key, c]) => ({ key, label: c.label || key.toUpperCase(), enabled: !!c.enabled }))
    );
  })
);

app.post(
  '/api/channels',
  loginRequired,
  asyncRoute(async (req, res) => {
    const key = ((req.body && req.body.key) || '').toString().trim();
    const label = ((req.body && req.body.label) || key).toString().trim().slice(0, 40);
    if (!CHANNEL_KEY_RE.test(key)) {
      throw validationError('Channel key must start with a letter and use only letters/numbers/_/-, max 20 chars');
    }
    if (!DEVICE_CHANNEL_KEYS.has(key)) throw validationError('This device has fixed ch1 and ch2 relay channels');
    const sch = loadSchedule();
    if (sch[key]) throw validationError(`Channel '${key}' already exists`);
    if (Object.keys(sch).length >= MAX_CHANNELS) throw validationError(`Too many channels (max ${MAX_CHANNELS})`);
    sch[key] = { enabled: false, pulse_ms: 2000, schedule: [], skip_dates: [], label: label || key.toUpperCase() };
    validateSchedule(sch);
    saveSchedule(sch);
    history.appendHistory({ ch: key, trigger: 'edit', status: 'channel_created' });
    pushLog(`channel '${key}' created`);
    res.json({ ok: true, key });
  })
);

app.delete(
  '/api/channels/:key',
  loginRequired,
  asyncRoute(async (req, res) => {
    const key = req.params.key;
    if (!DEVICE_CHANNEL_KEYS.has(key)) throw validationError('This device has fixed ch1 and ch2 relay channels');
    const sch = loadSchedule();
    if (!sch[key]) throw validationError(`Channel '${key}' not found`);
    throw validationError('Device relay channels ch1 and ch2 cannot be removed');
  })
);

// ---------------------------------------------------------------------------
// NEW — Manual on/off control (independent of the schedule)
// ---------------------------------------------------------------------------
app.post(
  '/api/relay/:key/trigger',
  apiKeyOrLogin,
  asyncRoute(async (req, res) => {
    const key = req.params.key;
    const sch = loadSchedule();
    if (!sch[key]) throw validationError(`Channel '${key}' not found`);
    const requestedPulse = req.body && req.body.pulse_ms;
    const pulseMs = requestedPulse === undefined ? (sch[key].pulse_ms || 2000) : Number(requestedPulse);
    if (!Number.isInteger(pulseMs) || pulseMs < 100 || pulseMs > MAX_PULSE_MS) {
      throw validationError(`pulse_ms must be an integer from 100 to ${MAX_PULSE_MS}`);
    }
    pendingCommands.set(key, { pulse_ms: pulseMs, issued_at: Date.now() });
    history.appendHistory({ ch: key, trigger: 'manual', status: 'queued', pulse_ms: pulseMs, note: req.apiKey ? `via API key '${req.apiKey.name}'` : 'via dashboard' });
    pushLog(`${key} manual trigger queued (${pulseMs}ms)`);
    res.json({ ok: true, queued: true, ch: key, pulse_ms: pulseMs });
  })
);

// ---------------------------------------------------------------------------
// NEW — History & analytics
// ---------------------------------------------------------------------------
app.get(
  '/api/history',
  apiKeyOrLogin,
  asyncRoute(async (req, res) => {
    const entries = history.readHistory({
      ch: req.query.ch,
      trigger: req.query.trigger,
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
    });
    res.json(entries);
  })
);

app.get(
  '/api/history/export',
  loginRequired,
  asyncRoute(async (req, res) => {
    const entries = history.readHistory({
      ch: req.query.ch,
      trigger: req.query.trigger,
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit || 5000,
    });
    const csv = history.toCsv(entries);
    res.set('Content-Type', 'text/csv').set('Content-Disposition', 'attachment; filename="relay-history.csv"').send(csv);
  })
);

// ---------------------------------------------------------------------------
// NEW — Backup & restore
// ---------------------------------------------------------------------------
// Backup & restore (now includes profiles, calendar, settings)
// ---------------------------------------------------------------------------
app.get(
  '/api/backup',
  loginRequired,
  asyncRoute(async (req, res) => {
    const bundle = {
      version: 2,
      exported_at: new Date().toISOString(),
      schedule: loadSchedule(),
      history: history.readHistory({ limit: 5000 }),
      profiles: profiles.exportAll(),
      calendar: calendar.getAll(),
      settings: profileSettings.getSettings(),
    };
    res
      .set('Content-Type', 'application/json')
      .set('Content-Disposition', 'attachment; filename="relay-backup.json"')
      .send(JSON.stringify(bundle, null, 2));
  })
);

app.post(
  '/api/restore',
  loginRequired,
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    const incomingSchedule = body.schedule || body; // accept either a full bundle or a bare schedule
    validateSchedule(incomingSchedule);
    saveSchedule(incomingSchedule);
    if (Array.isArray(body.history)) {
      history.replaceAll(body.history);
    }
    if (body.profiles) {
      validateProfileBundle(body.profiles);
      profiles.importProfiles(body.profiles);
    }
    if (body.calendar) {
      validateCalendarSnapshot(body.calendar);
      calendar.replaceAll(body.calendar);
    }
    if (body.settings) {
      validateSettingsSnapshot(body.settings);
      profileSettings.replaceAll(body.settings);
    }
    // Re-resolve profile after restore
    profileScheduler.resolveAndApply();
    history.appendHistory({ ch: '*', trigger: 'edit', status: 'restored', note: 'restored from backup' });
    pushLog('schedule restored from backup');
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Profile management API
// ---------------------------------------------------------------------------
app.get(
  '/api/profiles',
  loginRequired,
  asyncRoute(async (req, res) => {
    res.json(profiles.listProfiles());
  })
);

app.get(
  '/api/profiles/active',
  loginRequired,
  asyncRoute(async (req, res) => {
    res.json(profileScheduler.getActiveInfo());
  })
);

app.get(
  '/api/profiles/:id',
  loginRequired,
  asyncRoute(async (req, res) => {
    const p = profiles.getProfile(req.params.id);
    if (!p) throw Object.assign(new Error('Profile not found'), { status: 404 });
    res.json(p);
  })
);

app.post(
  '/api/profiles',
  loginRequired,
  asyncRoute(async (req, res) => {
    const name = (req.body && req.body.name) || 'New Profile';
    const channels = (req.body && req.body.channels) || undefined;
    if (channels !== undefined) validateSchedule(channels);
    const created = profiles.createProfile(name, channels);
    history.appendHistory({ ch: '*', trigger: 'edit', status: 'profile_created', note: created.name });
    pushLog(`profile '${created.name}' created`);
    res.json(created);
  })
);

app.put(
  '/api/profiles/:id',
  loginRequired,
  asyncRoute(async (req, res) => {
    const id = req.params.id;
    if (req.body && req.body.name !== undefined) {
      profiles.renameProfile(id, req.body.name);
    }
    if (req.body && req.body.channels !== undefined) {
      validateSchedule(req.body.channels);
      profiles.saveChannels(id, req.body.channels);
    }
    profileScheduler.resolveAndApply();
    const p = profiles.getProfile(id);
    if (!p) throw Object.assign(new Error('Profile not found'), { status: 404 });
    history.appendHistory({ ch: '*', trigger: 'edit', status: 'profile_updated', note: p.name });
    pushLog(`profile '${p.name}' updated`);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/profiles/:id',
  loginRequired,
  asyncRoute(async (req, res) => {
    const p = profiles.getProfile(req.params.id);
    if (!p) throw Object.assign(new Error('Profile not found'), { status: 404 });
    profiles.deleteProfile(req.params.id);
    calendar.removeProfileAssignments(req.params.id);
    profileSettings.clearProfileReferences(req.params.id);
    profileScheduler.resolveAndApply();
    history.appendHistory({ ch: '*', trigger: 'edit', status: 'profile_deleted', note: p.name });
    pushLog(`profile '${p.name}' deleted`);
    res.json({ ok: true });
  })
);

app.post(
  '/api/profiles/:id/duplicate',
  loginRequired,
  asyncRoute(async (req, res) => {
    const dup = profiles.duplicateProfile(req.params.id);
    history.appendHistory({ ch: '*', trigger: 'edit', status: 'profile_duplicated', note: dup.name });
    pushLog(`profile duplicated as '${dup.name}'`);
    res.json(dup);
  })
);

app.get(
  '/api/profiles/export/all',
  loginRequired,
  asyncRoute(async (req, res) => {
    const bundle = profiles.exportAll();
    res
      .set('Content-Type', 'application/json')
      .set('Content-Disposition', 'attachment; filename="profiles-export.json"')
      .send(JSON.stringify(bundle, null, 2));
  })
);

app.post(
  '/api/profiles/import',
  loginRequired,
  asyncRoute(async (req, res) => {
    validateProfileBundle(req.body);
    const count = profiles.importProfiles(req.body);
    profileScheduler.resolveAndApply();
    history.appendHistory({ ch: '*', trigger: 'edit', status: 'profiles_imported', note: `${count} profile(s)` });
    pushLog(`${count} profile(s) imported`);
    res.json({ ok: true, imported: count });
  })
);

// ---------------------------------------------------------------------------
// Calendar assignments API
// ---------------------------------------------------------------------------
app.get(
  '/api/calendar',
  loginRequired,
  asyncRoute(async (req, res) => {
    res.json(calendar.getAll());
  })
);

app.post(
  '/api/calendar/date',
  loginRequired,
  asyncRoute(async (req, res) => {
    const { date, profileId } = req.body || {};
    if (!date) throw validationError('date is required (YYYY-MM-DD)');
    if (profileId && !profiles.getProfile(profileId)) throw validationError('Profile not found');
    calendar.assignDate(date, profileId || null);
    profileScheduler.resolveAndApply();
    history.appendHistory({ ch: '*', trigger: 'edit', status: 'calendar_updated', note: `date ${date}` });
    pushLog(`calendar: ${date} -> ${profileId || '(removed)'}`);
    res.json(calendar.getAll());
  })
);

app.post(
  '/api/calendar/dow',
  loginRequired,
  asyncRoute(async (req, res) => {
    const { dow, profileId } = req.body || {};
    if (!dow) throw validationError('dow is required');
    if (profileId && !profiles.getProfile(profileId)) throw validationError('Profile not found');
    calendar.assignDow(dow, profileId || null);
    profileScheduler.resolveAndApply();
    history.appendHistory({ ch: '*', trigger: 'edit', status: 'calendar_updated', note: `dow ${dow}` });
    pushLog(`calendar: ${dow} -> ${profileId || '(removed)'}`);
    res.json(calendar.getAll());
  })
);

app.delete(
  '/api/calendar/:type/:key',
  loginRequired,
  asyncRoute(async (req, res) => {
    calendar.removeAssignment(req.params.type, req.params.key);
    profileScheduler.resolveAndApply();
    pushLog(`calendar: removed ${req.params.type} ${req.params.key}`);
    res.json(calendar.getAll());
  })
);

// ---------------------------------------------------------------------------
// Settings & override API
// ---------------------------------------------------------------------------
app.get(
  '/api/settings',
  loginRequired,
  asyncRoute(async (req, res) => {
    res.json(profileSettings.getSettings());
  })
);

app.put(
  '/api/settings',
  loginRequired,
  asyncRoute(async (req, res) => {
    if (req.body && req.body.default_profile !== undefined) {
      if (req.body.default_profile && !profiles.getProfile(req.body.default_profile)) throw validationError('Profile not found');
      profileSettings.setDefaultProfile(req.body.default_profile);
    }
    profileScheduler.resolveAndApply();
    res.json(profileSettings.getSettings());
  })
);

app.post(
  '/api/profiles/override',
  loginRequired,
  asyncRoute(async (req, res) => {
    const { profileId, until } = req.body || {};
    if (!profileId) throw validationError('profileId is required');
    if (!profiles.getProfile(profileId)) throw validationError('Profile not found');
    profileSettings.setOverride(profileId, until || null);
    profileScheduler.resolveAndApply();
    const info = profileScheduler.getActiveInfo();
    history.appendHistory({ ch: '*', trigger: 'edit', status: 'override_set', note: `-> ${info.name}` });
    pushLog(`manual override -> ${info.name}`);
    res.json(info);
  })
);

app.post(
  '/api/profiles/override/clear',
  loginRequired,
  asyncRoute(async (req, res) => {
    profileSettings.clearOverride();
    profileScheduler.resolveAndApply();
    const info = profileScheduler.getActiveInfo();
    history.appendHistory({ ch: '*', trigger: 'edit', status: 'override_cleared' });
    pushLog(`manual override cleared -> ${info.name}`);
    res.json(info);
  })
);

// ---------------------------------------------------------------------------
// Profiles dashboard page
// ---------------------------------------------------------------------------
app.get(
  '/profiles',
  loginRequired,
  asyncRoute(async (req, res) => {
    if (!fs.existsSync(PROFILES_TPL)) {
      return res.status(404).send('Profiles page not found');
    }
    const html = fs.readFileSync(PROFILES_TPL, 'utf8');
    res.set('Cache-Control', 'no-store').type('html').send(html);
  })
);

// ---------------------------------------------------------------------------
// NEW — Account: change password without SSH access
// ---------------------------------------------------------------------------
app.post(
  '/api/account/password',
  loginRequired,
  asyncRoute(async (req, res) => {
    const current = (req.body && req.body.current) || '';
    const next = (req.body && req.body.next) || '';
    if (!auth.verifyPassword(current)) throw validationError('Current password is incorrect');
    try {
      auth.setPassword(next);
    } catch (err) {
      throw validationError(err.message);
    }
    pushLog('dashboard password changed');
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// NEW — API keys for external integrations
// ---------------------------------------------------------------------------
app.get(
  '/api/keys',
  loginRequired,
  asyncRoute(async (req, res) => {
    res.json(apikeys.listKeys());
  })
);

app.post(
  '/api/keys',
  loginRequired,
  asyncRoute(async (req, res) => {
    const name = (req.body && req.body.name) || '';
    const created = apikeys.createKey(name);
    pushLog(`API key '${created.name}' created`);
    res.json(created); // `key` is only ever returned here — not retrievable again
  })
);

app.delete(
  '/api/keys/:id',
  loginRequired,
  asyncRoute(async (req, res) => {
    const ok = apikeys.revokeKey(req.params.id);
    if (!ok) throw validationError('Key not found');
    pushLog('API key revoked');
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
app.get(
  '/',
  loginRequired,
  asyncRoute(async (req, res) => {
    const html = fs.readFileSync(INDEX_TPL, 'utf8'); // read fresh every request, bypass any caching
    res.set('Cache-Control', 'no-store').type('html').send(html);
  })
);

// ---------------------------------------------------------------------------
// PWA assets — public (no auth; service workers MUST be scope-root)
// ---------------------------------------------------------------------------
app.get('/manifest.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600').type('json').sendFile(MANIFEST_PATH);
});

app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache').type('application/javascript').sendFile(SW_PATH);
});

app.get('/icon-192.png', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400').type('png').sendFile(ICON_192_PATH);
});

app.get('/icon-512.png', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400').type('png').sendFile(ICON_512_PATH);
});

app.get('/bell.svg', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400').type('svg').sendFile(BELL_SVG_PATH);
});

// ---------------------------------------------------------------------------
// 404 + centralized error handling
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

// This MUST have 4 args for Express to treat it as an error handler.
// Every thrown/rejected error from any route above (validation errors,
// bad JSON, disk I/O failures, etc.) ends up here instead of crashing
// the process or leaking a raw stack trace to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logError(`${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return;
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  res.status(status).json({
    error: status === 500 ? 'internal server error' : err.message,
  });
});

// ---------------------------------------------------------------------------
// UDP beacon — ESP32 auto-discovers the server
// ---------------------------------------------------------------------------
function startBeacon() {
  const sock = dgram.createSocket('udp4');
  sock.on('error', (err) => {
    logError('[beacon] socket error', err);
  });
  sock.bind(() => {
    sock.setBroadcast(true);
    log(`[beacon] Broadcasting on UDP/${BEACON_PORT} every ${BEACON_INTERVAL_MS / 1000}s`);
    setInterval(() => {
      sock.send(BEACON_MSG, 0, BEACON_MSG.length, BEACON_PORT, '255.255.255.255', (err) => {
        if (err) logError('[beacon] send failed', err);
      });
    }, BEACON_INTERVAL_MS);
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
const startTime = Date.now();

/**
 * Older installations keep their runtime JSON across git updates.  Seed the
 * built-in weekday/weekend profiles and assignments when they are absent, but
 * never replace an administrator's existing profile or calendar assignment.
 */
function seedMissingBuiltInCalendar() {
  let defaultProfiles;
  let defaultCalendar;
  try {
    defaultProfiles = JSON.parse(fs.readFileSync(DEFAULT_PROFILES_FILE, 'utf8'));
    defaultCalendar = JSON.parse(fs.readFileSync(DEFAULT_CALENDAR_FILE, 'utf8'));
  } catch (err) {
    logError('loading built-in profile defaults', err);
    return;
  }

  for (const [id, profile] of Object.entries(defaultProfiles.profiles || {})) {
    if (!profiles.getProfile(id) && profile && profile.name && profile.channels) {
      const created = profiles.createProfile(profile.name, profile.channels);
      log(`[server] Restored missing built-in profile '${created.name}' (${created.id})`);
    }
  }

  const current = calendar.getAll();
  for (const [dow, profileId] of Object.entries(defaultCalendar.dow || {})) {
    if (current.dow[dow] === undefined && profiles.getProfile(profileId)) {
      calendar.assignDow(dow, profileId);
      log(`[server] Restored missing ${dow} profile assignment -> ${profileId}`);
    }
  }
}

function bootstrap() {
  // Migration: if old schedule.json exists but profiles.json doesn't,
  // create a "Regular Working Day" profile from the existing schedule.
  if (!fs.existsSync(profiles.PROFILES_FILE) && fs.existsSync(SCHEDULE_FILE)) {
    try {
      const oldSchedule = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
      if (oldSchedule && typeof oldSchedule === 'object' && !Array.isArray(oldSchedule)) {
        const created = profiles.createProfile('Regular Working Day', oldSchedule);
        profileSettings.setDefaultProfile(created.id);
        log(`[server] Migrated schedule.json -> profile '${created.name}' (${created.id})`);
      }
    } catch (err) {
      log(`[server] Migration skipped: ${err.message}`);
    }
  }

  // Existing installations retain calendar.json/profiles.json, so they need
  // an explicit non-destructive migration when built-in days are introduced.
  seedMissingBuiltInCalendar();

  // Ensure at least one profile exists
  const ids = profiles.listIds();
  if (ids.length === 0) {
    const created = profiles.createProfile('Regular Working Day');
    profileSettings.setDefaultProfile(created.id);
    log(`[server] Created default profile '${created.name}'`);
  }

  if (!profileSettings.getSettings().default_profile && profiles.getProfile('regular-working-day')) {
    profileSettings.setDefaultProfile('regular-working-day');
  }

  // Resolve and apply the active profile for today
  profileScheduler.resolveAndApply();

  // Schedule midnight profile refresh — check every minute
  let lastDay = profileScheduler.todayStr();
  setInterval(() => {
    const today = profileScheduler.todayStr();
    if (today !== lastDay) {
      lastDay = today;
      profileScheduler.resolveAndApply();
      log(`[server] Midnight rollover — new active profile applied`);
    }
  }, PROFILE_REFRESH_INTERVAL_MS);

  auth.loadPasswordHash(); // creates password.json with default password notice, if needed
}

// Never let an unexpected error silently crash into a corrupt half-state.
// Log everything, then exit so a process manager (systemd/pm2) restarts
// the process cleanly. See README.md for a systemd example.
process.on('uncaughtException', (err) => {
  logError('uncaughtException', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason);
  process.exit(1);
});

bootstrap();
startBeacon();

const server = http.createServer(app);
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 100;
server.listen(PORT, HOST, () => {
  const localIp = getLocalIPv4();
  log(`[server] Relay Controller listening on http://${HOST}:${PORT} (accessible at http://${localIp}:${PORT})`);

});


// Graceful shutdown on SIGTERM/SIGINT (e.g. `systemctl stop`, Ctrl+C)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`[server] received ${sig}, shutting down…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
