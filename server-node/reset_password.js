#!/usr/bin/env node
'use strict';
/**
 * reset_password.js — reset the Relay Controller dashboard password
 * ───────────────────────────────────────────────────────────────────
 * Run this on the machine that hosts server.js (it edits password.json
 * next to it, so it must stay in the same folder as auth.js).
 *
 * Usage:
 *   node reset_password.js
 *       Prompts for a new password twice (hidden input) and saves it.
 *
 *   node reset_password.js --password "NewPassword123"
 *       Non-interactive — sets the password directly (careful: this may
 *       end up in your shell history / process list).
 *
 * The server does not need to be running for this to work, and if it IS
 * running you do not need to restart it — the password hash is re-read
 * from disk on every login attempt, so the new password takes effect
 * immediately.
 */
const readline = require('readline');
const auth = require('./auth');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--password' && argv[i + 1] !== undefined) {
      out.password = argv[i + 1];
      i++;
    }
  }
  return out;
}

/** Prompt for input with the typed characters hidden (masked as *). */
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Hide echoed input by intercepting the underlying writer.
    const originalWrite = rl._writeToOutput;
    rl._writeToOutput = function hiddenWrite(stringToWrite) {
      if (stringToWrite.charCodeAt(0) === 13 || stringToWrite.includes('\n')) {
        originalWrite.call(rl, stringToWrite);
      } else {
        originalWrite.call(rl, '*');
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let newPassword = args.password;

  if (!newPassword) {
    console.log('Reset Relay Controller dashboard password');
    console.log('-------------------------------------------');
    const p1 = await promptHidden('New password: ');
    const p2 = await promptHidden('Confirm password: ');
    if (p1 !== p2) {
      console.error('Error: passwords do not match.');
      process.exitCode = 1;
      return;
    }
    newPassword = p1;
  }

  try {
    auth.setPassword(newPassword);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Password updated successfully. (${auth.PASSWORD_FILE})`);
  console.log('Log in to the dashboard with the new password — no server restart needed.');
}

main();
