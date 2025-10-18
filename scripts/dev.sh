#!/usr/bin/env bash
# scripts/dev.sh
# Start backend (ts-node-dev) + frontend (Vite) for local development.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

BACKEND_PORT="${PORT:-8080}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

# ---------- helpers ----------
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1"; exit 1; }; }
banner() { printf "\n\033[1;36m== %s ==\033[0m\n" "$1"; }

need node
need npm

# ---------- install if needed ----------
if [[ ! -d "$BACKEND_DIR/node_modules" ]]; then
  banner "Installing backend deps"
  (cd "$BACKEND_DIR" && npm install)
fi

if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  banner "Installing frontend deps"
  (cd "$FRONTEND_DIR" && npm install)
fi

# ---------- env sanity ----------
if [[ ! -f "$BACKEND_DIR/.env" ]]; then
  echo "⚠️  backend/.env not found. Using process env only."
  echo "    Create backend/.env or export API_NINJAS_KEY, AISSTREAM_API_KEY, GEE_APP_BASE."
fi

# ---------- start both with concurrent output ----------
banner "Starting backend on :$BACKEND_PORT"
(
  cd "$BACKEND_DIR"
  # ts-node-dev gives fast reloads; falls back to ts-node if missing
  npx --yes ts-node-dev --respawn --transpile-only src/server.ts \
    2>&1 | sed -e 's/^/[backend] /'
) & BACK_PID=$!

banner "Starting frontend (Vite) on :$FRONTEND_PORT"
(
  cd "$FRONTEND_DIR"
  # Expose backend URL to Vite dev if you want fetch('/api/...') to proxy:
  export VITE_BACKEND_ORIGIN="http://localhost:${BACKEND_PORT}"
  npx --yes vite --port "$FRONTEND_PORT" \
    2>&1 | sed -e 's/^/[frontend] /'
) & FRONT_PID=$!

# ---------- cleanup on exit ----------
trap 'echo; echo "Shutting down..."; kill $BACK_PID $FRONT_PID 2>/dev/null || true; wait $BACK_PID $FRONT_PID 2>/dev/null || true' INT TERM

echo
echo "✅ Dev running:"
echo "   Backend : http://localhost:${BACKEND_PORT}"
echo "   Frontend: http://localhost:${FRONTEND_PORT}"
echo "   Press Ctrl+C to stop."
echo

wait