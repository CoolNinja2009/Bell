# Bell System — Project Checkpoint

> Generated 2026-08-09. Load this first in any new chat.

## What this is

A dual-channel ESP32 relay controller for school bells. WiFi, NTP, OTA firmware updates, Node.js dashboard. Three layers: C++ firmware (ESP32), Node.js server (Raspberry Pi), HTML dashboard.

**~11,000 lines across 48 files.** Two branches: `main` (stable), `dev` (bleeding edge).

---

## Architecture

```
ESP32 (COM3, 115200 baud)
├── Bell Core      — relays, schedule execution, RTC (DS3231), NVS persistence. NO network deps.
├── Network Sync   — WiFi, NTP, UDP beacon discovery, HTTP schedule/command/heartbeat polling
├── OTA Update     — version check → chunked download (HTTP Range) → SHA-256 verify → apply → reboot
├── LED Indicator  — RGB PWM (common-anode), 11 priority-ranked states, breathing/blink patterns
├── Storage        — LittleFS mount (256KB partition)
└── WiFi Provision — NVS credential store, BOOT button reset, captive AP portal (192.168.4.1)

Raspberry Pi (bell-server, 192.168.1.100:8080)
├── server.js          — Express REST API (40+ routes), UDP beacon (port 9999), PWA assets
├── bootstrap.js       — startup orchestrator (env verify, git update, PM2 lifecycle, health check)
├── lib/history.js     — JSONL event log, auto-trim at 5000 entries / 10MB
├── lib/profiles.js    — profile CRUD with channel data
├── lib/calendar.js    — date/DOW → profile assignments
├── lib/profile-scheduler.js — daily resolution (override > date > DOW > default)
├── lib/apikeys.js     — SHA-256 API key management
├── lib/settings.js    — active/default profile, manual override with expiry
└── templates/         — SSR-injected dashboard HTML (index, profiles, login)

CI/CD
├── .github/workflows/build-firmware.yml — PlatformIO build → GitHub Release on push to main (src/**)
└── platformio.ini                       — esp32dev, Arduino, OTA partitions, ArduinoJson v7, RTClib v2
```

---

## Key Files

### ESP32 Firmware (`src/`)

| File | Lines | Purpose |
|---|---|---|
| `main.cpp` | 67 | Entry point: `setup()` init chain, `loop()` tick chain |
| `bell_core.h` / `.cpp` | ~847 | Relay state machine, RTC, schedule NVS load/save, command queue |
| `network_sync.h` / `.cpp` | ~473 | WiFi connect/reconnect, UDP beacon, HTTP schedule fetch with hash dedup |
| `ota_update.h` / `.cpp` | ~598 | OTA state machine: IDLE→CHECK_VERSION→DOWNLOAD→VERIFY→APPLY→REBOOT |
| `led_indicator.h` / `.cpp` | ~320 | RGB LED with 11 priority-ranked states, PWM breathing/blink patterns |
| `storage.h` / `.cpp` | ~70 | LittleFS mount, auto-format |
| `wifi_provision.h` | ~580 | NVS credentials, BOOT button reset (GPIO0), captive AP portal |

### Node.js Server (`server-node/`)

| File | Lines | Purpose |
|---|---|---|
| `server.js` | ~1200 | Express server, all REST routes, UDP beacon, OTA firmware cache |
| `bootstrap.js` | ~960 | Production startup: env check, git update, PM2 start, health check |
| `lib/history.js` | ~140 | JSONL append-only history with auto-trim |
| `lib/profiles.js` | ~250 | Profile CRUD |
| `lib/calendar.js` | ~120 | Date/DOW calendar assignments |
| `lib/profile-scheduler.js` | ~90 | Active profile resolution |
| `templates/index.html` | ~1713 | Main dashboard SPA |
| `templates/profiles.html` | ~1485 | Profile management SPA |

---

