'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Verbatim mirrors of the ESP32 firmware's schedule parsing in
// src/bell_core.cpp, so a regression that drops a slot (the missing 10:30
// ch1 bell) is caught here without hardware:
//   parse_hhmm()          -> parseHhmm()
//   parse_channel_cfg()   -> firmwareScheduleSeconds() (insertion sort)
//   recompute_next_fire() -> nextFireSeconds() (strictly-after scan + wrap)
//
// The schedule sample below is fixed inline (not read from runtime state
// files such as profiles.json, which are gitignored and absent in CI), so the
// test is deterministic and self-contained.
// ---------------------------------------------------------------------------

const PARSE_ERROR = 0xffffffff;

function parseHhmm(s) {
  if (typeof s !== 'string' || s.length !== 5 || s[2] !== ':') return PARSE_ERROR;
  if (!/\d\d:\d\d/.test(s)) return PARSE_ERROR;
  const h = (s.charCodeAt(0) - 48) * 10 + (s.charCodeAt(1) - 48);
  const m = (s.charCodeAt(3) - 48) * 10 + (s.charCodeAt(4) - 48);
  if (h > 23 || m > 59) return PARSE_ERROR;
  return h * 3600 + m * 60;
}

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

function nextFireSeconds(sorted, nowSm) {
  let i = 0;
  while (i < sorted.length && sorted[i] <= nowSm) i += 1;
  if (i < sorted.length) return sorted[i];
  return sorted[0] + 86400;
}

const TEN_THIRTY = 10 * 3600 + 30 * 60; // 37800

// Exact JSON shape the server serves and the firmware parses: a mix of plain
// "HH:MM" strings and { time, pulse_ms } objects.
const SAMPLE_CH1_SCHEDULE = [
  { time: '08:50', pulse_ms: 3000 },
  '08:55',
  '10:20',
  '10:30',
  '11:10',
  { time: '12:30', pulse_ms: 2500 },
];

test('parse_hhmm maps "10:30" to 37800s and rejects malformed input', () => {
  assert.equal(parseHhmm('10:30'), TEN_THIRTY);
  assert.equal(parseHhmm('00:00'), 0);
  assert.equal(parseHhmm('23:59'), 23 * 3600 + 59 * 60);
  assert.equal(parseHhmm('24:00'), PARSE_ERROR);
  assert.equal(parseHhmm('10:60'), PARSE_ERROR);
  assert.equal(parseHhmm('1030'), PARSE_ERROR);
  assert.equal(parseHhmm('10:30:00'), PARSE_ERROR);
});

test('firmware parser maps ch1 "10:30" to 37800s and keeps the schedule sorted', () => {
  const seconds = firmwareScheduleSeconds(SAMPLE_CH1_SCHEDULE);
  assert.ok(seconds.includes(TEN_THIRTY), `parsed schedule must include 10:30 (37800); got ${JSON.stringify(seconds)}`);
  assert.equal(seconds.filter((s) => s === TEN_THIRTY).length, 1, '10:30 must appear exactly once');
  const sorted = [...seconds].sort((a, b) => a - b);
  assert.deepEqual(seconds, sorted, 'parsed schedule must be ascending');
  // both plain-string and object entries must be parsed
  assert.ok(seconds.includes(8 * 3600 + 50 * 60), 'object entry {time:"08:50"} must be parsed');
  assert.ok(seconds.includes(12 * 3600 + 30 * 60), 'object entry {time:"12:30"} must be parsed');
});

test('scheduler arms ch1 "10:30" as the next fire while running before 10:30', () => {
  const seconds = firmwareScheduleSeconds(SAMPLE_CH1_SCHEDULE);
  // 10:20:00 -> next slot is 10:30
  assert.equal(nextFireSeconds(seconds, 10 * 3600 + 20 * 60), TEN_THIRTY);
  // 10:29:59 -> next slot is 10:30 (a bell one second away must not be skipped)
  assert.equal(nextFireSeconds(seconds, 10 * 3600 + 29 * 60 + 59), TEN_THIRTY);
  // exactly 10:30:00 -> 10:30 is treated as already passed; next slot is 11:10
  assert.equal(nextFireSeconds(seconds, TEN_THIRTY), 11 * 3600 + 10 * 60);
  // past the last slot -> wraps to the next day's first slot (08:50 + 24h)
  assert.equal(nextFireSeconds(seconds, 12 * 3600 + 30 * 60), 8 * 3600 + 50 * 60 + 86400);
});
