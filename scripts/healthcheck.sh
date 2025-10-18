#!/usr/bin/env bash
#
# scripts/healthcheck.sh
#
# Simple health check script for your hedge fund backend.
# Checks that the server is reachable and responding with HTTP 200 OK
# and that the /health endpoint returns { ok: true }.
#
# Usage:
#   ./scripts/healthcheck.sh [URL]
# Example:
#   ./scripts/healthcheck.sh http://localhost:3000
#

set -euo pipefail

URL="${1:-http://localhost:3000/health}"
TIMEOUT=10

echo "🔍 Checking backend health at: $URL"
echo "⏱  Timeout: ${TIMEOUT}s"

# Try to fetch the health endpoint
HTTP_RESPONSE=$(curl -s -m "$TIMEOUT" -w "HTTPSTATUS:%{http_code}" "$URL" || true)

# Split response body and status
BODY=$(echo "$HTTP_RESPONSE" | sed -e 's/HTTPSTATUS\:.*//g')
STATUS=$(echo "$HTTP_RESPONSE" | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')

# Evaluate status
if [ "$STATUS" -ne 200 ]; then
  echo "❌ Healthcheck failed: HTTP status $STATUS"
  exit 1
fi

# Check JSON for "ok": true or "providers" object
if echo "$BODY" | grep -q '"ok": *true'; then
  echo "✅ Backend health: OK"
  exit 0
fi

if echo "$BODY" | grep -q '"providers"'; then
  echo "⚠️ Backend responded but missing ok=true flag (partial readiness)"
  echo "$BODY"
  exit 2
fi

echo "❌ Unexpected healthcheck response"
echo "$BODY"
exit 1