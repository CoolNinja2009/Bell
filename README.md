# Relay Controller

ESP32-based multi-channel relay controller with WiFi, NTP time sync, auto-updating Node.js server, and a profile-driven web dashboard. **11,069 lines** across 49 files (C++ firmware + Node.js backend + dashboard UI).

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

**Server settings (optional):** Expand "Server settings" in the portal to set a static server IP/port. Three-tier resolution:

```
1. UDP BEACON (live, auto-discovered)
        ↓ if beacon not heard for 20s
2. PROVISIONED IP (saved via setup portal)
        ↓ if not set
3. HARDCODED FALLBACK (FALLBACK_SERVER_IP in main.cpp)
```

### Relay safety guarantees

Relays fire **only** on confirmed schedule times or explicit "Run Now" commands:

- **Command discard on server loss** — when the server goes offline, any pending manual commands queued from that server are discarded immediately. No relay fires from a server that's no longer reachable.
- **No blind fallback polling** — when the ESP32 loses its server and falls back to the provisioned/hardcoded IP, it does **not** attempt HTTP hash polls or schedule fetches against an unknown endpoint. This prevents multi-second blocking timeouts that could delay relay pulse expiry.
- **Bell Core independence** — the relay/schedule subsystem never touches WiFi or HTTP. It runs from NVS-persisted schedules and an optional RTC. Bells ring on time even if the network module crashes or the server is down for days.

**Resetting WiFi:** Hold the BOOT button (GPIO0) for 5 seconds at any time — erases SSID, password, and provisioned server IP. All other settings (schedules, RTC) are preserved. Non-blocking, runs concurrent with normal operation.

## Deployment (Windows PC)

### One-time setup

On a fresh school PC, run `setup.bat` once. It installs Node.js and Git via `winget`, clones the repository, and runs the first bootstrap.

```
setup.bat
```

### Every boot

Add `start.bat` to Windows Startup. It runs `bootstrap.js` which:

- Verifies Node.js, Git, PM2, and the repository
- Checks GitHub for updates (only during startup)
- Auto-updates the repository if a newer commit exists
- Installs dependencies only when `package.json` changed
- Starts or restarts the server via PM2
- Health-checks `GET /health` — rolls back on failure
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
Dashboard: http://localhost:8080
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

Configure timezone in `src/bell_core.h` and fallback server IP in `src/network_sync.h`:

```cpp
constexpr long GMT_OFFSET_SEC = 19800;  // seconds from UTC (India = 19800)
```


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
| Bells always ring | Download pauses when a bell is within 10 minutes |
| Server unreachable | Retries every 30 minutes until a definitive answer |

### Triggering an update

Push any change to the `main` branch:

```bash
git add . && git commit -m "fix relay timing" && git push
```

GitHub Actions builds `firmware.bin`, creates a release. The Node.js server
picks it up within 30 minutes. ESP32 checks on every boot (after WiFi connects).

### Partition layout

```
4 MB flash:
  nvs (20 KB) | otadata (8 KB) | factory (1.5 MB) | ota_0 (1.5 MB) | ota_1 (960 KB)
```

- **factory** — golden image, USB-flashed only, never OTA'd
- **ota_0 / ota_1** — alternate on each update. ESP-IDF auto-rolls back
  if the new partition fails to boot.

### LED feedback during OTA

| State | LED | What's happening |
|---|---|---|
| OTA_DOWNLOADING | Blue breathing | Downloading firmware in background |
| OTA_VERIFYING | Blue blink | Computing SHA‑256 of downloaded firmware |
| OTA_APPLYING | Blue solid | Committing — reboot imminent (~1 second) |
| OTA_FAILED | Red blink (10 s) | Download/verify failed — will retry tomorrow |

### First-time flash (USB)

The very first time, flash via USB to get the OTA-capable firmware onto
the device:

```bash
pio run -t upload
pio device monitor    # watch serial output
```

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
  - **Paste** — paste multiple times at once, one per line (`HH:MM` or `HH:MM pulse_ms`). Skips duplicates, validates, sorts.
  - **Range** — generate a repeating sequence ("every 45 min from 08:00 to 15:00"). Optional pulse applies to all generated entries. Great for period bells.
