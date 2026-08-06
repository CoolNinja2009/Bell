'use strict';
/**
 * stop.js — Gracefully stop the relay-server managed by PM2.
 *
 * Usage:
 *   node stop.js          # stop the process, leave PM2 daemon running
 *   node stop.js --kill   # also kill the PM2 daemon afterward
 */

const path = require('path');

const ROOT = __dirname;
const PM2 = require(path.join(ROOT, 'services', 'pm2'));
const cfg = require(path.join(ROOT, 'config'));

const CHECK = '\u2713'; // ✓
const CROSS = '\u2717'; // ✗
const ECO_FILE = cfg.pm2.ecosystemFile;
const PROC_NAME = cfg.pm2.processName;
const KILL_DAEMON = process.argv.includes('--kill') || process.argv.includes('-k');

function ok(msg) {
  console.log(`  ${CHECK}  ${msg}`);
}

function fail(msg) {
  console.log(`  ${CROSS}  ${msg}`);
}

async function main() {
  console.log('Stopping relay-server...\n');

  // 1. Check PM2 binary
  const installed = await PM2.isInstalled();
  if (!installed) {
    fail('PM2 is not installed — nothing to stop.');
    process.exit(0);
  }
  ok('PM2 binary found');

  // 2. Check PM2 daemon
  const daemonAlive = await PM2.ping();
  if (!daemonAlive) {
    fail('PM2 daemon is not running — nothing to stop.');
    process.exit(0);
  }
  ok('PM2 daemon is alive');

  // 3. Check if process exists
  const running = await PM2.isRunning(ROOT, PROC_NAME);
  if (!running) {
    ok(`"${PROC_NAME}" is already stopped.`);
    if (KILL_DAEMON) {
      await PM2.kill();
      ok('PM2 daemon killed.');
    }
    console.log('\nDone.');
    process.exit(0);
  }
  ok(`"${PROC_NAME}" is running — stopping...`);

  // 4. Stop it
  try {
    await PM2.stop(ROOT, ECO_FILE);
    ok(`"${PROC_NAME}" stopped.`);
  } catch (err) {
    fail(`Failed to stop "${PROC_NAME}": ${err.message}`);
    process.exit(1);
  }

  // 5. Optionally kill daemon
  if (KILL_DAEMON) {
    try {
      await PM2.kill();
      ok('PM2 daemon killed.');
    } catch (err) {
      fail(`Failed to kill PM2 daemon: ${err.message}`);
    }
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
