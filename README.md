# Relay Controller

ESP32-based multi-channel relay controller with WiFi, NTP time sync, auto-updating Node.js server, and a profile-driven web dashboard. **~11,000 lines** across 48 files (C++ firmware + Node.js backend + dashboard UI).

## Hardware

| ESP32 Pin | Purpose             |
|-----------|---------------------|
| GPIO 25   | RGB LED — Red       |
| GPIO 33   | RGB LED — Green     |
| GPIO 32   | RGB LED — Blue      |
| GPIO 26   | Channel 1 relay     |
| GPIO 27   | Channel 2 relay     |
| GND       | Common ground       |
| 3.3V/5V   | Relay module power  |

### RGB Status LED (4-pin, common anode)

The onboard RGB LED indicates system state at a glance. Common anode to 3.3V; each cathode driven via PWM through a current-limiting resistor (220Ω–1kΩ).

| State | Color | Pattern | Cycle |
|---|---|---|---|
| HEALTHY | Green | Breathing | 3s |
| OFFLINE_MODE | Orange (R full, G ~39%) | Breathing | 3s |
| CONNECTING_WIFI | Orange | Blink | 500ms on / 500ms off |
| BOOTING | Cyan | Solid | — |
| SCHEDULE_SYNC | Blue | Blink | 250ms on / 250ms off |
| SETUP_MODE | White | Breathing | 2s |
| CRITICAL_ERROR | Red | Blink | 120ms on / 120ms off |
| OTA_DOWNLOADING | Blue | Breathing | 3s |
| OTA_VERIFYING | Blue | Blink | 250ms on / 250ms off |
| OTA_APPLYING | Blue | Solid | — |
| OTA_FAILED | Red | Blink | 120ms on / 120ms off |

**Temporary overrides** (interrupt current state, auto-revert):

| Trigger | Color | Pattern | Duration |
|---|---|---|---|
| Bell ring | Yellow | Flash (100ms toggle) | Pulse duration |
**Priority** (higher numeric = higher priority; highest active state wins):

```
HEALTHY (0) < OFFLINE_MODE (1) < CONNECTING_WIFI (2) < BOOTING (3)
     < SCHEDULE_SYNC (4) < SETUP_MODE (5) < CRITICAL_ERROR (6)
     < OTA_DOWNLOADING (7) < OTA_VERIFYING (8) < OTA_APPLYING (9)
     < OTA_FAILED (10)
```
OTA states outrank everything except each other — firmware updates are
system‑critical and must be visible. The relay scheduler still runs
during OTA; only the LED priority changes.
Relays trigger on **LOW** by default (`RELAY_ACTIVE_HIGH = false` in `src/bell_core.h`). If your module is active-high, flip that constant.

### Optional: RTC module (DS1307/DS3231/DS3232)

Keeps real time running even when the schedule server, WiFi, or internet is down. Auto-detected at boot — nothing to configure if not present.

```
ESP32          RTC Module
─────          ──────────
GND     ────── GND
3.3V/5V ────── VCC
GPIO21  ────── SDA
GPIO22  ────── SCL
```

## Wi‑Fi Provisioning

On first boot (or after resetting WiFi), the ESP32 creates a setup access point:

| Setting    | Value             |
|------------|-------------------|
| SSID       | `Bell_Setup`      |
| Password   | `12345678`        |
| IP address | `192.168.4.1`     |

Connect your phone/laptop to `Bell_Setup`, open `http://192.168.4.1`, scan for your network, and save. The ESP32 reboots and connects.

**Server discovery:** The ESP32 finds the server via UDP beacon (port 9999). No hardcoded IP, no DNS fallback — the server broadcasts its presence, the ESP32 picks it up. When the beacon stops for 20 seconds, the ESP32 immediately logs `!!! SERVER CONNECTION LOST — running from NVS !!!` and stops all HTTP operations. Bells continue from the NVS-stored schedule.

### Relay safety guarantees

Relays fire **only** on confirmed schedule times or explicit "Run Now" commands:

- **Command discard on server loss** — when the server goes offline, pending manual commands are discarded immediately. No relay fires from a server that's no longer reachable.
- **Immediate NVS fallback** — when the beacon times out (20s), `g_server_seen` flips to `false` on the next 50ms tick. All HTTP operations stop instantly. No multi-second timeouts jamming the scheduler. The Bell Core runs from NVS on core 1, unblocked.
- **Bell Core independence** — the relay/schedule subsystem never touches WiFi or HTTP. It runs from NVS-persisted schedules and an optional RTC. Bells ring on time even if the network module crashes or the server is down for days.
- **Independent watchdog** (optional, `-D WATCHDOG_ENABLED`) — separate FreeRTOS task at priority 3. Normal mode: SAFETY OFF only for stuck relays. Takeover mode (bell_core stalled >10s): force-drives relays from NVS schedule.

