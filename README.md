# Relay Controller

ESP32-based dual-channel relay controller with WiFi, NTP time sync, and a web dashboard for remote management. The ESP32 auto-discovers the server via UDP beacon — no static IP needed on flat networks. Falls back to a user-configurable provisioned IP, and finally to a compiled-in static IP if provisioned IP also fails.

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

## Wi‑Fi Provisioning

The ESP32 includes a built-in provisioning system — no need to hardcode
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
5. **Configure WiFi** — tap "Scan Networks" to see nearby WiFi networks with
   signal strength, select yours, enter the password.
6. **Configure Server (optional)** — click "Server settings" to set a static
   server IP and port for the scheduling server. Leave blank for auto-discovery.
7. Tap **"Save & Connect"** — the ESP32 saves everything, reboots, and connects
   to your network.

### Server Settings (optional — industrial-grade static IP override)

Expand the **"Server settings (optional)"** section in the setup portal to
set a static server IP address for the scheduling server:

| Field | Description | Default |
|-------|-------------|---------|
| Server IP | Dotted-decimal IPv4 address (e.g. `192.168.1.100`) | Auto-discovery |
| Server Port | TCP port (1–65535) | `8080` |

**How the server resolution works (three-tier fallback):**

```
1. UDP BEACON (live, auto-discovered)
        ↓ if beacon not heard for 45s
2. PROVISIONED IP (saved via setup portal)
        ↓ if not set
3. HARDCODED FALLBACK (FALLBACK_SERVER_IP in main.cpp)
```

- If a server IP is **provisioned**, the ESP32 uses it as the initial target
  on every boot — no need for the UDP beacon to arrive first.
- If the **UDP beacon** is later heard from a live server, the beacon IP
  takes priority (the real server may have a different IP).
- If the **beacon stops** for 45 seconds (server offline, network change),
  the ESP32 gracefully reverts to the provisioned IP — not the hardcoded
  fallback — keeping your specific server as the persistent default.
- If **no provisioned IP** was set, reverts to the hardcoded `FALLBACK_SERVER_IP`
  as before.
- **Implicit validation**: invalid IPs (e.g. `999.999.999.999`, `abc`) are
  rejected by the portal at save time with a `400 Bad Request` response.
  Corrupt NVS data is detected at boot and silently falls through to the
  hardcoded fallback.

> **For auto-discovery setups** — leave the Server IP blank. The existing
> beacon / BLE / fallback system works exactly as before, unchanged.

### Resetting WiFi (without re-flashing)

Hold the **BOOT button** (GPIO0) for **5 seconds** at **any time**:

- **Everything** WiFi-related is erased: SSID, password, and any provisioned
  server IP/port. RTC settings, bell schedules, and all other NVS data are
  preserved.
- The ESP32 restarts and enters Setup Mode so you can re-configure.
- The button is checked **continuously** in the main loop (non-blocking,
  no delay-loops, no polling latency) — just press and hold whenever.

### Behaviour when WiFi is lost at runtime

The built-in WiFi watchdog reconnects automatically every `WIFI_RETRY_MS`
(30s) — no user intervention needed. To re-enter Setup Mode, hold BOOT for
5s to erase credentials and reboot.

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
Dashboard (browser) ──▶ Schedule Server (:8080) ◀── HTTP every 5-30s ── ESP32
                              │
                        schedule.json (persistent)
                              │
                        UDP beacon :9999 (auto-discovery)
```

### Server discovery priority

```
Boot
  │
  ├─ Saved WiFi creds? ─── No ──▶ Enter Setup Mode (AP + web portal)
  │
  ├─ Connect to WiFi
  │
  ├─ Saved server IP? ──── Yes ──▶ Use provisioned IP
  │                                (overrides compiled fallback)
  │
  ├─ Beacon heard? ─────── Yes ──▶ Use beacon-discovered IP
  │                                (overrides provisioned IP)
  │
  └─ Beacon lost for 45s? ── Yes ─▶ Revert to provisioned IP,
                                     or hardcoded fallback if none
```

## Configuration

| File | What to change |
|------|---------------|
| `src/main.cpp` | Fallback server IP, timezone offset, GPIO pins, RTC pins |
| `src/wifi_provision.h` | All WiFi‑related config (AP SSID/password, connection timeout, BOOT button hold duration, reconnect interval) |
| `server/schedule.json` | Default schedule (auto-created on first run) |

## Features

- **Wi‑Fi provisioning** — configure WiFi from your phone on first boot, no hardcoded credentials needed
- **Server provisioning** — optionally set a static server IP/port in the setup portal; overrides hardcoded fallback; beacon discovery still takes priority
- **Three-tier server resolution** — UDP beacon → provisioned IP → hardcoded fallback; gracefully recovers in every failure mode
- **IP validation** — invalid server IPs are rejected at save time; corrupt NVS data is detected at boot and silently bypassed
- **BOOT button factory reset** — hold GPIO0 for 5s at any time to erase all network credentials; non-blocking, runs concurrent with normal operations
- **Zero-config discovery** — UDP beacon on flat networks, provisioned IP or hardcoded IP fallback
- **Live editing** — dashboard changes reach ESP32 in ≤5 seconds
- **NVS persistence** — survives reboots without server
- **Optional RTC support** — any DS1307/DS3231/DS3232-compatible module keeps time running through server/WiFi/internet outages; auto-detected, no wiring = no behavior change
- **Password-protected dashboard** — see `server/README.md` for login + password reset
- **Per-channel control** — enable/disable, custom pulse width, skip dates
- **Event log** — relay pulses visible in dashboard
- **Non-blocking** — no `delay()`, deterministic loop, 24/7 safe
