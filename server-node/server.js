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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const HOST = '0.0.0.0';
const PORT = 8080;
const SCHEDULE_FILE = path.join(__dirname, 'schedule.json'); // legacy — kept for migration
const PROFILES_TPL = path.join(__dirname, 'templates', 'profiles.html');
const PROFILE_REFRESH_INTERVAL_MS = 60000; // check every minute for midnight rollover
const BEACON_PORT = 9999;
const BEACON_INTERVAL_MS = 5000;
const BEACON_MSG = Buffer.from(`RELAY_CTRL:${PORT}\n`);
const INDEX_TPL = path.join(__dirname, 'templates', 'index.html');
const LOGIN_TPL = path.join(__dirname, 'templates', 'login.html');

const CHANNEL_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/; // must start with a letter
const MAX_CHANNELS = 24;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}
function logError(context, err) {
  console.error(`[${new Date().toISOString()}] [ERROR] ${context}:`, err && err.stack ? err.stack : err);
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
  return !Number.isNaN(dt.getTime());
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
  if (keys.length === 0) throw validationError('At least one channel is required');
  if (keys.length > MAX_CHANNELS) throw validationError(`Too many channels (max ${MAX_CHANNELS})`);

  for (const ch of keys) {
    if (!CHANNEL_KEY_RE.test(ch)) {
      throw validationError(`Invalid channel key '${ch}' — letters/numbers/_/-, must start with a letter, max 20 chars`);
    }
    const c = data[ch];
    if (!c || typeof c !== 'object') throw validationError(`${ch} must be an object`);
    if (typeof c.enabled !== 'boolean') throw validationError(`${ch}.enabled must be bool`);
    if (typeof c.pulse_ms !== 'number' || c.pulse_ms < 100) {
      throw validationError(`${ch}.pulse_ms must be >= 100`);
    }
    if (c.label !== undefined && (typeof c.label !== 'string' || c.label.length > 40)) {
      throw validationError(`${ch}.label must be a string up to 40 chars`);
    }
    if (!Array.isArray(c.schedule)) throw validationError(`${ch}.schedule must be a list`);
    for (const entry of c.schedule) {
      const parts = typeof entry === 'string' ? entry.split(':') : [];
      if (parts.length !== 2) throw validationError(`${ch} schedule entry '${entry}' invalid — use HH:MM`);
      const hh = Number(parts[0]);
      const mm = Number(parts[1]);
      if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
        throw validationError(`${ch} schedule entry '${entry}' invalid — use HH:MM`);
      }
    }
    if (!Array.isArray(c.skip_dates)) throw validationError(`${ch}.skip_dates must be a list`);
    for (const d of c.skip_dates) {
      if (!isValidDateStr(d)) throw validationError(`${ch} skip_date '${d}' invalid — use YYYY-MM-DD`);
    }
  }
}

function scheduleHash() {
  const sorted = JSON.stringify(sortObjectDeep(loadSchedule()));
  return crypto.createHash('md5').update(sorted).digest('hex').slice(0, 8);
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

const MAX_LOG_ENTRIES = 100;
const logBuf = [];
function pushLog(msg) {
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  logBuf.push({ t: `${hh}:${mm}:${ss}`, msg });
  while (logBuf.length > MAX_LOG_ENTRIES) logBuf.shift();
}

// NEW: pending manual-trigger commands, keyed by channel. The ESP32 already
// polls the server (for /api/schedule) so manual "run now" reuses that same
// pull model instead of requiring a push connection to the device: the
// dashboard queues a command, the device picks it up next time it polls
// GET /api/commands, and the command is cleared as soon as it's delivered.
const pendingCommands = new Map(); // ch -> { pulse_ms, issued_at }

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // honor X-Forwarded-For if run behind a reverse proxy

app.use(
  helmet({
    // The dashboard/login pages use inline <style>/<script> with no nonce,
    // so a strict default CSP would break them. Other protections (frame
    // guard, no-sniff, etc.) still apply.
    contentSecurityPolicy: false,
  })
);
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

app.use(
  session({
    name: 'relay.sid',
    secret: auth.loadOrCreateSecretKey(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
      httpOnly: true,
      sameSite: 'lax',
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
    res.json(loadSchedule());
  })
);

app.get(
  '/api/schedule/hash',
  asyncRoute(async (req, res) => {
    res.json({ h: scheduleHash() });
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
    const msg = ((req.body && req.body.msg) || '').toString().trim();
    if (msg) pushLog(msg);
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
    const sch = loadSchedule();
    if (sch[key]) throw validationError(`Channel '${key}' already exists`);
    if (Object.keys(sch).length >= MAX_CHANNELS) throw validationError(`Too many channels (max ${MAX_CHANNELS})`);
    sch[key] = { enabled: false, pulse_ms: 2000, schedule: [], skip_dates: [], label: label || key.toUpperCase() };
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
    const sch = loadSchedule();
    if (!sch[key]) throw validationError(`Channel '${key}' not found`);
    if (Object.keys(sch).length <= 1) throw validationError('At least one channel must remain');
    delete sch[key];
    saveSchedule(sch);
    heartbeats.delete(key);
    pendingCommands.delete(key);
    history.appendHistory({ ch: key, trigger: 'edit', status: 'channel_deleted' });
    pushLog(`channel '${key}' deleted`);
    res.json({ ok: true });
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
    const pulseMs = Number(req.body && req.body.pulse_ms) || sch[key].pulse_ms || 2000;
    if (pulseMs < 100) throw validationError('pulse_ms must be >= 100');
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
      profiles.importProfiles(body.profiles);
    }
    if (body.calendar) {
      const fs = require('fs');
      const path = require('path');
      fs.writeFileSync(calendar.CALENDAR_FILE, JSON.stringify(body.calendar, null, 2));
    }
    if (body.settings) {
      const fs = require('fs');
      fs.writeFileSync(profileSettings.SETTINGS_FILE, JSON.stringify(body.settings, null, 2));
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
    const count = profiles.importProfiles(req.body);
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
    calendar.assignDate(date, profileId || null);
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
    calendar.assignDow(dow, profileId || null);
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
      profileSettings.setDefaultProfile(req.body.default_profile);
    }
    res.json(profileSettings.getSettings());
  })
);

app.post(
  '/api/profiles/override',
  loginRequired,
  asyncRoute(async (req, res) => {
    const { profileId, until } = req.body || {};
    if (!profileId) throw validationError('profileId is required');
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

  // Ensure at least one profile exists
  const ids = profiles.listIds();
  if (ids.length === 0) {
    const created = profiles.createProfile('Regular Working Day');
    profileSettings.setDefaultProfile(created.id);
    log(`[server] Created default profile '${created.name}'`);
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
