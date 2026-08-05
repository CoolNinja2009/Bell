'use strict';
/**
 * services/pm2/index.js — PM2 lifecycle management.
 *
 * Handles: install, ping, start, restart, stop, and status checks.
 * Uses child_process.exec (shell) for cross-platform .cmd compatibility.
 * Installs PM2 globally if missing.
 */
const { exec } = require('child_process');
const { promisify } = require('util');
const execP = promisify(exec);

const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Run a command via shell and return trimmed stdout.
 * @param {string} cmd - full command string (e.g. 'pm2 list')
 * @param {string} cwd
 * @param {number} [timeoutMs=60000]
 * @returns {Promise<string>} trimmed stdout
 */
async function run(cmd, cwd, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { stdout } = await execP(cmd, {
    cwd,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return stdout.trim();
}

/**
 * Check if PM2 is installed (the binary exists on PATH).
 * @returns {Promise<boolean>}
 */
async function isInstalled() {
  try {
    await run('pm2 --version', process.cwd(), 5000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the installed PM2 version string.
 * @returns {Promise<string|null>}
 */
async function getVersion() {
  try {
    const out = await run('pm2 --version', process.cwd(), 10000);
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Install PM2 globally via npm.
 * @param {string} cwd - working directory (not critical for global install)
 * @returns {Promise<boolean>} true if installation succeeded
 */
async function install(cwd) {
  try {
    await run('npm install -g pm2', cwd, 120000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ping the PM2 daemon to check if it's alive.
 * @returns {Promise<boolean>}
 */
async function ping() {
  try {
    await run('pm2 ping', process.cwd(), 5000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill the PM2 daemon (clean up zombie state).
 */
async function kill() {
  try {
    await run('pm2 kill', process.cwd(), 10000);
  } catch {
    // Daemon might already be dead — that's fine
  }
}

/**
 * Resurrect previously saved PM2 processes.
 */
async function resurrect() {
  try {
    await run('pm2 resurrect', process.cwd(), 10000);
  } catch {
    // No saved processes — that's fine
  }
}

/**
 * Get the list of running PM2 processes as a raw string.
 * @param {string} cwd
 * @returns {Promise<string>}
 */
async function list(cwd) {
  try {
    return await run('pm2 list', cwd, 10000);
  } catch {
    return '';
  }
}

/**
 * Check if a named process is currently running.
 * @param {string} cwd
 * @param {string} processName
 * @returns {Promise<boolean>}
 */
async function isRunning(cwd, processName) {
  try {
    const out = await list(cwd);
    const lines = out.split('\n');
    for (const line of lines) {
      if (line.includes(processName) && line.includes('online')) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Start a PM2 process using an ecosystem config file.
 * @param {string} cwd
 * @param {string} ecosystemFile - path to ecosystem.config.js (relative to cwd)
 */
async function start(cwd, ecosystemFile) {
  await run(`pm2 start ${ecosystemFile}`, cwd, 30000);
}

/**
 * Restart a PM2 process using an ecosystem config file.
 * @param {string} cwd
 * @param {string} ecosystemFile
 */
async function restart(cwd, ecosystemFile) {
  await run(`pm2 restart ${ecosystemFile} --update-env`, cwd, 30000);
}

/**
 * Stop a PM2 process.
 * @param {string} cwd
 * @param {string} ecosystemFile
 */
async function stop(cwd, ecosystemFile) {
  try {
    await run(`pm2 stop ${ecosystemFile}`, cwd, 15000);
  } catch {
    // Process might not be running — that's fine
  }
}

module.exports = {
  isInstalled,
  getVersion,
  install,
  ping,
  kill,
  resurrect,
  list,
  isRunning,
  start,
  restart,
  stop,
};
