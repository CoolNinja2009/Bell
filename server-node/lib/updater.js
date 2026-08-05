'use strict';
/**
 * lib/updater.js — Self-updating server module.
 * ─────────────────────────────────────────────────────────────────────
 *
 * Flow:
 *   check() → fetch + reset → npm ci (if needed) → restart PM2 →
 *   health check → success | rollback
 *
 * OTA safety: blocks restart while firmware downloads are in progress.
 *
 * All async. No global state. Production error handling.
 */
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const config = require('./config');

const execFileP = promisify(execFile);

// ── State persistence ────────────────────────────────────────────────

function loadState() {
  try {
    const raw = fs.readFileSync(config.updater.stateFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      currentCommit: '',
      previousCommit: '',
      lastCheck: null,
      lastUpdate: null,
      status: 'unknown',
    };
  }
}

function saveState(state) {
  fs.writeFileSync(config.updater.stateFile, JSON.stringify(state, null, 2));
}

// ── Logging ──────────────────────────────────────────────────────────

function updaterLog(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [Updater] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(config.updater.logFile, line + '\n');
  } catch { /* log file not critical */ }
}

// ── Git helpers ──────────────────────────────────────────────────────

async function git(args, cwd) {
  const dir = cwd || path.join(__dirname, '..');
  try {
    const { stdout } = await execFileP('git', args, { cwd: dir, timeout: 30000 });
    return (stdout || '').trim();
  } catch (err) {
    throw new Error(`git ${args[0]} failed: ${err.message}`);
  }
}

/** Get the SHA of the latest commit on the remote branch — no fetch needed. */
async function getRemoteCommitSha() {
  const ref = `refs/heads/${config.updater.branch}`;
  const line = await git(['ls-remote', config.updater.remote, ref]);
  // Output format: "<sha>\trefs/heads/main"
  const sha = line.split(/\s+/)[0];
  if (!sha || sha.length < 40) throw new Error(`Bad ls-remote output: "${line}"`);
  return sha;
}

/** Get the current HEAD SHA. */
async function getCurrentSha() {
  return git(['rev-parse', 'HEAD']);
}

// ── Dependency detection ─────────────────────────────────────────────

/** Returns true if package.json or package-lock.json changed between oldSha and newSha. */
async function depsChanged(oldSha, newSha) {
  try {
    const diff = await git(['diff', '--name-only', oldSha, newSha]);
    const files = diff.split('\n').filter(Boolean);
    return files.some(f => f === 'package.json' || f === 'package-lock.json' ||
                           f === 'server-node/package.json' || f === 'server-node/package-lock.json');
  } catch {
    // If we can't diff (shallow clone, etc.), assume deps changed — safe.
    updaterLog('warning: cannot diff — assuming deps changed');
    return true;
  }
}

// ── npm ci ───────────────────────────────────────────────────────────

async function installDependencies() {
  updaterLog('Installing dependencies (npm ci)...');
  await execFileP('npm', ['ci'], { cwd: path.join(__dirname, '..'), timeout: 120000 });
  updaterLog('Dependencies installed.');
}

// ── PM2 integration ──────────────────────────────────────────────────

async function restartPM2() {
  updaterLog('Restarting server via PM2...');
  // "restart" is idempotent — starts if stopped, restarts if running.
  await execFileP('pm2', ['restart', 'ecosystem.config.js', '--update-env'], {
    timeout: 30000,
  });
}

// ── Health check ─────────────────────────────────────────────────────

async function healthCheck(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  // Dynamic import — fetch is ESM-only from Node 18+ but available globally.
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(config.updater.healthUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const body = await resp.json();
        if (body && body.status === 'ok') return true;
      }
    } catch {
      // Server hasn't started yet — keep waiting.
    }
    await sleep(1000);
  }
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Active download tracking ─────────────────────────────────────────
// Set by server.js. The updater reads this before restarting.

let activeDownloads = 0;

/** Call from server.js when a firmware download begins. */
function downloadStart() { activeDownloads++; }

/** Call from server.js when a firmware download ends. */
function downloadEnd() { activeDownloads = Math.max(0, activeDownloads - 1); }

/** Returns true if OTA downloads are currently in progress. */
function hasActiveDownloads() { return activeDownloads > 0; }