## Deployment

### Every boot

Add `start.bat` (Windows) or `start.sh` (Linux) to your system's startup. It runs `bootstrap.js` which:
- Verifies Node.js, Git, PM2, and the repository
- Checks GitHub for updates (only during startup)
- Auto-updates the repository if a newer commit exists
- Installs dependencies only when `package.json` changed
- Starts or restarts the server via PM2
- Health-checks `GET /health` — rolls back on failure
- Checks mDNS / LAN reachability (Linux only, auto-installs avahi-daemon)
- Exits — only PM2 and the server remain running

```
start.bat  →  bootstrap.js  →  PM2 + server
```

```
========================================================
      Relay Controller Server v2026.0805
========================================================

[✓] Node.js              v24.15.0
[✓] Git                  2.53.0
[✓] PM2                  7.0.3
[✓] Repository           OK
[✓] GitHub               Reachable
[✓] Local Commit         d6d63b9
[✓] Remote Commit        a9f4c21
[→] Update Available     Yes

Updating repository...
Health check........ PASS
Server online.
Dashboard: http://my-pi.local:8080
           http://192.168.0.104:8080
```

### CLI flags

Both `start.bat` and `start.sh` support these flags for scripting and remote management:

| Flag | Effect |
|------|--------|
| *(none)* | Full bootstrap: check for updates, start server |
| `--update` | `git fetch` + `git reset --hard origin/main`, then restart the server |
| `--restart` | `pm2 restart relay-server` (skip bootstrap — fast restart) |

### Stopping the server

```bash
# Windows
stop.bat

# Linux
./stop.sh
```

Both stop the PM2-managed server process. The ESP32 continues running its last-known schedule.

### mDNS / LAN hostname (Linux)

On Linux, the bootstrap auto-configures mDNS so you can reach the dashboard at `http://<hostname>.local:8080` instead of remembering an IP address. It:

- Detects and optionally auto-installs `avahi-daemon` via `apt`
- Verifies `<hostname>.local` resolves to the LAN IP
- Confirms the health endpoint is reachable via mDNS

If `sudo` requires a password, the auto-install is skipped — install manually:

```bash
sudo apt-get install -y avahi-daemon
```

### Manual (Raspberry Pi / Linux)

```bash
cd server-node
npm install
npm start
# → Dashboard at http://<host>:8080
# → Beacon broadcasts on UDP port 9999
```

Log rotation (prevents disk fill on long-running deployments):

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

> **Important**: The server must be running when crossing midnight for day-of-week profile transitions to work. The ESP32 fetches the active profile from the server on every poll; if the server is down at midnight, the ESP32 continues ringing the previous day's schedule until the server returns.

### Time zone

The firmware timezone is set in `src/bell_core.h`. **This MUST be changed before deploying outside India.** The offset is seconds EAST of UTC (POSIX convention).

| Region | UTC Offset | `GMT_OFFSET_SEC` |
|--------|-----------|-------------------|
| India (IST) | UTC+5:30 | `19800` *(default)* |
| UK (GMT/BST) | UTC+0 / +1 | `0` (or `3600` for BST) |
| US Eastern | UTC-5 / -4 | `-18000` (or `-14400` for EDT) |
| US Central | UTC-6 / -5 | `-21600` (or `-18000` for CDT) |
| US Pacific | UTC-8 / -7 | `-28800` (or `-25200` for PDT) |
| Japan (JST) | UTC+9 | `32400` |
| Australia East (AEST) | UTC+10 | `36000` |
| UAE / Gulf | UTC+4 | `14400` |

To calculate: `GMT_OFFSET_SEC = (hours * 3600) + (minutes * 60)`. Example for UTC+5:30 → `5*3600 + 30*60 = 19800`.

If your region observes Daylight Saving Time, you'll need to toggle `DAYLIGHT_SEC` seasonally or set `GMT_OFFSET_SEC` to the standard-time offset and handle DST elsewhere.

```cpp
// src/bell_core.h
constexpr long GMT_OFFSET_SEC = 19800;   // India IST = UTC+5:30
constexpr long DAYLIGHT_SEC   = 0;       // set to 3600 for DST
```

