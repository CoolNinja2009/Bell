'use strict';
/**
 * utils/logger.js — File logger with rotation.
 *
 * Writes timestamped entries to log files. Rotates when a file exceeds
 * the configured size limit by renaming *.log → *.1.log, *.1.log → *.2.log, etc.
 * Oldest backup is discarded.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_SIZE = 1 * 1024 * 1024; // 1 MB
const DEFAULT_MAX_FILES = 5;

/**
 * Ensure the directory for `filePath` exists.
 * @param {string} filePath
 */
function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Rotate log files for `filePath`.
 * Renames file → file.1, file.1 → file.2, ..., discarding the oldest.
 * @param {string} filePath - absolute path to the log file
 * @param {number} maxFiles - number of rotated backups to keep
 */
function rotate(filePath, maxFiles) {
  if (!fs.existsSync(filePath)) return;

  const ext = path.extname(filePath);
  const base = filePath.slice(0, -ext.length);

  // Remove oldest backup
  const oldest = `${base}.${maxFiles}${ext}`;
  if (fs.existsSync(oldest)) {
    fs.unlinkSync(oldest);
  }

  // Shift backups: .4 → .5, .3 → .4, ..., .1 → .2
  for (let i = maxFiles - 1; i >= 1; i--) {
    const src = i === 1 ? filePath : `${base}.${i - 1}${ext}`;
    const dst = `${base}.${i}${ext}`;
    if (fs.existsSync(src)) {
      fs.renameSync(src, dst);
    }
  }
}

/**
 * Log a message to a file with rotation.
 * @param {string} filePath - absolute path to the log file
 * @param {string} message - the message to log
 * @param {{ maxSize?: number, maxFiles?: number }} [opts]
 */
function log(filePath, message, opts = {}) {
  const maxSize = opts.maxSize || DEFAULT_MAX_SIZE;
  const maxFiles = opts.maxFiles || DEFAULT_MAX_FILES;

  ensureDir(filePath);

  // Rotate if file exists and exceeds max size
  if (fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath);
    if (stat.size >= maxSize) {
      rotate(filePath, maxFiles);
    }
  }

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;

  fs.appendFileSync(filePath, line, 'utf8');
}

/**
 * Log a message to multiple files at once.
 * @param {string[]} filePaths - absolute paths
 * @param {string} message
 * @param {{ maxSize?: number, maxFiles?: number }} [opts]
 */
function logMulti(filePaths, message, opts = {}) {
  for (const fp of filePaths) {
    log(fp, message, opts);
  }
}

module.exports = { log, logMulti, rotate, ensureDir };
