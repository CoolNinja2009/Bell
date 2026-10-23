'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { safeNextPath, MAX_NEXT_LENGTH } = require('../lib/safe-redirect');

test('same-site paths are kept, including query strings and a literal percent', () => {
  assert.equal(safeNextPath('/'), '/');
  assert.equal(safeNextPath('/profiles'), '/profiles');
  assert.equal(safeNextPath('/profile-editor?repair=1'), '/profile-editor?repair=1');
  // Already decoded by Express: must pass through, never be decoded again.
  assert.equal(safeNextPath('/profiles?note=100%'), '/profiles?note=100%');
});

test('missing, empty and non-string values fall back to the dashboard', () => {
  assert.equal(safeNextPath(undefined), '/');
  assert.equal(safeNextPath(null), '/');
  assert.equal(safeNextPath(''), '/');
  assert.equal(safeNextPath(['/a', '/b']), '/');
  assert.equal(safeNextPath({ toString: () => '/x' }), '/');
});

test('off-site and malformed redirect targets are rejected', () => {
  assert.equal(safeNextPath('https://example.com/'), '/');
  assert.equal(safeNextPath('//example.com/path'), '/');
  assert.equal(safeNextPath('/\\example.com'), '/');
  assert.equal(safeNextPath('profiles'), '/');
  assert.equal(safeNextPath('/profiles\r\nSet-Cookie: x=1'), '/');
});

test('over-long values are rejected', () => {
  assert.equal(safeNextPath('/' + 'a'.repeat(MAX_NEXT_LENGTH)), '/');
  assert.equal(safeNextPath('/' + 'a'.repeat(MAX_NEXT_LENGTH - 1)).length, MAX_NEXT_LENGTH);
});
