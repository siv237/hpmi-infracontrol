#!/usr/bin/env bash
# Launch the iRMC Viewer bridge server.
# - Loads .env (if present) for PORT or overrides.
# - Installs deps on first run (no node_modules).
# - Kills any previous instance on PORT first (no EADDRINUSE).
# - Output is mirrored to logs/server-<timestamp>.log (live pin logs/server.log)
#   so runtime issues are easy to inspect: tail -f logs/server.log
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

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

LOG_DIR="${LOG_DIR:-$SCRIPT_DIR/logs}"
mkdir -p "$LOG_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/server-$TS.log"
ln -sfn "$LOG_FILE" "$LOG_DIR/server.log"

echo "Starting iRMC Viewer bridge on ${PORT} (Ctrl-C to stop)."
echo "Log: ${LOG_FILE} (live tail: tail -f ${LOG_DIR}/server.log)"

# tee: keep output visible in the terminal AND append to the file.
node server/index.js 2>&1 | tee -a "$LOG_FILE"
