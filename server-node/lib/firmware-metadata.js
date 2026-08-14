'use strict';

const crypto = require('crypto');
const fs = require('fs');

const BUILD_STAMP_RE = /BELL_BUILD:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/;
const OTA_PROTOCOL_RE = /BELL_OTA_PROTOCOL:(\d{1,2})(?!\d)/;
const OTA_MIN_PROTOCOL_RE = /BELL_OTA_MIN_PROTOCOL:(\d{1,2})(?!\d)/;
const LEGACY_OTA_PROTOCOL = 1;

function readMarker(binaryOrPath, expression) {
  const binary = Buffer.isBuffer(binaryOrPath) ? binaryOrPath : fs.readFileSync(binaryOrPath);
  const match = expression.exec(binary.toString('latin1'));
  return match ? match[1] : null;
}

function validProtocol(value) {
  return Number.isInteger(value) && value >= 1 && value <= 99;
}

function parseDeviceOtaProtocol(value) {
  const parsed = Number(value);
  return validProtocol(parsed) ? parsed : LEGACY_OTA_PROTOCOL;
}

function readBuildStamp(binaryOrPath) {
  return readMarker(binaryOrPath, BUILD_STAMP_RE);
}

function readOtaProtocol(binaryOrPath) {
  const parsed = Number(readMarker(binaryOrPath, OTA_PROTOCOL_RE));
  return validProtocol(parsed) ? parsed : LEGACY_OTA_PROTOCOL;
}

function readMinimumOtaProtocol(binaryOrPath) {
  const parsed = Number(readMarker(binaryOrPath, OTA_MIN_PROTOCOL_RE));
  return validProtocol(parsed) ? parsed : LEGACY_OTA_PROTOCOL;
}

function inspectFirmware(binaryOrPath, maxSize) {
  const binary = Buffer.isBuffer(binaryOrPath) ? binaryOrPath : fs.readFileSync(binaryOrPath);
  if (binary.length < 4096 || binary.length > maxSize || binary[0] !== 0xe9) {
    throw new Error('invalid ESP32 firmware image');
  }
  return {
    size: binary.length,
    sha256: crypto.createHash('sha256').update(binary).digest('hex'),
    compiled_at: readBuildStamp(binary),
    ota_protocol: readOtaProtocol(binary),
    min_ota_protocol: readMinimumOtaProtocol(binary),
  };
}

module.exports = {
  LEGACY_OTA_PROTOCOL,
  parseDeviceOtaProtocol,
  readBuildStamp,
  inspectFirmware,
  readOtaProtocol,
  readMinimumOtaProtocol,
};
