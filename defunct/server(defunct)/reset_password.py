#!/usr/bin/env python3
"""
reset_password.py — reset the Relay Controller dashboard password
───────────────────────────────────────────────────────────────────
Run this on the machine that hosts server.py (it edits password.json
in the same folder, so it must be run from here, or from anywhere as
long as this script stays next to auth.py).

Usage:
    python reset_password.py
        Prompts for a new password twice (hidden input) and saves it.

    python reset_password.py --password "NewPassword123"
        Non-interactive — sets the password directly (careful: this may
        end up in your shell history / process list).

The dashboard server does not need to be running for this to work, but
if it IS running, restart it afterwards so nothing gets confused (the
password hash is re-read from disk on every login attempt, so this is
actually not required — the new password takes effect immediately).
"""
import argparse
import getpass
import sys

import auth  # local module, must stay in the same folder


def main() -> int:
    parser = argparse.ArgumentParser(description="Reset the Relay Controller dashboard password.")
    parser.add_argument(
        "--password",
        help="New password (non-interactive). If omitted, you'll be prompted securely.",
    )
    args = parser.parse_args()

    if args.password:
        new_password = args.password
    else:
        print("Reset Relay Controller dashboard password")
        print("-------------------------------------------")
        new_password = getpass.getpass("New password: ")
        confirm = getpass.getpass("Confirm password: ")
        if new_password != confirm:
            print("Error: passwords do not match.")
            return 1

    try:
        auth.set_password(new_password)
    except ValueError as e:
        print(f"Error: {e}")
        return 1

    print(f"Password updated successfully. ({auth.PASSWORD_FILE})")
    print("Log in to the dashboard with the new password — no server restart needed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
