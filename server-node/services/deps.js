'use strict';
/**
 * services/deps.js — npm dependency management.
 *
 * Installs dependencies using npm ci (strict, from lockfile) with
 * fallback to npm install.
 */
const { exec } = require('child_process');
const { promisify } = require('util');
const execP = promisify(exec);
const path = require('path');
const fs = require('fs');

/**
 * Run an npm command and return trimmed stdout.
 */
async function run(cwd, cmd, timeoutMs = 120000) {
  const { stdout } = await execP(`npm ${cmd}`, {
    cwd,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return stdout.trim();
}

/**
 * Run npm ci, falling back to npm install on failure.
 * @param {string} cwd - working directory
 * @returns {Promise<{ ok: boolean, command: string, error?: string }>}
 */
async function install(cwd) {
  // Prefer npm ci (strict, from lockfile, faster)
  try {
    await run(cwd, 'ci');
    return { ok: true, command: 'npm ci' };
  } catch {
    // npm ci fails if node_modules exists but is stale — clean it
    try {
      const nodeModules = path.join(cwd, 'node_modules');
      if (fs.existsSync(nodeModules)) {
        fs.rmSync(nodeModules, { recursive: true, force: true });
      }
    } catch {
      // Best effort
    }

    // Fallback to npm install
    try {
      await run(cwd, 'install');
      return { ok: true, command: 'npm install' };
    } catch {
      // Last resort: clear cache and retry
      try {
        await run(cwd, 'cache clean --force', 30000);
      } catch {
        // Best effort
      }

      try {
        await run(cwd, 'install');
        return { ok: true, command: 'npm install (after cache clear)' };
      } catch (finalErr) {
        return {
          ok: false,
          command: 'npm install',
          error: finalErr.message || String(finalErr),
        };
      }
    }
  }
}

/**
 * Check if node_modules exists.
 * @param {string} cwd
 * @returns {boolean}
 */
function nodeModulesExist(cwd) {
  return fs.existsSync(path.join(cwd, 'node_modules'));
}

module.exports = { install, nodeModulesExist };
