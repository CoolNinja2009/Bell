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

## Wi‑Fi Provisioning (new)

The ESP32 now includes a built-in provisioning system — no need to hardcode
WiFi credentials before flashing. On first boot (or after resetting WiFi),
the ESP32 creates a setup access point so you can configure it from your
phone or laptop.

### How it works

1. **Flash once** — upload the firmware normally via `pio run -t upload`.
2. **First boot** — the ESP32 checks for saved WiFi credentials in NVS.
   - If **no credentials** are found → enters **Setup Mode**.
   - If **credentials exist** → connects to WiFi and boots normally.
3. **Setup Mode** — the ESP32 creates an access point:

   | Setting | Value |
   |---------|-------|
   | SSID | `Bell_Setup` |
   | Password | `12345678` |
   | IP address | `192.168.4.1` |

4. **Connect** your phone/laptop to the `Bell_Setup` network, then open
   `http://192.168.4.1` in a browser.
5. **Configure** — tap "Scan Networks" to see nearby WiFi networks with
   signal strength, select yours, enter the password, and tap "Save & Connect".
6. The ESP32 saves the credentials, reboots, and boots normally into the
   relay controller firmware.

### Resetting WiFi (without re-flashing)

Hold the **BOOT button** (GPIO0) for **5 seconds** at **any time**:

- Only WiFi credentials are erased — RTC settings, bell schedules,
  server configs, and all other NVS data are preserved.
- The ESP32 then restarts and enters Setup Mode so you can re-configure
  WiFi.
- The button is checked continuously in the main loop, so you don't need
  to time it with a reset — just press and hold whenever you want to
  factory-reset the WiFi settings.

### Behaviour when WiFi is lost at runtime

If the connection drops, the built-in WiFi watchdog reconnects automatically
(the existing `loop()` behaviour is unchanged). To re-enter Setup Mode
manually, hold BOOT for 5s at the next power cycle or reset.

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

Configure timezone and fallback server IP in `src/main.cpp`:

```cpp
constexpr long GMT_OFFSET_SEC = 19800;  // seconds from UTC (India = 19800)
constexpr char FALLBACK_SERVER_IP[] = "192.168.1.100";  // change to your server IP
```

No need to set WiFi credentials — provisioning handles that on first boot.

Then flash:

```bash
pio run -t upload
pio device monitor    # watch serial output
```

### 3. First-time setup

After flashing, check the serial monitor. You'll see:

```
=== RELAY CONTROLLER BOOT ===
Reading WiFi credentials...
No WiFi configured.
Entering Setup Mode...
AP Started
SSID: Bell_Setup
Password: 12345678
Open: http://192.168.4.1
```

Connect to `Bell_Setup` from your phone, open `http://192.168.4.1`,
scan for your network, and save. The ESP32 will reboot and connect.

### 4. Verify

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
| `src/main.cpp` | Fallback server IP, timezone offset, GPIO pins, RTC pins |
| `src/wifi_provision.h` | All WiFi‑related config (AP SSID/password, connection timeout, BOOT button hold duration, reconnect interval) |
| `server/schedule.json` | Default schedule (auto-created on first run) |

## Features

- **Wi‑Fi provisioning** — configure WiFi from your phone on first boot, no hardcoded credentials needed
- **BOOT button factory reset** — hold GPIO0 for 5s to erase only WiFi credentials, preserving all other settings
- **Zero-config discovery** — UDP beacon on flat networks, hardcoded IP fallback
- **Live editing** — dashboard changes reach ESP32 in ≤5 seconds
- **NVS persistence** — survives reboots without server
- **Optional RTC support** — any DS1307/DS3231/DS3232-compatible module keeps time running through server/WiFi/internet outages; auto-detected, no wiring = no behavior change
- **Password-protected dashboard** — see `server/README.md` for login + password reset
- **Per-channel control** — enable/disable, custom pulse width, skip dates
- **Event log** — relay pulses visible in dashboard
- **Non-blocking** — no `delay()`, deterministic loop, 24/7 safe
