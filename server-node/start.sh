#!/bin/bash
set -e
cd "$(dirname "$0")"

case "${1:-}" in
  --update)
    echo "==> Fetching updates..."
    git fetch origin
    echo "==> Resetting to origin/main..."
    git reset --hard origin/main
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
