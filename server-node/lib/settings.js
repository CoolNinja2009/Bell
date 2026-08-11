'use strict';
/**
 * lib/settings.js — Active profile, default profile, and manual override
 * ─────────────────────────────────────────────────────────────────────
 * Stores in settings.json:
 *   - active_profile: the currently active profile ID (resolved daily)
 *   - default_profile: fallback when no calendar assignment matches
 *   - manual_override: profile ID when dashboard override is active
 *   - override_until: optional ISO date for auto-expiry
 *   - override_date: YYYY-MM-DD when the override was set (cleared on day change)
 *
 * Overrides are persisted to file so they survive server restarts.
 * Midnight rollover clears them (handled by server.js setInterval).
 */
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');

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
    override_date: null,
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
/** Get all settings — returns persisted state.
 *  Auto-clears expired override and stale (previous-day) overrides. */
function getSettings() {
  const s = load();

  // Auto-clear expired override
  if (s.manual_override && s.override_until) {
    const until = new Date(s.override_until);
    if (!isNaN(until.getTime()) && until <= new Date()) {
      s.manual_override = null;
      s.override_until = null;
      s.override_date = null;
      save(s);
    }
  }

  // Auto-clear stale override (set on a previous day)
  if (s.manual_override && s.override_date) {
    const today = new Date().toISOString().slice(0, 10);
    if (s.override_date !== today) {
      s.manual_override = null;
      s.override_until = null;
      s.override_date = null;
      save(s);
    }
  }

  return s;
}

/** Set manual override to a profile ID (persisted, survives restart).
 *  `until` is an optional ISO date for auto-expiry. */
function setOverride(profileId, until) {
  const s = load();
  s.manual_override = profileId || null;
  s.override_until = until || null;
  s.override_date = profileId ? new Date().toISOString().slice(0, 10) : null;
  if (profileId) {
    s.active_profile = profileId;
  }
  save(s);
  return s;
}

/** Clear manual override. */
function clearOverride() {
  const s = load();
  s.manual_override = null;
  s.override_until = null;
  s.override_date = null;
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
