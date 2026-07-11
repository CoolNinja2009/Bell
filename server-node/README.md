# Relay Controller Server (Node.js / Express)

A production-hardened rewrite of the original Flask prototype. Same core API,
same ESP32 compatibility, same login flow — but built to survive bad input,
bad requests, and unexpected errors without taking the whole server down,
plus a bunch of features layered on top (see below).

## Quick start

```bash
npm install
npm start
# → Dashboard at http://localhost:8080
```

## What's new

Everything from the original build still works exactly as before (auth,
`ch1`/`ch2` schedule API, UDP beacon, crash-proof error handling, logging).
On top of that:

- **Any number of channels** — not just `ch1`/`ch2`. Add/rename/delete relay
  channels from the dashboard (`+ Add Channel`); each gets a label, its own
  pulse duration, schedule, and skip dates.
- **Manual on/off** — a "Run Now" button per channel queues an immediate
  trigger. The device picks it up the same way it already polls for its
  schedule (`GET /api/commands?ch=<key>`), so no firmware push is required.
- **History & analytics** — every schedule save, manual trigger, and
  channel change is recorded to `history.jsonl` (plain JSON-Lines, no
  database). The dashboard shows a 14-day runs-per-day chart, a filterable
  event table, and a CSV export.
- **Backup / restore** — `Backup` downloads a JSON snapshot of the schedule
  + history; `Restore` uploads one back. Handy before firmware/server
  changes or when moving to new hardware.
- **API keys** — mint scoped tokens (Settings → API Keys) for external
  integrations like Home Assistant, a cron job, or a phone shortcut. Send
  them as an `X-API-Key` header instead of logging in; they currently work
  on `GET /api/status`, `GET /api/history`, and the manual trigger endpoint.
- **In-dashboard password change** — Settings → Change Password. The
  `reset_password.js` script still works too, for when you're locked out.

None of this changes what the ESP32 needs to do — `/api/schedule`,
`/api/schedule/hash`, `/api/heartbeat`, and `/api/log` behave exactly as
before, and old `schedule.json` files (just `ch1`/`ch2`, no `label`) load
fine as-is.

## Why this is more robust than the original

| Problem with the Flask prototype | Fix here |
|---|---|
| Flask's built-in dev server is single-threaded and not meant for production | Node's event loop handles concurrent connections natively; `http.createServer` is the same primitive Node production servers use |
| An uncaught exception in a route could 500 with no useful log | Every route is wrapped (`asyncRoute`) so errors always reach a central error handler that logs the full stack **and** returns a clean JSON response — the process never crashes from a bad request |
| A truly unexpected error (bug, disk failure, etc.) had no safety net | `uncaughtException` / `unhandledRejection` handlers log loudly and exit cleanly, so a process manager can restart in a known-good state instead of limping along corrupted |
| No visibility into what caused a 500 | Every request is logged with method, path, status, and duration; every error is logged with its full stack trace |
| Validation errors returned as opaque 500s | Validation failures return `400` with the actual reason (e.g. `"ch1.pulse_ms must be >= 100"`) |
| Plaintext-adjacent password storage | `bcryptjs` password hashing (same category as `scrypt`, just a different well-vetted algorithm) |

## Running it for real — process management

Node itself doesn't restart on crash; pair it with a process manager for true
"production-grade" always-on behavior. Two easy options:

### Option A: systemd (Linux, recommended for a Pi/server)

Create `/etc/systemd/system/relay-controller.service`:

```ini
[Unit]
Description=Relay Controller Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/server-node
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3
User=pi

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now relay-controller
sudo journalctl -u relay-controller -f   # tail logs
```

### Option B: pm2

```bash
npm install -g pm2
pm2 start server.js --name relay-controller
pm2 save
pm2 startup   # follow the printed instructions to survive reboots
```

## Login

Same as before:

- **First run:** `password.json` is auto-created with default password **`admin`** — change it immediately.
- **Reset:** `node reset_password.js` (interactive) or `node reset_password.js --password "New"` (scripted). Takes effect immediately, no restart needed.
- **Sessions:** 8 hours, signed with a persisted secret (`secret.key`, auto-generated — keep private).
- **Rate limiting:** 5 login attempts per minute per IP.

## What's protected vs. open

Same split as the Python version — the ESP32 can't log in, so its endpoints
stay open:

| Method | Endpoint | Auth |
|--------|----------|------|
| `GET` | `/api/schedule` | open (device) |
| `GET` | `/api/schedule/hash` | open (device) |
| `POST` | `/api/heartbeat?ch=ch1` | open (device) |
| `POST` | `/api/log` | open (device) |
| `GET` | `/api/commands?ch=ch1` | open (device) — pending manual trigger, if any |
| `POST` | `/api/execution` | open (device) — optional: confirm a relay actually fired |
| `GET` | `/api/log` | **login** |
| `POST` | `/api/schedule` | **login** |
| `GET` | `/api/status` | **login** or API key |
| `GET` | `/api/channels` | **login** |
| `POST` | `/api/channels` | **login** — add a channel |
| `DELETE` | `/api/channels/:key` | **login** — remove a channel |
| `POST` | `/api/relay/:key/trigger` | **login** or API key — manual "run now" |
| `GET` | `/api/history` | **login** or API key |
| `GET` | `/api/history/export` | **login** — CSV download |
| `GET` | `/api/backup` | **login** — JSON snapshot download |
| `POST` | `/api/restore` | **login** — restore from a JSON snapshot |
| `POST` | `/api/account/password` | **login** — change password |
| `GET` | `/api/keys` | **login** |
| `POST` | `/api/keys` | **login** — mint a new API key |
| `DELETE` | `/api/keys/:id` | **login** — revoke a key |
| `GET` | `/` | **login** |
| `GET`/`POST` | `/login` | open |
| `GET` | `/logout` | open |

API-key auth: send the key as an `X-API-Key` header. It's accepted anywhere
the table says "**login** or API key" as an alternative to a session cookie.

## Storage

- `schedule.json` — persistent schedule, any number of channels (auto-created with `ch1`/`ch2` defaults)
- `password.json` — bcrypt password hash (auto-created, default password `admin`)
- `secret.key` — session signing secret (auto-created; keep private)
- `history.jsonl` — append-only run/event history, capped at ~5000 entries (auto-created)
- `api_keys.json` — hashed API keys for external integrations (auto-created; keep private)
- Heartbeats and the raw device log are in-memory only (reset on restart) — history is not

## Debugging a 500

Every request and every error is logged to stdout with a timestamp, e.g.:

```
[2026-07-04T15:49:41.203Z] POST /api/schedule -> 400 (2ms)
[2026-07-04T15:49:41.203Z] [ERROR] POST /api/schedule: Error: ch1.pulse_ms must be >= 100
    at validateSchedule (/path/server.js:...)
```

If you're running via systemd, `journalctl -u relay-controller -f` shows this
live. If you're running via pm2, `pm2 logs relay-controller`. If you're just
running `node server.js` directly, it's right there in the terminal.
