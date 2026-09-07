'use strict';
/**
 * lib/settings.js â€” Active profile, default profile, and manual override
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * Stores in settings.json:
 *   - active_profile: the currently active profile ID (resolved daily)
 *   - default_profile: fallback when no calendar assignment matches
 *   - manual_override: temporary override profile ID (or null)
 *   - override_until: ISO date string (null = until disabled)
 */
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = process.env.RELAY_SETTINGS_FILE || path.join(__dirname, '..', 'settings.json');

function writeFileAtomic(filePath, contents) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

function defaults() {
  return {
    active_profile: null,
    default_profile: null,
    manual_override: null,
    override_until: null,
  };
}

let lastGoodData = defaults();
let storeBroken = false;
let lastError = null;

function load() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    storeBroken = false;
    lastError = null;
    lastGoodData = defaults();
    return lastGoodData;
  }
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('settings.json must contain a JSON object');
    }
    const clean = {
      active_profile: typeof data.active_profile === 'string' ? data.active_profile : null,
      default_profile: typeof data.default_profile === 'string' ? data.default_profile : null,
      manual_override: typeof data.manual_override === 'string' ? data.manual_override : null,
      override_until: typeof data.override_until === 'string' ? data.override_until : null,
    };
    storeBroken = false;
    lastError = null;
    lastGoodData = clean;
    return clean;
  } catch (err) {
    // Critical: setActiveProfile() is called automatically by the scheduler
    // on every resolve cycle, with no user action at all. If a broken file
    // were silently treated as "no settings yet", that automatic call would
    // immediately overwrite it with a near-empty file — permanently losing
    // default_profile / manual_override. So: log it, serve the last
    // known-good in-memory copy for read continuity, and block writes.
    if (!storeBroken || lastError !== err.message) {
      console.error(`[SETTINGS] settings.json failed to load: ${err.message}`);
      console.error('[SETTINGS] Serving last known-good in-memory settings (if any); writes are blocked until the file is fixed or removed.');
    }
    storeBroken = true;
    lastError = err.message;
    return lastGoodData;
  }
}

function save(data) {
  if (storeBroken) {
    const err = new Error(
      'settings.json is currently broken on disk and cannot be safely modified. ' +
      'Fix or remove the file, then try again.'
    );
    err.status = 409;
    err.code = 'SETTINGS_STORE_BROKEN';
    throw err;
  }
  writeFileAtomic(SETTINGS_FILE, JSON.stringify(data, null, 2));
  lastGoodData = data;
}

/** True when settings.json currently fails to load. */
function isBroken() {
  return storeBroken;
}

/** Human-readable reason for the current failure, or null if healthy. */
function getLastError() {
  return lastError;
}

/** Get all settings. */
function getSettings() {
  // Auto-clear expired overrides
  const s = load();
  if (s.manual_override && s.override_until && !storeBroken) {
    const until = new Date(s.override_until);
    if (!isNaN(until.getTime()) && until <= new Date()) {
      s.manual_override = null;
      s.override_until = null;
      save(s);
    }
  }
  return s;
}

/** Set manual override to a profile ID. `until` is an optional ISO date. */
function setOverride(profileId, until) {
  const s = load();
  s.manual_override = profileId || null;
  s.override_until = until || null;
  if (profileId) {
    // If overriding, also set as active
    s.active_profile = profileId;
  }
  save(s);
  return s;
}

/** Clear manual override, forcing re-resolution on next cycle. */
function clearOverride() {
  const s = load();
  s.manual_override = null;
  s.override_until = null;
  save(s);
  return s;
}

/** Set the default profile. */
function setDefaultProfile(profileId) {
  const s = load();
  s.default_profile = profileId || null;
  save(s);
  return s;
}

/** Record the currently active profile (set by the scheduler). */
function setActiveProfile(profileId) {
  const s = load();
  const next = profileId || null;
  if (s.active_profile !== next) {
    s.active_profile = next;
    save(s);
  }
  return s;
}

/** Clear settings fields that reference a deleted profile. */
function clearProfileReferences(profileId) {
  const s = load();
  let changed = false;
  for (const key of ['active_profile', 'default_profile', 'manual_override']) {
    if (s[key] === profileId) {
      s[key] = null;
      changed = true;
    }
  }
  if (changed) {
    if (!s.manual_override) s.override_until = null;
    save(s);
  }
  return s;
}

/** Replace settings after caller validation, discarding unknown legacy fields. */
function replaceAll(data) {
  const next = {
    active_profile: data.active_profile || null,
    default_profile: data.default_profile || null,
    manual_override: data.manual_override || null,
    override_until: data.override_until || null,
  };
  save(next);
  return next;
}

module.exports = {
  SETTINGS_FILE,
  getSettings,
  setOverride,
  clearOverride,
  setDefaultProfile,
  setActiveProfile,
  clearProfileReferences,
  replaceAll,
  isBroken,
  getLastError,
};