The firmware timezone is set in `src/bell_core.h` (POSIX seconds-east-of-UTC).


## OTA Firmware Updates

Firmware updates are fully automated. You push code to GitHub — ESP32
devices update themselves the next morning. No USB cable, no manual steps.

### How it works

```
git push → GitHub Actions builds firmware.bin → GitHub Release
  → Node.js server fetches latest release (30 min cache)
    → ESP32 checks on every boot (60s after WiFi connects)
      → version newer? downloads 939 KB → SHA‑256 verifies → reboots
```

### Current update decision rule

Normal OTA ordering is based only on the embedded `BELL_BUILD` UTC compilation
timestamp. Release tags, version strings, and commit hashes never decide whether
an update is newer. A release missing that trusted timestamp is skipped during a
normal check, even if its tag looks newer.

The Firmware Manager can serve GitHub latest, a pinned GitHub release, or a
local `.bin` upload. It displays the selected source alongside the actual
artifact resolved by the server, including its SHA prefix and compilation time.
The source is `synced` only when those match.

Triple-click the same **Use release** button within 1.5 seconds to issue a
warning-only force request. The force is bound to that exact SHA-256 and can
bypass the normal timestamp gate, but SHA-256 verification and partition
rollback protection remain active. A normal source selection clears the force.

The ESP32 reports acknowledgement, skip reasons, download, verification,
installation, failure, and stable-boot outcomes back to the dashboard. Its
latest outcome is retried after a short server interruption.

### Verified end-to-end

OTA has been tested on real hardware (ESP32 DevKit V3, 4 MB flash).
Full update from `0.0.0-dev` to `2026.0804.f5d1f5f` completed in ~90 seconds
with SHA-256 verification and successful reboot to the new firmware.

### Safety guarantees

| Guarantee | Mechanism |
|---|---|
| Corrupt download caught | SHA‑256 verified before committing |
| Interrupted download resumes | HTTP Range requests — picks up where it left off |
| New firmware crashes on boot | ESP‑IDF auto‑rolls back to previous working partition |
| Factory fallback | Factory partition never touched by OTA — USB flash always works |
| Never downgrades | Lexicographic version comparison — only updates when strictly newer |
| Bells always ring | Download pauses when a bell is within 10 min; version checks deferred within 2 min; each tick blocks ≤200ms |
| Non‑blocking OTA | HTTP timeouts capped at 2s (version) / 500ms (chunk); per‑tick window 200ms — bell_core_tick never starves |

### Triggering an update

Push any change to the `main` branch:

```bash
git add . && git commit -m "fix relay timing" && git push
```

GitHub Actions builds `firmware.bin` and creates a release. The Node.js server
picks it up within 30 minutes. The ESP32 uses the embedded compilation time,
not the release tag, when making a normal update decision.

### Partition layout

```
4 MB flash (partitions_ota.csv):
  nvs (20 KB) | otadata (8 KB) | factory (1 MB) | ota_0 (1.3 MB) | ota_1 (1.3 MB) | coredump (64 KB) | littlefs (256 KB)
```

- **factory** — golden image, USB-flashed only, never OTA'd
- **ota_0 / ota_1** — alternate on each update. ESP-IDF auto-rolls back
  if the new partition fails to boot.
- **post_upload.py** — runs automatically after every `pio run -t upload`,
  erases the `otadata` partition to force the bootloader to boot `factory`.
  No more "am I running the new firmware?" confusion.

### First-time flash (USB)

```bash
pio run -t upload    # flashes factory + erases otadata → boots factory
pio device monitor   # watch serial output
```

You should see `BOOT: running from factory partition (0x010000)` — this
confirms the ESP32 is running the firmware you just flashed, not a stale
OTA slot. If you ever see `ota_0` or `ota_1` here, something's wrong.

### 3. First-time setup

After flashing, the serial monitor shows:

```
=== RELAY CONTROLLER BOOT ===
No WiFi configured.
Entering Setup Mode...
SSID: Bell_Setup
Password: 12345678
Open: http://192.168.4.1
```

Connect to `Bell_Setup`, open `http://192.168.4.1`, configure WiFi, and save.

### 4. Verify

Open `http://<server-ip>:8080` in a browser. Default password is **`admin`** — change it immediately (Settings → Change Password). The status bar shows green dots when the ESP32 connects.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Dashboard (browser)                                │
│  ┌──────────────┐  ┌─────────────────────────────┐  │
│  │ / (Schedule)  │  │ /profiles (Profile Manager)│  │
│  │ Channel grid  │  │ Profile CRUD, calendar,    │  │
│  │ History, log  │  │ override, import/export    │  │
│  └──────┬───────┘  └──────────────┬──────────────┘  │
└─────────┼─────────────────────────┼─────────────────┘
          │      HTTP (login)       │
          ▼                         ▼
