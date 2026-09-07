'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateProfilesText } = require('../lib/profile-validator');
const { attemptRepair } = require('../lib/profile-recovery');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function fullValidStore() {
  return {
    profiles: {
      'regular-working-day': {
        name: 'Regular Working Day',
        channels: {
          ch1: {
            enabled: true,
            pulse_ms: 1700,
            schedule: [
              { time: '08:50', pulse_ms: 3000 },
              '08:55',
              '09:40',
              '10:30',
            ],
            skip_dates: ['2026-12-25'],
            label: 'Bell Middle School',
          },
          ch2: {
            enabled: true,
            pulse_ms: 1700,
            schedule: ['08:55', '09:00'],
            skip_dates: [],
            label: 'Bell High School',
          },
        },
        created: '2026-08-06T19:30:00.000Z',
        updated: '2026-08-15T08:44:38.339Z',
      },
    },
    order: ['regular-working-day'],
  };
}

function minimalValidStore() {
  return {
    profiles: {
      sunday: {
        name: 'Sunday',
        channels: {
          ch1: { enabled: true, pulse_ms: 1700, schedule: [], skip_dates: [] },
        },
      },
    },
    order: ['sunday'],
  };
}

// ---------------------------------------------------------------------------
// Layer 1 — syntax
// ---------------------------------------------------------------------------
test('valid: a full normal schedule passes all three layers', () => {
  const r = validateProfilesText(JSON.stringify(fullValidStore(), null, 2));
  assert.equal(r.syntax_valid, true);
  assert.equal(r.schema_valid, true);
  assert.equal(r.application_valid, true);
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('valid: a minimal valid profile (empty schedule) passes', () => {
  const r = validateProfilesText(JSON.stringify(minimalValidStore()));
  assert.equal(r.valid, true);
});

test('syntax: missing comma between properties is rejected with a line/column', () => {
  const text = '{\n  "profiles": {}\n  "order": []\n}';
  const r = validateProfilesText(text);
  assert.equal(r.syntax_valid, false);
  assert.equal(r.valid, false);
  assert.ok(r.errors.length > 0);
  assert.equal(r.errors[0].type, 'syntax');
  assert.equal(typeof r.errors[0].line, 'number');
});

test('syntax: missing closing brace is rejected', () => {
  const r = validateProfilesText('{ "profiles": {}, "order": [previous_content]');
  assert.equal(r.syntax_valid, false);
});

test('syntax: missing closing bracket is rejected', () => {
  const r = validateProfilesText('{ "profiles": {}, "order": ["a", "b" }');
  assert.equal(r.syntax_valid, false);
});

test('syntax: unterminated string is rejected', () => {
  const r = validateProfilesText('{ "profiles": {}, "order": ["a }');
  assert.equal(r.syntax_valid, false);
  assert.equal(r.errors[0].type, 'syntax');
});

test('syntax: invalid escape sequence is rejected', () => {
  const r = validateProfilesText('{ "profiles": {"a": {"name": "Bad \\q escape", "channels": {}}}, "order": ["a"] }');
  assert.equal(r.syntax_valid, false);
});

test('syntax: malformed number is rejected', () => {
  const r = validateProfilesText('{ "profiles": {}, "order": [], "extra": 01 }');
  assert.equal(r.syntax_valid, false);
});

test('syntax: trailing garbage after the JSON value is rejected', () => {
  const r = validateProfilesText('{ "profiles": {}, "order": [] } garbage');
  assert.equal(r.syntax_valid, false);
});

test('syntax: empty file is rejected, not treated as an empty store', () => {
  const r = validateProfilesText('');
  assert.equal(r.syntax_valid, false);
  assert.equal(r.valid, false);
  assert.match(r.errors[0].message, /empty/i);
});

test('syntax: truncated file is rejected', () => {
  const r = validateProfilesText('{ "profiles": { "a": { "name": "X", "channels": { "ch1": { "enabled": true');
  assert.equal(r.syntax_valid, false);
});

test('syntax: duplicate keys are flagged even though JSON.parse succeeds', () => {
  const text = '{ "profiles": {}, "order": [], "order": [] }';
  const r = validateProfilesText(text);
  assert.equal(r.syntax_valid, false);
  assert.ok(r.errors.some((e) => /duplicate/i.test(e.message)));
});

// ---------------------------------------------------------------------------
// Layer 2 — schema / semantic
// ---------------------------------------------------------------------------
test('schema: missing required field (channels) is rejected', () => {
  const store = { profiles: { a: { name: 'A' } }, order: ['a'] };
  const r = validateProfilesText(JSON.stringify(store));
  assert.equal(r.syntax_valid, true);
  assert.equal(r.schema_valid, false);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.type === 'schema' && /channels/i.test(e.message)));
});

test('schema: wrong type (pulse_ms as boolean) is rejected', () => {
  const store = minimalValidStore();
  store.profiles.sunday.channels.ch1.pulse_ms = true;
  const r = validateProfilesText(JSON.stringify(store));
  assert.equal(r.schema_valid, false);
});

