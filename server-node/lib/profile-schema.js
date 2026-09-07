'use strict';
/**
 * lib/profile-schema.js — Authoritative JSON Schema for profiles.json
 * ─────────────────────────────────────────────────────────────────────
 * This describes the on-disk shape of profiles.json:
 *   { profiles: { <profileId>: Profile, ... }, order: [profileId, ...] }
 *
 * It mirrors (does not replace) the existing hand-written checks in
 * server.js's validateSchedule() — those constants (channel key pattern,
 * pulse_ms bounds, schedule/skip_dates limits) are reused here so the two
 * never drift apart. Business rules that JSON Schema cannot conveniently
 * express (e.g. "every id in `order` must exist in `profiles`", "no
 * duplicate schedule times") live in lib/profile-validator.js instead.
 */

// Kept identical to server.js so schema + legacy validator agree.
const CHANNEL_KEY_PATTERN = '^[a-zA-Z][a-zA-Z0-9_-]{0,19}$';
const PROFILE_ID_PATTERN = '^[a-z][a-z0-9-]{0,39}$';
const TIME_PATTERN = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

const MAX_CHANNELS = 24;
const MAX_SCHEDULE_SLOTS = 24;
const MAX_SKIP_DATES = 32;
const MAX_PULSE_MS = 60000;
const MIN_PULSE_MS = 100;
const MAX_PROFILES = 50;

const scheduleEntrySchema = {
  oneOf: [
    { type: 'string', pattern: TIME_PATTERN },
    {
      type: 'object',
      properties: {
        time: { type: 'string', pattern: TIME_PATTERN },
        pulse_ms: { type: 'integer', minimum: MIN_PULSE_MS, maximum: MAX_PULSE_MS },
      },
      required: ['time'],
      additionalProperties: false,
    },
  ],
};

const channelSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    pulse_ms: { type: 'integer', minimum: MIN_PULSE_MS, maximum: MAX_PULSE_MS },
    label: { type: 'string', maxLength: 40 },
    schedule: {
      type: 'array',
      maxItems: MAX_SCHEDULE_SLOTS,
      items: scheduleEntrySchema,
    },
    skip_dates: {
      type: 'array',
      maxItems: MAX_SKIP_DATES,
      items: { type: 'string', pattern: DATE_PATTERN },
    },
  },
  required: ['enabled', 'pulse_ms', 'schedule', 'skip_dates'],
  additionalProperties: false,
};

const channelsSchema = {
  type: 'object',
  // NOTE: no minProperties here — a profile with zero channels (e.g. a
  // placeholder "no bells today" profile used in existing fixtures/tests)
  // is a valid, if unusual, structure. Whether a profile is *useful* is a
  // business-rule concern (see lib/profile-validator.js), not a schema one.
  maxProperties: MAX_CHANNELS,
  patternProperties: {
    [CHANNEL_KEY_PATTERN]: channelSchema,
  },
  additionalProperties: false,
};

const profileSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 60 },
    channels: channelsSchema,
    created: { type: 'string' },
    updated: { type: 'string' },
  },
  required: ['name', 'channels'],
  additionalProperties: false,
};

const profilesStoreSchema = {
  $id: 'profiles.json',
  type: 'object',
  properties: {
    profiles: {
      type: 'object',
      maxProperties: MAX_PROFILES,
      patternProperties: {
        [PROFILE_ID_PATTERN]: profileSchema,
      },
      additionalProperties: false,
    },
    order: {
      type: 'array',
      items: { type: 'string', pattern: PROFILE_ID_PATTERN },
    },
  },
  required: ['profiles', 'order'],
  additionalProperties: false,
};

module.exports = {
  profilesStoreSchema,
  profileSchema,
  channelsSchema,
  channelSchema,
  scheduleEntrySchema,
  CHANNEL_KEY_PATTERN,
  PROFILE_ID_PATTERN,
  TIME_PATTERN,
  DATE_PATTERN,
  MAX_CHANNELS,
  MAX_SCHEDULE_SLOTS,
  MAX_SKIP_DATES,
  MAX_PULSE_MS,
  MIN_PULSE_MS,
  MAX_PROFILES,
};