┌─────────────────────────────────────────────────────┐
│  Schedule Server (server-node/)          :8080      │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐ │
│  │ Profiles │ │ Calendar │ │ Settings / Override  │ │
│  │ CRUD API │ │date + dow│ │ active profile mgmt  │ │
│  └────┬─────┘ └────┬─────┘ └──────────┬───────────┘ │
│       │             │                  │            │
│       ▼             ▼                  ▼            │
│  ┌──────────────────────────────────────────────┐   │
│  │        Profile Scheduler                     │   │
│  │  Resolves active profile daily:              │   │
│  │  override > calendar date > DOW > default    │   │
│  └──────────────────┬───────────────────────────┘   │
│                     │                               │
│                     ▼                               │
│  ┌──────────────────────────────────────────────┐   │
│  │  schedule.json  (ESP32-compatible format)    │   │
│  └──────────────────┬───────────────────────────┘   │
│                     │                               │
│  UDP beacon :9999   │  HTTP (open, device)          │
└─────────────────────┼───────────────────────────────┘
                      ▼
┌──────────────────────────────────────────────────────┐
│  ESP32 (src/)                                        │
│  ┌────────────┐  ┌────────────────────────────────┐  │
│  │ bell_core  │  │ network_sync                   │  │
│  │ Relays,    │  │ WiFi, HTTP poll, heartbeats,   │  │
│  │ schedule   │  │ NTP, server discovery          │  │
│  │ execution, │  │                                │  │
│  │ RTC, NVS   │  │ (Independent — bells ring even │  │
│  │            │  │  if network module crashes)    │  │
│  └────────────┘  └────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### Storage files

| File | Purpose |
|------|---------|
| `server-node/profiles.json` | All profiles with their channel schedules |
| `server-node/calendar.json` | Date and day-of-week → profile assignments |
| `server-node/settings.json` | Active profile, default profile, manual override state |
| `server-node/password.json` | bcrypt password hash |
| `server-node/secret.key` | Session signing secret (auto-generated) |
| `server-node/history.jsonl` | Append-only event log (runs, edits, saves) |
| `server-node/api_keys.json` | Hashed API keys for external integrations |
| `server-node/schedule.json` | **Legacy** — auto-migrated to profiles on first run |

## Profiles

Profiles are named schedules — each contains a set of channels with their pulse durations, time schedules, and skip dates. You manage them at `/profiles`.

### How the active profile is chosen

Every minute, the profile scheduler resolves which profile should be active:

1. **Manual override** (if set, with optional auto-expiry date)
2. **Calendar date assignment** (specific YYYY-MM-DD → profile)
3. **Day-of-week assignment** (e.g. "Saturday" → weekend profile)
4. **Default profile** (configurable per-profile)

The active profile's channel schedule is what the ESP32 receives via `/api/schedule`.

### Calendar

Assign profiles to specific dates or recurring days of the week at `/profiles` → Calendar. Date assignments take priority over day-of-week. Higher priority than the default profile.

### Override

Temporarily switch to any profile regardless of calendar. Optionally set an auto-expiry date. Override clears automatically at midnight or when manually cleared.

## Dashboard features

### Schedule page (`/`)

- **Channel grid** — one card per channel showing label, pulse duration, time schedule, and skip dates
- **Channel on/off toggle** — turn a channel off to grey it out and lock all controls. Toggle it back on to restore editing. Save still works in either state.
- **Run Now** — queue an immediate relay trigger for any channel
- **Variable bell timings** — each schedule entry can have its own pulse duration. In the schedule array, plain `"HH:MM"` strings use the channel default; `{"time":"HH:MM","pulse_ms":N}` objects override per-entry. The ESP32 parses this directly from JSON and stores it in NVS — zero config needed on the device.
- **Bulk add** — two tools under each channel's schedule (click "+ Bulk add"):
  - **Paste** — paste multiple times at once, one per line (`H:MM` or `H:MM pulse_ms`). Single-digit hours accepted (e.g. `8:00` = `08:00`). Skips duplicates, validates, sorts.
  - **Range** — generate a repeating sequence ("every 45 min from 08:00 to 15:00"). Optional pulse applies to all generated entries. Great for period bells.
