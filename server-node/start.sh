#!/bin/bash
set -e
cd "$(dirname "$0")"

case "${1:-}" in
  --update)
    echo "==> Fetching updates..."
    git fetch origin
    OLD_SHA=$(git rev-parse HEAD)
    echo "==> Resetting to origin/main..."
    git reset --hard origin/main
    NEW_SHA=$(git rev-parse HEAD)
    # Only reinstall deps when package.json/lockfile actually changed (or
    # node_modules is missing) — avoids a full reinstall on every daily
    # cron restart, while still catching new dependencies automatically.
    if [ "$OLD_SHA" != "$NEW_SHA" ] && git diff --name-only "$OLD_SHA" "$NEW_SHA" | grep -qE '^(server-node/)?package(-lock)?\.json$'; then
      echo "==> Dependencies changed — installing..."
      npm ci --omit=dev 2>/dev/null || npm install
    elif [ ! -d node_modules ]; then
      echo "==> node_modules missing — installing..."
      npm ci --omit=dev 2>/dev/null || npm install
    else
      echo "==> Dependencies unchanged — skipping install."
    fi
    echo "==> Restarting server..."
    pm2 restart relay-server
    echo "==> Done. Server restarting with latest code."
    ;;
  --restart)
    echo "==> Restarting server..."
    pm2 restart relay-server
    echo "==> Done."
    ;;
  *)
    node bootstrap.js
    ;;
esac