test('schema: invalid time format is rejected', () => {
  const store = minimalValidStore();
  store.profiles.sunday.channels.ch1.schedule = ['25:99'];
  const r = validateProfilesText(JSON.stringify(store));
  assert.equal(r.schema_valid, false);
});

test('schema: malformed schedule entry (object missing "time") is rejected', () => {
  const store = minimalValidStore();
  store.profiles.sunday.channels.ch1.schedule = [{ pulse_ms: 2000 }];
  const r = validateProfilesText(JSON.stringify(store));
  assert.equal(r.schema_valid, false);
});

test('schema: impossible values (pulse_ms way out of range) are rejected', () => {
  const store = minimalValidStore();
  store.profiles.sunday.channels.ch1.pulse_ms = 999999999;
  const r = validateProfilesText(JSON.stringify(store));
  assert.equal(r.schema_valid, false);
});

test('schema: unexpected/unknown properties are rejected (additionalProperties: false)', () => {
  const store = minimalValidStore();
  store.profiles.sunday.channels.ch1.unexpected_field = 'nope';
  const r = validateProfilesText(JSON.stringify(store));
  assert.equal(r.schema_valid, false);
  assert.ok(r.errors.some((e) => /unexpected_field/.test(e.message)));
});

test('semantic: order referencing a non-existent profile is an application error', () => {
  const store = minimalValidStore();
  store.order.push('does-not-exist');
  const r = validateProfilesText(JSON.stringify(store));
  assert.equal(r.schema_valid, true);
  assert.equal(r.application_valid, false);
  assert.equal(r.valid, false);
});

test('semantic: a profile missing from "order" is a warning, not a hard failure', () => {
  const store = minimalValidStore();
  store.profiles.monday = JSON.parse(JSON.stringify(store.profiles.sunday));
  store.profiles.monday.name = 'Monday';
  // 'monday' intentionally left out of order[]
  const r = validateProfilesText(JSON.stringify(store));
  assert.equal(r.valid, true, 'orphaned-from-order profile should only warn, not invalidate the file');
  assert.ok(r.errors.some((e) => e.severity === 'warning' && /order/i.test(e.message)));
});

test('semantic: duplicate schedule entries in the same channel are rejected when forbidden', () => {
  const store = minimalValidStore();
  store.profiles.sunday.channels.ch1.schedule = ['08:00', '08:00'];
  const r = validateProfilesText(JSON.stringify(store));
  assert.equal(r.schema_valid, true);
  assert.equal(r.application_valid, false);
  assert.ok(r.errors.some((e) => /duplicate schedule time/i.test(e.message)));
});

test('valid JSON with invalid schedule data is caught at the schema layer, not silently accepted', () => {
  const text = '{ "profiles": { "a": { "name": "A", "channels": { "ch1": { "enabled": true, "pulse_ms": "not-a-number", "schedule": [], "skip_dates": [] } } } }, "order": ["a"] }';
  const r = validateProfilesText(text);
  assert.equal(r.syntax_valid, true);
  assert.equal(r.schema_valid, false);
  assert.equal(r.valid, false);
});

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------
test('recovery: broken JSON (missing comma) with a recoverable schedule', () => {
  const broken = `{
  "profiles": {
    "regular-working-day": {
      "name": "Regular Working Day"
      "channels": {
        "ch1": { "enabled": true, "pulse_ms": 1700, "schedule": ["08:50", "09:40", "10:30"], "skip_dates": [] }
      }
    }
  },
  "order": ["regular-working-day"]
}`;
  const result = attemptRepair(broken);
  assert.equal(result.recovery.mode, 'structured');
  assert.ok(result.recovery.recovered_entries >= 3, 'should recover the three visible times');
  assert.equal(result.recovery.unresolved_entries, 0);
  assert.equal(result.validation.valid, true, 'rebuilt profile should be schema+application valid');
  assert.deepEqual(result.rebuilt.profiles['regular-working-day'].channels.ch1.schedule, ['08:50', '09:40', '10:30']);
});

test('recovery: heavily damaged JSON with partial schedules still recovers what it can', () => {
  const broken = `{{{ "profiles": { "mon"::: { "name": "Mon" "channels": { "ch1": {{ "pulse_ms": 2000 "schedule": [ "08:00", "09:15" ] }}}`;
  const result = attemptRepair(broken);
  assert.ok(result.recovery.recovered_entries >= 2);
  assert.ok(result.recovery.warnings.some((w) => /enabled/.test(w)), 'missing enabled must be disclosed as a default, not silent');
});

test('recovery: multiple recoverable channels/profiles are all picked up', () => {
  const broken = `{
    "profiles": {
      "weekday": { "name": "Weekday", "channels": {
        "ch1": { "enabled": true, "pulse_ms": 1700, "schedule": ["08:00", "09:00"], "skip_dates": [] },
        "ch2": { "enabled": true, "pulse_ms": 1700, "schedule": ["08:05"], "skip_dates": [] }
      } },
      "weekend": { "name": "Weekend", "channels": {
        "ch1": { "enabled": true, "pulse_ms": 1700, "schedule": ["10:00"], "skip_dates": [] }
      } }
    }
    "order": ["weekday", "weekend"]
  }`;
  const result = attemptRepair(broken);
  assert.equal(Object.keys(result.rebuilt.profiles).length, 2);
  assert.equal(result.recovery.recovered_entries, 4);
});

