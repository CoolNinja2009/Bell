"""
auth.py — small helper module shared by server.py and reset_password.py
─────────────────────────────────────────────────────────────────────
Handles:
  • loading / saving the hashed dashboard password (password.json)
  • loading / creating the Flask session secret key (secret.key)

Nothing here talks to Flask directly, so it can be imported by the
standalone reset_password.py script without needing the web app running.
"""
import json
import os
import secrets

from werkzeug.security import generate_password_hash, check_password_hash

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PASSWORD_FILE = os.path.join(_BASE_DIR, "password.json")
SECRET_KEY_FILE = os.path.join(_BASE_DIR, "secret.key")

DEFAULT_PASSWORD = "admin"  # only used the very first time the server runs


def load_password_hash() -> str:
    """Return the stored password hash, creating a default one if missing."""
    if not os.path.exists(PASSWORD_FILE):
        set_password(DEFAULT_PASSWORD)
        print(f"[auth] No password set — created default password.json "
              f"(default password: '{DEFAULT_PASSWORD}'). "
              f"Please change it: python reset_password.py")
    with open(PASSWORD_FILE, "r") as f:
        return json.load(f)["password_hash"]


def set_password(new_password: str) -> None:
    """Hash `new_password` and persist it to disk (atomic write)."""
    if not new_password or len(new_password) < 4:
        raise ValueError("Password must be at least 4 characters long")
    data = {"password_hash": generate_password_hash(new_password)}
    tmp = PASSWORD_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, PASSWORD_FILE)


def verify_password(candidate: str) -> bool:
    """Check `candidate` against the stored hash."""
    stored_hash = load_password_hash()
    return check_password_hash(stored_hash, candidate)


def load_or_create_secret_key() -> bytes:
    """Return a persisted random secret key for Flask sessions, creating one
    on first run so sessions survive server restarts."""
    if os.path.exists(SECRET_KEY_FILE):
        with open(SECRET_KEY_FILE, "rb") as f:
            key = f.read().strip()
            if key:
                return key
    key = secrets.token_bytes(32)
    with open(SECRET_KEY_FILE, "wb") as f:
        f.write(key)
    return key
