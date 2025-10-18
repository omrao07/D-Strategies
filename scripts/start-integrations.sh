#!/usr/bin/env bash
#
# scripts/start-integration.sh
#
# Starts the backend in a background process, waits for /health to report OK,
# runs integration tests, then shuts down cleanly.
#
# Usage:
#   ./scripts/start-integration.sh
#

set -euo pipefail

PORT=${PORT:-3000}
HEALTH_URL="http://localhost:${PORT}/health"
TIMEOUT=40
START_CMD="npx ts-node src/server.ts"
TEST_CMD="npx ts-node src/tests/run-all.ts"  # adjust this if you use Jest or Vitest

echo "🚀 Starting backend server on port ${PORT}..."
echo "▶️ Command: ${START_CMD}"

# Start backend in background
$START_CMD &
SERVER_PID=$!
echo "📡 Server PID: $SERVER_PID"

# Trap cleanup on exit or interrupt
cleanup() {
  echo ""
  echo "🧹 Cleaning up..."
  kill $SERVER_PID >/dev/null 2>&1 || true
  echo "✅ Server stopped."
}
trap cleanup EXIT INT TERM

# Wait until health check passes
echo ""
echo "⏳ Waiting for backend to become healthy (max ${TIMEOUT}s)..."

START_TIME=$(date +%s)
while true; do
  if curl -fs -m 3 "$HEALTH_URL" | grep -q '"ok": *true'; then
    echo "✅ Backend is healthy!"
    break
  fi
  sleep 2
  NOW=$(date +%s)
  if (( NOW - START_TIME > TIMEOUT )); then
    echo "❌ Timeout: backend failed to start within ${TIMEOUT}s."
    exit 1
  fi
done

# Run integration tests
echo ""
echo "🧪 Running integration tests..."
if $TEST_CMD; then
  echo "✅ Integration tests passed."
else
  echo "❌ Integration tests failed."
  exit 1
fi

# Everything passed, cleanup handled by trap
echo ""
echo "🎉 All integration checks completed successfully."