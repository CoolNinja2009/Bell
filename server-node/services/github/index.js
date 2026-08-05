'use strict';
/**
 * services/github/index.js — GitHub reachability and remote SHA queries.
 *
 * Uses `git ls-remote` to check if GitHub is reachable and to get the
 * latest commit SHA on the tracked branch. No fetch needed.
 */
const { exec } = require('child_process');
const { promisify } = require('util');
const execP = promisify(exec);

const TIMEOUT_MS = 15000;

/**
 * Execute git ls-remote and return trimmed stdout.
 */
async function lsRemote(cwd, remote, branch) {
  const { stdout } = await execP(`git ls-remote ${remote} refs/heads/${branch}`, {
    cwd,
    timeout: TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout.trim();
}

/**
 * Check whether GitHub (the remote) is reachable.
 * @param {string} cwd - working directory
 * @param {string} remote - remote name (e.g. 'origin')
 * @param {string} branch - branch name (e.g. 'main')
 * @returns {Promise<boolean>}
 */
async function isReachable(cwd, remote, branch) {
  try {
    const out = await lsRemote(cwd, remote, branch);
    return out.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the SHA of the latest commit on the remote branch.
 * Returns null if GitHub is unreachable.
 * @param {string} cwd
 * @param {string} remote
 * @param {string} branch
 * @returns {Promise<string|null>}
 */
async function getRemoteSha(cwd, remote, branch) {
  try {
    const out = await lsRemote(cwd, remote, branch);
    if (!out) return null;

    // ls-remote output: "<sha>\trefs/heads/main"
    const sha = out.split(/\s+/)[0];
    // Validate it looks like a SHA (40 hex chars)
    if (/^[0-9a-f]{40}$/i.test(sha)) {
      return sha;
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = { isReachable, getRemoteSha };