// ── Wait for downloads to drain ──────────────────────────────────────

async function waitForDownloads() {
  if (!hasActiveDownloads()) return;
  updaterLog(`${activeDownloads} active OTA download(s) — waiting...`);
  const deadline = Date.now() + config.updater.downloadDrainTimeoutMs;
  while (hasActiveDownloads() && Date.now() < deadline) {
    updaterLog(`Still ${activeDownloads} active download(s) — retrying in ${config.updater.downloadDrainRetryMs / 1000}s...`);
    await sleep(config.updater.downloadDrainRetryMs);
  }
  if (hasActiveDownloads()) {
    updaterLog(`Timed out waiting for downloads to drain (${activeDownloads} still active) — proceeding anyway`);
  }
}

// ── Rollback ─────────────────────────────────────────────────────────

async function rollback(previousCommit) {
  updaterLog(`ROLLBACK: resetting to ${previousCommit.substring(0, 7)}`);
  await git(['reset', '--hard', previousCommit]);
  await installDependencies();
  await restartPM2();

  const ok = await healthCheck(config.updater.restartTimeoutMs);
  if (ok) {
    const state = loadState();
    state.previousCommit = state.currentCommit;
    state.currentCommit = previousCommit;
    state.lastUpdate = new Date().toISOString();
    state.status = 'rolled_back';
    saveState(state);
    updaterLog('Rollback successful — server is healthy on previous commit.');
  } else {
    updaterLog('ROLLBACK FAILED — server is unhealthy even after rollback. Manual intervention required!');
    const state = loadState();
    state.status = 'rollback_failed';
    saveState(state);
  }
}

// ── Main update flow ─────────────────────────────────────────────────

/**
 * Check for updates. If a newer commit exists on the remote branch,
 * fetch, reset, rebuild deps if needed, restart, and health-check.
 *
 * Returns: { updated: boolean, from?: string, to?: string }
 */
async function checkForUpdates() {
  const state = loadState();
  state.lastCheck = new Date().toISOString();
  saveState(state);

  updaterLog('Checking GitHub...');

  let remoteSha;
  try {
    remoteSha = await getRemoteCommitSha();
  } catch (err) {
    updaterLog(`Failed to query remote: ${err.message}`);
    state.status = 'check_failed';
    saveState(state);
    return { updated: false };
  }

  const currentSha = await getCurrentSha();

  if (remoteSha === currentSha) {
    updaterLog('Already up-to-date.');
    return { updated: false };
  }

  updaterLog(`New commit detected: ${currentSha.substring(0, 7)} → ${remoteSha.substring(0, 7)}`);

  // ── Wait for active OTA downloads ──
  await waitForDownloads();

  // ── Update repository ──
  updaterLog('Updating repository...');
  try {
    await git(['fetch', config.updater.remote]);
  } catch (err) {
    updaterLog(`Fetch failed: ${err.message}`);
    return { updated: false };
  }

  const depsNeedInstall = await depsChanged(currentSha, remoteSha);

  await git(['reset', '--hard', `${config.updater.remote}/${config.updater.branch}`]);

  if (depsNeedInstall) {
    await installDependencies();
  }

  // ── Persist pre-restart state ──
  state.previousCommit = currentSha;
  state.currentCommit = remoteSha;
  state.lastUpdate = new Date().toISOString();
  state.status = 'applying';
  saveState(state);

  // ── Restart ──
  updaterLog('Restarting server...');
  await restartPM2();

  // ── Health check ──
  const ok = await healthCheck(config.updater.restartTimeoutMs);
  if (ok) {
    state.status = 'success';
    saveState(state);
    updaterLog('Health check passed. Update complete.');
    return { updated: true, from: currentSha, to: remoteSha };
  }

  // ── Health check failed — rollback ──
  updaterLog('Health check FAILED — rolling back...');
  state.status = 'rolling_back';
  saveState(state);
  await rollback(currentSha);

  return { updated: false, from: currentSha, to: remoteSha, rolledBack: true };
}

// ── Exports ──────────────────────────────────────────────────────────

module.exports = {
  checkForUpdates,
  loadState,
  downloadStart,
  downloadEnd,
  hasActiveDownloads,
  updaterLog,
};
