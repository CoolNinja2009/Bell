'use strict';
/**
 * lib/profile-recovery.js — Automatic repair / schedule recovery
 * ─────────────────────────────────────────────────────────────────────
 * Best-effort extraction of usable schedule information from a broken
 * profiles.json, WITHOUT ever inventing a bell time that wasn't in the
 * source. Structural fields that are genuinely required by the schema
 * but cannot be recovered (enabled, pulse_ms) are given a safe, clearly
 * disclosed default and reported as a warning — never silently.
 *
 * This module never writes to disk. It returns a proposed rebuilt
 * profiles.json object plus a recovery report; the caller (server.js)
 * is responsible for showing a preview/diff and requiring the user to
 * explicitly confirm before anything is written.
 */
const { validateProfilesText } = require('./profile-validator');

const CHANNEL_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/;
const DEFAULT_PULSE_MS = 2000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function slugify(name) {
  const s = (name || '').toString().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'recovered-profile';
}

function uniqueId(base, taken) {
  let id = base;
  let n = 1;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

/** Normalize a possibly-sloppy time token ("8:0", "8:00", "08:00 AM") into
 *  strict "HH:MM", or return null if it can't be confidently interpreted. */
function normalizeTime(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Find the substring of `text` starting at `openIdx` (position of an
 *  opening bracket char) up to and including its matching close bracket,
 *  tolerant of the rest of the document being broken. Returns
 *  { content, endIdx } — content excludes the surrounding brackets.
 *  Falls back to a bounded slice if brackets never balance. */
function extractBalanced(text, openIdx, openChar, closeChar, maxLen = 20000) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < text.length && i - openIdx < maxLen; i++) {
    const c = text[i];
    if (inString) {
      if (escape) { escape = false; }
      else if (c === '\\') { escape = true; }
      else if (c === '"') { inString = false; }
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return { content: text.slice(openIdx + 1, i), endIdx: i };
    }
  }
  // Unbalanced — best effort: everything up to maxLen or EOF.
  const end = Math.min(text.length, openIdx + maxLen);
  return { content: text.slice(openIdx + 1, end), endIdx: end, unbalanced: true };
}

/** Pull every recognizable schedule entry (string time or {time,pulse_ms}
 *  object) out of a "schedule": [ ... ] region's raw text. */
function extractScheduleEntries(regionText, warnings, contextLabel) {
  const entries = [];
  let unresolved = 0;

  // {"time": "H:MM", "pulse_ms": N} style objects first, so we don't
  // double-count their inner time string as a bare entry afterwards.
  const objRe = /\{\s*"time"\s*:\s*"([^"]*)"(?:\s*,\s*"pulse_ms"\s*:\s*(\d+))?\s*\}/g;
  let consumed = regionText;
  let m;
  while ((m = objRe.exec(regionText)) !== null) {
    const t = normalizeTime(m[1]);
    if (t) {
      const entry = m[2] !== undefined ? { time: t, pulse_ms: Number(m[2]) } : t;
      entries.push(entry);
    } else {
      unresolved++;
      warnings.push(`${contextLabel}: could not interpret time value "${m[1]}" — dropped, not guessed`);
    }
    consumed = consumed.replace(m[0], '');
  }

  // Any remaining bare quoted strings in the region are candidate scalar
  // schedule entries — normalize or mark unresolved (never dropped silently).
  const strRe = /"([^"\\]*)"/g;
  while ((m = strRe.exec(consumed)) !== null) {
    const raw = m[1];
    const t = normalizeTime(raw);
    if (t) entries.push(t);
    else {
      unresolved++;
      warnings.push(`${contextLabel}: could not interpret time value "${raw}" — dropped, not guessed`);
    }
  }

  return { entries, unresolved };
}

/** Structured recovery: look for "channels": { ... } blocks and pull
 *  channel objects keyed by a plausible channel id out of them. */
