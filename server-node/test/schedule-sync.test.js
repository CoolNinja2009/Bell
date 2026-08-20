'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const profiles = require('../lib/profiles');

// ---------------------------------------------------------------------------
// These helpers are verbatim mirrors of the ESP32 firmware's schedule parsing
// in src/bell_core.cpp, so a regression in the firmware algorithm that drops
// a slot (the missing 10:30 ch1 bell) is caught here without hardware:
//   parse_hhmm()          -> parseHhmm()
//   parse_channel_cfg()   -> firmwareScheduleSeconds() (insertion sort)
//   recompute_next_fire() -> nextFireSeconds() (strictly-after scan + wrap)
// ---------------------------------------------------------------------------

const PARSE_ERROR = 0xffffffff;

// "HH:MM" -> seconds since midnight (mirror of parse_hhmm, which requires
// exactly 5 chars and rejects out-of-range hh/mm).
function parseHhmm(s) {
  if (typeof s !== 'string' || s.length !== 5 || s[2] !== ':') return PARSE_ERROR;
  if (!/\d\d:\d\d/.test(s)) return PARSE_ERROR;
  const h = (s.charCodeAt(0) - 48) * 10 + (s.charCodeAt(1) - 48);
  const m = (s.charCodeAt(3) - 48) * 10 + (s.charCodeAt(4) - 48);
  if (h > 23 || m > 59) return PARSE_ERROR;
  return h * 3600 + m * 60;
}

// Build the insertion-sorted seconds array (mirror of parse_channel_cfg).
function firmwareScheduleSeconds(entries) {
  const out = [];
  for (const entry of entries) {
    const t = typeof entry === 'string' ? entry : entry.time;
    if (!t) continue;
    const sm = parseHhmm(t);
    if (sm === PARSE_ERROR) continue;
    let pos = out.length;
    while (pos > 0 && out[pos - 1] > sm) pos -= 1;
    out.splice(pos, 0, sm);
  }
  return out;
}

// Next slot strictly after `nowSm` seconds-of-day (mirror of
// recompute_next_fire without the boot grace window), wrapping to the next
// day when past the last slot.
function nextFireSeconds(sorted, nowSm) {
  let i = 0;
  while (i < sorted.length && sorted[i] <= nowSm) i += 1;
  if (i < sorted.length) return sorted[i];
  return sorted[0] + 86400;
}

const TEN_THIRTY = 10 * 3600 + 30 * 60; // 37800

test('ch1 "10:30" is present in the regular-working-day profile', () => {
  const p = profiles.getProfile('regular-working-day');
  assert.ok(p, 'regular-working-day profile must exist');
  assert.ok(p.channels && p.channels.ch1, 'ch1 channel must exist');
  assert.equal(p.channels.ch1.enabled, true, 'ch1 must be enabled');
  const times = p.channels.ch1.schedule.map((e) => (typeof e === 'string' ? e : e.time));
  assert.ok(times.includes('10:30'), `ch1 schedule must contain "10:30"; got ${JSON.stringify(times)}`);
  for (const t of times) assert.match(t, /^\d{2}:\d{2}$/, `time ${t} must be HH:MM`);
});

test('firmware parser maps ch1 "10:30" to 37800s and keeps the schedule sorted', () => {
  const p = profiles.getProfile('regular-working-day');
  const seconds = firmwareScheduleSeconds(p.channels.ch1.schedule);
  assert.ok(seconds.includes(TEN_THIRTY), `parsed schedule must include 10:30 (37800); got ${JSON.stringify(seconds)}`);
  assert.equal(seconds.filter((s) => s === TEN_THIRTY).length, 1, '10:30 must appear exactly once');
  const sorted = [...seconds].sort((a, b) => a - b);
  assert.deepEqual(seconds, sorted, 'parsed schedule must be ascending');
});

test('scheduler arms ch1 "10:30" as the next fire while running before 10:30', () => {
  const p = profiles.getProfile('regular-working-day');
  const seconds = firmwareScheduleSeconds(p.channels.ch1.schedule);
  // 10:20:00 -> next slot is 10:30
  assert.equal(nextFireSeconds(seconds, 10 * 3600 + 20 * 60), TEN_THIRTY);
  // 10:29:59 -> next slot is 10:30 (a bell one second away must not be skipped)
  assert.equal(nextFireSeconds(seconds, 10 * 3600 + 29 * 60 + 59), TEN_THIRTY);
});
