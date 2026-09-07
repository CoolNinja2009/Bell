'use strict';
/**
 * lib/profiles.js — Profile-Based Schedule Manager: profile CRUD
 * ─────────────────────────────────────────────────────────────────────
 * Stores schedule profiles (each containing channel configs identical
 * to the ESP32 format) in profiles.json. Profile IDs are alphanumeric
 * slugs derived from the name.
 *
 * VALIDATION / CORRUPTION HANDLING
 * ─────────────────────────────────────────────────────────────────────
 * Every read of profiles.json is routed through lib/profile-validator.js
 * (syntax -> schema -> business rules). A profiles.json that fails any of
 * those layers is never silently treated as empty:
 *   - `storeBroken` flips true and `lastValidation` holds the full,
 *     structured error report (see lib/profile-validator.js).
 *   - Reads fall back to the last successfully-validated in-memory copy
 *     (`lastGoodData`) so a dashboard that was already running keeps
 *     functioning for *display* purposes — but every write path below
 *     (save()) refuses to run while storeBroken is true, so nothing ever
 *     overwrites the broken on-disk file with a "helpfully" reconstructed
 *     empty store. This is the "last known-good in-memory" carve-out
 *     described in the validation spec, applied narrowly: it prevents
 *     data loss, it never hides the broken status from the UI (server.js
 *     exposes lastValidation via GET/POST /api/profile/validate), and it
 *     never lets a mutation succeed against stale/empty data.
 *   - The only way out of `storeBroken` is writeValidatedText(), used by
 *     the JSON editor's "Save" and the repair flow's "Apply", both of
 *     which run the *new* content through the full validation pipeline
 *     first and refuse to write anything that doesn't pass.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateProfilesBuffer, validateProfilesText } = require('./profile-validator');

const PROFILES_FILE = process.env.RELAY_PROFILES_FILE || path.join(__dirname, '..', 'profiles.json');
const BACKUP_FILE = PROFILES_FILE + '.bak';
const MAX_PROFILES = 50;
const MAX_CHANNELS = 24;
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

function writeFileAtomic(filePath, contents) {
  const tmp = filePath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

function nowIso() {
  return new Date().toISOString();
}

/** Slugify a name into a valid profile ID. */
function slugify(name) {
  const s = (name || '').toString().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'profile';
}

function defaultProfileChannels() {
  return {
    ch1: { enabled: true, pulse_ms: 2000, schedule: ['08:00', '20:00'], skip_dates: [], label: 'Channel 1' },
    ch2: { enabled: true, pulse_ms: 2000, schedule: ['06:30', '18:45'], skip_dates: [], label: 'Channel 2' },
  };
}

// ---------------------------------------------------------------------------
// Validation-aware load/save — see header comment above.
// ---------------------------------------------------------------------------
const EMPTY_STORE = Object.freeze({ profiles: {}, order: [] });

let lastGoodData = null;
let storeBroken = false;
let brokenRawText = null;
let lastValidation = {
  valid: true, syntax_valid: true, schema_valid: true, application_valid: true, errors: [], source: 'uninitialized',
};

function logValidationFailure(result) {
  console.error(`[PROFILE] profiles.json failed validation: syntax=${result.syntax_valid} schema=${result.schema_valid} application=${result.application_valid}`);
  for (const e of result.errors) {
    console.error(`[PROFILE]   ${e.severity.toUpperCase()} (${e.type}) ${e.path} line ${e.line ?? '?'} col ${e.column ?? '?'}: ${e.message}`);
  }
}

function load() {
  if (!fs.existsSync(PROFILES_FILE)) {
    lastValidation = { valid: true, syntax_valid: true, schema_valid: true, application_valid: true, errors: [], source: 'missing' };
    storeBroken = false;
    brokenRawText = null;
    lastGoodData = { profiles: {}, order: [] };
    return lastGoodData;
  }

  let buf;
  try {
    buf = fs.readFileSync(PROFILES_FILE);
  } catch (err) {
    storeBroken = true;
    lastValidation = {
      valid: false, syntax_valid: false, schema_valid: false, application_valid: false, source: 'read-error',
      errors: [{
        type: 'encoding', message: `Could not read profiles.json: ${err.message}`, path: '$',
        line: null, column: null, severity: 'error', recoverable: false, field: null,
      }],
    };
    console.error(`[PROFILE] Failed to read ${PROFILES_FILE}: ${err.message}`);
    return lastGoodData || { profiles: {}, order: [] };
  }

  const result = validateProfilesBuffer(buf);
  lastValidation = { ...result, source: 'file' };

  if (!result.valid) {
    storeBroken = true;
    brokenRawText = buf.toString('utf8');
    logValidationFailure(result);
    // Serve the last known-good in-memory copy (if this process has one)
    // for *read* continuity only — never persisted, never silently healed.
    return lastGoodData || { profiles: {}, order: [] };
  }

  storeBroken = false;
  brokenRawText = null;
  lastGoodData = result.parsed;
  return result.parsed;
}

