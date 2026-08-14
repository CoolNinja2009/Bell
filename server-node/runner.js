'use strict';

const { spawn } = require('child_process');

let child;
let stopping = false;
let restartDelayMs = 1000;
let startedAt = 0;

function launch() {
  startedAt = Date.now();
  child = spawn(process.execPath, ['server.js'], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (stopping) process.exit(code || 0);
    if (Date.now() - startedAt > 60000) restartDelayMs = 1000;
    console.error(`[runner] server exited (${signal || code}); restarting in ${restartDelayMs}ms`);
    setTimeout(() => {
      restartDelayMs = Math.min(restartDelayMs * 2, 30000);
      launch();
    }, restartDelayMs);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    if (child) child.kill(signal);
    else process.exit(0);
  });
}

launch();
