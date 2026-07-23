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

const CALENDAR_FILE = path.join(__dirname, '..', 'calendar.json');

const VALID_DOWS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function writeFileAtomic(filePath, contents) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

function load() {
  if (!fs.existsSync(CALENDAR_FILE)) return { dates: {}, dow: {} };
  try {
    return JSON.parse(fs.readFileSync(CALENDAR_FILE, 'utf8'));
  } catch {
    return { dates: {}, dow: {} };
  }
}

function save(data) {
  writeFileAtomic(CALENDAR_FILE, JSON.stringify(data, null, 2));
}

/** Get all calendar assignments. */
function getAll() {
  return load();
}

/** Assign a profile to a specific date (YYYY-MM-DD). Set profileId to null to remove. */
function assignDate(date, profileId) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error('Invalid date format (YYYY-MM-DD)'), { status: 400 });
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

module.exports = { CALENDAR_FILE, getAll, assignDate, assignDow, removeAssignment, VALID_DOWS };
