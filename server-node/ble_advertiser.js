#!/usr/bin/env node
'use strict';

// Simple BLE GATT peripheral that exposes the relay controller's
// reachable IP/port (and optional token) in a readable characteristic.
// Compatible with ESP32 BLE clients that read the JSON payload.

const bleno = require('bleno');
const os = require('os');

const SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';
const CHAR_UUID = 'abcdef01-1234-5678-1234-56789abcdef0';

function getLocalIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

const argv = require('minimist')(process.argv.slice(2));
const NAME = argv.name || 'RelayCtrl';
const PORT = argv.port || process.env.PORT || 8080;
const TOKEN = argv.token || '';
const INTERVAL = Number(argv.interval || 5000);

let latestPayload = null;

function buildPayload() {
  const payload = {
    ip: getLocalIPv4(),
    port: Number(PORT),
  };
  if (TOKEN) payload.token = TOKEN;
  return JSON.stringify(payload);
}

const Characteristic = bleno.Characteristic;

class InfoCharacteristic extends Characteristic {
  constructor() {
    super({
      uuid: CHAR_UUID,
      properties: ['read'],
    });
  }

  onReadRequest(offset, callback) {
    const data = Buffer.from(latestPayload || buildPayload());
    if (offset > data.length) return callback(this.RESULT_INVALID_OFFSET, null);
    const chunk = data.slice(offset);
    callback(this.RESULT_SUCCESS, chunk);
  }
}

const infoChar = new InfoCharacteristic();

bleno.on('stateChange', (state) => {
  console.log('[ble] stateChange', state);
  if (state === 'poweredOn') {
    bleno.startAdvertising(NAME, [SERVICE_UUID], (err) => {
      if (err) console.error('[ble] startAdvertising error', err);
      else console.log('[ble] advertising', NAME, SERVICE_UUID);
    });
  } else {
    bleno.stopAdvertising();
  }
});

bleno.on('advertisingStart', (err) => {
  if (err) return console.error('[ble] advertisingStart error', err);
  bleno.setServices([
    new bleno.PrimaryService({
      uuid: SERVICE_UUID,
      characteristics: [infoChar],
    }),
  ]);
  latestPayload = buildPayload();
  setInterval(() => {
    latestPayload = buildPayload();
  }, INTERVAL);
});

console.log('[ble] advertiser starting — build payload every', INTERVAL, 'ms');
console.log('[ble] service UUID:', SERVICE_UUID);
console.log('[ble] characteristic UUID:', CHAR_UUID);