function save(data) {
  if (storeBroken) {
    const err = new Error(
      'profiles.json is currently broken on disk and cannot be safely modified. ' +
      'Open the JSON Editor to view the error, or use Attempt Automatic Repair.'
    );
    err.status = 409;
    err.code = 'PROFILE_STORE_BROKEN';
    throw err;
  }
  writeFileAtomic(PROFILES_FILE, JSON.stringify(data, null, 2));
  lastGoodData = data;
  lastValidation = { valid: true, syntax_valid: true, schema_valid: true, application_valid: true, errors: [], source: 'file' };
}

/** True when the on-disk profiles.json currently fails validation. */
function isStoreBroken() {
  return storeBroken;
}

/** Full structured validation result for the on-disk file (or the
 *  in-memory store, if it was never loaded from a broken file). */
function getValidationState() {
  return lastValidation;
}

/** Raw text of the broken on-disk file, for the editor to load verbatim
 *  (never fabricated — this is exactly what's on disk right now). */
function getBrokenRawText() {
  return brokenRawText;
}

/** Current on-disk text, whether valid or broken — used by the editor's
 *  "Open" action so it always shows the real file, not a reconstruction. */
function getCurrentRawText() {
  if (!fs.existsSync(PROFILES_FILE)) return JSON.stringify(EMPTY_STORE, null, 2);
  try {
    return fs.readFileSync(PROFILES_FILE, 'utf8');
  } catch (err) {
    return brokenRawText || '';
  }
}

/**
 * Validate arbitrary text (e.g. the editor's current buffer) against the
 * exact same pipeline used for the on-disk file, without touching disk.
 */
function validateCandidateText(text) {
  return validateProfilesText(text);
}

/**
 * Atomically replace profiles.json with new, already-validated text.
 * Refuses to write anything that doesn't pass the full pipeline, keeps a
 * single rotating backup of whatever was on disk before (even if that
 * "before" state was itself broken — the backup is for forensic/undo
 * purposes and is never validated), and clears storeBroken on success.
 */
function writeValidatedText(text, { reason } = {}) {
  const result = validateProfilesText(text);
  if (!result.valid) {
    const err = new Error('Refusing to save: the provided content does not pass validation.');
    err.status = 400;
    err.code = 'PROFILE_VALIDATION_FAILED';
    err.validation = result;
    throw err;
  }

  if (fs.existsSync(PROFILES_FILE)) {
    try {
      fs.copyFileSync(PROFILES_FILE, BACKUP_FILE);
    } catch (err) {
      console.error(`[PROFILE] Could not write backup ${BACKUP_FILE}: ${err.message}`);
    }
  }

  writeFileAtomic(PROFILES_FILE, text);
  storeBroken = false;
  brokenRawText = null;
  lastGoodData = result.parsed;
  lastValidation = { ...result, source: 'file' };
  console.log(`[PROFILE] profiles.json replaced via ${reason || 'editor'} — validation: PASS`);
  return result;
}

/** Restore profiles.json from the single rotating backup, if present. */
function restoreBackup() {
  if (!fs.existsSync(BACKUP_FILE)) {
    const err = new Error('No backup file exists');
    err.status = 404;
    throw err;
  }
  const text = fs.readFileSync(BACKUP_FILE, 'utf8');
  return writeValidatedText(text, { reason: 'restore-backup' });
}

function hasBackup() {
  return fs.existsSync(BACKUP_FILE);
}

/** Return profile IDs in display order. */
function listIds() {
  const data = load();
  return data.order.filter(id => data.profiles[id]);
}

/** List all profiles with summary (no channel details). */
function listProfiles() {
  const data = load();
  return listIds().map(id => {
    const p = data.profiles[id];
    const channelCount = p.channels ? Object.keys(p.channels).length : 0;
    return { id, name: p.name, channelCount, created: p.created, updated: p.updated };
  });
}

/** Get a single profile by ID (full channel data). */
function getProfile(id) {
  const data = load();
  const p = data.profiles[id];
  if (!p) return null;
  return { id, name: p.name, channels: p.channels, created: p.created, updated: p.updated };
}

/** Create a new profile. Returns { id, name } or throws. */
function createProfile(name, channels) {
  const data = load();
  if (data.order.length >= MAX_PROFILES) throw Object.assign(new Error(`Max ${MAX_PROFILES} profiles`), { status: 400 });

  let baseId = slugify(name);
  let id = baseId;
  let n = 1;
  while (data.profiles[id]) {
    id = baseId + '-' + (n++);
    if (id.length > 40) id = baseId.slice(0, 36) + '-' + (n - 1);
  }

  const now = nowIso();
  data.profiles[id] = {
    name: (name || 'New Profile').toString().trim().slice(0, 60) || 'New Profile',
    channels: channels || defaultProfileChannels(),
    created: now,
    updated: now,
  };
  data.order.push(id);
  save(data);
  return { id, name: data.profiles[id].name };
}

