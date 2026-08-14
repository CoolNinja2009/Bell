'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const metadata = require('../lib/firmware-metadata');

test('reads build and OTA protocol markers from firmware data', () => {
  const firmware = Buffer.from(
    'header BELL_BUILD:2026-08-14T12:34:56Z BELL_OTA_PROTOCOL:2 BELL_OTA_MIN_PROTOCOL:1 tail',
    'latin1'
  );
  assert.equal(metadata.readBuildStamp(firmware), '2026-08-14T12:34:56Z');
  assert.equal(metadata.readOtaProtocol(firmware), 2);
  assert.equal(metadata.readMinimumOtaProtocol(firmware), 1);
});

test('treats firmware without protocol markers as legacy-compatible', () => {
  const firmware = Buffer.from('BELL_BUILD:2026-08-14T12:34:56Z', 'latin1');
  assert.equal(metadata.readOtaProtocol(firmware), 1);
  assert.equal(metadata.readMinimumOtaProtocol(firmware), 1);
});

test('rejects malformed OTA protocol markers', () => {
  const firmware = Buffer.from('BELL_OTA_PROTOCOL:0 BELL_OTA_MIN_PROTOCOL:100', 'latin1');
  assert.equal(metadata.readOtaProtocol(firmware), 1);
  assert.equal(metadata.readMinimumOtaProtocol(firmware), 1);
});

test('uses the legacy protocol when a device does not send a valid header', () => {
  assert.equal(metadata.parseDeviceOtaProtocol(undefined), 1);
  assert.equal(metadata.parseDeviceOtaProtocol('2'), 2);
  assert.equal(metadata.parseDeviceOtaProtocol('0'), 1);
  assert.equal(metadata.parseDeviceOtaProtocol('invalid'), 1);
});

test('inspects image shape, digest, and embedded metadata together', () => {
  const firmware = Buffer.concat([
    Buffer.from([0xe9]),
    Buffer.alloc(4095, 0),
    Buffer.from('BELL_BUILD:2026-08-14T12:34:56Z BELL_OTA_PROTOCOL:2 BELL_OTA_MIN_PROTOCOL:1'),
  ]);
  const info = metadata.inspectFirmware(firmware, 0x150000);
  assert.equal(info.size, firmware.length);
  assert.match(info.sha256, /^[a-f0-9]{64}$/);
  assert.equal(info.compiled_at, '2026-08-14T12:34:56Z');
  assert.equal(info.ota_protocol, 2);
});

test('rejects invalid ESP32 image headers and sizes', () => {
  assert.throws(() => metadata.inspectFirmware(Buffer.alloc(4096), 0x150000));
  assert.throws(() => metadata.inspectFirmware(Buffer.concat([Buffer.from([0xe9]), Buffer.alloc(4096)]), 4096));
});
