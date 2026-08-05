'use strict';
/**
 * lib/scheduler.js — Simple in-process job scheduler.
 * ─────────────────────────────────────────────────────────────────────
 * Runs named async jobs at fixed intervals. Designed for long-running
 * background tasks like the updater's hourly check.
 *
 * Adding a new scheduled job in the future:
 *   scheduler.addJob('cleanup', 24 * 3600 * 1000, cleanupFn);
 */
const { updaterLog } = require('./updater');

class Scheduler {
  constructor() {
    this._jobs = new Map();   // name → { intervalMs, fn, timer, running }
  }

  /**
   * Register a job that runs every `intervalMs` milliseconds.
   * The first run happens after `intervalMs` (not immediately).
   * `fn` must be an async function that takes no arguments.
   * If `fn` is still running when the next interval fires, the next
   * invocation is skipped (no overlapping runs).
   */
  addJob(name, intervalMs, fn) {
    if (this._jobs.has(name)) {
      throw new Error(`Scheduler: duplicate job name "${name}"`);
    }
    const job = { intervalMs, fn, timer: null, running: false };
    this._jobs.set(name, job);

    job.timer = setInterval(async () => {
      if (job.running) {
        updaterLog(`scheduler: "${name}" skipped — previous run still in progress`);
        return;
      }
      job.running = true;
      try {
        await fn();
      } catch (err) {
        updaterLog(`scheduler: "${name}" error: ${err.message}`);
      } finally {
        job.running = false;
      }
    }, intervalMs);

    // Allow the timer to not keep the process alive.
    job.timer.unref();
  }

  /** Remove a job by name. */
  removeJob(name) {
    const job = this._jobs.get(name);
    if (job) {
      clearInterval(job.timer);
      this._jobs.delete(name);
    }
  }

  /** Stop all jobs. */
  stopAll() {
    for (const [name, job] of this._jobs) {
      clearInterval(job.timer);
    }
    this._jobs.clear();
  }
}

module.exports = new Scheduler();
