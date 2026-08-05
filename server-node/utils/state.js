'use strict';
/**
 * utils/state.js — Bootstrap state persistence.
 *
 * Reads and writes update_state.json. Handles missing files, corrupt
 * JSON, and missing directories gracefully.
 */
const fs = require('fs');
const path = require('path');

/**
 * Default state object when no state file exists.
 */
function defaultState() {
  return {
    currentCommit: null,
    previousCommit: null,
    lastStartup: null,
    lastUpdate: null,
    status: 'unknown',
  };
}

/**
 * Load state from disk. Returns default state if the file is missing
 * or unreadable.
 * @param {string} filePath - absolute path to update_state.json
 * @returns {{ currentCommit: string|null, previousCommit: string|null, lastStartup: string|null, lastUpdate: string|null, status: string }}
 */
function load(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultState();
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return defaultState();
    }

    const parsed = JSON.parse(raw);

    // Merge with defaults to handle missing keys from older versions
    return { ...defaultState(), ...parsed };
  } catch (_err) {
    // Corrupt file — start fresh
    return defaultState();
  }
}

/**
 * Save state to disk atomically (write to temp file, then rename).
 * Creates parent directories as needed.
 * @param {string} filePath - absolute path to update_state.json
 * @param {object} data
 */
function save(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmp = filePath + '.tmp';
  const json = JSON.stringify(data, null, 2);

  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, filePath);
}

module.exports = { load, save, defaultState };
