'use strict';
/**
 * lib/safe-redirect.js - choose where to send a user after login.
 *
 * Express has already URL-decoded req.query, so the value must NOT be decoded
 * again: decodeURIComponent() throws URIError on a literal '%', and inside the
 * login callback that would be an uncaught exception that restarts the server.
 *
 * Only same-site absolute paths are accepted. Protocol-relative ('//host'),
 * backslash ('/\host') and control-character forms are rejected, and so is
 * anything that is not a string (e.g. ?next=a&next=b arrives as an array).
 */

const MAX_NEXT_LENGTH = 512;

function safeNextPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_NEXT_LENGTH) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\r\n]/.test(raw)) return '/';
  return raw;
}

module.exports = { safeNextPath, MAX_NEXT_LENGTH };
