'use strict';
/**
 * lib/apikeys.js — API keys for external integrations
 * ─────────────────────────────────────────────────────────────────────
 * Lets the dashboard mint long-lived keys (e.g. for Home Assistant, a
 * cron job, a phone shortcut) that can call a small allow-listed set of
 * endpoints via an `X-API-Key` header, without a browser session.
 *
 * Keys are shown once at creation time; only a salted SHA-256 hash is
 * ever persisted to disk (api_keys.json), same spirit as password.json.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEYS_FILE = path.join(__dirname, '..', 'api_keys.json');
const KEY_PREFIX = 'rc_';

function writeFileAtomic(filePath, contents) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

let lastGoodData = { keys: [] };
let storeBroken = false;
let lastError = null;

function load() {
  if (!fs.existsSync(KEYS_FILE)) {
    storeBroken = false;
    lastError = null;
    lastGoodData = { keys: [] };
    return lastGoodData;
  }
  try {
    const data = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    if (!Array.isArray(data.keys)) throw new Error('api_keys.json must contain a "keys" array');
    storeBroken = false;
    lastError = null;
    lastGoodData = data;
    return data;
  } catch (err) {
    // A broken api_keys.json must never be treated as "no keys issued" —
    // createKey()/revokeKey() would then save() that empty view and
    // permanently delete every previously issued key. Log it, serve the
    // last known-good in-memory copy for read/verify continuity (so
    // existing integrations keep working this process's lifetime), and
    // block writes until the file is fixed.
    if (!storeBroken || lastError !== err.message) {
      console.error(`[APIKEYS] api_keys.json failed to load: ${err.message}`);
      console.error('[APIKEYS] Serving last known-good in-memory keys (if any); creating/revoking keys is blocked until the file is fixed or removed.');
    }
    storeBroken = true;
    lastError = err.message;
    return lastGoodData;
  }
}

function save(data) {
  if (storeBroken) {
    const err = new Error(
      'api_keys.json is currently broken on disk and cannot be safely modified. ' +
      'Fix or remove the file, then try again.'
    );
    err.status = 409;
    err.code = 'APIKEYS_STORE_BROKEN';
    throw err;
  }
  writeFileAtomic(KEYS_FILE, JSON.stringify(data, null, 2));
  lastGoodData = data;
}

/** True when api_keys.json currently fails to load. */
function isBroken() {
  return storeBroken;
}

/** Human-readable reason for the current failure, or null if healthy. */
function getLastError() {
  return lastError;
}

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Create a new key. Returns { id, name, key } — `key` is only ever available here. */
function createKey(name) {
  const cleanName = (name || '').toString().trim().slice(0, 40) || 'Unnamed key';
  const raw = KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
  const data = load();
  const entry = {
    id: crypto.randomUUID(),
    name: cleanName,
    hash: hashKey(raw),
    prefix: raw.slice(0, KEY_PREFIX.length + 6),
    created: new Date().toISOString(),
    last_used: null,
  };
  data.keys.push(entry);
  save(data);
  return { id: entry.id, name: entry.name, key: raw, created: entry.created };
}

/** List keys without their hashes (safe to send to the dashboard). */
function listKeys() {
  return load().keys.map(({ hash, ...rest }) => rest);
}

function revokeKey(id) {
  const data = load();
  const before = data.keys.length;
  data.keys = data.keys.filter((k) => k.id !== id);
  save(data);
  return data.keys.length < before;
}

/** Verify a raw candidate key (from the X-API-Key header). Returns the matching entry or null. */
function verifyKey(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  const candidateHash = hashKey(candidate);
  const data = load();
  const candidateBuf = Buffer.from(candidateHash, 'hex');
  for (const entry of data.keys) {
    const entryBuf = Buffer.from(entry.hash, 'hex');
    if (entryBuf.length === candidateBuf.length && crypto.timingSafeEqual(entryBuf, candidateBuf)) {
      entry.last_used = new Date().toISOString();
      try {
        save(data);
      } catch (err) {
        // A key that was already loaded successfully should still be
        // allowed to authenticate even if we can't persist the last_used
        // bookkeeping timestamp right now (e.g. the file was corrupted by
        // something else between requests). Don't fail a real integration
        // over a housekeeping write.
        console.error(`[APIKEYS] Verified key but could not record last_used: ${err.message}`);
      }
      return entry;
    }
  }
  return null;
}

module.exports = { KEYS_FILE, createKey, listKeys, revokeKey, verifyKey, isBroken, getLastError };