- **Add Channel** — dynamically add new relay channels (up to 24)
- **History & analytics** — filterable event table, 14-day runs-per-day chart, CSV export
- **Device log** — raw ESP32 log messages in real time
- **Heartbeat status** — per-channel online/offline indicators
- **Profile switcher** — quick profile override from the schedule page
- **Settings modal** — change password, manage API keys
- **Backup / Restore** — download or upload a full JSON snapshot
- **Dark mode** — auto-detected from system preference, manually togglable
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
| `GET` | `/api/schedule` | Download active profile's channels for today. Schedule entries may be plain `"HH:MM"` strings (use channel `pulse_ms`) or `{"time":"HH:MM","pulse_ms":N}` objects (per-entry override). |
| `GET` | `/api/schedule/hash` | Quick change detection (MD5, 8 hex chars) |
| `POST` | `/api/heartbeat?ch=ch1` | Device liveness ping per channel |
| `POST` | `/api/log` | Device pushes a log line |
| `GET` | `/api/commands?ch=ch1` | Poll for queued manual trigger |
| `POST` | `/api/execution` | Optional: confirm a relay actually fired |

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

API-key auth: send `X-API-Key` header on endpoints marked as API-key compatible (`/api/status`, `/api/history`, manual trigger).

## Configuration

| File | What to change |
|------|---------------|
| `src/bell_core.h` | GPIO pins, relay active logic, timezone, RTC pins |
| `src/network_sync.h` | Beacon timeout, poll intervals, fallback IP, NTP servers |
| `src/led_indicator.h` | LED GPIO pins (R=25, G=33, B=32 by default) |
| `src/wifi_provision.h` | AP SSID/password, connection timeout, BOOT button hold duration, reconnect interval |
| `src/main.cpp` | Fallback server IP (`FALLBACK_SERVER_IP`) |
| `platformio.ini` | Board type, upload port, library versions |
## ESP32 firmware architecture

```
src/
├── main.cpp            Minimal glue: init bell_core → init network_sync
├── bell_core.h/cpp     Relay control, schedule execution, RTC, NVS persistence
├── network_sync.h/cpp  WiFi, HTTP, schedule download, heartbeats, server discovery
├── led_indicator.h/cpp RGB LED status indicator (standalone, no network deps)
└── wifi_provision.h    WiFi provisioning portal (AP mode, web config)
```

**Bell Core** never touches WiFi — it's the highest-priority subsystem. If the network module crashes, bells continue ringing from NVS-persisted schedules. **LED Indicator** is similarly independent — it reflects state but never affects relay operation.


## Features

- **Wi‑Fi provisioning** — configure WiFi from your phone on first boot, no hardcoded credentials
- **Server provisioning** — optionally set a static server IP/port in the setup portal
- **Three-tier server resolution** — UDP beacon → provisioned IP → hardcoded fallback
- **RGB status LED** — 7 system states with color-coded breathing/blink patterns; 3s green=healthy, 3s orange=offline, 2s white=setup, cyan/blue/red for boot/sync/error
- **Relay safety** — pending commands discarded on server loss; no blind HTTP polling against fallback IP; Bell Core never touches WiFi
- **20s server-loss detection** — UDP beacon timeout detects offline server within 4 missed beacons
- **BOOT button factory reset** — hold GPIO0 for 5s to erase network credentials
- **Zero-config discovery** — UDP beacon on flat networks
- **Profile-based scheduling** — multiple named schedules with calendar-based daily rotation
- **Calendar assignments** — date-specific and day-of-week profile mapping
- **Manual override** — temporarily switch profiles with optional auto-expiry
- **Variable bell timings** — per-entry pulse durations in schedule arrays; ESP32 parses directly, no config
- **Bulk schedule entry** — paste or generate repeating time sequences to fill schedules fast
- **Multi-channel** — any number of relay channels (up to 24), not just ch1/ch2
- **Channel on/off** — disable a channel to grey it out and lock editing; save and toggle remain functional
- **Manual trigger** — "Run Now" queues an immediate relay pulse
- **Live editing** — dashboard changes reach ESP32 in ≤5 seconds
- **History & analytics** — runs-per-day chart, filterable event table, CSV export
- **Backup / restore** — full JSON snapshot including profiles, calendar, settings, and history
- **API keys** — mint scoped tokens for external integrations (Home Assistant, cron, etc.)
- **Password-protected dashboard** — bcrypt-hashed, changeable in-app or via `reset_password.js`
- **Dark mode** — auto-detected from system preference, manually togglable
- **NVS persistence** — survives ESP32 reboots without server
- **Optional RTC** — DS1307/DS3231/DS3232 keeps time through network outages
- **Per-channel control** — custom pulse width, time schedules, skip dates
- **Non-blocking** — no `delay()`, deterministic loop, 24/7 safe
