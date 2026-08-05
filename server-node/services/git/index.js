'use strict';
/**
 * services/git/index.js — Git operations for the bootstrap.
 *
 * Every function takes `cwd` as the first argument.
 * Uses child_process.exec (shell) for cross-platform .cmd/.bat compatibility.
 * All functions throw on failure — callers must handle errors.
 */
const { exec } = require('child_process');
const { promisify } = require('util');
const execP = promisify(exec);

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Execute a git command and return trimmed stdout.
 * @param {string} cwd - working directory
 * @param {string} cmd - git command with args (e.g. 'rev-parse HEAD')
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<string>} trimmed stdout
 */
async function run(cwd, cmd, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { stdout } = await execP(`git ${cmd}`, {
    cwd,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return stdout.trim();
}

/**
 * Verify the directory is a git repository.
 * @param {string} cwd
 * @returns {Promise<boolean>}
 */
async function isRepo(cwd) {
  try {
    await run(cwd, 'rev-parse --git-dir', 5000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the SHA of HEAD.
 * @param {string} cwd
 * @returns {Promise<string>}
 */
async function getLocalSha(cwd) {
  return run(cwd, 'rev-parse HEAD', 10000);
}

/**
 * Get the remote URL for the given remote name.
 * @param {string} cwd
 * @param {string} remote - remote name (e.g. 'origin')
 * @returns {Promise<string>}
 */
async function getRemoteUrl(cwd, remote) {
  return run(cwd, `remote get-url ${remote}`, 10000);
}

/**
 * Set or update the remote URL.
 * @param {string} cwd
 * @param {string} remote - remote name
 * @param {string} url - remote URL
 */
async function setRemoteUrl(cwd, remote, url) {
  try {
    await run(cwd, `remote add ${remote} ${url}`, 10000);
  } catch {
    await run(cwd, `remote set-url ${remote} ${url}`, 10000);
  }
}

/**
 * Fetch from the given remote.
 * @param {string} cwd
 * @param {string} remote
 */
async function fetch(cwd, remote) {
  await run(cwd, `fetch ${remote}`, 60000);
}

/**
 * Hard reset to remote/branch. WARNING: destructive.
 * @param {string} cwd
 * @param {string} remote
 * @param {string} branch
 */
async function resetHard(cwd, remote, branch) {
  await run(cwd, `reset --hard ${remote}/${branch}`, 30000);
}

/**
 * Reset hard to a specific commit. Used for rollback.
 * @param {string} cwd
 * @param {string} commitSha
 */
async function resetToCommit(cwd, commitSha) {
  await run(cwd, `reset --hard ${commitSha}`, 30000);
}

/**
 * List files changed between two commits.
 * @param {string} cwd
 * @param {string} oldSha
 * @param {string} newSha
 * @returns {Promise<string[]>}
 */
async function diffNames(cwd, oldSha, newSha) {
  const out = await run(cwd, `diff --name-only ${oldSha} ${newSha}`, 30000);
  if (!out) return [];
  return out.split('\n').filter(Boolean);
}

/**
 * Check if any of the given filenames appear in the diff between two commits.
 * @param {string} cwd
 * @param {string} oldSha
 * @param {string} newSha
 * @param {string[]} patterns - filenames to look for
 * @returns {Promise<boolean>}
 */
async function diffContains(cwd, oldSha, newSha, patterns) {
  const files = await diffNames(cwd, oldSha, newSha);
  const patternSet = new Set(patterns);
  return files.some((f) => patternSet.has(f) || (f.startsWith('server-node/') && patternSet.has(f.replace('server-node/', ''))));
}

/**
 * Clean stale git lock files that can prevent operations after a crash.
 * @param {string} cwd
 */
function cleanLocks(cwd) {
  const fs = require('fs');
  const path = require('path');
  const locks = [
    path.join(cwd, '.git', 'index.lock'),
    path.join(cwd, '.git', 'shallow.lock'),
    path.join(cwd, '.git', 'HEAD.lock'),
  ];
  for (const lock of locks) {
    try {
      if (fs.existsSync(lock)) {
        fs.unlinkSync(lock);
      }
    } catch {
      // Best effort — if we can't delete, the next git command will fail with a clear error
    }
  }
}

module.exports = {
  isRepo,
  getLocalSha,
  getRemoteUrl,
  setRemoteUrl,
  fetch,
  resetHard,
  resetToCommit,
  diffNames,
  diffContains,
  cleanLocks,
};
