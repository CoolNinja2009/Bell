'use strict';
/**
 * bootstrap.js — Production-grade startup orchestrator for the Relay Controller Server.
 *
 * Responsibilities:
 *   1. Verify environment (Node.js, npm, Git, PM2, repository integrity)
 *   2. Check GitHub for updates
 *   3. Stop PM2, update repository, install deps, start PM2
 *   4. Health check the running server
 *   5. Rollback on health check failure
 *
 * This script EXITS after completing startup. Only PM2 and the server remain.
 */
const path = require('path');

// ── Internal modules ──────────────────────────────────────────────────
const config = require('./config');
const logger = require('./utils/logger');
const state = require('./utils/state');
const gitSvc = require('./services/git');
const githubSvc = require('./services/github');
const pm2Svc = require('./services/pm2');
const healthSvc = require('./services/health');
const depsSvc = require('./services/deps');

// ── Shortcuts ─────────────────────────────────────────────────────────
const ROOT = config.paths.root;
const STATE_FILE = config.paths.stateFile;
const BOOTSTRAP_LOG = config.paths.bootstrapLog;
const UPDATE_LOG = config.paths.updateLog;
const HEALTH_LOG = config.paths.healthLog;
const LOG_OPTS = { maxSize: config.logging.maxLogSizeBytes, maxFiles: config.logging.maxLogFiles };

// ── Display helpers ───────────────────────────────────────────────────



const CHECK = '\u2713';   // ✓
const CROSS = '\u2717';   // ✗

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';

function padRight(str, len) {
  return str + ' '.repeat(Math.max(0, len - visibleLength(str)));
}

function visibleLength(str) {
  // Strip ANSI escape sequences for length calculation
  return str.replace(/\x1b\[\d+(;\d+)?m/g, '').length;
}

/**
 * Print a check line: [✓] label    value
 */
function checkLine(ok, label, value) {
  const status = ok ? `[${CHECK}]` : `[${CROSS}]`;
  const line = `${status} ${padRight(label, 20)} ${value}`;
  console.log(line);
  logToFile(BOOTSTRAP_LOG, `CHECK ${ok ? 'OK' : 'FAIL'} ${label}: ${value}`);
}

/**
 * Print a banner header.
 */
function printBanner() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const version = `v${yyyy}.${mm}${dd}`;

  const lines = [
    '',
    '========================================================',
    `      Relay Controller Server ${version}`,
    '========================================================',
    '',
  ];
  for (const line of lines) {
    console.log(line);
  }
  logToFile(BOOTSTRAP_LOG, `Bootstrap started — ${version}`);
}

/**
 * Print a phase header.
 */
function phaseHeader(text) {
  console.log(`\n${text}`);
}

/**
 * Print final status.
 */
function printServerOnline() {
  const port = config.health.url.match(/:(\d+)/);
  const portStr = port ? port[1] : '8080';
  console.log(`\nServer online.`);
  console.log(`Dashboard: http://localhost:${portStr}`);
  console.log();
}

// ── Logging helper ────────────────────────────────────────────────────

function logToFile(filePath, message) {
  try {
    logger.log(filePath, message, LOG_OPTS);
  } catch {
    // Never let logging crash the bootstrap
  }
}

function logError(message) {
  logToFile(BOOTSTRAP_LOG, `[ERROR] ${message}`);
  console.error(`  ${CROSS} ${message}`);
}

// ── Time helpers ──────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoNow() {
  return new Date().toISOString();
}



// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Environment verification
// ═══════════════════════════════════════════════════════════════════════

