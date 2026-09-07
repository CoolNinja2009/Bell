'use strict';

const fs = require('fs');
const path = require('path');

const FIRMWARE_STATE_FILE = path.join(__dirname, '..', 'firmware_state.json');

function defaults() {
  return {
    auto_update: true,
    source: 'latest',
    release_tag: null,
    custom: null,
    force: null,
    request_id: 0,
    control_id: 0,
    last_device: null,
    updated_at: null,
  };
}

let lastGoodData = defaults();
let storeBroken = false;
let lastError = null;

function load() {
  if (!fs.existsSync(FIRMWARE_STATE_FILE)) {
    storeBroken = false;
    lastError = null;
    lastGoodData = defaults();
    return lastGoodData;
  }
  try {
    const data = JSON.parse(fs.readFileSync(FIRMWARE_STATE_FILE, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('firmware_state.json must contain a JSON object');
    }
    const clean = {
      auto_update: data.auto_update !== false,
      source: ['latest', 'release', 'custom'].includes(data.source) ? data.source : 'latest',
      release_tag: typeof data.release_tag === 'string' ? data.release_tag : null,
      custom: data.custom && typeof data.custom === 'object' ? data.custom : null,
      force: data.force && typeof data.force === 'object'
        && Number.isSafeInteger(data.force.id) && data.force.id > 0
        && typeof data.force.sha256 === 'string' ? data.force : null,
      request_id: Number.isSafeInteger(data.request_id) && data.request_id >= 0 ? data.request_id : 0,
      control_id: Number.isSafeInteger(data.control_id) && data.control_id >= 0 ? data.control_id : 0,
      last_device: data.last_device && typeof data.last_device === 'object' ? data.last_device : null,
      updated_at: typeof data.updated_at === 'string' ? data.updated_at : null,
    };
    storeBroken = false;
    lastError = null;
    lastGoodData = clean;
    return clean;
  } catch (err) {
    // A broken firmware_state.json must never be treated as "fresh
    // install" — that would silently reset request_id/control_id back to
    // 0, which can make the ESP32 re-apply or skip OTA state transitions
    // unexpectedly. Log it, serve the last known-good in-memory copy for
    // read continuity, and block writes until the file is fixed.
    if (!storeBroken || lastError !== err.message) {
      console.error(`[FIRMWARE-STATE] firmware_state.json failed to load: ${err.message}`);
      console.error('[FIRMWARE-STATE] Serving last known-good in-memory state (if any); writes are blocked until the file is fixed or removed.');
    }
    storeBroken = true;
    lastError = err.message;
    return lastGoodData;
  }
}

function save(data) {
  if (storeBroken) {
    const err = new Error(
      'firmware_state.json is currently broken on disk and cannot be safely modified. ' +
      'Fix or remove the file, then try again.'
    );
    err.status = 409;
    err.code = 'FIRMWARE_STATE_BROKEN';
    throw err;
  }
  const next = { ...defaults(), ...data, updated_at: new Date().toISOString() };
  const tmp = `${FIRMWARE_STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, FIRMWARE_STATE_FILE);
  lastGoodData = next;
  return next;
}

/** True when firmware_state.json currently fails to load. */
function isBroken() {
  return storeBroken;
}

/** Human-readable reason for the current failure, or null if healthy. */
function getLastError() {
  return lastError;
}

function update(changes, requestDeviceCheck = false) {
  const current = load();
  const next = { ...current, ...changes };
  // All dashboard changes get a control revision; only update actions request OTA.
  next.control_id = current.control_id + 1;
  if (requestDeviceCheck) next.request_id = current.request_id + 1;
  return save(next);
}

function acknowledgeDevice(status) {
  const current = load();
  return save({
    ...current,
    last_device: {
      control_id: status.control_id,
      request_id: status.request_id,
      auto_update: status.auto_update,
      firmware_version: status.firmware_version,
      compiled_at: status.compiled_at,
      ota_protocol: status.ota_protocol || 1,
      ota_status: status.ota_status || 'acknowledged',
      ota_detail: status.ota_detail || null,
      seen_at: new Date().toISOString(),
    },
  });
}

module.exports = { FIRMWARE_STATE_FILE, load, save, update, acknowledgeDevice, isBroken, getLastError };
