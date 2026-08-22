'use strict';
/**
 * services/health/index.js — HTTP health check.
 *
 * Performs an actual HTTP GET to the health endpoint and requires
 * HTTP 200. Does NOT trust PM2 status — the server must respond.
 */
const http = require('http');

/**
 * Perform a single health check request.
 * @param {string} url - full URL (e.g. 'http://127.0.0.1:80/health')
 * @param {number} timeoutMs - request timeout
 * @returns {Promise<boolean>}
 */
function checkOnce(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      // Consume response data to free up memory
      res.resume();
      resolve(res.statusCode === 200);
    });

    req.on('error', () => {
      resolve(false);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform health checks with retries.
 * @param {string} url - health endpoint URL
 * @param {number} timeoutMs - per-request timeout
 * @param {number} retries - number of attempts (including the first)
 * @param {number} retryDelayMs - delay between attempts
 * @param {function(string):void} [onAttempt] - called after each attempt with a status char
 * @returns {Promise<boolean>}
 */
async function check(url, timeoutMs, retries, retryDelayMs, onAttempt) {
  for (let i = 0; i < retries; i++) {
    const ok = await checkOnce(url, timeoutMs);
    if (ok) {
      if (onAttempt) onAttempt('.');
      return true;
    }
    if (onAttempt) onAttempt('.');
    if (i < retries - 1) {
      await sleep(retryDelayMs);
    }
  }
  return false;
}

module.exports = { check, checkOnce };
