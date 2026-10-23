# Claude Project Guide

This repository contains the Bell relay controller: ESP32 firmware and a
Node.js server/dashboard that coordinate scheduled relay operations. Treat
relay behavior and schedule data as safety-sensitive. Make changes narrowly,
preserve existing behavior, and verify the relevant side of the system before
finishing.

## Start Here

Before changing files:

1. Read this guide and check `git status --short`. Preserve pre-existing user
   changes; never discard or overwrite them.
2. Read the relevant sections of [`README.md`](README.md) and, for server work,
   [`server-node/README.md`](server-node/README.md). They contain the hardware
   map, deployment instructions, API reference, data formats, and operational
   behavior; do not duplicate their full contents here.
3. Identify whether the change affects firmware, server, dashboard, deployment,
   or a shared contract. Trace both sides when changing a contract.
4. Avoid generated, cached, deployed, and historical data unless the task
   explicitly concerns it. In particular, do not treat `.pio/`,
   `server-node/node_modules/`, `server-node/.firmware_cache/`, logs, backups,
   or the `defunct/` tree as active source.

Use the existing patterns and tests. Keep changes focused; update the relevant
README when user-visible behavior, setup, hardware, deployment, or API
contracts change.

## Repository Map

| Path | Purpose |
| --- | --- |
| `src/` | Active Arduino/ESP32 firmware. `main.cpp` wires together the firmware modules. |
| `platformio.ini` | PlatformIO target, libraries, build metadata hooks, and upload settings. |
| `partitions_ota.csv` | ESP32 partition layout, including OTA slots. |
| `server-node/server.js` | Express API, dashboard delivery, schedule/profile operations, device communication, and firmware serving. |
| `server-node/templates/` | Dashboard, profiles, login, and profile-editor HTML. |
| `server-node/assets/` | Shared UI served at `/assets`: `ui.css` (design system for every page) and `channel-card.js` (channel editor used by both the dashboard and the profile manager). |
| `server-node/lib/` | Profile/calendar/settings persistence and validation, scheduling, history, and firmware metadata/state helpers. |
| `server-node/services/` | Bootstrap support for dependencies, Git, GitHub, health checks, and PM2. |
| `server-node/config/index.js` | Bootstrap configuration. |
| `server-node/defaults/` | Shipped default profile, calendar, and settings data. |
| `server-node/test/` | Node.js tests for safety, metadata, profile validation, and schedule synchronization. |
| `.github/workflows/` | CI verification and firmware build/release automation. |
| `defunct/` | Historical/retired implementation; not the active product. |
| `CHECKPOINT.md` | Project checkpoint notes; verify claims against current source before relying on them. |

The server is deliberately file-backed rather than database-backed. Its
runtime JSON, logs, and backups are operational data, not disposable fixtures.

## Architecture and Important Contracts

### Firmware

- `src/main.cpp` initializes the LED, bell core, network synchronization, OTA,
  and LittleFS storage, then continuously ticks the bell core, OTA, and LED.
- The relay scheduler is the highest-priority behavior. `bell_core` must remain
  independent of Wi-Fi, HTTP, and server availability: schedules are persisted
  in ESP32 NVS and bells must continue to run while offline.
- Network synchronization runs HTTP/network work on its own FreeRTOS task.
  It supplies validated schedules and queued commands to the bell core; it
  must not directly control relay pins or block the scheduler.
- The LED, storage, OTA, network, and bell-core modules are separated into
  corresponding `.cpp`/`.h` files under `src/`. Follow those module boundaries
  rather than adding unrelated behavior to `main.cpp`.
- Current hardware is two relay channels: `ch1` on GPIO 26 and `ch2` on GPIO
  27. The current firmware relay polarity is active-low. Do not change pin
  mapping, polarity, timezone, or physical relay behavior without an explicit
  requirement and corresponding documentation.
- Firmware schedule capacity, skip-date capacity, channel keys, and per-slot
  pulse duration constraints are defined in `src/bell_core.h` and the parser
  in `src/bell_core.cpp`. Check these together when changing schedule format.
- Firmware local time is configured in `src/bell_core.h`; it currently uses
  India Standard Time (UTC+05:30). Keep schedule/profile day selection and
  device time assumptions consistent.
- Network discovery uses a UDP beacon (port 9999); server HTTP is on port
  8080. Do not silently replace discovery or alter polling/timeout behavior.
- OTA is a safety-sensitive path: preserve dual-partition rollback behavior,
  firmware metadata/protocol compatibility, integrity verification, and the
  scheduler's priority. Coordinate changes with `src/ota_update.*`,
  `server-node/server.js`, and the firmware release workflow.

### Server and dashboard

- `server-node/server.js` is the Express entry point and owns HTTP routes,
  middleware, and orchestration. It listens on port 8080 and sends UDP
  discovery beacons on port 9999.
- Profile, calendar, settings, validation, and firmware logic is factored into
  `server-node/lib/`. Extend/reuse those modules instead of duplicating
  persistence or validation inside route handlers.
- Dashboard markup and browser behavior are in `server-node/templates/` and
  related assets such as `server-node/sw.js`. Keep the UI/API payloads aligned.
- The server may support profile/channel configuration beyond what the device
  can execute. The firmware currently accepts only `ch1` and `ch2` (with the
  legacy `bell` alias mapped to `ch1`); server support for additional channels
  does **not** mean additional hardware support. Do not make the device appear
  to execute unsupported channels.
- Profile selection follows the established scheduler precedence: manual
  override, calendar date, day of week, then configured default. Preserve
  timezone-aware boundaries and midnight rollover behavior.
- Profile validation is centralized in `server-node/lib/profile-validator.js`.
  Route reads, imports, edits, and repairs through that pipeline. Invalid or
  corrupt profile data must not be silently replaced with an empty/default
  store or written over; preserve the last-known-good and recovery behavior.
