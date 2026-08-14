'use strict';
/**
 * lib/profile-scheduler.js â€” Daily profile resolution
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * Determines which profile should be active today.
 *
 * Priority:
 *   1. Manual override (if set and not expired)
 *   2. Date-specific calendar assignment (YYYY-MM-DD)
 *   3. Day-of-week calendar assignment
 *   4. Default profile
 *
 * Also resolves a profile ID to its channel data in the exact format
 * the ESP32 expects (the existing schedule.json structure).
 */
const profiles = require('./profiles');
const calendar = require('./calendar');
const settings = require('./settings');

const SCHEDULE_TIME_ZONE = process.env.SCHEDULE_TIME_ZONE || 'Asia/Kolkata';

function nowParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  }).formatToParts(new Date());
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

/** Get today's date as YYYY-MM-DD in local timezone. */
function todayStr() {
  const p = nowParts();
  return `${p.year}-${p.month}-${p.day}`;
}

/** Get current day of week as lowercase English name. */
function todayDow() {
  return nowParts().weekday.toLowerCase();
}

/**
 * Resolve which profile ID should be active right now.
 * Returns { profileId, reason } where reason explains the selection.
 */
function resolveActiveProfileId() {
  const s = settings.getSettings();
  const exists = (id) => !!(id && profiles.getProfile(id));

  // 1. Manual override
  if (exists(s.manual_override)) {
    return { profileId: s.manual_override, reason: 'manual_override' };
  }

  const cal = calendar.getAll();

  // 2. Date-specific assignment
  const today = todayStr();
  if (exists(cal.dates[today])) {
    return { profileId: cal.dates[today], reason: `calendar_date:${today}` };
  }

  // 3. Day-of-week assignment
  const dow = todayDow();
  if (exists(cal.dow[dow])) {
    return { profileId: cal.dow[dow], reason: `calendar_dow:${dow}` };
  }

  // 4. Default profile
  if (exists(s.default_profile)) {
    return { profileId: s.default_profile, reason: 'default' };
  }

  // Fallback: first available profile
  const ids = profiles.listIds();
  if (ids.length > 0) {
    return { profileId: ids[0], reason: 'fallback_first' };
  }

  return { profileId: null, reason: 'none' };
}

/**
 * Resolve and apply the active profile.
 * Updates settings.active_profile and returns the resolved info.
 */
function resolveAndApply() {
  const { profileId, reason } = resolveActiveProfileId();
  const previousProfileId = settings.getSettings().active_profile;

  if (profileId) {
    settings.setActiveProfile(profileId);
  }

  const info = { profileId, reason, appliedAt: new Date().toISOString() };
  if (previousProfileId !== profileId) {
    console.log(`[profile-scheduler] Active profile: ${profileId || '(none)'} (${reason})`);
  }
  return info;
}

/**
 * Get the ESP32-compatible channel schedule for the currently active
 * profile. Returns the exact { ch1: {...}, ch2: {...} } format or null.
 */
function getActiveSchedule() {
  resolveAndApply();

  const s = settings.getSettings();
  const profileId = s.active_profile;

  if (!profileId) return null;

  const p = profiles.getProfile(profileId);
  if (!p || !p.channels) return null;

  return p.channels;
}

/**
 * Get info about the currently active profile for display purposes.
 */
function getActiveInfo() {
  const resolved = resolveAndApply();
  const s = settings.getSettings();
  const profileId = s.active_profile;

  if (!profileId) return { profileId: null, name: null, reason: 'none' };

  // Re-derive the reason (we don't persist it)
  const p = profiles.getProfile(profileId);

  return {
    profileId,
    name: p ? p.name : '(deleted)',
    reason: resolved.reason,
    override: !!s.manual_override,
    overrideUntil: s.override_until || null,
    channelCount: p && p.channels ? Object.keys(p.channels).length : 0,
  };
}

module.exports = { resolveAndApply, getActiveSchedule, getActiveInfo, todayStr, todayDow, SCHEDULE_TIME_ZONE };