## Key APIs (ESP32 → Server)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/schedule` | GET | Schedule JSON (ESP32 pulls) |
| `/api/schedule/hash` | GET | 8-char hash for dedup check |
| `/api/heartbeat?ch=` | POST | Channel alive ping |
| `/api/commands?ch=` | GET | Pending manual "run now" commands |
| `/api/execution` | POST | Execution confirmation reports |
| `/api/log` | POST | Log buffer drain from ESP32 |
| `/api/firmware/version` | GET | `{version, size, sha256}` for OTA check |
| `/api/firmware/download?v=` | GET | Binary with HTTP Range support |

---

## OTA Update Flow

1. ESP32 polls `/api/firmware/version` (60s after boot, then daily at 3 AM or 24h)
2. Server caches latest GitHub Release binary (30-min TTL)
3. If server version > current → download with HTTP Range resume
4. SHA-256 verify → `Update.end()` → reboot
5. New firmware boots → `ota_confirm_boot_if_stable()` defers rollback cancel 90s
6. If crash within 90s → ESP-IDF bootloader rolls back to previous OTA partition

**Partition layout** (4MB flash):
- `factory` (1MB at 0x10000) — USB-flashed golden image, never OTA'd
- `ota_0` (1.3MB at 0x110000) — OTA slot A
- `ota_1` (1.3MB at 0x260000) — OTA slot B
- `otadata` (8KB at 0xE000) — bootloader partition selection + rollback state

---

## Rollback Safety (recent fix)

**Problem:** `ota_init()` called `esp_ota_mark_app_valid_cancel_rollback()` immediately at boot, defeating ESP-IDF's dual-partition rollback.

**Fix:** Removed the immediate call. Added `ota_confirm_boot_if_stable()` which defers to 90s after boot + scheduler-ready. Called every `loop()` iteration. Once confirmed, becomes no-op. If firmware crashes before 90s, ESP-IDF automatically rolls back to previous partition.

---

## Recent Fixes (this session)

| Issue | Fix | File |
|---|---|---|
| Rollback cancelled at boot | Deferred to `ota_confirm_boot_if_stable()` (90s + scheduler gate) | `ota_update.cpp`, `main.cpp` |
| Server download endpoint sent zero-byte bodies | Added missing `const stream = fs.createReadStream(...)` | `server.js:557` |
| "Schedule updated" never printed | Changed `DBGLN` to `Serial.println` | `network_sync.cpp:195` |
| No "WiFi connected" message | Added transition detection with file-scope flag | `network_sync.cpp` |
| History unbounded growth risk | Added 10MB file-size ceiling + startup cleanup | `lib/history.js` |

---

## Dev Environment

- **Windows PC** with PlatformIO, Python, Node.js
- **ESP32** on COM3 (USB-Serial CH340, 115200 baud)
- **Raspberry Pi** at `bell-server` (192.168.1.100:8080), user `bell`, password `bell`
- **GitHub** repo: `CoolNinja2009/Bell`
- **Pi server restart:** `ssh bell@bell-server` then `pm2 restart relay-server` or `pkill -f server.js; cd /home/bell/Bell/server-node && node server.js &`
- **ESP32 serial:** `pio device monitor --port COM3 --baud 115200` or Python `serial.Serial('COM3', 115200)`
- **ESP32 reset:** toggle DTR via Python serial, or `pio run -t upload` (flashes factory partition)
- **Force factory boot:** `esptool --chip esp32 --port COM3 erase_region 0xE000 0x2000`
- **Flash to specific OTA slot:** `esptool write_flash 0x110000 firmware.bin` (ota_0) or `0x260000` (ota_1)

---

## Build Commands

```bash
# Build firmware
pio run

# Build + flash + monitor
pio run -t upload && pio device monitor

# Build with custom version
PLATFORMIO_BUILD_FLAGS="-D FIRMWARE_VERSION='\"1.2.3\"'" pio run

# Start Pi server (on Pi)
cd /home/bell/Bell/server-node && node server.js

# Start Pi server with PM2 (on Pi)
cd /home/bell/Bell/server-node && node bootstrap.js
```

---

## Current State

- **Branch:** `main` at `8307db7`, `dev` at `8307db7` (identical)
- **ESP32:** running working firmware (rollback fix + all patches)
- **Pi server:** running, health check OK
- **All test releases deleted,** git history clean