- Maintain compatibility among server schedule JSON, ESP32 parsing, and
  schedule hashes/polling. A seemingly harmless schema change can cause a
  device to ignore a schedule or miss a bell.
- Keep endpoint authentication and authorization intentional. Public device
  endpoints, session-protected dashboard endpoints, and API-key-protected
  operations are distinct; follow the current route-level patterns and
  [`server-node/README.md`](server-node/README.md)'s Auth & Security and API
  Reference sections.

## Safety, Secrets, and Operational Data

- Never print, copy, commit, or put credentials, API keys, session secrets,
  passwords, private tokens, or their values in documentation, logs, tests, or
  examples. Treat files such as `api_keys.json`, `password.json`, and
  `secret.key` as sensitive. Do not inspect their contents unless the task
  explicitly requires it; never expose them in tool output.
- Do not use real credentials in tests. Use temporary directories and
  synthetic values. Do not send project secrets to external services.
- Treat profile, calendar, settings, history, password, API-key, and firmware
  state files as potentially live or user-specific data. Prefer
  `server-node/defaults/` and isolated test fixtures for code examples/tests.
  Do not replace or normalize runtime state as part of an unrelated code task.
- Do not run firmware upload/flash commands, trigger relay commands, send
  manual run-now requests, change deployed schedules, or restart a production
  service unless the user specifically requests that action.
- Do not run `start.bat --update` or `start.sh --update` as a routine check.
  Those options fetch and hard-reset the working tree to `origin/main`, which
  can irreversibly discard local changes. Never use `git reset --hard`, forced
  checkout, or equivalent destructive commands without explicit user approval.
- Do not start the production server just to validate a change if doing so
  could conflict with an existing process or access real state. Prefer the
  test suite and static checks.
- Never assume a log, backup, cache, firmware binary, or user-edited JSON file
  is safe to delete. Do not clean up anything outside files created during
  your current task.

## Development Setup and Validation

Run commands from the appropriate directory. PlatformIO must be installed for
firmware builds; Node.js must meet `server-node/package.json`'s engine
requirement (Node 22 is used in CI).

### Server

```powershell
Set-Location server-node
npm ci
npm test
node --check server.js
npm audit --omit=dev --audit-level=high
```

- `npm test` runs the `node:test` suite from `server-node/test/`.
- Run the smallest meaningful checks for the files changed, then the relevant
  broader check when practical. For route/module changes, run the server tests
  and syntax-check the changed JavaScript files.
- Do not run `npm audit fix` automatically; it can change dependency versions
  and lockfiles. Report audit findings and make dependency changes only when
  required by the task.
- Do not run `npm install` to refresh the lockfile unless intentionally changing
  dependencies. Use `npm ci` for a clean dependency install.

### Firmware

```powershell
pio run
```

Run the firmware build after changes under `src/`, `platformio.ini`,
`partitions_ota.csv`, or build scripts. CI additionally verifies embedded OTA
protocol metadata in the built image. `pio run -t upload` flashes a physical
device and is not a routine validation command.

There is no firmware unit-test target defined in the current project setup.
For scheduler or parser behavior, preserve/add deterministic Node tests in
`server-node/test/` where they mirror the firmware, and build the actual
firmware as well. Tests that mirror firmware logic should document that
relationship and use isolated fixtures.

### CI

The primary verification workflow is `.github/workflows/verify.yml`: server
tests, JavaScript syntax check, dependency audit, PlatformIO build, and embedded
OTA metadata checks. `.github/workflows/build-firmware.yml` builds/releases
firmware based on its configured triggers. Keep workflow assumptions aligned
with the documented build and metadata process.

## Implementation Conventions

- Match the surrounding style: Arduino/C++ modules under `src/`; CommonJS
  JavaScript with `'use strict'` in server modules; existing tests use
  `node:test` and `node:assert/strict`.
- Prefer clear module APIs and existing helpers to parallel implementations.
  Keep validation at system boundaries and make failures explicit; avoid
  broad catches, silent fallbacks, and success-shaped responses for invalid
  state.
- Preserve atomic and validation-aware writes in the profile/settings
  persistence path. When adding file-backed state, handle malformed data and
  write failures without destroying the previous valid contents.
- Keep schedule ordering, duplicate handling, time parsing, per-slot pulse
  overrides, skip dates, date boundaries, and offline fallback behavior
  explicit in tests whenever touched.
- Treat browser-rendered values as untrusted input. Preserve the existing
  escaping/validation patterns; do not interpolate user-controlled content
  into HTML or commands unsafely.
- Avoid adding dependencies for functionality already supported by Node.js or
  existing packages. If a dependency change is necessary, update
  `package.json` and `package-lock.json` deliberately and validate it.
- Do not edit generated dependencies (`server-node/node_modules/`,
  `.pio/libdeps/`) or build outputs (`.pio/build/`) directly.
- Keep examples and sample configuration free of real secrets and site-specific
  values. Do not copy runtime data into defaults.

## Change Checklist

Before considering a change complete:

- [ ] Confirmed the working-tree state and preserved existing user changes.
- [ ] Traced affected firmware/server/UI interfaces and preserved schedule and
      device compatibility.
- [ ] Added or updated focused tests for behavior changes and edge cases.
- [ ] Ran relevant tests, syntax checks, or firmware build and reported any
      validation that could not be completed.
- [ ] Updated the appropriate README when public behavior or operations changed.
- [ ] Reviewed the diff for unrelated edits, generated files, and sensitive data.
- [ ] Did not flash hardware, trigger relays, mutate a live service, or perform
      a destructive Git/update operation without explicit authorization.
