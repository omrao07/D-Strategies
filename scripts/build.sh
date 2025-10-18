#!/usr/bin/env bash
# scripts/build.sh
# Monorepo build: backend (TypeScript) + frontend (Vite)
# Usage:
#   scripts/build.sh [--clean] [--skip-tests] [--prod]
# Env:
#   NODE_OPTIONS, CI

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
OUT_DIR="$ROOT_DIR/build"
BACKEND_OUT="$OUT_DIR/backend"
FRONTEND_OUT="$OUT_DIR/frontend"

CLEAN=0
SKIP_TESTS=0
MODE="dev" # or prod

for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --prod) MODE="prod" ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

echo "== Build settings =="
echo "  CLEAN:       $CLEAN"
echo "  SKIP_TESTS:  $SKIP_TESTS"
echo "  MODE:        $MODE"
echo "  ROOT:        $ROOT_DIR"
echo

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required tool: $1" >&2; exit 1; }
}

need node
need npm

# Optional: print versions
echo "Node: $(node -v)"
echo "NPM:  $(npm -v)"
echo

# Clean output if requested
if [[ "$CLEAN" -eq 1 ]]; then
  echo "Cleaning $OUT_DIR ..."
  rm -rf "$OUT_DIR"
fi

mkdir -p "$BACKEND_OUT" "$FRONTEND_OUT"

# --- Backend build ---
echo "=== Backend ==="
cd "$BACKEND_DIR"

# Install deps (use ci if lockfile present)
if [[ -f package-lock.json ]]; then npm ci; else npm install; fi

# Type checks
if [[ -f tsconfig.json ]]; then
  echo "Type-checking backend..."
  npx tsc --noEmit
fi

# Tests (if present and not skipped)
if [[ "$SKIP_TESTS" -eq 0 && -f package.json && "$(jq -r '.scripts.test // empty' package.json 2>/dev/null || true)" != "" ]]; then
  echo "Running backend tests..."
  npm test --silent
fi

echo "Building backend..."
npm run build

# Copy backend artifacts
# Assumes backend outputs to backend/dist
if [[ -d dist ]]; then
  rsync -a --delete dist/ "$BACKEND_OUT/"
else
  echo "Warn: backend 'dist/' not found; copying src (runtime TS?)"
  rsync -a --delete src/ "$BACKEND_OUT/src/"
fi

# Copy production files
cp -f package.json "$BACKEND_OUT/package.json"
# Do NOT copy secrets; .env stays local. If you need prod env, pass via deploy system.
# If you need a sample:
if [[ -f .env.example ]]; then cp -f .env.example "$BACKEND_OUT/.env.example"; fi
# Include any runtime assets (adjust as needed)
for f in README.md LICENSE; do [[ -f "$f" ]] && cp -f "$f" "$BACKEND_OUT/"; done

echo "Backend built → $BACKEND_OUT"
echo

# --- Frontend build ---
echo "=== Frontend ==="
cd "$FRONTEND_DIR"

# Install deps
if [[ -f package-lock.json ]]; then npm ci; else npm install; fi

# Lint (optional)
if [[ -f package.json && "$(jq -r '.scripts.lint // empty' package.json 2>/dev/null || true)" != "" ]]; then
  echo "Linting frontend..."
  npm run lint --silent || echo "Lint warnings ignored."
fi

# Type checks
if [[ -f tsconfig.json ]]; then
  echo "Type-checking frontend..."
  npx tsc --noEmit
fi

# Tests (if present and not skipped)
if [[ "$SKIP_TESTS" -eq 0 && -f package.json && "$(jq -r '.scripts.test // empty' package.json 2>/dev/null || true)" != "" ]]; then
  echo "Running frontend tests..."
  npm test --silent
fi

# Build
if [[ "$MODE" == "prod" ]]; then
  echo "Building frontend (production)..."
  npm run build
else
  echo "Building frontend (default)..."
  npm run build
fi

# Copy frontend dist
if [[ -d dist ]]; then
  rsync -a --delete dist/ "$FRONTEND_OUT/"
else
  echo "Error: frontend 'dist/' not found after build." >&2
  exit 1
fi

echo "Frontend built → $FRONTEND_OUT"
echo

# --- Summary ---
echo "=== Done ==="
echo "Artifacts:"
echo "  Backend:  $BACKEND_OUT"
echo "  Frontend: $FRONTEND_OUT"
echo
echo "Tip:"
echo "  - Run backend:   (cd $BACKEND_OUT && npm ci --omit=dev && node server.js) if your dist has server.js"
echo "  - Serve frontend: any static server (e.g., npx serve $FRONTEND_OUT)"