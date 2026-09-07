'use strict';
/**
 * auth.js — shared by server.js and reset_password.js
 * ─────────────────────────────────────────────────────────────────────
 * Handles:
 *   • loading / saving the hashed dashboard password (password.json)
 *   • loading / creating the Express session secret (secret.key)
 *
 * Kept dependency-free of Express so reset_password.js can use it
 * standalone without the web server running.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const BASE_DIR = __dirname;
const PASSWORD_FILE = path.join(BASE_DIR, 'password.json');
const SECRET_KEY_FILE = path.join(BASE_DIR, 'secret.key');

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;
// The one-time default credential created on first boot (see README
// "Verify" step). It is ONLY ever written by the bootstrap path below —
// setPassword() (used for every user-initiated change) always enforces
// MIN_PASSWORD_LENGTH with no exceptions, so once an admin changes the
// password, "admin" stops working and can't be set again (it's too short).
const DEFAULT_PASSWORD = 'admin';

/** Atomic write helper — write to a temp file then rename over the target. */
function writeFileAtomic(filePath, contents) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

function writePasswordHash(hash) {
  writeFileAtomic(PASSWORD_FILE, JSON.stringify({ password_hash: hash }, null, 2));
}

/** Hash `newPassword` and persist it to disk. Throws on invalid input.
 *  This is the only path for user-initiated password changes (the
 *  dashboard's "Change Password" and reset_password.js) — it always
 *  enforces the minimum length, with no exceptions for any value. */
function setPassword(newPassword) {
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long`);
  }
  writePasswordHash(bcrypt.hashSync(newPassword, BCRYPT_ROUNDS));
}

/** Return the stored password hash, creating the one-time default
 *  ('admin') if no password.json exists yet — or if it exists but is
 *  unreadable/corrupted, since a broken credentials file would otherwise
 *  lock the admin out of their own dashboard with no way back in short of
 *  editing files by hand. Self-healing to the documented default (loudly
 *  logged) is safer than either crashing or leaving login permanently
 *  broken. This is the ONLY place the short default is ever written — it
 *  bypasses setPassword()'s length check on purpose. */
function loadPasswordHash() {
  if (fs.existsSync(PASSWORD_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(PASSWORD_FILE, 'utf8'));
      if (data && typeof data.password_hash === 'string' && /^\$2[aby]\$/.test(data.password_hash)) {
        return data.password_hash;
      }
      throw new Error('password.json does not contain a valid password_hash');
    } catch (err) {
      console.error(`[auth] password.json is corrupted or unreadable: ${err.message}`);
      console.error(`[auth] Resetting to the default password ('${DEFAULT_PASSWORD}') so the dashboard remains accessible. Please change it immediately.`);
    }
  }
  writePasswordHash(bcrypt.hashSync(DEFAULT_PASSWORD, BCRYPT_ROUNDS));
  console.log(
    `[auth] No password set — created default password.json ` +
    `(one-time password: '${DEFAULT_PASSWORD}'). ` +
    `Please change it immediately: Settings → Change Password, or node reset_password.js`
  );
  return JSON.parse(fs.readFileSync(PASSWORD_FILE, 'utf8')).password_hash;
}

/** Check `candidate` against the stored hash. */
function verifyPassword(candidate) {
  const storedHash = loadPasswordHash();
  return bcrypt.compareSync(candidate, storedHash);
}

/** Return a persisted random secret for signing session cookies, creating
 *  one on first run so sessions survive server restarts. */
function loadOrCreateSecretKey() {
  if (fs.existsSync(SECRET_KEY_FILE)) {
    const key = fs.readFileSync(SECRET_KEY_FILE, 'utf8').trim();
    if (key) return key;
    console.error('[auth] secret.key exists but is empty — regenerating. All existing sessions will be logged out.');
  }
  const key = crypto.randomBytes(32).toString('hex');
  writeFileAtomic(SECRET_KEY_FILE, key);
  return key;
}

module.exports = {
  PASSWORD_FILE,
  SECRET_KEY_FILE,
  MIN_PASSWORD_LENGTH,
  DEFAULT_PASSWORD,
  setPassword,
  loadPasswordHash,
  verifyPassword,
  loadOrCreateSecretKey,
};
