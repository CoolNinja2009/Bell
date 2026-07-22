# Relay Controller Server

Flask-based web server for the ESP32 relay controller. Provides a dashboard UI and REST API.

## Quick start

```bash
pip install -r requirements.txt
python server.py
# → http://localhost:8080
```

## Login

The dashboard is now password-protected.

- **First run:** a `password.json` file is created automatically with the default password **`admin`**. Change it right away (see below).
- **Log in:** visit `http://localhost:8080/`, you'll be redirected to `/login`.
- **Log out:** click "Log out" in the dashboard header, or visit `/logout`.
- Sessions last 8 hours and are stored server-side via a signed cookie (secret key auto-generated into `secret.key` — keep this file private, don't commit it).
- Login attempts are rate-limited (5 tries / minute per IP) to slow down guessing.

### Resetting the password

```bash
python reset_password.py
# prompts for a new password (hidden input), takes effect immediately —
# no server restart needed

# or non-interactively:
python reset_password.py --password "YourNewPassword"
```

### What's protected vs. not

The ESP32 firmware can't "log in", so its endpoints stay open on purpose:
`GET /api/schedule`, `GET /api/schedule/hash`, `POST /api/heartbeat`, `POST /api/log`.

Everything a human uses from a browser requires login: the dashboard page itself,
`POST /api/schedule` (saving a new schedule), `GET /api/status`, `GET /api/log`.

This is a lightweight guard suited to a small local-network device — not
hardened for exposing the server to the public internet.

## API

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| `GET` | `/api/schedule` | Full schedule JSON (ESP32 fetches) | open |
| `GET` | `/api/schedule/hash` | 8-char MD5 hash (ESP32 polls every 5s for changes) | open |
| `POST` | `/api/heartbeat?ch=ch1` | ESP32 heartbeat (updates dashboard status) | open |
| `POST` | `/api/log` | ESP32 log entry (`{"msg":"..."}`) | open |
| `GET` | `/api/log` | Recent log entries (dashboard polls) | **login** |
| `POST` | `/api/schedule` | Save schedule (dashboard saves) | **login** |
| `GET` | `/api/status` | Server health + heartbeat ages | **login** |
| `GET` | `/` | Dashboard UI | **login** |
| `GET`/`POST` | `/login` | Login page | open |
| `GET` | `/logout` | Clear session | open |

## Storage

- `schedule.json` — persistent schedule (auto-created with defaults)
- `password.json` — hashed dashboard password (auto-created, default password `admin`)
- `secret.key` — session signing key (auto-created; keep private)
- Heartbeats and logs are in-memory only (reset on restart)

## Beacon

A background thread broadcasts `RELAY_CTRL:8080` to `255.255.255.255:9999` every 5 seconds. The ESP32 listens for this to auto-discover the server IP.