- **Inline editing** — click any schedule time tag to edit it in-place
- **Add Channel** — dynamically add new relay channels (up to 24)
- **History & analytics** — filterable event table, 14-day runs-per-day chart, CSV export
- **Device log** — raw ESP32 log messages in real time
- **Heartbeat status** — per-channel online/offline indicators
- **Profile switcher** — quick profile override from the schedule page
- **Settings modal** — change password, manage API keys
- **Backup / Restore** — download or upload a full JSON snapshot
- **Dark mode** — auto-detected from system preference, manually togglable
- **Installable PWA** — add to home screen on Android/iOS/desktop for a native app experience, with offline support via service worker
### Monitoring and workspace

- **ESP32 Serial Monitor** - Wi-Fi mirrored firmware `Serial` output, delivered
  in retained batches without a USB connection
- **Movable panels** - drag Firmware Manager, History, and ESP32 Serial Monitor
  by their headers; each browser remembers its own order
- **Firmware Manager** - choose latest, pin a release, upload a local build,
  inspect the served SHA/build timestamp, and request a controlled force install
  when necessary

### Profiles page (`/profiles`)

- **Profile sidebar** — create, rename, duplicate, delete profiles
- **Channel editor** — per-profile channel grid with full schedule editing
- **Set as Default** — mark any profile as the fallback
- **Calendar** — date-specific and day-of-week profile assignments
- **Manual override** — with optional auto-expiry
- **Import / Export** — export all profiles + calendar + settings as JSON; import merges into existing
### Device endpoints (open — no auth)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/schedule` | Download active profile's channels for today. Schedule entries may be plain `"HH:MM"` strings (use channel `pulse_ms`) or `{"time":"HH:MM","pulse_ms":N}` objects (per-entry override). Single-digit hours (e.g. `"8:00"`) are accepted and normalized. |
| `GET` | `/api/schedule/hash` | Quick change detection (MD5, 8 hex chars) |
| `POST` | `/api/heartbeat?ch=ch1` | Device liveness ping per channel |
| `POST` | `/api/log` | Device pushes one log line or a batch of up to 8 Wi-Fi mirrored serial lines |
| `GET` | `/api/commands?ch=ch1` | Poll for queued manual trigger |
| `POST` | `/api/execution` | Optional: confirm a relay actually fired |
| `GET` | `/api/firmware/version` | Latest firmware version + SHA-256 hash |
| `GET` | `/api/firmware/download` | Firmware binary with HTTP Range support for resume |
| `GET` | `/api/firmware/control` | Dashboard daily-update setting and update-check revision |
| `POST` | `/api/firmware/device-status` | ESP32 acknowledgement and OTA outcome telemetry |

### Dashboard endpoints (login required)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET`/`POST` | `/api/schedule` | Read/write channel schedule |
| `GET` | `/api/status` | Server uptime + per-channel heartbeats |
| `GET` | `/api/channels` | List channels |
| `POST` | `/api/channels` | Add a channel |
| `DELETE` | `/api/channels/:key` | Remove a channel |
| `POST` | `/api/relay/:key/trigger` | Queue manual relay trigger |
| `GET` | `/api/history` | Event history (filterable) |
| `GET` | `/api/history/export` | CSV download |
| `GET` | `/api/backup` | JSON snapshot download |
| `POST` | `/api/restore` | Restore from JSON snapshot |
| `POST` | `/api/account/password` | Change dashboard password |
| `GET`/`POST`/`DELETE` | `/api/keys` | Manage API keys |
| `GET`/`POST`/`PUT`/`DELETE` | `/api/profiles[/:id]` | Profile CRUD |
| `POST` | `/api/profiles/:id/duplicate` | Clone a profile |
| `GET` | `/api/profiles/active` | Current active profile info |
| `GET` | `/api/profiles/export/all` | Export all profiles bundle |
| `POST` | `/api/profiles/import` | Import profiles bundle |
| `POST` | `/api/profiles/override` | Set manual override |
| `POST` | `/api/profiles/override/clear` | Clear manual override |
| `GET` | `/api/calendar` | Get all calendar assignments |
| `POST` | `/api/calendar/date` | Assign profile to date |
| `POST` | `/api/calendar/dow` | Assign profile to day of week |
| `DELETE` | `/api/calendar/:type/:key` | Remove calendar assignment |
| `GET`/`PUT` | `/api/settings` | Read/update settings |
| `GET` | `/api/firmware` | Firmware Manager state, served artifact, and GitHub releases |
| `PUT` | `/api/firmware/source` | Select latest or a pinned release; supports guarded `force: true` |
| `PUT` | `/api/firmware/settings` | Toggle daily OTA checks |
| `POST` | `/api/firmware/check` | Request an immediate ESP32 OTA check |
| `POST` | `/api/firmware/custom` | Upload and select a local firmware binary |

