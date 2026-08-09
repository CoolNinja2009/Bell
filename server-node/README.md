# Relay Controller Server

Node.js / Express backend for the ESP32 Relay Controller. Serves the dashboard, manages profiles/calendars/schedules, brokers ESP32 communication, caches OTA firmware, and self-updates from GitHub.

**1,198 lines** of server code + **960 lines** of bootstrap orchestrator. Node.js v24+, zero database — all state is flat JSON files.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [File Map](#file-map)
- [Configuration](#configuration)
- [API Reference](#api-reference)
  - [Public Endpoints (ESP32)](#public-endpoints-esp32)
  - [Dashboard Endpoints (login required)](#dashboard-endpoints-login-required)
  - [API Key Endpoints](#api-key-endpoints)
- [State Files](#state-files)
- [Auth & Security](#auth--security)
- [Profiles & Scheduling](#profiles--scheduling)
- [OTA Firmware Serving](#ota-firmware-serving)
- [Bootstrap & Self-Update](#bootstrap--self-update)
- [UDP Beacon](#udp-beacon)
- [mDNS / LAN Hostname](#mdns--lan-hostname)
- [Logging & Monitoring](#logging--monitoring)
- [Lifecycle & Process Management](#lifecycle--process-management)
- [Error Handling](#error-handling)
- [Migration Path](#migration-path)

---

## Quick Start

```bash
cd server-node
npm install
npm start
# → Dashboard at http://localhost:8080
# → Beacon broadcasts on UDP port 9999
# → Default password: admin (change immediately)
```

For production, use the bootstrap orchestrator:

```bash
# Windows
start.bat              # Full bootstrap with update check
start.bat --update     # git pull + restart
start.bat --restart    # Fast restart (skip bootstrap)

# Linux
./start.sh
./start.sh --update
./start.sh --restart
```

Stop:
```bash
stop.bat       # Windows
./stop.sh      # Linux
```

---

## Architecture

```
                        ┌──────────────────────────┐
                        │   Browser Dashboard       │
                        │   /           /profiles   │
                        │   /login      PWA assets  │
                        └──────┬──────────┬────────┘
                               │ HTTP      │ HTTP
                          (session)   (X-API-Key)
                               ▼           ▼
┌──────────────────────────────────────────────────────────┐
│                     server.js :8080                       │
│                                                          │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌───────────┐  │
│  │ Profiles │ │ Calendar │ │ Settings  │ │ Scheduler │  │
│  │  CRUD    │ │ date+dow │ │ override  │ │ midnight  │  │
│  │          │ │          │ │ default   │ │ rollover  │  │
│  └────┬─────┘ └────┬─────┘ └─────┬─────┘ └─────┬─────┘  │
│       │             │              │             │       │
│       └─────────────┴──────┬──────┴─────────────┘       │
│                            ▼                             │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Profile Scheduler                    │   │
│  │  override > calendar date > DOW > default         │   │
│  └─────────────────────┬────────────────────────────┘   │
│                        ▼                                │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Active Schedule (ESP32-compatible JSON)         │   │
│  └─────────────────────┬────────────────────────────┘   │
│                        │                                │
│    ┌───────────────────┼───────────────────┐            │
│    │                   │                   │            │
│  ┌─▼──────────┐  ┌─────▼──────┐  ┌────────▼─────────┐  │
│  │ Heartbeats │  │ Commands   │  │  Device Log      │  │
│  │ In-memory  │  │ Map(ch→ms) │  │  Ring buffer(100)│  │
│  │ Map(ch→ts) │  │ 5 min TTL  │  │                  │  │
│  └────────────┘  └────────────┘  └──────────────────┘  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Firmware Cache  (.firmware_cache/)              │   │
│  │  GitHub Releases → local .bin + .sha256          │   │
│  │  30 min TTL, Range support for resume            │   │
│  └──────────────────────────────────────────────────┘   │
└────────────────┬──────────────────────┬─────────────────┘
                 │ UDP Beacon :9999     │ HTTP (open)
                 │ every 5s             │ /api/schedule
                 ▼                      ▼
        ┌────────────────────────────────────┐
        │           ESP32                    │
        └────────────────────────────────────┘
```

**Key design decisions:**

- **No database** — all state is flat JSON files, atomic writes via tmp+rename. Fast enough for a handful of relay events per day. SD-card friendly.
- **ESP32 pulls, never pushed** — the device polls `/api/schedule`, `/api/commands`, `/api/firmware/version`. No WebSocket, no persistent connection. Survives reboots and network flaps cleanly.
- **In-memory hot path** — heartbeats and pending commands live in `Map`s. The ESP32 polls every few seconds; disk I/O on that path would be wasteful.
- **Profile resolution is server-side** — the ESP32 gets one resolved schedule. It never needs to know about calendars, overrides, or profile IDs.

---

## File Map

```
server-node/
├── server.js              Main Express app (1,198 lines)
├── bootstrap.js           Startup orchestrator (960 lines)
├── auth.js                Password + session secret (79 lines)
├── ecosystem.config.js    PM2 process definition
├── package.json
│
├── config/
│   ├── bell.conf          Human-readable settings (edit this file)
│   └── index.js           Reads bell.conf, exports structured config
│
├── lib/
│   ├── profiles.js        Profile CRUD + import/export (222 lines)
│   ├── calendar.js         Date/DOW → profile assignments (80 lines)
│   ├── settings.js         Active/default/override settings (105 lines)
│   ├── profile-scheduler.js Daily active-profile resolution (128 lines)
│   ├── history.js          JSON-Lines event log (115 lines)
│   ├── apikeys.js          API key management (92 lines)
│   ├── scheduler.js        In-process job scheduler (69 lines)
│   ├── updater.js          Self-update engine (287 lines)
│   └── config.js           Updater-specific config (re-exports from config/)
│
├── services/
│   ├── deps.js            npm dependency detection (82 lines)
│   ├── git/index.js       Git operations wrapper (167 lines)
│   ├── github/index.js    GitHub API reachability check (67 lines)
│   ├── health/index.js    HTTP health check with retries (66 lines)
│   └── pm2/index.js       PM2 process management (183 lines)
│
├── utils/
│   ├── logger.js          Rotating file logger (92 lines)
│   └── state.js           Bootstrap state persistence (70 lines)
│
├── templates/
│   ├── index.html         Dashboard SPA (1,712 lines)
│   ├── profiles.html      Profile manager page (1,484 lines)
│   └── login.html         Login page (133 lines)
│
├── defaults/              Fresh-install default state
│   ├── settings.json
│   ├── profiles.json
│   └── calendar.json
│
├── state/                 Runtime state (gitignored)
│   └── update_state.json
│
├── logs/                  Rotating log files (gitignored)
│   ├── bootstrap.log
│   ├── update.log
│   └── health.log
│
└── .firmware_cache/       Cached OTA binaries (gitignored)
```

---

All settings live in one file: **`config/bell.conf`** — edit it, restart, done.
No more hunting through source code for constants.

### Quick reference

| Section | Key | Default | What it does |
|---|---|---|---|
| `[Repository]` | `url` | `github.com/.../Bell.git` | Where updates come from |
| | `remote` | `origin` | Git remote name |
| | `branch` | `main` | Branch to track |
| | `fetch_retries` | `3` | Retry git fetch N times |
| | `fetch_retry_delay` | `5` s | Wait between fetch retries |
| `[PM2]` | `process_name` | `relay-server` | Name in `pm2 list` (auto-wired to ecosystem) |
| | `startup_grace` | `5` s | Wait after restart before health check |
| `[Health]` | `url` | `http://127.0.0.1:8080/health` | Endpoint checked on startup |
| | `timeout` | `10` s | Per-attempt timeout |
| | `retries` | `10` | Health check attempts |
| | `retry_delay` | `2` s | Wait between retries |
| `[Logging]` | `max_log_size` | `1048576` (1 MB) | Rotate log files at this size |
| | `max_log_files` | `5` | Keep N rotated backups |
| `[Server]` | `host` | `0.0.0.0` | Listen on all interfaces |
| | `port` | `8080` | Dashboard + API port |
| `[Beacon]` | `port` | `9999` | UDP broadcast for ESP32 discovery |
| | `interval_ms` | `5000` | Broadcast every 5 seconds |
| `[ProfileRefresh]` | `interval_ms` | `60000` | Check for profile changes every minute |
| `[Channels]` | `max_channels` | `24` | Max relay channels |
| | `key_pattern` | regex | Valid channel name format (letter first, max 20 chars) |
| `[Firmware]` | `repo` | `CoolNinja2009/Bell` | GitHub repo for OTA firmware |
| | `asset_name` | `firmware.bin` | File to download from release |
| | `cache_minutes` | `30` | Re-check GitHub when ESP32 asks (auto) |
| `[Cron]` | `daily_check` | `30 16 * * *` | Daily restart at 4:30 PM |
| | `update_command` | `cd {root} && ...` | Cron shell command (`{root}` auto-filled) |

### How it works

- `config/index.js` reads `bell.conf` on startup, applies defaults for anything missing, and exports structured config to `server.js`, `bootstrap.js`, and `ecosystem.config.js`.
- If `bell.conf` is missing, the JS defaults kick in — same values, server runs fine.
- **Firmware repo/asset can also be set via environment variables** (`FIRMWARE_REPO`, `FIRMWARE_ASSET_NAME`) — env vars win over the conf file.
- The `{root}` placeholder in `update_command` resolves to the actual server directory path automatically.

### Session configuration

| Setting | Value |
|---------|-------|
| Cookie name | `relay.sid` |
| Max age | 8 hours |
| httpOnly | true |
| sameSite | lax |
| Secret | Auto-generated 32-byte hex, persisted to `secret.key` |

### Security middleware

| Middleware | Config |
|-----------|--------|
| Helmet | CSP disabled (dashboard uses inline scripts), all other headers active |
| JSON body limit | 256 KB |
| URL-encoded body limit | 64 KB |
| Login rate limit | 5 attempts per minute per IP |
| Trust proxy | Enabled (honors `X-Forwarded-For`) |

---

## API Reference

### Public Endpoints (ESP32)

No authentication — the ESP32 has no browser session.

#### `GET /api/schedule`

Returns the current active profile's channel schedule in ESP32-compatible format.

**Response:**
```json
{
  "ch1": {
    "enabled": true,
    "pulse_ms": 2000,
    "schedule": ["08:00", "09:45", {"time": "12:00", "pulse_ms": 5000}],
    "skip_dates": ["2026-12-25"],
    "label": "Morning Bell"
  },
  "ch2": {
    "enabled": true,
    "pulse_ms": 3000,
    "schedule": ["06:30", "18:45"],
    "skip_dates": [],
    "label": "Evening Bell"
  }
}
```

Schedule entries are either plain `"HH:MM"` strings (use channel's `pulse_ms`) or `{"time":"HH:MM","pulse_ms":N}` objects (per-entry override). Single-digit hours (`"8:00"`) are accepted and normalized.

On first run (no profiles exist), returns a hardcoded fallback schedule.

#### `GET /api/schedule/hash`

Quick change detection. Returns MD5 of the sorted, serialized schedule.

**Response:** `{ "h": "a1b2c3d4" }` (8 hex chars)

#### `POST /api/heartbeat?ch=ch1`

Device liveness ping. Stores timestamp in memory.

**Response:** `{ "ok": true }`

Stale heartbeats (>2 min) are cleaned on every schedule poll.

#### `POST /api/log`

Device pushes a log line.

**Body:** `{ "msg": "ch1 fired (schedule)" }`

Stored in a ring buffer of 100 entries. Drained by the dashboard's `/api/log` (login required).

#### `GET /api/commands?ch=ch1`

Poll for a queued manual trigger. Commands are delivered exactly once — they're deleted on read. Commands older than 5 minutes are discarded.

**Response (pending):**
```json
{ "pending": true, "ch": "ch1", "pulse_ms": 2000 }
```

**Response (none):**
```json
{ "pending": false }
```

#### `POST /api/execution`

Optional confirmation hook. If the ESP32 firmware is updated to report "I actually fired ch1 for 2000ms", it lands in history as a confirmed execution.

**Body:** `{ "ch": "ch1", "pulse_ms": 2000, "trigger": "manual" }`

`trigger` must be `"manual"` or `"schedule"`. Logged to history and the device log buffer.

#### `GET /api/firmware/version`

Latest firmware version info from GitHub Releases (cached 30 min).

**Response:**
```json
{
  "version": "2026.0809.a1b2c3d",
  "size": 961536,
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

Returns `503` if no firmware is available.

#### `GET /api/firmware/download`

Firmware binary with HTTP Range support for interrupted-download resume.

- `200` — full file
- `206` — partial content (if `Range` header present)
- `Accept-Ranges: bytes` always set
- `ETag` set to firmware version
- `Cache-Control: public, max-age=3600`

#### `GET /health`

Health check for PM2 and monitoring.

```json
{
  "status": "ok",
  "uptime": 12345.678,
  "timestamp": "2026-08-09T05:10:56.989Z",
  "node": "v24.15.0"
}
```

---

### Dashboard Endpoints (login required)

All require a valid session cookie. Some also accept `X-API-Key` header (noted below).

#### `GET /`
Serves the dashboard SPA (`templates/index.html`). `Cache-Control: no-store`.

#### `GET /profiles`
Serves the profile manager page (`templates/profiles.html`). `Cache-Control: no-store`.

#### `POST /api/schedule`

Save the channel schedule to the active profile. Validates the full schedule object.

**Body:** Full `{ ch1: {...}, ch2: {...} }` object.

**Validation rules:**
- Must be a non-empty object
- Max 24 channels
- Each channel key must match `CHANNEL_KEY_RE` (start with letter, alphanumeric/`_`/`-`, max 20 chars)
- `enabled` must be boolean
- `pulse_ms` must be ≥ 100
- `label` must be ≤ 40 chars if present
- Schedule entries: `"HH:MM"` or `{"time":"HH:MM","pulse_ms":N}`, HH 0-23, MM 0-59
- `skip_dates`: array of `YYYY-MM-DD` strings (valid calendar dates)

Throws `400` on validation failure (caught by error middleware).

#### `GET /api/status`

Server status + per-channel heartbeats.

```json
{
  "heartbeats": { "ch1": 2.5, "ch2": 0.3 },
  "server_uptime": 12345.6
}
```

Heartbeat values are seconds since last ping. Accepts `X-API-Key`.

#### `GET /api/log`

Returns the device log ring buffer (last 100 entries).

```json
[
  { "t": "05:10:56", "msg": "ch1 fired (schedule)" },
  { "t": "05:11:02", "msg": "ch2 manual trigger queued (2000ms)" }
]
```

#### `GET /api/history`

Event history with optional filters.

**Query params:**
| Param | Type | Purpose |
|-------|------|---------|
| `ch` | string | Filter by channel key |
| `trigger` | string | Filter by trigger type (`schedule`, `manual`, `edit`) |
| `from` | ISO/ms | Start of time range |
| `to` | ISO/ms | End of time range |
| `limit` | number | Max entries (newest-first) |

Returns newest-first. Accepts `X-API-Key`.

#### `GET /api/history/export`

CSV download of filtered history. Same filters as `/api/history`. Default limit 5000.

Columns: `id, ts, ch, trigger, status, pulse_ms, note`

#### `GET /api/backup`

Full JSON snapshot download (v2 bundle format).

```json
{
  "version": 2,
  "exported_at": "2026-08-09T05:10:56.989Z",
  "schedule": { "ch1": {...}, "ch2": {...} },
  "history": [...],
  "profiles": { "ids": [...], "profiles": {...} },
  "calendar": { "dates": {...}, "dow": {...} },
  "settings": { "active_profile": "...", "default_profile": "...", "manual_override": null, "override_until": null }
}
```

#### `POST /api/restore`

Restore from a backup bundle or bare schedule object.

Accepts the full v2 bundle (restores schedule, history, profiles, calendar, settings) or a bare `{ ch1: {...}, ch2: {...} }` object (restores schedule only). After restore, re-resolves the active profile.

#### `POST /api/account/password`

Change the dashboard password.

**Body:** `{ "current": "old-password", "next": "new-password" }`

Minimum 4 characters. bcrypt with 12 rounds.

---

### Channel Management

#### `GET /api/channels`

List all channels with labels and enabled state.

```json
[
  { "key": "ch1", "label": "Morning Bell", "enabled": true },
  { "key": "ch2", "label": "Evening Bell", "enabled": false }
]
```

#### `POST /api/channels`

Add a new channel.

**Body:** `{ "key": "ch3", "label": "Lunch Bell" }`

- `key` must match `CHANNEL_KEY_RE`
- `label` optional, defaults to key uppercase, max 40 chars
- New channels start disabled with empty schedule
- Max 24 channels

#### `DELETE /api/channels/:key`

Remove a channel. Refuses if it's the last remaining channel. Cleans up heartbeats and pending commands for that channel.

#### `POST /api/relay/:key/trigger`

Queue a manual relay trigger ("Run Now").

**Body:** `{ "pulse_ms": 2000 }` (optional, defaults to channel's `pulse_ms`)

Logs to history. Accepts `X-API-Key`.

---

### Profile Management

#### `GET /api/profiles`

List all profiles with summary (id, name, channel_count, is_default, created, updated). No channel details.

#### `GET /api/profiles/active`

Current active profile info including resolution reason.

```json
{
  "profileId": "regular-working-day",
  "name": "Regular Working Day",
  "reason": "calendar: date 2026-08-09",
  "channel_count": 2,
  "is_default": true
}
```

#### `GET /api/profiles/:id`

Full profile including channel data. Returns `404` if not found.

#### `POST /api/profiles`

Create a new profile.

**Body:** `{ "name": "Weekend", "channels": { "ch1": {...}, "ch2": {...} } }`

- `name` defaults to "New Profile"
- `channels` optional — empty profiles get default ch1/ch2
- ID is auto-generated from the name slug
- Max 50 profiles

#### `PUT /api/profiles/:id`

Update profile name and/or channels.

**Body:** `{ "name": "New Name" }`, `{ "channels": {...} }`, or both.

Channels are validated through `validateSchedule()`.

#### `DELETE /api/profiles/:id`

Delete a profile. Refuses to delete the last profile.

#### `POST /api/profiles/:id/duplicate`

Clone a profile. New ID is `{original}-copy` (incremented if taken).

#### `GET /api/profiles/export/all`

Export all profiles + calendar + settings as a JSON bundle. Used for profile-only backups (lighter than the full backup).

#### `POST /api/profiles/import`

Import profiles from an export bundle. Merges into existing — overwrites by ID.

---

### Calendar

#### `GET /api/calendar`

Get all calendar assignments.

```json
{
  "dates": { "2026-12-25": "holiday" },
  "dow": { "saturday": "weekend", "sunday": "weekend" }
}
```

#### `POST /api/calendar/date`

Assign a profile to a specific date. Set `profileId` to `null` to remove.

**Body:** `{ "date": "2026-12-25", "profileId": "holiday" }`

#### `POST /api/calendar/dow`

Assign a profile to a day of week. Valid DOWs: `sunday`–`saturday`. Set `profileId` to `null` to remove.

**Body:** `{ "dow": "saturday", "profileId": "weekend" }`

#### `DELETE /api/calendar/:type/:key`

Remove a calendar assignment. `type` = `"date"` or `"dow"`.

---

### Settings & Override

#### `GET /api/settings`

```json
{
  "active_profile": "regular-working-day",
  "default_profile": "regular-working-day",
  "manual_override": null,
  "override_until": null
}
```

#### `PUT /api/settings`

Update the default profile.

**Body:** `{ "default_profile": "weekend" }`

#### `POST /api/profiles/override`

Set a manual profile override.

**Body:** `{ "profileId": "holiday", "until": "2026-08-10" }`

`until` is optional — if set, the override auto-expires after that date. Immediately resolves and applies the override.

#### `POST /api/profiles/override/clear`

Clear any active manual override. Immediately re-resolves the active profile.

---

### API Keys

#### `GET /api/keys`

List all API keys (hashes excluded).

```json
[
  {
    "id": "uuid",
    "name": "Home Assistant",
    "prefix": "rc_abc123",
    "created": "2026-08-09T05:10:56.989Z",
    "last_used": null
  }
]
```

#### `POST /api/keys`

Create a new API key.

**Body:** `{ "name": "Home Assistant" }`

**Response:** `{ "id": "uuid", "name": "Home Assistant", "key": "rc_...", "created": "..." }`

The raw `key` is returned **only here** — it cannot be retrieved again. Store it immediately. Keys are prefixed `rc_` + 32 chars base64url. Stored as salted SHA-256 hashes.

#### `DELETE /api/keys/:id`

Revoke an API key by ID.

---

### API Key Endpoints

These endpoints accept `X-API-Key` header as an alternative to session auth:

| Endpoint | Method |
|----------|--------|
| `/api/status` | GET |
| `/api/history` | GET |
| `/api/relay/:key/trigger` | POST |

If both session and API key are present, session takes priority. Invalid API keys get `401`.

---

### PWA Assets (public, no auth)

| Path | Cache | Purpose |
|------|-------|---------|
| `/manifest.json` | 1 hour | PWA manifest |
| `/sw.js` | no-cache | Service worker |
| `/icon-192.png` | 24 hours | App icon |
| `/icon-512.png` | 24 hours | App icon |
| `/bell.svg` | 24 hours | Favicon |

---

## State Files

All state is flat JSON files in the `server-node/` directory. Atomic writes (write to `.tmp`, rename) prevent corruption.

| File | Module | Schema |
|------|--------|--------|
| `profiles.json` | `lib/profiles.js` | `{ ids: string[], profiles: { [id]: { name, channels, created, updated } } }` |
| `calendar.json` | `lib/calendar.js` | `{ dates: { "YYYY-MM-DD": profileId }, dow: { "sunday": profileId, ... } }` |
| `settings.json` | `lib/settings.js` | `{ active_profile, default_profile, manual_override, override_until }` |
| `password.json` | `auth.js` | `{ password_hash: "bcrypt..." }` |
| `secret.key` | `auth.js` | Random 32-byte hex string |
| `history.jsonl` | `lib/history.js` | JSON-Lines, one event per line, max 5000 trimmed |
| `api_keys.json` | `lib/apikeys.js` | `{ keys: [{ id, name, hash, prefix, created, last_used }] }` |
| `schedule.json` | Legacy | Auto-migrated to profiles on first run |

**Defaults directory** (`defaults/`): Fresh-install default state files. Copied/created on first run if the real files don't exist.

---

## Auth & Security

### Password

- Default: `admin` (created on first run with a console warning)
- Hashing: bcrypt, 12 rounds
- Minimum length: 4 characters
- Changed via: `POST /api/account/password` or `node reset_password.js`
- File: `password.json`

### Session

- Library: `express-session`
- Secret: Auto-generated 32-byte hex, persisted to `secret.key` (survives restarts)
- Cookie: `relay.sid`, httpOnly, sameSite=lax, 8-hour max age
- Session regeneration on login (prevents session fixation)

### Login Rate Limiting

- 5 attempts per minute per IP
- Returns HTML error page (not JSON) so the login form displays it

### API Keys

- Format: `rc_` + 32 chars base64url
- Storage: salted SHA-256 hashes only (raw key shown once at creation)
- Timing-safe comparison via `crypto.timingSafeEqual`
- `last_used` timestamp updated on each successful verification
- Allowed on: `/api/status`, `/api/history`, `/api/relay/:key/trigger`

### Helmet

CSP disabled because the dashboard uses inline `<script>` and `<style>` without nonces. All other Helmet protections are active: X-Frame-Options, X-Content-Type-Options, Strict-Transport-Security (if HTTPS), etc.

---

## Profiles & Scheduling

### Profile Resolution (every minute)

```
1. Manual override (if set and not expired)
   ↓ no override or expired
2. Calendar date assignment (YYYY-MM-DD match)
   ↓ no date match
3. Day-of-week assignment (today's DOW)
   ↓ no DOW match
4. Default profile
```

### Midnight Rollover

A `setInterval` checks every 60 seconds whether the date changed. If so, re-resolves the active profile and logs the transition. The server must be running at midnight for this to work — if it's down, the ESP32 continues with the previous day's schedule.

### Profile Storage

- Max 50 profiles
- Profile IDs are slugs: `[a-z][a-z0-9-]{0,39}`
- Each profile contains a full channel schedule object in ESP32-compatible format
- Duplicate creates `{id}-copy`, then `{id}-copy-2`, etc.

### Override Expiry

Overrides with an `until` date auto-expire. The expiry is checked on every resolution cycle (every minute + on midnight rollover). No persistent timer needed — it's a date comparison.

---

## OTA Firmware Serving

The server acts as a firmware distribution point. ESP32 devices check `/api/firmware/version` on boot and download from `/api/firmware/download`.

### Flow

```
1. ESP32 boots → GET /api/firmware/version
2. Server checks GitHub Releases for latest tag
3. If not cached: downloads asset, computes SHA-256, saves to .firmware_cache/
4. Returns { version, size, sha256 }
5. ESP32 compares version → if newer, GET /api/firmware/download
6. Server streams the binary with Range support
7. ESP32 verifies SHA-256, commits to OTA partition, reboots
```

### Caching

- Cache dir: `.firmware_cache/` (gitignored)
- TTL: 30 minutes (re-checks GitHub after expiry)
- Files: `{tag}_firmware.bin` + `{tag}_firmware.bin.sha256`
- On cache miss: downloads from GitHub, computes SHA-256, saves both files
- On GitHub failure: serves stale cache if available, returns `503` if no cache exists

### Range Support

The download endpoint parses `Range: bytes=N-M` headers and serves partial content (HTTP 206). This allows the ESP32 to resume interrupted downloads instead of restarting from zero.

### Configuration

Firmware repo and asset name are set in `config/bell.conf` under `[Firmware]`.
You can also override them via environment variables for CI/deployment:

| Env Var | Conf key | Default | Purpose |
|---|---|---|---|
| `FIRMWARE_REPO` | `repo` | `CoolNinja2009/Bell` | GitHub owner/repo |
| `FIRMWARE_ASSET_NAME` | `asset_name` | `firmware.bin` | Release asset filename |

Env vars take priority over the conf file. The server uses the **latest release** (via `listReleases` with `per_page=1`) — not `getLatestRelease` which skips prereleases.

---

## Bootstrap & Self-Update

`bootstrap.js` is the production-grade startup orchestrator. It runs before `server.js` and ensures the environment is healthy.

### Phases

| Phase | What it does |
|-------|-------------|
| **1. Environment** | Verify Node.js, Git, PM2, repository, required files |
| **2. Local Commit** | Get current HEAD SHA |
| **3. GitHub Check** | Fetch remote SHA, check connectivity |
| **4. Action** | If up to date: ensure PM2 running. If update available: git pull, npm ci (if deps changed), restart, health check, rollback on failure |
| **5. Health Check** | `GET /health` with retries (10 attempts, 2s apart). Rolls back on failure |
| **6. mDNS** | Auto-install avahi-daemon (Linux only), verify mDNS resolution and HTTP reachability |

### Update Flow

```
1. git fetch origin main
2. Compare local SHA vs remote SHA
3. If different:
   a. git reset --hard origin/main
   b. Check if package.json changed → npm ci
   c. pm2 restart relay-server
   d. Health check (10 retries × 2s)
   e. If health check fails: git reset --hard previous-commit → npm ci (if needed) → pm2 restart → health check
   f. If rollback fails: log CRITICAL, exit 1
4. Save state to state/update_state.json
```

### Rollback

On update failure:
1. `git reset --hard` to the previous commit
2. Re-install dependencies if they changed
3. Restart PM2
4. Health check
5. If rollback health check also fails → manual intervention required

### State File

`state/update_state.json`:
```json
{
  "currentCommit": "a1b2c3d...",
  "previousCommit": "d6d63b9...",
  "lastStartup": "2026-08-09T05:10:56.989Z",
  "lastUpdate": "2026-08-09T04:30:00.000Z",
  "status": "up_to_date"
}
```

Status values: `up_to_date`, `updated`, `rolled_back`, `github_unreachable`, `health_check_failed`, `rollback_failed`

### Retry Policy

- GitHub fetch: 3 retries, 5s apart
- Health check: 10 retries, 2s apart
- All retries are exponential-ish (fixed intervals for predictability)

---

## UDP Beacon

The server broadcasts a UDP beacon every 5 seconds on port 9999 to `255.255.255.255`. This lets ESP32 devices on the same subnet auto-discover the server without any configuration.

**Payload:** `RELAY_CTRL:8080\n`

The ESP32 parses this to get the server's IP and port. If the beacon isn't heard for 20 seconds (4 missed beacons), the ESP32 falls back to the provisioned IP or hardcoded fallback.

---

## mDNS / LAN Hostname

On Linux, the bootstrap auto-configures mDNS so the dashboard is reachable at `http://<hostname>.local:8080`.

**Flow:**
1. Check if `avahi-daemon` is installed (`dpkg -s`)
2. If not installed: attempt `sudo apt-get install -y avahi-daemon`
3. If sudo requires a password: print manual install instructions, skip
4. Verify `<hostname>.local` resolves to the LAN IP via `dns.lookup`
5. Verify `http://<hostname>.local:8080/health` responds

**Manual install:**
```bash
sudo apt-get install -y avahi-daemon
```

**Passwordless sudo (for auto-install):**
```
# /etc/sudoers.d/bell-avahi
username ALL=(ALL) NOPASSWD: /usr/bin/apt-get, /usr/bin/systemctl enable --now avahi-daemon
```

---

## Logging & Monitoring

### Server Logs (console)

Every request is logged: `[ISO timestamp] METHOD /path -> STATUS (DURATIONms)`

Errors are logged with full stack traces.

### Device Log Ring Buffer

ESP32 log messages (`POST /api/log`) are stored in an in-memory ring buffer of 100 entries. Each entry: `{ t: "HH:MM:SS", msg: "..." }`. Oldest entries are dropped when full.

### File Logging (bootstrap only)

| File | Contents |
|------|----------|
| `logs/bootstrap.log` | Bootstrap phase results, errors, mDNS status |
| `logs/update.log` | Update decisions, git output, npm output |
| `logs/health.log` | Health check results |

Rotation: 1 MB max per file, 5 rotated backups. Timestamped entries.

### History (append-only JSON-Lines)

`history.jsonl` records every significant event:

| Event | `trigger` | `status` |
|-------|-----------|----------|
| Relay fired (schedule) | `schedule` | `executed` |
| Manual trigger queued | `manual` | `queued` |
| Schedule saved | `edit` | `schedule_saved` |
| Channel created/deleted | `edit` | `channel_created`, `channel_deleted` |
| Profile CRUD | `edit` | `profile_created`, `profile_updated`, `profile_deleted`, `profile_duplicated` |
| Backup restored | `edit` | `restored` |
| Override set/cleared | `edit` | `override_set`, `override_cleared` |
| Calendar updated | `edit` | `calendar_updated` |
| Profiles imported | `edit` | `profiles_imported` |

Trimmed to 5000 most recent entries. Trim check runs every 25 appends to avoid stat-ing every write.

---

## Lifecycle & Process Management

### Startup (PM2 mode)

```
start.bat/start.sh → bootstrap.js → pm2 start ecosystem.config.js → health check → exit
```

`bootstrap.js` exits after verifying the server is healthy. Only PM2 and the server process remain running.

### Startup (direct mode)

```
node server.js
```

Used for development. No update check, no health check.

### Graceful Shutdown

`SIGTERM` / `SIGINT` → close HTTP server → exit 0. Timeout of 3 seconds before force-exit.

### Crash Recovery

`uncaughtException` and `unhandledRejection` are caught, logged, and the process exits with code 1. PM2 (or systemd) restarts it.

### Midnight Safety

The server must be running at midnight for DOW-based profile transitions. If down, the ESP32 continues ringing the last-known schedule until the server returns.

---

## Error Handling

### Validation Errors

Thrown with `err.status = 400`. Caught by the Express error middleware. Client sees:

```json
{ "error": "ch1.schedule time '25:00' invalid — use HH:MM" }
```

### Not Found (404)

Any unmatched route returns:
```json
{ "error": "not found" }
```

### Internal Errors (500)

Unexpected errors are caught by the error middleware, logged with full stack trace, and the client sees:

```json
{ "error": "internal server error" }
```

The stack trace is never leaked to the client.

### asyncRoute Wrapper

Every async route handler is wrapped in `asyncRoute(fn)` which catches rejected promises and forwards them to `next(err)`. Without this, a rejected promise would crash the process.

### Atomic Writes

All state files use `writeFileAtomic()`: write to `file.tmp`, then `fs.renameSync(tmp, target)`. This prevents corruption if the process crashes mid-write — the rename is atomic on POSIX and near-atomic on Windows NTFS.

---

## Migration Path

### Legacy `schedule.json` → Profiles

On first run, if `schedule.json` exists but `profiles.json` doesn't:

1. Parse `schedule.json`
2. Create a "Regular Working Day" profile from the schedule data
3. Set it as the default and active profile
4. Schedule data is now managed through profiles

The old `schedule.json` is not deleted — it's just no longer the source of truth.

### Default State

If no profiles exist at all (fresh install):
1. Create a "Regular Working Day" profile with default ch1/ch2
2. Set it as the default profile
3. Resolve and apply

### Fresh Install Checklist

1. `npm install`
2. `npm start` (or `start.bat` / `./start.sh`)
3. Open `http://localhost:8080`
4. Login with password `admin`
5. Change password immediately (Settings → Change Password)
6. Add your channels and schedules
7. The ESP32 will auto-discover the server via UDP beacon

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `express` | ^5 | HTTP framework |
| `express-session` | ^1 | Session management |
| `express-rate-limit` | ^7 | Login brute-force protection |
| `helmet` | ^8 | Security headers |
| `bcryptjs` | ^3 | Password hashing (pure JS, no native deps) |
| `@octokit/rest` | ^21 | GitHub API client (firmware cache) |

Bootstrap-only (not loaded by server.js):
- `pm2` — Process manager (system dependency, not in package.json)
---

## Environment Variables

Most settings live in `config/bell.conf`. These env vars override specific values for CI/deployment:

| Variable | Overrides conf key | Default |
|---|---|---|
| `FIRMWARE_REPO` | `[Firmware]` `repo` | `CoolNinja2009/Bell` |
| `FIRMWARE_ASSET_NAME` | `[Firmware]` `asset_name` | `firmware.bin` |
