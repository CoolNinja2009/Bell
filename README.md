# Relay Controller

ESP32-based multi-channel relay controller with WiFi, NTP time sync, and a profile-driven web dashboard for remote management. The ESP32 auto-discovers the server via UDP beacon — no static IP needed on flat networks. Falls back to a user-configurable provisioned IP, and finally to a compiled-in static IP if provisioned IP also fails.

## Hardware

| ESP32 Pin | Purpose             |
|-----------|---------------------|
| GPIO 26   | Channel 1 relay     |
| GPIO 27   | Channel 2 relay     |
| GND       | Common ground       |
| 3.3V/5V   | Relay module power  |

### Wiring (most relay modules)

```
ESP32          Relay Module
─────          ─────────────
GND     ────── GND
3.3V    ────── VCC   (use 5V/VIN if module requires 5V logic)
GPIO26  ────── IN1    (Channel 1)
GPIO27  ────── IN2    (Channel 2)
```

Relays trigger on **LOW** by default (`RELAY_ACTIVE_HIGH = false` in `src/main.cpp`). If your module is active-high, flip that constant.

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
        ↓ if beacon not heard for 45s
2. PROVISIONED IP (saved via setup portal)
        ↓ if not set
3. HARDCODED FALLBACK (FALLBACK_SERVER_IP in main.cpp)
```

**Resetting WiFi:** Hold the BOOT button (GPIO0) for 5 seconds at any time — erases SSID, password, and provisioned server IP. All other settings (schedules, RTC) are preserved. Non-blocking, runs concurrent with normal operation.

### 1. Server (Raspberry Pi or PC)

```bash
cd server-node
npm install
npm start
# → Dashboard at http://<host>:8080
# → Beacon broadcasts on UDP port 9999
```

#### Production deployment with PM2

PM2 keeps the server running 24/7 with automatic restarts on crash, log rotation, and startup-on-boot.

```bash
# Install PM2 globally
npm install -g pm2

# Start the server
cd server-node
pm2 start server.js --name relay-server --cwd .

# Save the process list so it survives reboots
pm2 save

# Register PM2 as a system service (auto-starts on boot)
pm2 startup
# → Follow the printed command (needs sudo on Linux)
```

Daily operations:

```bash
pm2 status              # list all processes
pm2 logs relay-server   # tail logs (--lines 200 for more)
pm2 restart relay-server
pm2 stop relay-server
pm2 monit               # real-time CPU/memory dashboard
```

Log rotation (prevents disk fill on long-running deployments):

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

> **Important**: PM2 must be running when the server crosses midnight for day-of-week profile transitions to work. The ESP32 fetches the new profile from the server; if the server is down at midnight, the ESP32 rings the previous day's schedule.

### 2. ESP32

Configure timezone and fallback server IP in `src/bell_core.h`:

```cpp
constexpr long GMT_OFFSET_SEC = 19800;  // seconds from UTC (India = 19800)
```

Then flash:

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

## API

### Device endpoints (open — no auth)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/schedule` | Download active profile's channels for today |
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
| `src/wifi_provision.h` | AP SSID/password, connection timeout, BOOT button hold duration, reconnect interval |
| `src/main.cpp` | Fallback server IP (`FALLBACK_SERVER_IP`) |
| `platformio.ini` | Board type, upload port, library versions |

## ESP32 firmware architecture

```
src/
├── main.cpp           Minimal glue: init bell_core → init network_sync
├── bell_core.h/cpp    Relay control, schedule execution, RTC, NVS persistence
├── network_sync.h/cpp WiFi, HTTP, schedule download, heartbeats, server discovery
└── wifi_provision.h   WiFi provisioning portal (AP mode, web config)
```

**Bell Core** never touches WiFi — it's the highest-priority subsystem. If the network module crashes, bells continue ringing from NVS-persisted schedules.

## BLE client (alternative discovery)

`esp32/ble_client/` contains an alternative ESP32 sketch that discovers the server via BLE advertisement instead of UDP beacon. See `esp32/ble_client/README.md` for setup.

## Features

- **Wi‑Fi provisioning** — configure WiFi from your phone on first boot, no hardcoded credentials
- **Server provisioning** — optionally set a static server IP/port in the setup portal
- **Three-tier server resolution** — UDP beacon → provisioned IP → hardcoded fallback
- **BOOT button factory reset** — hold GPIO0 for 5s to erase network credentials
- **Zero-config discovery** — UDP beacon on flat networks
- **Profile-based scheduling** — multiple named schedules with calendar-based daily rotation
- **Calendar assignments** — date-specific and day-of-week profile mapping
- **Manual override** — temporarily switch profiles with optional auto-expiry
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
