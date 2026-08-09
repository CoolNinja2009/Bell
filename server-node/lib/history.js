'use strict';
/**
 * lib/history.js — lightweight append-only event history
 * ─────────────────────────────────────────────────────────────────────
 * Records relay runs (scheduled + manual) and channel/schedule changes
 * to a plain JSON-Lines file (`history.jsonl`), one JSON object per line.
 *
 * No database — just fs.appendFileSync, which is more than fast enough
 * for a handful of relay events per day and stays friendly to a
 * Raspberry Pi / SD card. The file is periodically trimmed so it can't
 * grow unbounded.
 */
const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '..', 'history.jsonl');
const MAX_ENTRIES        = 5000;   // entry-count ceiling
const MAX_FILE_SIZE      = 10 * 1024 * 1024; // 10 MiB — hard filesystem ceiling (well under 400 MB)
const TRIM_CHECK_EVERY   = 25;     // check every N appends
const TRIM_AGGRESSIVE    = 2000;   // target entry count when MAX_FILE_SIZE is breached

let appendsSinceTrim = 0;

function nowIso() {
  return new Date().toISOString();
}

/** Append one history event. `entry` is a plain object; `ts`/`id` are added automatically. */
function appendHistory(entry) {
  const record = Object.assign(
    { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, ts: nowIso() },
    entry
  );
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(record) + '\n');

  appendsSinceTrim++;
  if (appendsSinceTrim >= TRIM_CHECK_EVERY) {
    appendsSinceTrim = 0;
    trimIfNeeded();
  }
  return record;
}

function readAllRaw() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip a corrupt line rather than failing the whole read
    }
  }
  return out;
}

/** Check file size + entry count. Trim if either limit is breached.
 *  When file size exceeds MAX_FILE_SIZE we trim to TRIM_AGGRESSIVE
 *  entries instead of MAX_ENTRIES to give headroom. */
function trimIfNeeded() {
  let ceiling = MAX_ENTRIES;

  // File-size guard — if the file somehow blew past the ceiling
  // (e.g. MAX_ENTRIES was raised temporarily, or entries grew huge),
  // drop to an aggressive target to protect the Pi's filesystem.
  try {
    const stat = fs.statSync(HISTORY_FILE);
    if (stat.size > MAX_FILE_SIZE) {
      console.log(`[history] File size ${(stat.size / 1024 / 1024).toFixed(1)} MiB > ${MAX_FILE_SIZE / 1024 / 1024} MiB limit — aggressive trim to ${TRIM_AGGRESSIVE} entries`);
      ceiling = TRIM_AGGRESSIVE;
    }
  } catch (_) { /* file missing — nothing to trim */ return; }

  const all = readAllRaw();
  if (all.length <= ceiling) return;

  const trimmed = all.slice(all.length - ceiling);
  const tmp = HISTORY_FILE + '.tmp';
  fs.writeFileSync(tmp, trimmed.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.renameSync(tmp, HISTORY_FILE);
  console.log(`[history] Trimmed ${all.length - trimmed.length} entries → ${trimmed.length} (ceiling: ${ceiling})`);
}

// ── Startup: force a size check on module load so a previously-unbounded
//    file doesn't sit around bloated until the next append-triggered trim.
trimIfNeeded();

/**
 * Read history with optional filters.
 * opts: { ch, trigger, from (ISO or ms), to (ISO or ms), limit }
 * Returns newest-first.
 */
function readHistory(opts = {}) {
  let entries = readAllRaw();

  if (opts.ch) entries = entries.filter((e) => e.ch === opts.ch);
  if (opts.trigger) entries = entries.filter((e) => e.trigger === opts.trigger);
  if (opts.from) {
    const fromMs = new Date(opts.from).getTime();
    if (!Number.isNaN(fromMs)) entries = entries.filter((e) => new Date(e.ts).getTime() >= fromMs);
  }
  if (opts.to) {
    const toMs = new Date(opts.to).getTime();
    if (!Number.isNaN(toMs)) entries = entries.filter((e) => new Date(e.ts).getTime() <= toMs);
  }

  entries.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 5000);
  return entries.slice(0, limit);
}

/** Replace the entire history file (used by /api/restore). `entries` newest-or-oldest, order doesn't matter. */
function replaceAll(entries) {
  if (!Array.isArray(entries)) throw new Error('history must be an array');
  const tmp = HISTORY_FILE + '.tmp';
  fs.writeFileSync(tmp, entries.map((r) => JSON.stringify(r)).join('\n') + (entries.length ? '\n' : ''));
  fs.renameSync(tmp, HISTORY_FILE);
}

/** Simple CSV export (id, ts, ch, trigger, status, pulse_ms, note). */
function toCsv(entries) {
  const cols = ['id', 'ts', 'ch', 'trigger', 'status', 'pulse_ms', 'note'];
  const esc = (v) => {
    if (v === undefined || v === null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const e of entries) {
    lines.push(cols.map((c) => esc(e[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

module.exports = { HISTORY_FILE, appendHistory, readHistory, replaceAll, toCsv };