function recoverStructured(text, warnings) {
  const profiles = {};
  const order = [];
  const takenIds = new Set();
  let recovered = 0;
  let unresolved = 0;

  const channelsKeyRe = /"channels"\s*:\s*\{/g;
  let cm;
  while ((cm = channelsKeyRe.exec(text)) !== null) {
    const openIdx = text.indexOf('{', cm.index);
    if (openIdx === -1) continue;
    const { content: channelsBlock } = extractBalanced(text, openIdx, '{', '}');

    // Try to find a profile name/id near this "channels" block: look
    // backwards up to 400 chars for `"<id>": { ... "name": "<name>"`.
    const precedingText = text.slice(Math.max(0, cm.index - 400), cm.index);
    const nameMatch = /"name"\s*:\s*"([^"]*)"/.exec(precedingText);
    const idMatch = /"([a-z][a-z0-9-]{0,39})"\s*:\s*\{[^{}]*$/.exec(precedingText);
    const profileName = nameMatch ? nameMatch[1] : `Recovered Profile ${order.length + 1}`;
    const baseId = idMatch ? idMatch[1] : slugify(profileName);
    const profileId = uniqueId(baseId, takenIds);

    const channels = {};
    const chKeyRe = /"([a-zA-Z][a-zA-Z0-9_-]{0,19})"\s*:\s*\{/g;
    let km;
    let anyChannel = false;
    while ((km = chKeyRe.exec(channelsBlock)) !== null) {
      const key = km[1];
      if (!CHANNEL_KEY_RE.test(key) || key === 'schedule') continue;
      const chOpenIdx = channelsBlock.indexOf('{', km.index);
      if (chOpenIdx === -1) continue;
      const { content: chBlock } = extractBalanced(channelsBlock, chOpenIdx, '{', '}');

      const enabledMatch = /"enabled"\s*:\s*(true|false)/.exec(chBlock);
      const pulseMatch = /"pulse_ms"\s*:\s*(\d+)/.exec(chBlock);
      const labelMatch = /"label"\s*:\s*"([^"]*)"/.exec(chBlock);
      const scheduleKeyIdx = chBlock.search(/"schedule"\s*:\s*\[/);

      let scheduleEntries = [];
      if (scheduleKeyIdx >= 0) {
        const arrOpenIdx = chBlock.indexOf('[', scheduleKeyIdx);
        const { content: schedText } = extractBalanced(chBlock, arrOpenIdx, '[', ']');
        const res = extractScheduleEntries(schedText, warnings, `${profileId}.${key}`);
        scheduleEntries = res.entries;
        unresolved += res.unresolved;
      }

      const defaultsUsed = [];
      let enabled;
      if (enabledMatch) enabled = enabledMatch[1] === 'true';
      else { enabled = true; defaultsUsed.push('enabled=true'); }

      let pulseMs;
      if (pulseMatch) pulseMs = Number(pulseMatch[1]);
      else { pulseMs = DEFAULT_PULSE_MS; defaultsUsed.push(`pulse_ms=${DEFAULT_PULSE_MS}`); }

      if (defaultsUsed.length > 0) {
        warnings.push(`${profileId}.${key}: ${defaultsUsed.join(', ')} — could not be recovered, using safe default`);
      }

      channels[key] = {
        enabled,
        pulse_ms: pulseMs,
        schedule: scheduleEntries,
        skip_dates: [],
        ...(labelMatch ? { label: labelMatch[1] } : {}),
      };
      anyChannel = true;
      recovered += scheduleEntries.length;
    }

    if (anyChannel) {
      const now = new Date().toISOString();
      profiles[profileId] = { name: profileName, channels, created: now, updated: now };
      order.push(profileId);
    }
  }

  return { profiles, order, recovered, unresolved };
}

/** Fallback recovery for text that isn't JSON-shaped at all: look for
 *  weekday headers followed by bare time tokens, per the spec's example:
 *    Monday
 *    08:30
 *    09:20
 */
function recoverFreeform(text, warnings) {
  const profiles = {};
  const order = [];
  const takenIds = new Set();
  let recovered = 0;
  let unresolved = 0;

  const lines = text.split(/\r?\n/);
  let current = null;

  const flush = () => {
    if (!current) return;
    const id = uniqueId(slugify(current.name), takenIds);
    const now = new Date().toISOString();
    profiles[id] = {
      name: current.name,
      channels: {
        ch1: {
          enabled: true,
          pulse_ms: DEFAULT_PULSE_MS,
          schedule: current.times,
          skip_dates: [],
          label: current.name,
        },
      },
      created: now,
      updated: now,
    };
    order.push(id);
    warnings.push(`${current.name}: enabled=true, pulse_ms=${DEFAULT_PULSE_MS} — no channel metadata found in source, using safe default`);
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const dow = WEEKDAYS.find((d) => d === line.toLowerCase().replace(/[^a-z]/g, ''));
    if (dow) {
      flush();
      current = { name: dow.charAt(0).toUpperCase() + dow.slice(1), times: [] };
      continue;
    }
    const timeMatch = /^(\d{1,2}:\d{2})\b/.exec(line);
    if (timeMatch && current) {
      const t = normalizeTime(timeMatch[1]);
      if (t) { current.times.push(t); recovered++; }
      else { unresolved++; warnings.push(`${current.name}: could not interpret time "${timeMatch[1]}" — dropped, not guessed`); }
    } else if (timeMatch && !current) {
      unresolved++;
      warnings.push(`Found time "${timeMatch[1]}" with no preceding day heading — could not place it, dropped`);
    }
  }
  flush();

  return { profiles, order, recovered, unresolved };
}

/**
 * Attempt to recover a usable profiles.json from broken text.
 * Returns { rebuilt, rebuiltText, recovery, validation } where `validation`
 * is the result of running the rebuilt object back through the full
 * validation pipeline (it may still be invalid, e.g. zero profiles
 * recovered — the caller must show this to the user before any write).
 */
function attemptRepair(originalText) {
  const warnings = [];
  let structured = recoverStructured(originalText, warnings);

  let recovered = structured.recovered;
  let unresolved = structured.unresolved;
  let profiles = structured.profiles;
  let order = structured.order;
  let mode = 'structured';

  if (order.length === 0) {
    const freeform = recoverFreeform(originalText, warnings);
    if (freeform.order.length > 0) {
      profiles = freeform.profiles;
      order = freeform.order;
      recovered = freeform.recovered;
      unresolved = freeform.unresolved;
      mode = 'freeform';
    }
  }

  const rebuilt = { profiles, order };
  const rebuiltText = JSON.stringify(rebuilt, null, 2);
  const validation = validateProfilesText(rebuiltText);

  let confidence;
  if (order.length === 0) confidence = 'none';
  else if (warnings.length === 0 && unresolved === 0) confidence = 'high';
  else if (recovered > 0 && unresolved <= recovered) confidence = 'medium';
  else confidence = 'low';

  return {
    rebuilt,
    rebuiltText,
    recovery: {
      mode,
      confidence,
      recovered_entries: recovered,
      unresolved_entries: unresolved,
      warnings,
    },
    validation,
  };
}

module.exports = {
  attemptRepair,
  normalizeTime,
};
