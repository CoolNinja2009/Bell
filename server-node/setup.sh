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

echo "[1/4] Checking Node.js..."

if ! command -v node >/dev/null 2>&1; then
    echo "[X] Node.js is not installed."
    echo "    Install Node.js first."
    exit 1
fi

echo "  [✓] Node.js $(node --version)"

# ── Check Git ───────────────────────────────────────────────

echo "[2/4] Checking Git..."

if ! command -v git >/dev/null 2>&1; then
    echo "[X] Git is not installed."
    echo "    Install it with: sudo apt install git"
    exit 1
fi

echo "  [✓] $(git --version)"

# ── Clone repository ────────────────────────────────────────

echo "[3/4] Checking repository..."

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
echo "[4/4] Running Bell server bootstrap..."
echo

cd "$REPO_DIR/server-node"

node bootstrap.js

echo
echo "========================================================"
echo "  Setup complete."
echo "========================================================"
echo