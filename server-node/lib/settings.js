'use strict';
/**
 * lib/settings.js — Active profile, default profile, and manual override
 * ─────────────────────────────────────────────────────────────────────
 * Stores in settings.json:
 *   - active_profile: the currently active profile ID (resolved daily)
 *   - default_profile: fallback when no calendar assignment matches
 *
 * Manual override is session-only (in-memory, cleared on server restart).
 * Within a session, an optional `until` ISO date auto-expires the override.
 */
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');

// In-memory session-only override — cleared on server restart
let sessionOverride = null;       // profileId or null
let sessionOverrideUntil = null;  // ISO date string or null (within-session expiry)

function writeFileAtomic(filePath, contents) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

function defaults() {
  return {
    active_profile: null,
    default_profile: null,
  };
}

function load() {
  if (!fs.existsSync(SETTINGS_FILE)) return defaults();
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return { ...defaults(), ...data };
  } catch {
    return defaults();
  }
}

function save(data) {
  writeFileAtomic(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

/** Get all settings — merges session-only override into persisted state. */
function getSettings() {
  const s = load();

  // Auto-clear expired session override
  if (sessionOverride && sessionOverrideUntil) {
    const until = new Date(sessionOverrideUntil);
    if (!isNaN(until.getTime()) && until <= new Date()) {
      sessionOverride = null;
      sessionOverrideUntil = null;
    }
  }

  // Merge session-only override into returned object
  s.manual_override = sessionOverride;
  s.override_until = sessionOverrideUntil;
  return s;
}

/** Set manual override to a profile ID (session-only, lost on restart).
 *  `until` is an optional ISO date for within-session auto-expiry. */
function setOverride(profileId, until) {
  sessionOverride = profileId || null;
  sessionOverrideUntil = until || null;
  if (profileId) {
    // Persist active_profile so the ESP32 schedule resolves correctly
    const s = load();
    s.active_profile = profileId;
    save(s);
  }
  return getSettings();
}

/** Clear manual override (session-only). */
function clearOverride() {
  sessionOverride = null;
  sessionOverrideUntil = null;
  return getSettings();
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
  s.active_profile = profileId || null;
  save(s);
  return s;
}

module.exports = {
  SETTINGS_FILE,
  getSettings,
  setOverride,
  clearOverride,
  setDefaultProfile,
  setActiveProfile,
};