/** Rename a profile. */
function renameProfile(id, newName) {
  const data = load();
  const p = data.profiles[id];
  if (!p) throw Object.assign(new Error('Profile not found'), { status: 404 });
  p.name = (newName || 'Profile').toString().trim().slice(0, 60) || 'Profile';
  p.updated = nowIso();
  save(data);
  return { id, name: p.name };
}

/** Duplicate a profile. Returns new profile { id, name }. */
function duplicateProfile(id) {
  const data = load();
  const p = data.profiles[id];
  if (!p) throw Object.assign(new Error('Profile not found'), { status: 404 });
  if (data.order.length >= MAX_PROFILES) throw Object.assign(new Error(`Max ${MAX_PROFILES} profiles`), { status: 400 });

  let newId = id + '-copy';
  if (newId.length > 40) newId = id.slice(0, 35) + '-copy';
  let n = 1;
  while (data.profiles[newId]) {
    newId = id + '-copy-' + (n++);
    if (newId.length > 40) newId = id.slice(0, 34) + '-copy-' + (n - 1);
  }

  const cloned = JSON.parse(JSON.stringify(p));
  cloned.name = (cloned.name + ' (Copy)').slice(0, 60);
  cloned.created = nowIso();
  cloned.updated = cloned.created;
  data.profiles[newId] = cloned;
  data.order.push(newId);
  save(data);
  return { id: newId, name: cloned.name };
}

/** Delete a profile by ID. Refuses to delete the last profile. */
function deleteProfile(id) {
  const data = load();
  if (!data.profiles[id]) throw Object.assign(new Error('Profile not found'), { status: 404 });
  if (data.order.filter(i => data.profiles[i]).length <= 1) {
    throw Object.assign(new Error('Cannot delete the last profile'), { status: 400 });
  }
  delete data.profiles[id];
  data.order = data.order.filter(i => i !== id);
  save(data);
  return true;
}

/** Update a profile's channels (the schedule body). `channels` is the
 *  full { ch1: {...}, ch2: {...} } object in ESP32 format. */
function saveChannels(id, channels) {
  const data = load();
  const p = data.profiles[id];
  if (!p) throw Object.assign(new Error('Profile not found'), { status: 404 });
  // shallow-validate channel count
  const keys = Object.keys(channels);
  if (keys.length === 0) throw Object.assign(new Error('At least one channel is required'), { status: 400 });
  if (keys.length > MAX_CHANNELS) throw Object.assign(new Error(`Too many channels (max ${MAX_CHANNELS})`), { status: 400 });
  p.channels = channels;
  p.updated = nowIso();
  save(data);
  return true;
}

/** Export all profiles + calendar + settings as a bundle. */
function exportAll() {
  const data = load();
  return {
    version: 1,
    exported_at: nowIso(),
    profiles: data.profiles,
    order: data.order,
  };
}

/** Import profiles from a bundle. Merges into existing (overwrites by ID). */
function importProfiles(bundle) {
  if (!bundle || !bundle.profiles || typeof bundle.profiles !== 'object') {
    throw Object.assign(new Error('Invalid import bundle'), { status: 400 });
  }
  const data = load();
  const incoming = bundle.profiles;
  const incomingOrder = Array.isArray(bundle.order) ? bundle.order : Object.keys(incoming);
  let imported = 0;
  for (const id of incomingOrder) {
    const p = incoming[id];
    if (!p || !p.name || !p.channels) continue;
    if (data.order.length >= MAX_PROFILES && !data.profiles[id]) break;
    if (data.profiles[id]) {
      // merge: keep existing ID but update channels/name
      data.profiles[id].name = p.name;
      data.profiles[id].channels = p.channels;
      data.profiles[id].updated = nowIso();
    } else {
      data.profiles[id] = { ...p, updated: nowIso() };
      data.order.push(id);
    }
    imported++;
  }
  save(data);
  return imported;
}

module.exports = {
  PROFILES_FILE,
  BACKUP_FILE,
  listIds,
  listProfiles,
  getProfile,
  createProfile,
  renameProfile,
  duplicateProfile,
  deleteProfile,
  saveChannels,
  exportAll,
  importProfiles,
  isStoreBroken,
  getValidationState,
  getBrokenRawText,
  getCurrentRawText,
  validateCandidateText,
  writeValidatedText,
  restoreBackup,
  hasBackup,
};
