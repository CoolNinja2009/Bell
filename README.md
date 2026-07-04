# Relay Controller

ESP32-based dual-channel relay controller with WiFi, NTP time sync, and a web dashboard for remote management. The ESP32 auto-discovers the server via UDP beacon — no static IP needed on flat networks. Falls back to a hardcoded IP if the beacon doesn't arrive (enterprise/campus networks).

## Hardware

| ESP32 Pin | Purpose      |
|-----------|--------------|
| GPIO 26   | Channel 1 relay |
| GPIO 27   | Channel 2 relay |
| GND       | Common ground    |
| 3.3V/5V   | Relay module power |

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

### Optional: RTC module (any DS1307/DS3231/DS3232-compatible board)

Not required — the controller works exactly as before without one. If wired in, it keeps
real time running even when the schedule server, WiFi, or internet is down (or before NTP
has synced for the first time), instead of the controller sitting idle waiting on the network.

```
ESP32          RTC Module (DS1307 / DS3231 / etc.)
─────          ────────────────────────────────────
GND     ────── GND
3.3V/5V ────── VCC
GPIO21  ────── SDA
GPIO22  ────── SCL
```

It's auto-detected at boot (`RTC_I2C_ADDR = 0x68` in `src/main.cpp`) — nothing to configure
if you're not using one. Time is periodically corrected from NTP once it's available, so RTC
drift doesn't build up over time.

## Quick start

### 1. Server (Raspberry Pi or PC)

There are two server implementations in this repo:

- **`server-node/`** — Node.js/Express, production-hardened (recommended). See `server-node/README.md`.
- **`server/`** — the original Flask prototype, kept for reference.

```bash
cd server-node
npm install
npm start
# → Dashboard at http://<host>:8080
# → Beacon broadcasts on UDP port 9999
```

### 2. ESP32

Edit `src/main.cpp`:

```cpp
constexpr char WIFI_SSID[] = "your-ssid";
constexpr char WIFI_PASS[] = "your-password";
constexpr long GMT_OFFSET_SEC = 19800;  // seconds from UTC (India = 19800)
constexpr char FALLBACK_SERVER_IP[] = "192.168.1.100";  // change to your server IP
```

Then flash:

```bash
pio run -t upload
pio device monitor    # watch serial output
```

### 3. Verify

Open `http://<server-ip>:8080` in a browser. The status bar shows green dots when the ESP32 connects. Add schedule entries, toggle channels, set skip dates — changes reach the ESP32 within 5 seconds.

## Architecture

```
Dashboard (browser) ──▶ Flask server (:8080) ◀── HTTP every 5-30s ── ESP32
                              │
                        schedule.json (persistent)
                              │
                        UDP beacon :9999 (auto-discovery)
```

## Configuration

| File | What to change |
|------|---------------|
| `src/main.cpp:38-39` | WiFi SSID / password |
| `src/main.cpp:48` | Fallback server IP |
| `src/main.cpp:72` | Timezone offset (seconds from UTC) |
| `src/main.cpp:31-32` | GPIO pins |
| `src/main.cpp:99-103` | RTC I2C address / pins (optional module) |
| `server/schedule.json` | Default schedule (auto-created on first run) |

## Features

- **Zero-config discovery** — UDP beacon on flat networks, hardcoded IP fallback
- **Live editing** — dashboard changes reach ESP32 in ≤5 seconds
- **NVS persistence** — survives reboots without server
- **Optional RTC support** — any DS1307/DS3231/DS3232-compatible module keeps time running through server/WiFi/internet outages; auto-detected, no wiring = no behavior change
- **Password-protected dashboard** — see `server/README.md` for login + password reset
- **Per-channel control** — enable/disable, custom pulse width, skip dates
- **Event log** — relay pulses visible in dashboard
- **Non-blocking** — no `delay()`, deterministic loop, 24/7 safe
