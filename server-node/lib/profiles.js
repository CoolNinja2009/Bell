'use strict';
/**
 * lib/profiles.js — Profile-Based Schedule Manager: profile CRUD
 * ─────────────────────────────────────────────────────────────────────
 * Stores schedule profiles (each containing channel configs identical
 * to the ESP32 format) in profiles.json. Profile IDs are alphanumeric
 * slugs derived from the name.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROFILES_FILE = path.join(__dirname, '..', 'profiles.json');
const MAX_PROFILES = 50;
const MAX_CHANNELS = 24;
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

function writeFileAtomic(filePath, contents) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, contents);
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

function load() {
  if (!fs.existsSync(PROFILES_FILE)) return { profiles: {}, order: [] };
  try {
    return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
  } catch {
    return { profiles: {}, order: [] };
  }
}

function save(data) {
  writeFileAtomic(PROFILES_FILE, JSON.stringify(data, null, 2));
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
};
