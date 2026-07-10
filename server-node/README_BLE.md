BLE advertiser (RPi)
=====================

This script advertises the relay-controller server's reachable IP and port
over Bluetooth Low Energy as a small JSON payload. The ESP32 can read the
payload and then connect over Wi‑Fi to the server URL.

Usage
-----

Install dependencies (on the Raspberry Pi with working BlueZ):

```bash
cd server-node
npm install bleno minimist
```

Run the advertiser:

```bash
node ble_advertiser.js --name RelayCtrl --port 8080 --interval 5000
```

Options:
- `--name`: BLE device name (default `RelayCtrl`)
- `--port`: server port (default from `PORT` env or `8080`)
- `--token`: optional token included in the JSON payload
- `--interval`: how frequently the payload is rebuilt (ms)

Service & characteristic UUIDs (for the ESP32 client):
- Service: `12345678-1234-5678-1234-56789abcdef0`
- Characteristic: `abcdef01-1234-5678-1234-56789abcdef0`

Security
--------
BLE advertising and GATT characteristics are not encrypted unless you
enable pairing/bonding. If you need confidentiality, include a pre-shared
token in the payload and require it before accepting connections.
