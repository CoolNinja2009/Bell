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

function load() {
  if (!fs.existsSync(FIRMWARE_STATE_FILE)) return defaults();
  try {
    const data = JSON.parse(fs.readFileSync(FIRMWARE_STATE_FILE, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return defaults();
    return {
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
  } catch {
    return defaults();
  }
}

function save(data) {
  const next = { ...defaults(), ...data, updated_at: new Date().toISOString() };
  const tmp = `${FIRMWARE_STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, FIRMWARE_STATE_FILE);
  return next;
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

module.exports = { FIRMWARE_STATE_FILE, load, save, update, acknowledgeDevice };