API-key auth: send `X-API-Key` header on endpoints marked as API-key compatible (`/api/status`, `/api/history`, manual trigger).

## Configuration

| File | What to change |
|------|---------------|
| `src/bell_core.h` | GPIO pins, relay active logic, timezone, RTC pins |
| `src/network_sync.h` | Beacon timeout, poll intervals, NTP servers |
| `src/led_indicator.h` | LED GPIO pins (R=25, G=33, B=32 by default) |
| `src/wifi_provision.h` | AP SSID/password, connection timeout, BOOT button hold duration, reconnect interval |
| `src/main.cpp` | Initialisation order, watchdog hook |
| `platformio.ini` | Board type, upload port, build flags, feature toggles |

```
src/
├── main.cpp            Minimal glue: init bell_core → init network_sync
├── bell_core.h/cpp     Relay control, schedule execution, RTC, NVS persistence
├── network_sync.h/cpp  WiFi, HTTP, schedule download, heartbeats, server discovery
├── led_indicator.h/cpp RGB LED status indicator (standalone, no network deps)
├── ota_update.h/cpp    OTA firmware update engine (download, verify, apply)
├── storage.h/cpp       LittleFS storage for logs and persistent state
└── wifi_provision.h    WiFi provisioning portal (AP mode, web config)
```

**Bell Core** never touches WiFi — it's the highest-priority subsystem. If the network module crashes, bells continue ringing from NVS-persisted schedules. **LED Indicator** is similarly independent — it reflects state but never affects relay operation.


## Features

- **Wi‑Fi provisioning** — configure WiFi from your phone on first boot, no hardcoded credentials
- **Server provisioning** — optionally set a static server IP/port in the setup portal
- **Three-tier server resolution** — UDP beacon → provisioned IP → hardcoded fallback
- **mDNS auto-discovery** — bootstrap configures avahi-daemon on Linux for `http://<hostname>.local` access
- **RGB status LED** — 11 system states with color-coded breathing/blink patterns covering boot, sync, error, and OTA phases
- **20s server-loss detection** — UDP beacon timeout detects offline server within 4 missed beacons
- **Relay safety** — pending commands discarded on server loss; immediate NVS fallback with zero HTTP blocking; Bell Core never touches WiFi
- **Zero-config discovery** — UDP beacon on flat networks
- **OTA firmware updates** — push to GitHub → ESP32 updates itself next boot; SHA‑256 verified, auto-rollback, resume support
- **Profile-based scheduling** — multiple named schedules with calendar-based daily rotation
- **Calendar assignments** — date-specific and day-of-week profile mapping
- **Manual override** — temporarily switch profiles with optional auto-expiry
- **Variable bell timings** — per-entry pulse durations in schedule arrays; ESP32 parses directly, no config
- **Bulk schedule entry** — paste or generate repeating time sequences; single-digit hours accepted (`8:00` = `08:00`)
- **Multi-channel** — any number of relay channels (up to 24), not just ch1/ch2
- **Channel on/off** — disable a channel to grey it out and lock editing; save and toggle remain functional
- **Manual trigger** — "Run Now" queues an immediate relay pulse
- **Live editing** — dashboard changes reach ESP32 in ≤5 seconds
- **History & analytics** — runs-per-day chart, filterable event table, CSV export
- **Backup / restore** — full JSON snapshot including profiles, calendar, settings, and history
- **API keys** — mint scoped tokens for external integrations (Home Assistant, cron, etc.)
- **Password-protected dashboard** — bcrypt-hashed, changeable in-app or via `reset_password.js`
- **Dark mode** — auto-detected from system preference, manually togglable
- **Installable PWA** — add to home screen on mobile/desktop; offline support via service worker
- **NVS persistence** — survives ESP32 reboots without server
- **Optional RTC** — DS1307/DS3231/DS3232 keeps time through network outages
- **Per-channel control** — custom pulse width, time schedules, skip dates
- **CLI management** — `--update` pulls latest from git, `--restart` restarts the server
- **Multi-platform scripts** — `.bat` (Windows) and `.sh` (Linux) for setup, start, stop
- **Non-blocking** — no `delay()`, deterministic loop, 24/7 safe
