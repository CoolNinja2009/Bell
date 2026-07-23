'use strict';
/**
 * lib/settings.js — Active profile, default profile, and manual override
 * ─────────────────────────────────────────────────────────────────────
 * Stores in settings.json:
 *   - active_profile: the currently active profile ID (resolved daily)
 *   - default_profile: fallback when no calendar assignment matches
 *   - manual_override: temporary override profile ID (or null)
 *   - override_until: ISO date string (null = until disabled)
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

/** Get all settings. */
function getSettings() {
  // Auto-clear expired overrides
  const s = load();
  if (s.manual_override && s.override_until) {
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
