#!/usr/bin/env bash
# Launch the iRMC Viewer bridge server.
# - Loads .env (if present) for PORT or overrides.
# - Installs deps on first run (no node_modules).
# - Kills any previous instance on PORT first (no EADDRINUSE).
# - Starts `node server/index.js` (like `npm start`).
set -euo pipefail

cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

PORT="${PORT:-1845}"

if [ ! -d node_modules ]; then
  echo "node_modules missing -> npm install"
  npm install
fi

# Free the port if something is already bound to it (a stale/other instance).
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${PORT}\$"; then
  echo "Port ${PORT} is busy -> killing the old instance"
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  sleep 1
fi

echo "Starting iRMC Viewer bridge on ${PORT} (Ctrl-C to stop)..."
exec node server/index.js
