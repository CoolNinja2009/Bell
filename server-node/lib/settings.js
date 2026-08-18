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

const SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');

function writeFileAtomic(filePath, contents) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

const DATE_FORMATS = ['dd-mm-yyyy', 'mm-dd-yyyy', 'yyyy-mm-dd'];
const TIME_FORMATS = ['hh:mm:ss', 'hh:mm'];

function validDateFormat(value) {
  return DATE_FORMATS.includes(value) ? value : 'dd-mm-yyyy';
}

function validTimeFormat(value) {
  return TIME_FORMATS.includes(value) ? value : 'hh:mm:ss';
}

function defaults() {
  return {
    active_profile: null,
    default_profile: null,
    manual_override: null,
    override_until: null,
    date_format: 'dd-mm-yyyy',
    time_format: 'hh:mm:ss',
  };
}

function load() {
  if (!fs.existsSync(SETTINGS_FILE)) return defaults();
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return defaults();
    return {
      active_profile: typeof data.active_profile === 'string' ? data.active_profile : null,
      default_profile: typeof data.default_profile === 'string' ? data.default_profile : null,
      manual_override: typeof data.manual_override === 'string' ? data.manual_override : null,
      override_until: typeof data.override_until === 'string' ? data.override_until : null,
      date_format: validDateFormat(data.date_format),
      time_format: validTimeFormat(data.time_format),
    };
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
    date_format: validDateFormat(data.date_format),
    time_format: validTimeFormat(data.time_format),
  };
  save(next);
  return next;
}

/** Set the date/time display format. Unknown values fall back to the Indian default. */
function setTimeFormat(date_format, time_format) {
  const s = load();
  if (date_format !== undefined) s.date_format = validDateFormat(date_format);
  if (time_format !== undefined) s.time_format = validTimeFormat(time_format);
  save(s);
  return s;
}

module.exports = {
  SETTINGS_FILE,
  DATE_FORMATS,
  TIME_FORMATS,
  getSettings,
  setOverride,
  clearOverride,
  setDefaultProfile,
  setActiveProfile,
  clearProfileReferences,
  replaceAll,
  setTimeFormat,
};