test('recovery: ambiguous/garbled time tokens are dropped, never guessed', () => {
  const broken = `{ "profiles": { "a": { "name": "A", "channels": { "ch1": { "enabled": true, "pulse_ms": 1700, "schedule": ["08:00", "notatime", "9:9"], "skip_dates": [] } } } } "order": ["a"] }`;
  const result = attemptRepair(broken);
  assert.deepEqual(result.rebuilt.profiles.a.channels.ch1.schedule, ['08:00']);
  assert.ok(result.recovery.unresolved_entries >= 1);
});

test('recovery: no recoverable schedule information yields confidence "none"', () => {
  const result = attemptRepair('this is not json at all, just prose with no times or channels');
  assert.equal(result.recovery.confidence, 'none');
  assert.equal(Object.keys(result.rebuilt.profiles).length, 0);
  assert.equal(result.validation.valid, true, 'an empty-but-well-formed rebuilt store is schema-valid (warns, does not error)');
});

test('recovery: freeform day-name + bare-time text (non-JSON) is recovered per spec example', () => {
  const broken = 'Monday\n08:30\n09:20\n10:10\n11:00\n\nTuesday\n08:45\n';
  const result = attemptRepair(broken);
  assert.equal(result.recovery.mode, 'freeform');
  assert.equal(Object.keys(result.rebuilt.profiles).length, 2);
  const monday = Object.values(result.rebuilt.profiles).find((p) => p.name === 'Monday');
  assert.deepEqual(monday.channels.ch1.schedule, ['08:30', '09:20', '10:10', '11:00']);
});

// ---------------------------------------------------------------------------
// lib/profiles.js — corruption must never silently destroy the file
// ---------------------------------------------------------------------------
function freshProfilesModule(fixtureDir) {
  process.env.RELAY_PROFILES_FILE = path.join(fixtureDir, 'profiles.json');
  delete require.cache[require.resolve('../lib/profiles')];
  delete require.cache[require.resolve('../lib/profile-validator')];
  delete require.cache[require.resolve('../lib/profile-schema')];
  return require('../lib/profiles');
}

test('profiles.js: a broken on-disk file is never silently replaced by an auto-created default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-profiles-test-'));
  const file = path.join(dir, 'profiles.json');
  const brokenText = '{ "profiles": { "a": { "name": "A" "channels": {} } }, "order": ["a"] }'; // missing comma
  fs.writeFileSync(file, brokenText);

  const profiles = freshProfilesModule(dir);

  assert.equal(profiles.listIds().length, 0, 'reads return no profiles while broken (never a fabricated default)');
  assert.equal(profiles.isStoreBroken(), true);
  assert.equal(profiles.getValidationState().valid, false);

  // The dangerous path: code that assumes "no profiles" means "safe to create one".
  assert.throws(() => profiles.createProfile('Should Not Be Written'), /broken/i);

  // The original broken bytes on disk must be completely untouched.
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.equal(onDisk, brokenText, 'a broken profiles.json must never be overwritten by a side-effect of reading it');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('profiles.js: writeValidatedText() replaces a broken file only with something that passes validation, and keeps a backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-profiles-test-'));
  const file = path.join(dir, 'profiles.json');
  const brokenText = '{ "profiles": {}, "order": [} '; // syntax error
  fs.writeFileSync(file, brokenText);

  const profiles = freshProfilesModule(dir);
  profiles.listIds(); // trigger the validation-aware load
  assert.equal(profiles.isStoreBroken(), true);

  assert.throws(() => profiles.writeValidatedText('{ not json'), /validation/i);
  assert.equal(fs.readFileSync(file, 'utf8'), brokenText, 'a failed repair attempt must not touch the on-disk file');

  const goodText = JSON.stringify(minimalValidStore(), null, 2);
  profiles.writeValidatedText(goodText, { reason: 'test' });

  assert.equal(profiles.isStoreBroken(), false);
  assert.equal(fs.readFileSync(file, 'utf8'), goodText);
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), brokenText, 'the previous (broken) content is preserved as a backup, not discarded');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('profiles.js: a healthy file loads normally and mutations work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-profiles-test-'));
  const file = path.join(dir, 'profiles.json');
  fs.writeFileSync(file, JSON.stringify(fullValidStore()));

  const profiles = freshProfilesModule(dir);
  assert.equal(profiles.listIds().length, 1);
  assert.equal(profiles.isStoreBroken(), false);

  const created = profiles.createProfile('Extra Profile');
  assert.ok(profiles.getProfile(created.id));

  fs.rmSync(dir, { recursive: true, force: true });
});
