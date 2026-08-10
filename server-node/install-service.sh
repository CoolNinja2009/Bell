#!/bin/bash
# install-service.sh — Auto-start the Relay Controller Server on boot (Linux)
# ─────────────────────────────────────────────────────────────────────────────
# ONE-TIME setup. Run this script, follow the final sudo command, done.
#
# What it does:
#   1. Runs bootstrap.js  → verifies Node.js/Git/PM2, checks for updates,
#                           installs deps, starts the server via PM2
#   2. pm2 save            → snapshots the running process list
#   3. pm2 startup          → generates & prints the systemd command to run
#
# After the sudo command, PM2 will resurrect the server on every boot.
# The server dashboard will be available at http://<hostname>:8080
#
# Stop the auto-start later:  pm2 unstartup
# Stop the server now:        pm2 stop relay-server
# See server logs:            pm2 logs relay-server

set -e
cd "$(dirname "$0")"

echo ""
echo "============================================"
echo "  Relay Controller — Boot Service Installer"
echo "============================================"
echo ""

# ── Step 1: Bootstrap (starts server if not running) ──────────────────────
echo "[1/3] Starting server via bootstrap.js..."
node bootstrap.js
echo ""

# ── Step 2: Save PM2 process list ─────────────────────────────────────────
echo "[2/3] Saving PM2 process list for resurrection on boot..."
pm2 save
echo ""

# ── Step 3: Install PM2 startup hook ──────────────────────────────────────
echo "[3/3] Installing PM2 startup hook..."
echo ""
echo "  PM2 will now print a 'sudo' command below."
echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │  COPY and RUN that exact sudo command in your terminal. │"
echo "  │  It installs a systemd service that starts PM2 on boot.  │"
echo "  └─────────────────────────────────────────────────────────┘"
echo ""

pm2 startup

echo ""
echo "============================================"
echo "  Almost done!"
echo "============================================"
echo ""
echo "  1. Run the sudo command printed above (the one starting with 'sudo env PATH=...')"
echo "  2. Reboot to verify:  sudo reboot"
echo "  3. After reboot, check: pm2 status"
echo ""
echo "  Dashboard:  http://$(hostname).local:8080"
echo "  Stop:       pm2 stop relay-server"
echo "  Logs:       pm2 logs relay-server"
echo "  Status:     pm2 status"
echo "  Disable:    pm2 unstartup"
echo ""
