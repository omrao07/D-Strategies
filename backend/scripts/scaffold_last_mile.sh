#!/usr/bin/env bash
# scripts/scaffold-last-mile.sh
# Utility to prepare "last mile" scaffolding: directories, placeholders, and demo files.
# Usage:
#   ./scripts/scaffold-last-mile.sh

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "📦 Scaffolding project structure in $ROOT ..."

# Ensure main folders exist
mkdir -p "$ROOT/backtester"
mkdir -p "$ROOT/options"
mkdir -p "$ROOT/futures"
mkdir -p "$ROOT/utils"
mkdir -p "$ROOT/docs"
mkdir -p "$ROOT/examples"
mkdir -p "$ROOT/scripts"

# Create placeholder README files if missing
for d in backtester options futures utils docs examples; do
  if [ ! -f "$ROOT/$d/README.md" ]; then
    echo "# $d" > "$ROOT/$d/README.md"
    echo "✔ Created $d/README.md"
  fi
done

# Scaffold sample example files
if [ ! -f "$ROOT/examples/iron_condor.json" ]; then
  cat > "$ROOT/examples/iron_condor.json" <<'JSON'
{
  "name": "Iron Condor",
  "spotRef": 100,
  "legs": [
    { "kind": "option", "right": "P", "strike": 95, "premium": 1.2, "qty": 1, "multiplier": 100 },
    { "kind": "option", "right": "P", "strike": 100, "premium": 2.5, "qty": -1, "multiplier": 100 },
    { "kind": "option", "right": "C", "strike": 105, "premium": 2.6, "qty": -1, "multiplier": 100 },
    { "kind": "option", "right": "C", "strike": 110, "premium": 1.3, "qty": 1, "multiplier": 100 }
  ]
}
JSON
  echo "✔ Seeded examples/iron_condor.json"
fi

if [ ! -f "$ROOT/examples/portfolio.json" ]; then
  cat > "$ROOT/examples/portfolio.json" <<'JSON'
{
  "cash": 25000,
  "positions": {
    "AAPL-2025-01-17-C-110": { "symbol": "AAPL-2025-01-17-C-110", "qty": -2 },
    "AAPL-2025-01-17-P-90":  { "symbol": "AAPL-2025-01-17-P-90",  "qty": -2 }
  },
  "specs": {
    "AAPL-2025-01-17-C-110": { "symbol":"AAPL-2025-01-17-C-110","underlying":"AAPL","right":"C","strike":110,"expiryISO":"2025-01-17","multiplier":100 },
    "AAPL-2025-01-17-P-90":  { "symbol":"AAPL-2025-01-17-P-90", "underlying":"AAPL","right":"P","strike":90, "expiryISO":"2025-01-17","multiplier":100 }
  }
}
JSON
  echo "✔ Seeded examples/portfolio.json"
fi

# Ensure docs have basic files
for f in changelog.md disclaimer.md readme.md license; do
  if [ ! -f "$ROOT/docs/$f" ]; then
    echo "# $f" > "$ROOT/docs/$f"
    echo "✔ Created docs/$f"
  fi
done

echo "✅ Last mile scaffolding complete."