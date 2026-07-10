ESP32 BLE client
=================

This sketch scans for the RPi BLE advertiser (service UUID
`12345678-1234-5678-1234-56789abcdef0`) and reads the JSON payload from
the characteristic `abcdef01-1234-5678-1234-56789abcdef0`.

It then performs an HTTP GET to `/api/schedule` on the discovered server.

Requirements
------------
- ESP32 Arduino core
- Libraries: `ESP32 BLE Arduino`, `ArduinoJson`

How to use
----------
1. Set your Wi‑Fi credentials in `ble_client.ino`.
2. Optionally update `fallbackServer` to a static server address for when
   BLE isn't available.
3. Build & flash the sketch to your ESP32.

Notes
-----
- The sketch assumes the ESP32 can reach the discovered IP on the Wi‑Fi
  network (i.e., both devices are on the same network and AP isolation is off).
- For production, add validation and authentication (e.g. check `token`
  field included in the BLE payload against a value on the server).
