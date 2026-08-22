#!/bin/bash

set -e

REPO_URL="https://github.com/CoolNinja2009/Bell.git"
REPO_DIR="$HOME/Bell"

echo
echo "========================================================"
echo "        Bell System — One-Time Setup"
echo "========================================================"
echo
echo "This will clone the Bell repository and configure"
echo "the Node.js server on this Raspberry Pi."
echo

# ── Check Node.js ───────────────────────────────────────────

echo "[1/5] Checking Node.js..."

if ! command -v node >/dev/null 2>&1; then
    echo "[X] Node.js is not installed."
    echo "    Install Node.js first."
    exit 1
fi

echo "  [✓] Node.js $(node --version)"

# ── Check Git ───────────────────────────────────────────────

echo "[2/5] Checking Git..."

if ! command -v git >/dev/null 2>&1; then
    echo "[X] Git is not installed."
    echo "    Install it with: sudo apt install git"
    exit 1
fi

echo "  [✓] $(git --version)"

# ── Hostname + port 80 ──────────────────────────────────────

echo "[3/5] Configuring hostname and port 80..."

# mDNS name — must match the hostname the dashboard is served as.
if [ "$(hostname)" != "bell-server" ]; then
    sudo hostnamectl set-hostname bell-server
    echo "  [✓] Hostname set to bell-server"
else
    echo "  [✓] Hostname is already bell-server"
fi

# Allow the Node server (running as an unprivileged user) to bind port 80.
if [ "$(cat /proc/sys/net/ipv4/ip_unprivileged_port_start 2>/dev/null || echo 0)" != "0" ]; then
    echo 'net.ipv4.ip_unprivileged_port_start=0' | sudo tee /etc/sysctl.d/99-bell.conf >/dev/null
    sudo sysctl -w net.ipv4.ip_unprivileged_port_start=0 >/dev/null
    echo "  [✓] Unprivileged port 80 binding enabled"
else
    echo "  [✓] Unprivileged port 80 binding already enabled"
fi

# Restart avahi so the new hostname is announced on the LAN (if present).
if command -v avahi-daemon >/dev/null 2>&1; then
    sudo systemctl restart avahi-daemon || true
fi

# ── Clone repository ────────────────────────────────────────

echo "[4/5] Checking repository..."

if [ -f "$REPO_DIR/server-node/bootstrap.js" ]; then
    echo "  [✓] Repository already exists at:"
    echo "      $REPO_DIR"
else
    if [ -d "$REPO_DIR" ]; then
        echo "[!] $REPO_DIR exists but doesn't look like the Bell repository."
        exit 1
    fi

    echo "  Cloning repository..."
    git clone "$REPO_URL" "$REPO_DIR"
    echo "  [✓] Repository cloned."
fi

# ── Run bootstrap ───────────────────────────────────────────

echo
echo "[5/5] Running Bell server bootstrap..."
echo

cd "$REPO_DIR/server-node"

node bootstrap.js

echo
echo "========================================================"
echo "  Setup complete."
echo "========================================================"
echo