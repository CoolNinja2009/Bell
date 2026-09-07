'use strict';
/**
 * lib/calendar.js — Calendar-based profile assignments
 * ─────────────────────────────────────────────────────────────────────
 * Stores date-specific and day-of-week → profile assignments in
 * calendar.json. Dates are YYYY-MM-DD; DOW keys are lowercase English
 * names: sunday, monday, ..., saturday.
 */
const fs = require('fs');
const path = require('path');

const CALENDAR_FILE = process.env.RELAY_CALENDAR_FILE || path.join(__dirname, '..', 'calendar.json');

const VALID_DOWS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function emptyCalendar() {
  return { dates: {}, dow: {} };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function writeFileAtomic(filePath, contents) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

let lastGoodData = emptyCalendar();
let storeBroken = false;
let lastError = null;

function load() {
  if (!fs.existsSync(CALENDAR_FILE)) {
    storeBroken = false;
    lastError = null;
    lastGoodData = emptyCalendar();
    return lastGoodData;
  }
  try {
    const data = JSON.parse(fs.readFileSync(CALENDAR_FILE, 'utf8'));
    if (!isPlainObject(data)) throw new Error('calendar.json must contain a JSON object with "dates" and "dow"');
    const clean = {
      dates: isPlainObject(data.dates) ? data.dates : {},
      dow: isPlainObject(data.dow) ? data.dow : {},
    };
    storeBroken = false;
    lastError = null;
    lastGoodData = clean;
    return clean;
  } catch (err) {
    // A broken calendar.json must never be silently treated as "no
    // assignments" — that would let a later save() permanently erase
    // whatever was on disk. Log it, serve the last known-good in-memory
    // copy (if this process has one) for read continuity, and block
    // writes until the file is fixed.
    if (!storeBroken || lastError !== err.message) {
      console.error(`[CALENDAR] calendar.json failed to load: ${err.message}`);
      console.error('[CALENDAR] Serving last known-good in-memory assignments (if any); writes are blocked until the file is fixed or removed.');
    }
    storeBroken = true;
    lastError = err.message;
    return lastGoodData;
  }
}

function save(data) {
  if (storeBroken) {
    const err = new Error(
      'calendar.json is currently broken on disk and cannot be safely modified. ' +
      'Fix or remove the file (a backup may help), then try again.'
    );
    err.status = 409;
    err.code = 'CALENDAR_STORE_BROKEN';
    throw err;
  }
  writeFileAtomic(CALENDAR_FILE, JSON.stringify(data, null, 2));
  lastGoodData = data;
}

/** True when calendar.json currently fails to load. */
function isBroken() {
  return storeBroken;
}

/** Human-readable reason for the current failure, or null if healthy. */
function getLastError() {
  return lastError;
}

/** Get all calendar assignments. */
function getAll() {
  return load();
}

/** Assign a profile to a specific date (YYYY-MM-DD). Set profileId to null to remove. */
function assignDate(date, profileId) {
  if (!isValidDate(date)) throw Object.assign(new Error('Invalid date format (YYYY-MM-DD)'), { status: 400 });
  const data = load();
  if (profileId === null || profileId === undefined || profileId === '') {
    delete data.dates[date];
  } else {
    data.dates[date] = String(profileId);
  }
  save(data);
  return data;
}

/** Assign a profile to a day of week. Set profileId to null to remove. */
function assignDow(dow, profileId) {
  if (!VALID_DOWS.includes(dow)) throw Object.assign(new Error('Invalid day of week'), { status: 400 });
  const data = load();
  if (profileId === null || profileId === undefined || profileId === '') {
    delete data.dow[dow];
  } else {
    data.dow[dow] = String(profileId);
  }
  save(data);
  return data;
}

/** Remove an assignment by type ('date' or 'dow') and key. */
function removeAssignment(type, key) {
  const data = load();
  if (type === 'date') {
    delete data.dates[key];
  } else if (type === 'dow') {
    delete data.dow[key];
  } else {
    throw Object.assign(new Error('Type must be "date" or "dow"'), { status: 400 });
  }
  save(data);
  return data;
}

/** Remove every date/day assignment pointing to a deleted profile. */
function removeProfileAssignments(profileId) {
  const data = load();
  let changed = false;
  for (const [date, id] of Object.entries(data.dates)) {
    if (id === profileId) {
      delete data.dates[date];
      changed = true;
    }
  }
  for (const [dow, id] of Object.entries(data.dow)) {
    if (id === profileId) {
      delete data.dow[dow];
      changed = true;
    }
  }
  if (changed) save(data);
  return data;
}

/** Replace all assignments after caller validation. */
function replaceAll(data) {
  save({ dates: { ...data.dates }, dow: { ...data.dow } });
  return getAll();
}

module.exports = { CALENDAR_FILE, getAll, assignDate, assignDow, removeAssignment, removeProfileAssignments, replaceAll, VALID_DOWS, isValidDate, isBroken, getLastError };
