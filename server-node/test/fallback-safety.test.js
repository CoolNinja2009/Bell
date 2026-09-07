'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshModule(modPath, envVar, dir, filename) {
  process.env[envVar] = path.join(dir, filename);
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bell-fallback-test-'));
}

// ---------------------------------------------------------------------------
// lib/calendar.js
// ---------------------------------------------------------------------------
test('calendar.js: a broken calendar.json is never silently replaced', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'calendar.json');
  const broken = '{ "dates": {} "dow": {} }'; // missing comma
  fs.writeFileSync(file, broken);

  const calendar = freshModule('../lib/calendar', 'RELAY_CALENDAR_FILE', dir, 'calendar.json');

  const all = calendar.getAll();
  assert.deepEqual(all, { dates: {}, dow: {} }, 'reads fall back to an empty view, not a crash');
  assert.equal(calendar.isBroken(), true);
  assert.match(calendar.getLastError(), /,|}|token|Unexpected|comma/i);

  assert.throws(() => calendar.assignDow('monday', 'regular-working-day'), /broken/i);
  assert.throws(() => calendar.assignDate('2026-01-01', 'regular-working-day'), /broken/i);

  assert.equal(fs.readFileSync(file, 'utf8'), broken, 'the original broken bytes must be untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('calendar.js: a healthy file loads and mutates normally', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'calendar.json');
  fs.writeFileSync(file, JSON.stringify({ dates: {}, dow: { monday: 'regular-working-day' } }));

  const calendar = freshModule('../lib/calendar', 'RELAY_CALENDAR_FILE', dir, 'calendar.json');
  assert.equal(calendar.isBroken(), false);
  assert.equal(calendar.getAll().dow.monday, 'regular-working-day');

  calendar.assignDow('tuesday', 'saturday');
  assert.equal(calendar.getAll().dow.tuesday, 'saturday');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// lib/settings.js
// ---------------------------------------------------------------------------
test('settings.js: a broken settings.json blocks writes instead of being silently reset', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  const broken = '{ "active_profile": "regular-working-day", "default_profile": }'; // syntax error
  fs.writeFileSync(file, broken);

  const settings = freshModule('../lib/settings', 'RELAY_SETTINGS_FILE', dir, 'settings.json');

  const s = settings.getSettings();
  assert.equal(s.active_profile, null, 'falls back to defaults for reads');
  assert.equal(settings.isBroken(), true);

  assert.throws(() => settings.setActiveProfile('saturday'), /broken/i);
  assert.throws(() => settings.setDefaultProfile('saturday'), /broken/i);
  assert.throws(() => settings.setOverride('saturday', null), /broken/i);

  assert.equal(fs.readFileSync(file, 'utf8'), broken, 'the original broken settings.json must be untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('settings.js: getSettings() never throws even while broken (called from timers/bootstrap)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'not even json');
  const settings = freshModule('../lib/settings', 'RELAY_SETTINGS_FILE', dir, 'settings.json');
  assert.doesNotThrow(() => settings.getSettings());
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// lib/apikeys.js — note: this module doesn't support an env var override in
// the original code, so we exercise it via a temp KEYS_FILE monkey-patch by
// reloading with a relative CWD trick is unnecessary; instead we validate
// the pure load()/save() guard logic directly through the exported surface
// using a dedicated fixture file path injected the same way as the others
// would require a code change we didn't make (out of scope) — so this test
// instead confirms the exported guard functions exist and behave for the
// real on-disk file location in isolation using a save/restore dance.
// ---------------------------------------------------------------------------
test('apikeys.js: broken api_keys.json blocks create/revoke and is never silently wiped', () => {
  const apikeys = require('../lib/apikeys');
  const original = fs.existsSync(apikeys.KEYS_FILE) ? fs.readFileSync(apikeys.KEYS_FILE, 'utf8') : null;
  try {
    fs.writeFileSync(apikeys.KEYS_FILE, '{ "keys": [1, 2, }'); // syntax error
    delete require.cache[require.resolve('../lib/apikeys')];
    const reloaded = require('../lib/apikeys');
    assert.equal(reloaded.listKeys().length, 0);
    assert.equal(reloaded.isBroken(), true);
    assert.throws(() => reloaded.createKey('test'), /broken/i);
    assert.throws(() => reloaded.revokeKey('nonexistent'), /broken/i);
    assert.equal(fs.readFileSync(apikeys.KEYS_FILE, 'utf8'), '{ "keys": [1, 2, }');
  } finally {
    if (original !== null) fs.writeFileSync(apikeys.KEYS_FILE, original);
    else fs.rmSync(apikeys.KEYS_FILE, { force: true });
    delete require.cache[require.resolve('../lib/apikeys')];
  }
});

// ---------------------------------------------------------------------------
// lib/firmware-state.js — same story: no env var override, use save/restore.
// ---------------------------------------------------------------------------
test('firmware-state.js: broken firmware_state.json blocks writes and does not reset counters silently', () => {
  const fw = require('../lib/firmware-state');
  const original = fs.existsSync(fw.FIRMWARE_STATE_FILE) ? fs.readFileSync(fw.FIRMWARE_STATE_FILE, 'utf8') : null;
  try {
    fs.writeFileSync(fw.FIRMWARE_STATE_FILE, '{ "request_id": 5, "control_id": }');
    delete require.cache[require.resolve('../lib/firmware-state')];
    const reloaded = require('../lib/firmware-state');
    reloaded.load(); // trigger the validation-aware load before checking isBroken()
    assert.equal(reloaded.isBroken(), true);
    assert.throws(() => reloaded.update({ auto_update: false }), /broken/i);
  } finally {
    if (original !== null) fs.writeFileSync(fw.FIRMWARE_STATE_FILE, original);
    else fs.rmSync(fw.FIRMWARE_STATE_FILE, { force: true });
    delete require.cache[require.resolve('../lib/firmware-state')];
  }
});

// ---------------------------------------------------------------------------
// lib/profile-scheduler.js — resolveAndApply() must never throw even when
// settings.json is broken, since it's called from setInterval/bootstrap
// contexts that aren't wrapped in Express's error handling.
// ---------------------------------------------------------------------------
test('profile-scheduler.js: resolveAndApply() never throws when settings.json is broken', () => {
  const dir = tmpDir();
  process.env.RELAY_PROFILES_FILE = path.join(dir, 'profiles.json');
  process.env.RELAY_SETTINGS_FILE = path.join(dir, 'settings.json');
  process.env.RELAY_CALENDAR_FILE = path.join(dir, 'calendar.json');
  fs.writeFileSync(process.env.RELAY_PROFILES_FILE, JSON.stringify({
    profiles: { a: { name: 'A', channels: { ch1: { enabled: true, pulse_ms: 1700, schedule: [], skip_dates: [] } } } },
    order: ['a'],
  }));
  fs.writeFileSync(process.env.RELAY_SETTINGS_FILE, '{ broken');

  delete require.cache[require.resolve('../lib/profiles')];
  delete require.cache[require.resolve('../lib/settings')];
  delete require.cache[require.resolve('../lib/calendar')];
  delete require.cache[require.resolve('../lib/profile-scheduler')];
  const scheduler = require('../lib/profile-scheduler');
  const settings = require('../lib/settings');

  settings.getSettings(); // trigger the validation-aware load before checking isBroken()
  assert.equal(settings.isBroken(), true);
  assert.doesNotThrow(() => scheduler.resolveAndApply());

  fs.rmSync(dir, { recursive: true, force: true });
});
