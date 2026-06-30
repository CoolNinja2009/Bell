"""
Relay Controller Server  —  Flask REST API + Dashboard
───────────────────────────────────────────────────────
Serves the schedule to the ESP32 and provides a web UI for editing.

Quick start:
    pip install flask
    python server.py
    → Dashboard at http://<host>:8080
    → ESP32 polls   http://<host>:8080/api/schedule

Storage:  schedule.json  (auto‑created with defaults on first run)
"""
import socket
import threading

import hashlib
import json
import os
import time
from datetime import date

from flask import Flask, Response, jsonify, render_template, request

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
HOST = "0.0.0.0"
PORT = 8080
SCHEDULE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "schedule.json")
BEACON_PORT = 9999
BEACON_INTERVAL_S = 5
BEACON_MSG = f"RELAY_CTRL:{PORT}\n".encode()

app = Flask(__name__)

# --- Template path (read from disk every request to bypass Jinja2 cache) ---
_TPL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates", "index.html")
print(f"DEBUG TEMPLATE PATH: {_TPL}")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_schedule() -> dict:
    """Read schedule from disk; return defaults if missing or corrupt."""
    try:
        with open(SCHEDULE_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return _default_schedule()


def save_schedule(data: dict) -> None:
    """Persist schedule to disk atomically."""
    tmp = SCHEDULE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, SCHEDULE_FILE)


def _default_schedule() -> dict:
    """Factory defaults — written to disk if schedule.json is missing."""
    return {
        "ch1": {
            "enabled": True,
            "pulse_ms": 2_000,
            "schedule": ["08:00", "20:00"],
            "skip_dates": [],
        },
        "ch2": {
            "enabled": True,
            "pulse_ms": 2_000,
            "schedule": ["06:30", "18:45"],
            "skip_dates": [],
        },
    }


# In‑memory heartbeat tracking  (volatile — resets on server restart)
_heartbeats: dict[str, float] = {}


def _clean_stale_heartbeats(ttl: float = 120.0) -> None:
    """Drop heartbeats older than `ttl` seconds."""
    now = time.time()
    stale = [k for k, v in _heartbeats.items() if now - v > ttl]
    for k in stale:
        del _heartbeats[k]


# ---------------------------------------------------------------------------
# REST API  —  consumed by the ESP32
# ---------------------------------------------------------------------------

@app.get("/api/schedule")
def api_get_schedule():
    """Return the full schedule as JSON.  Called by the ESP32 periodically."""
    _clean_stale_heartbeats()
    return jsonify(load_schedule())

@app.get("/api/schedule/hash")
def api_schedule_hash():
    """Tiny endpoint — ESP32 polls this every 5 s to detect changes."""
    raw = json.dumps(load_schedule(), sort_keys=True).encode()
    return jsonify({"h": hashlib.md5(raw).hexdigest()[:8]})


@app.post("/api/heartbeat")
def api_heartbeat():
    """ESP32 calls this to say 'I'm alive'."""
    ch = request.args.get("ch", "unknown")
    _heartbeats[ch] = time.time()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# REST API  —  consumed by the web dashboard
# ---------------------------------------------------------------------------

@app.post("/api/schedule")
def api_post_schedule():
    """Save a new schedule sent by the web UI."""
    data = request.get_json(force=True)
    _validate_schedule(data)
    save_schedule(data)
    return jsonify({"ok": True})


@app.get("/api/status")
def api_status():
    """Health snapshot for the dashboard."""
    _clean_stale_heartbeats()
    return jsonify({
        "heartbeats": {k: round(time.time() - v, 1) for k, v in _heartbeats.items()},
        "server_uptime": round(time.time() - _start_time, 1),
    })


def _validate_schedule(data: dict) -> None:
    """Raise ValueError if the schedule is malformed."""
    for ch in ("ch1", "ch2"):
        if ch not in data:
            raise ValueError(f"Missing {ch}")
        s = data[ch]
        if not isinstance(s.get("enabled"), bool):
            raise ValueError(f"{ch}.enabled must be bool")
        if not isinstance(s.get("pulse_ms"), (int, float)) or s["pulse_ms"] < 100:
            raise ValueError(f"{ch}.pulse_ms must be >= 100")
        if not isinstance(s.get("schedule"), list):
            raise ValueError(f"{ch}.schedule must be a list")
        for entry in s["schedule"]:
            parts = entry.split(":")
            if len(parts) != 2 or not (0 <= int(parts[0]) <= 23) or not (0 <= int(parts[1]) <= 59):
                raise ValueError(f"{ch} schedule entry '{entry}' invalid — use HH:MM")
        if not isinstance(s.get("skip_dates"), list):
            raise ValueError(f"{ch}.skip_dates must be a list")
        for d in s["skip_dates"]:
            try:
                date.fromisoformat(d)
            except ValueError:
                raise ValueError(f"{ch} skip_date '{d}' invalid — use YYYY-MM-DD")


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

@app.get("/")
def dashboard():
    print(f"[debug] serving template from {_TPL} ({os.path.getsize(_TPL)} bytes)")
    with open(_TPL, encoding="utf-8") as f:
        html = f.read()
    resp = Response(html, content_type="text/html; charset=utf-8")
    resp.headers["Cache-Control"] = "no-store"
    return resp

# ---------------------------------------------------------------------------
# UDP Beacon  —  ESP32 auto‑discovers the server
# ---------------------------------------------------------------------------

def _beacon_loop() -> None:
    """Broadcast server address every BEACON_INTERVAL_S seconds."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    # Bind on all interfaces — some OS require this before broadcast
    sock.bind(("", 0))
    print(f"[beacon] Broadcasting on UDP/{BEACON_PORT} every {BEACON_INTERVAL_S}s")
    while True:
        try:
            sock.sendto(BEACON_MSG, ("255.255.255.255", BEACON_PORT))
        except OSError:
            pass
        time.sleep(BEACON_INTERVAL_S)


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

_start_time = time.time()


def _bootstrap():
    """Create schedule.json with defaults if it doesn't exist."""
    if not os.path.exists(SCHEDULE_FILE):
        save_schedule(_default_schedule())
        print(f"[server] Created {SCHEDULE_FILE} with defaults")


if __name__ == "__main__":
    _bootstrap()
    threading.Thread(target=_beacon_loop, daemon=True).start()
    print(f"[server] Relay Controller listening on http://{HOST}:{PORT}")
    app.run(host=HOST, port=PORT, debug=False)
