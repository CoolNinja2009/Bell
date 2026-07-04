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

const DEFAULT_PASSWORD = 'admin'; // only used the very first time the server runs
const BCRYPT_ROUNDS = 12;

/** Atomic write helper — write to a temp file then rename over the target. */
function writeFileAtomic(filePath, contents) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

/** Hash `newPassword` and persist it to disk. Throws on invalid input. */
function setPassword(newPassword) {
  if (!newPassword || newPassword.length < 4) {
    throw new Error('Password must be at least 4 characters long');
  }
  const hash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
  writeFileAtomic(PASSWORD_FILE, JSON.stringify({ password_hash: hash }, null, 2));
}

/** Return the stored password hash, creating a default one if missing. */
function loadPasswordHash() {
  if (!fs.existsSync(PASSWORD_FILE)) {
    setPassword(DEFAULT_PASSWORD);
    console.log(
      `[auth] No password set — created default password.json ` +
      `(default password: '${DEFAULT_PASSWORD}'). ` +
      `Please change it: node reset_password.js`
    );
  }
  const data = JSON.parse(fs.readFileSync(PASSWORD_FILE, 'utf8'));
  return data.password_hash;
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
  }
  const key = crypto.randomBytes(32).toString('hex');
  writeFileAtomic(SECRET_KEY_FILE, key);
  return key;
}

module.exports = {
  PASSWORD_FILE,
  SECRET_KEY_FILE,
  setPassword,
  loadPasswordHash,
  verifyPassword,
  loadOrCreateSecretKey,
};