async function verifyEnvironment() {
  const results = [];
  let allOk = true;

  // --- Node.js ---
  try {
    const v = process.version;
    results.push({ ok: true, label: 'Node.js', value: v });
  } catch {
    results.push({ ok: false, label: 'Node.js', value: 'NOT FOUND' });
    allOk = false;
  }

  // --- npm ---
  try {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const { stdout } = await promisify(exec)(`${config.commands.npm} --version`, { timeout: 10000, windowsHide: true });
    results.push({ ok: true, label: 'npm', value: `v${stdout.trim()}` });
  } catch {
    results.push({ ok: false, label: 'npm', value: 'NOT FOUND' });
    allOk = false;
  }

  // --- Git ---
  try {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const { stdout } = await promisify(exec)(`${config.commands.git} --version`, { timeout: 10000, windowsHide: true });
    const m = stdout.trim().match(/(\d+\.\d+\.\d+)/);
    results.push({ ok: true, label: 'Git', value: m ? m[0] : stdout.trim() });
  } catch {
    results.push({ ok: false, label: 'Git', value: 'NOT FOUND' });
    allOk = false;
  }

  // --- Repository ---
  const isRepo = await gitSvc.isRepo(ROOT);
  results.push({ ok: isRepo, label: 'Repository', value: isRepo ? 'OK' : 'NOT A GIT REPO' });
  if (isRepo) {
    // Clean stale locks
    await gitSvc.cleanLocks(ROOT);

    // Verify remote
    try {
      const url = await gitSvc.getRemoteUrl(ROOT, config.repo.remote);
      results.push({ ok: true, label: 'Git Remote', value: url });
    } catch {
      // Try to add it
      try {
        await gitSvc.setRemoteUrl(ROOT, config.repo.remote, config.repo.url);
        results.push({ ok: true, label: 'Git Remote', value: 'Added' });
      } catch (e) {
        results.push({ ok: false, label: 'Git Remote', value: `FAILED: ${e.message}` });
        allOk = false;
      }
    }
  } else {
    allOk = false;
  }

  // --- ecosystem.config.js ---
  const fs = require('fs');
  const ecoPath = path.join(ROOT, config.required.ecosystemConfig);
  const hasEco = fs.existsSync(ecoPath);
  results.push({ ok: hasEco, label: 'ecosystem.config.js', value: hasEco ? 'OK' : 'MISSING' });
  if (!hasEco) allOk = false;

  // --- package.json ---
  const pkgPath = path.join(ROOT, config.required.packageJson);
  const hasPkg = fs.existsSync(pkgPath);
  results.push({ ok: hasPkg, label: 'package.json', value: hasPkg ? 'OK' : 'MISSING' });
  if (!hasPkg) allOk = false;

  // --- PM2 ---
  let pm2Version = null;
  try {
    pm2Version = await pm2Svc.getVersion();
  } catch { /* handled below */ }

  if (!pm2Version) {
    // PM2 not installed — try auto-install
    results.push({ ok: false, label: 'PM2', value: 'Installing...' });
    logToFile(BOOTSTRAP_LOG, 'PM2 not found — attempting auto-install');

    const installed = await pm2Svc.install(ROOT);
    if (installed) {
      pm2Version = await pm2Svc.getVersion();
      results.push({ ok: true, label: 'PM2', value: pm2Version || 'installed' });
      logToFile(BOOTSTRAP_LOG, `PM2 installed: ${pm2Version}`);
    } else {
      results.push({ ok: false, label: 'PM2', value: 'INSTALL FAILED' });
      allOk = false;
    }
  } else {
    results.push({ ok: true, label: 'PM2', value: pm2Version });
  }

  // --- npm dependencies ---
  if (!depsSvc.nodeModulesExist(ROOT)) {
    results.push({ ok: false, label: 'Dependencies', value: 'Installing...' });
    logToFile(BOOTSTRAP_LOG, 'node_modules not found — installing dependencies');

    const depResult = await depsSvc.install(ROOT);
    if (depResult.ok) {
      results.push({ ok: true, label: 'Dependencies', value: depResult.command });
      logToFile(BOOTSTRAP_LOG, `Dependencies installed via ${depResult.command}`);
    } else {
      results.push({ ok: false, label: 'Dependencies', value: `FAILED: ${depResult.error}` });
      logToFile(BOOTSTRAP_LOG, `Dependency install failed: ${depResult.error}`);
      allOk = false;
    }
  } else {
    results.push({ ok: true, label: 'Dependencies', value: 'OK' });
  }


  // Output results
  for (const r of results) {
    checkLine(r.ok, r.label, r.value);
  }

  // If critical failures, print help
  if (!allOk) {
    console.log('');
    for (const r of results) {
      if (!r.ok) {
        switch (r.label) {
          case 'Node.js':
            console.log(`  Install from https://nodejs.org/ (v18+)`);
            break;
          case 'npm':
            console.log(`  Reinstall Node.js from https://nodejs.org/`);
            break;
          case 'Git':
            console.log(`  Install from https://git-scm.com/`);
            break;
          case 'Repository':
            console.log(`  Clone: git clone ${config.repo.url}`);
            break;
          case 'PM2':
            console.log(`  Run as Administrator: npm install -g pm2`);
            break;
          case 'ecosystem.config.js':
            console.log(`  File missing from repository. Re-clone or restore.`);
            break;
          case 'package.json':
            console.log(`  File missing from repository. Re-clone or restore.`);
            break;
        }
      }
    }
  }

  return { allOk, pm2Installed: !!pm2Version };
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: GitHub check
// ═══════════════════════════════════════════════════════════════════════

async function checkGitHub() {
  const { remote, branch } = config.repo;

  // GitHub reachable?
  const reachable = await githubSvc.isReachable(ROOT, remote, branch);
  checkLine(reachable, 'GitHub', reachable ? 'Reachable' : 'UNREACHABLE');

  if (!reachable) {
    logToFile(BOOTSTRAP_LOG, 'GitHub unreachable — will start with current version');
    return null;
  }

  // Remote SHA
  const remoteSha = await githubSvc.getRemoteSha(ROOT, remote, branch);
  checkLine(!!remoteSha, 'Remote Commit', remoteSha ? remoteSha.slice(0, 7) : 'ERROR');

  if (!remoteSha) {
    logToFile(BOOTSTRAP_LOG, 'Failed to get remote SHA — will start with current version');
    return null;
  }

  return remoteSha;
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Update (if needed)
// ═══════════════════════════════════════════════════════════════════════

async function performUpdate(localSha, remoteSha) {
  const { remote, branch, fetchRetries, fetchRetryDelayMs } = config.repo;

  phaseHeader('Updating repository...');

  // Remember previous commit for rollback
  const prevCommit = localSha;

  // Step 1: Stop PM2 before touching repository files
  logToFile(UPDATE_LOG, `Update: ${localSha.slice(0, 7)} -> ${remoteSha.slice(0, 7)}`);
  logToFile(BOOTSTRAP_LOG, 'Stopping PM2 before repository update...');
  console.log('  Stopping server...');
  await pm2Svc.stop(ROOT, config.pm2.ecosystemFile);

  // Step 1b: Back up runtime data before git reset destroys it
  console.log('  Backing up runtime data...');
  const RUNTIME_FILES = ['profiles.json', 'settings.json', 'calendar.json'];
  const runtimeBackups = {};
  let backupDir = null;
  try {
    const fs = require('fs');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    backupDir = path.join(ROOT, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    for (const f of RUNTIME_FILES) {
      const src = path.join(ROOT, f);
      if (fs.existsSync(src)) {
        runtimeBackups[f] = fs.readFileSync(src, 'utf8');
        const dest = path.join(backupDir, `${path.basename(f, '.json')}_${ts}.json`);
        fs.writeFileSync(dest, runtimeBackups[f], 'utf8');
      }
    }
    const count = Object.keys(runtimeBackups).length;
    logToFile(UPDATE_LOG, `Backed up ${count} runtime file(s) to ${backupDir}`);
    console.log(`  Backed up ${count} runtime file(s) to backups/`);
  } catch (e) {
    logError(`Runtime data backup failed: ${e.message}`);
    // Non-fatal — continue with update, data may be lost
    console.log(`  Backup failed (continuing): ${e.message}`);
  }

  // Step 2: Check if deps changed BEFORE resetting
  let depsChanged = false;
  try {
    depsChanged = await gitSvc.diffContains(ROOT, localSha, remoteSha, [
      'package.json',
      'package-lock.json',
      'server-node/package.json',
      'server-node/package-lock.json',
    ]);
  } catch {
    // If we can't diff (shallow clone, etc.), assume deps changed
    depsChanged = true;
  }

  // Step 3: Fetch with retries
  console.log('  Fetching updates...');
  let fetched = false;
  for (let i = 0; i < fetchRetries; i++) {
    try {
      await gitSvc.fetch(ROOT, remote);
      fetched = true;
      break;
    } catch (e) {
      logToFile(UPDATE_LOG, `Fetch attempt ${i + 1}/${fetchRetries} failed: ${e.message}`);
      if (i < fetchRetries - 1) {
        console.log(`  Fetch retry ${i + 1}/${fetchRetries}...`);
        await sleep(fetchRetryDelayMs);
      }
    }
  }

  if (!fetched) {
    logError('Fetch failed after retries — starting with current version.');
    try { await ensurePm2Running(); } catch (e) { logError(`PM2 start failed: ${e.message}`); }
    return { ok: false, rollback: false };
  }

  // Step 4: Reset to remote
  console.log('  Applying updates...');
  try {
    await gitSvc.resetHard(ROOT, remote, branch);
    logToFile(UPDATE_LOG, `Reset to ${remote}/${branch} at ${remoteSha.slice(0, 7)}`);
  } catch (e) {
    logError(`Reset failed: ${e.message}`);
    try { await ensurePm2Running(); } catch (e2) { logError(`PM2 start failed: ${e2.message}`); }
    return { ok: false, rollback: false };
  }

  // Step 4b: Restore runtime data backed up before reset
  if (Object.keys(runtimeBackups).length > 0) {
    try {
      const fs = require('fs');
      for (const [f, content] of Object.entries(runtimeBackups)) {
        const dest = path.join(ROOT, f);
        fs.writeFileSync(dest, content, 'utf8');
      }
      logToFile(UPDATE_LOG, `Restored ${Object.keys(runtimeBackups).length} runtime file(s)`);
      console.log(`  Restored ${Object.keys(runtimeBackups).length} runtime file(s)`);
    } catch (e) {
      logError(`Runtime data restore failed: ${e.message}`);
      console.log(`  ${CROSS} Runtime data restore failed — backups saved to backups/`);
    }
  }

  // Step 5: Install dependencies if changed
  if (depsChanged) {
    console.log('  Dependencies changed — installing...');
    logToFile(UPDATE_LOG, 'Dependencies changed — running npm ci');
    const result = await depsSvc.install(ROOT);
    if (!result.ok) {
      logError(`Dependency install failed: ${result.error}`);
      // Attempt rollback
      return { ok: false, rollback: true, prevCommit };
    }
    logToFile(UPDATE_LOG, `Dependencies installed via ${result.command}`);
  } else {
    // Also check if node_modules is simply missing
    if (!depsSvc.nodeModulesExist(ROOT)) {
      console.log('  node_modules missing — installing...');
      const result = await depsSvc.install(ROOT);
      if (!result.ok) {
        logError(`Dependency install failed: ${result.error}`);
        return { ok: false, rollback: true, prevCommit };
      }
    } else {
      console.log('  Dependencies unchanged — skipping install.');
    }
  }

  // Step 6: Start/Restart PM2
  console.log('  Starting server...');
  try {
    await ensurePm2Running();
  } catch (e) {
    logError(`PM2 start failed after update: ${e.message}`);
    return { ok: false, rollback: true, prevCommit };
  }

  // Step 7: Health check
  console.log('  Health check........');
  process.stdout.write('  ');
  const healthy = await healthSvc.check(
    config.health.url,
    config.health.timeoutMs,
    config.health.retries,
    config.health.retryDelayMs,
    (dot) => process.stdout.write(dot)
  );
  console.log(healthy ? ` ${PASS}` : ` ${FAIL}`);

  if (!healthy) {
    logToFile(HEALTH_LOG, `Health check FAILED after update to ${remoteSha.slice(0, 7)}`);
    return { ok: false, rollback: true, prevCommit };
  }

  logToFile(HEALTH_LOG, `Health check PASS after update to ${remoteSha.slice(0, 7)}`);
  return { ok: true, rollback: false };
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Rollback
// ═══════════════════════════════════════════════════════════════════════

async function performRollback(prevCommit) {
  phaseHeader('Rolling back...');
  logToFile(BOOTSTRAP_LOG, `Rolling back to ${prevCommit.slice(0, 7)}`);
  logToFile(UPDATE_LOG, `Rollback to ${prevCommit.slice(0, 7)}`);

  console.log(`  Rolling back to ${prevCommit.slice(0, 7)}...`);

  // Stop PM2
  console.log('  Stopping server...');
  await pm2Svc.stop(ROOT, config.pm2.ecosystemFile);

  // Back up runtime data before reset
  console.log('  Backing up runtime data...');
  const RUNTIME_FILES = ['profiles.json', 'settings.json', 'calendar.json'];
  const rbBackups = {};
  try {
    const fs = require('fs');
    for (const f of RUNTIME_FILES) {
      const src = path.join(ROOT, f);
      if (fs.existsSync(src)) {
        rbBackups[f] = fs.readFileSync(src, 'utf8');
      }
    }
  } catch (e) {
    logError(`Rollback backup failed: ${e.message}`);
  }

  // Reset to previous commit
  try {
    await gitSvc.resetToCommit(ROOT, prevCommit);
    logToFile(UPDATE_LOG, `Reset to ${prevCommit.slice(0, 7)}`);
  } catch (e) {
    logError(`Rollback reset failed: ${e.message}`);
    logToFile(BOOTSTRAP_LOG, 'CRITICAL: Rollback failed — manual intervention required');
    return false;
  }

  // Restore runtime data after reset
  if (Object.keys(rbBackups).length > 0) {
    try {
      const fs = require('fs');
      for (const [f, content] of Object.entries(rbBackups)) {
        const dest = path.join(ROOT, f);
        fs.writeFileSync(dest, content, 'utf8');
      }
      logToFile(UPDATE_LOG, `Rollback: restored ${Object.keys(rbBackups).length} runtime file(s)`);
      console.log(`  Restored ${Object.keys(rbBackups).length} runtime file(s)`);
    } catch (e) {
      logError(`Rollback restore failed: ${e.message}`);
    }
  }

  // Install deps (may have changed due to rollback)
  console.log('  Installing dependencies...');
  const result = await depsSvc.install(ROOT);
  if (!result.ok) {
    logError(`Rollback dependency install failed: ${result.error}`);
    logToFile(BOOTSTRAP_LOG, 'CRITICAL: Rollback dependency install failed');
    return false;
  }

  // Start PM2
  console.log('  Starting server...');
  try {
    await ensurePm2Running();
  } catch (e) {
    logError(`PM2 start failed during rollback: ${e.message}`);
    logToFile(BOOTSTRAP_LOG, 'CRITICAL: PM2 start failed during rollback');
    return false;
  }

  // Health check
  console.log('  Health check........');
  process.stdout.write('  ');
  const healthy = await healthSvc.check(
    config.health.url,
    config.health.timeoutMs,
    config.health.retries,
    config.health.retryDelayMs,
    (dot) => process.stdout.write(dot)
  );
  console.log(healthy ? ` ${PASS}` : ` ${FAIL}`);

  if (healthy) {
    logToFile(HEALTH_LOG, `Health check PASS after rollback to ${prevCommit.slice(0, 7)}`);
    logToFile(BOOTSTRAP_LOG, 'Rollback successful');
    return true;
  }

  logToFile(HEALTH_LOG, `Health check FAILED after rollback to ${prevCommit.slice(0, 7)}`);
  logToFile(BOOTSTRAP_LOG, 'CRITICAL: Health check failed even after rollback');
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// PM2 lifecycle helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Ensure PM2 daemon is alive and the server process is running.
 */
async function ensurePm2Running() {
  // Check PM2 daemon
  const daemonAlive = await pm2Svc.ping();
  if (!daemonAlive) {
    logToFile(BOOTSTRAP_LOG, 'PM2 daemon not responding — restarting daemon');
    await pm2Svc.kill();
    // Small delay for cleanup
    await sleep(1000);
  }

  // Check if process is already running
  const running = await pm2Svc.isRunning(ROOT, config.pm2.processName);

  if (running) {
    logToFile(BOOTSTRAP_LOG, `Restarting ${config.pm2.processName} via PM2`);
  } else {
    logToFile(BOOTSTRAP_LOG, `Starting ${config.pm2.processName} via PM2`);
  }

  try {
    if (running) {
      await pm2Svc.restart(ROOT, config.pm2.ecosystemFile);
    } else {
      await pm2Svc.start(ROOT, config.pm2.ecosystemFile);
    }
  } catch (e) {
    // pm2 start/restart can fail if daemon is corrupted — try one more time after kill
    logToFile(BOOTSTRAP_LOG, `PM2 ${running ? 'restart' : 'start'} failed: ${e.message} — retrying after daemon kill`);
    await pm2Svc.kill();
    await sleep(2000);
    if (running) {
      await pm2Svc.restart(ROOT, config.pm2.ecosystemFile);
    } else {
      await pm2Svc.start(ROOT, config.pm2.ecosystemFile);
    }
  }

  // Give the process a moment to bind its port
  await sleep(config.pm2.startupGraceMs);
}

// ═══════════════════════════════════════════════════════════════════════
// State persistence
// ═══════════════════════════════════════════════════════════════════════

function saveState(currentCommit, previousCommit, status) {
  // Preserve lastUpdate from prior state; only overwrite when commit actually changed
  const oldState = state.load(STATE_FILE);
  const commitChanged = !!(currentCommit && currentCommit !== oldState.currentCommit);

  const data = {
    currentCommit: currentCommit || null,
    previousCommit: previousCommit || null,
    lastStartup: isoNow(),
    lastUpdate: commitChanged ? isoNow() : oldState.lastUpdate,
    status,
  };
  try {
    state.save(STATE_FILE, data);
  } catch (e) {
    logToFile(BOOTSTRAP_LOG, `Failed to save state: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  // --- Banner ---
  printBanner();

  // --- Phase 1: Verify environment ---
  const env = await verifyEnvironment();
  if (!env.allOk) {
    console.log(`\n${CROSS} Environment check failed. Fix the issues above and re-run.`);
    logToFile(BOOTSTRAP_LOG, 'Bootstrap FAILED — environment check failed');
    process.exit(1);
  }

  // --- Phase 2: Local commit ---
  let localSha;
  try {
    localSha = await gitSvc.getLocalSha(ROOT);
    checkLine(true, 'Local Commit', localSha.slice(0, 7));
  } catch (e) {
    checkLine(false, 'Local Commit', `ERROR: ${e.message}`);
    logToFile(BOOTSTRAP_LOG, 'Failed to get local SHA');
    process.exit(1);
  }

  // Load previous state
  const prevState = state.load(STATE_FILE);

  // --- Phase 3: Check GitHub ---
  const remoteSha = await checkGitHub();

  // --- Phase 4: Decide action ---
  let finalSha = localSha;
  let finalStatus = 'unknown';

  if (!remoteSha) {
    // GitHub unreachable — start with current version
    checkLine(true, 'Update Status', 'GitHub unreachable — using current version');
    try { await ensurePm2Running(); } catch (e) {
      logError(`PM2 start failed: ${e.message}`);
      process.exit(1);
    }
    finalStatus = 'github_unreachable';
  } else if (remoteSha === localSha) {
    // Already up to date
    checkLine(true, 'Update Available', 'No (up to date)');
    try { await ensurePm2Running(); } catch (e) {
      logError(`PM2 start failed: ${e.message}`);
      process.exit(1);
    }
    finalStatus = 'up_to_date';
  } else {
    // Update needed
    checkLine(true, 'Update Available', `Yes (${localSha.slice(0, 7)} → ${remoteSha.slice(0, 7)})`);

    const updateResult = await performUpdate(localSha, remoteSha);

    if (updateResult.ok) {
      finalSha = remoteSha;
      finalStatus = 'updated';
    } else if (updateResult.rollback) {
      const rollbackOk = await performRollback(updateResult.prevCommit);
      if (rollbackOk) {
        finalSha = updateResult.prevCommit;
        finalStatus = 'rolled_back';
      } else {
        checkLine(false, 'Rollback', 'FAILED — manual intervention required');
        saveState(updateResult.prevCommit, localSha, 'rollback_failed');
        logToFile(BOOTSTRAP_LOG, 'CRITICAL: Rollback failed. Server may be in a bad state.');
        process.exit(1);
      }
    } else {
      finalStatus = 'update_failed_no_rollback';
    }
  }

  // --- Phase 5: Final health check (for non-update paths) ---
  if (finalStatus === 'up_to_date' || finalStatus === 'github_unreachable' || finalStatus === 'rolled_back' || finalStatus === 'update_failed_no_rollback') {
    // Health check for paths that didn't already run one inside performUpdate/performRollback
    // (up_to_date, github_unreachable, update_failed_no_rollback) or as a double-check (rolled_back)
    console.log('  Health check........');
    process.stdout.write('  ');
    const healthy = await healthSvc.check(
      config.health.url,
      config.health.timeoutMs,
      config.health.retries,
      config.health.retryDelayMs,
      (dot) => process.stdout.write(dot)
    );
    console.log(healthy ? ` ${PASS}` : ` ${FAIL}`);

    if (!healthy) {
      logToFile(HEALTH_LOG, 'Health check FAILED');
      saveState(finalSha, prevState.currentCommit, 'health_check_failed');
      console.log(`\n${CROSS} Health check failed. Check logs for details.`);
      console.log('  pm2 logs relay-server');
      process.exit(1);
    }

    logToFile(HEALTH_LOG, 'Health check PASS');
  }

  // --- Save state ---
  saveState(finalSha, prevState.currentCommit, finalStatus);

  // --- Done ---
  printServerOnline();
  logToFile(BOOTSTRAP_LOG, `Bootstrap complete — status: ${finalStatus}`);
}

// ── Entry point ───────────────────────────────────────────────────────

main().then((code) => {
  if (typeof code === 'number') process.exit(code);
}).catch((err) => {
  const msg = err && err.stack ? err.stack : String(err);
  console.error(`\n${CROSS} Unexpected error:`, msg);
  logToFile(BOOTSTRAP_LOG, `UNHANDLED ERROR: ${msg}`);
  process.exit(1);
});
