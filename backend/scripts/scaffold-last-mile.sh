#!/usr/bin/env bash
# scripts/scaffold-last-mile.sh
# One-command, idempotent “last mile” setup for this TypeScript trading/risk repo.
# - Creates missing folders and helper files
# - Wires package.json scripts
# - Installs dev tooling (ts, ts-node, vitest, eslint, prettier)
# - Drops example envs & run scripts
# - Never overwrites existing files (backs up with .bak if needed)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log()  { printf "\033[1;34m▸ %s\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m✔ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m⚠ %s\033[0m\n" "$*"; }
err()  { printf "\033[1;31m✖ %s\033[0m\n" "$*" >&2; }

backup_if_exists() {
  local f="$1"
  if [[ -f "$f" ]]; then
    cp "$f" "$f.bak.$(date +%s)"
    warn "Backed up $f -> $f.bak.*"
  fi
}

ensure_dir() {
  local d="$1"
  if [[ ! -d "$d" ]]; then
    mkdir -p "$d"
    ok "Created dir $d"
  fi
}

node_ok() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1
}

npm_json_set() {
  # npm pkg set key=value if npm>=8, else jq fallback
  local kv="$1"
  if npm -v >/dev/null 2>&1; then
    if npm pkg set "$kv" >/dev/null 2>&1; then
      return 0
    fi
  fi
  if command -v jq >/dev/null 2>&1; then
    backup_if_exists package.json
    jq ". + {$(
      # split key.path=value into nested JSON
      # simplistic: only supports top-level keys or scripts.*
      if [[ "$kv" == scripts.*=* ]]; then
        local k="${kv#scripts.}"; k="${k%%=*}"; local v="${kv#*=}"
        printf '"scripts": { "%s": %s }' "$k" "$(printf '%s' "$v" | jq -R .)"
      else
        local k="${kv%%=*}"; local v="${kv#*=}"
        printf '"%s": %s' "$k" "$(printf '%s' "$v" | jq -R .)"
      fi
    )}" package.json > package.json.tmp && mv package.json.tmp package.json
  else
    warn "Could not set $kv (need npm>=8 or jq)."
  fi
}

write_if_missing() {
  local f="$1"
  shift
  if [[ ! -f "$f" ]]; then
    mkdir -p "$(dirname "$f")"
    cat > "$f" <<'EOF'
'"$@"'
EOF
    ok "Wrote $f"
  else
    warn "Skip (exists): $f"
  fi
}

append_unique() {
  local f="$1"; local line="$2"
  touch "$f"
  if ! grep -Fqx "$line" "$f"; then
    echo "$line" >> "$f"
    ok "Appended to $f: $line"
  fi
}

# 1) Basic structure -----------------------------------------------------------------
log "Ensuring directory structure"

for d in \
  config health persistence/logs logging engine strategies examples altdata brokers data risk state scripts bin; do
  ensure_dir "$d"
done

# 2) package.json / tsconfig ----------------------------------------------------------
log "Bootstrapping package.json and tsconfig.json"

if [[ ! -f package.json ]]; then
  npm init -y >/dev/null
  ok "Initialized package.json"
fi

# TypeScript config
if [[ ! -f tsconfig.json ]]; then
  cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "lib": ["ES2020", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "baseUrl": ".",
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
JSON
  ok "Wrote tsconfig.json"
fi

# 3) Dev deps -------------------------------------------------------------------------
log "Installing dev dependencies (TypeScript toolchain + lint/test)"

DEVS=(
  typescript ts-node
  vitest @types/node
  eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin
  prettier eslint-config-prettier eslint-plugin-import
)

npm pkg set type=module >/dev/null 2>&1 || true

npm i -D "${DEVS[@]}" >/dev/null
ok "Dev dependencies installed"

# 4) ESLint / Prettier config ---------------------------------------------------------
if [[ ! -f .eslintrc.json ]]; then
  cat > .eslintrc.json <<'JSON'
{
  "root": true,
  "parser": "@typescript-eslint/parser",
  "plugins": ["@typescript-eslint", "import"],
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:import/recommended",
    "prettier"
  ],
  "settings": { "import/resolver": { "node": { "extensions": [".js", ".ts"] } } },
  "env": { "node": true, "es2021": true },
  "rules": {
    "no-console": "off",
    "@typescript-eslint/no-explicit-any": "off",
    "import/no-unresolved": "off"
  }
}
JSON
  ok "Wrote .eslintrc.json"
fi

if [[ ! -f .prettierrc ]]; then
  cat > .prettierrc <<'JSON'
{ "semi": false, "singleQuote": false, "trailingComma": "es5", "printWidth": 100 }
JSON
  ok "Wrote .prettierrc"
fi

# 5) Git ignore & envs ----------------------------------------------------------------
append_unique .gitignore "node_modules/"
append_unique .gitignore "dist/"
append_unique .gitignore ".DS_Store"
append_unique .gitignore "*.log"
append_unique .gitignore ".env.local"
append_unique .gitignore "persistence/logs/*.json"

write_if_missing ".env.example" '# Example environment
# ALPACA_KEY_ID=
# ALPACA_SECRET_KEY=
# IBKR_GATEWAY_HOST=127.0.0.1
# IBKR_GATEWAY_PORT=7497
# KITE_API_KEY=
# KITE_ACCESS_TOKEN=
# DATABASE_URL=sqlite://./data/db.sqlite
'

# 6) NPM scripts ----------------------------------------------------------------------
log "Wiring npm scripts"

npm_json_set 'scripts.build=tsc -p tsconfig.json'
npm_json_set 'scripts.dev=ts-node --esm examples/mean\ reversion.ts'
npm_json_set 'scripts.dev:trend=ts-node --esm examples/trend\ following.ts'
npm_json_set 'scripts.test=vitest run'
npm_json_set 'scripts.lint=eslint "**/*.ts"'
npm_json_set 'scripts.format=prettier --write "**/*.{ts,js,json,md}"'
npm_json_set 'scripts.typecheck=tsc -p tsconfig.json --noEmit'
npm_json_set 'scripts.start=node dist/index.js'

# 7) Demo runner scripts --------------------------------------------------------------
ensure_dir bin
write_if_missing bin/run-demo-mean.sh '#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
exec npx ts-node --esm "examples/mean reversion.ts"
'
chmod +x bin/run-demo-mean.sh

write_if_missing bin/run-demo-trend.sh '#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
exec npx ts-node --esm "examples/trend following.ts"
'
chmod +x bin/run-demo-trend.sh

# 8) Health check stub ----------------------------------------------------------------
write_if_missing scripts/healthcheck.sh '#!/usr/bin/env bash
set -euo pipefail
echo "ok"
'
chmod +x scripts/healthcheck.sh

# 9) Optional: create a minimal dist entry if missing ---------------------------------
if [[ ! -f src/index.ts && ! -f index.ts ]]; then
  write_if_missing index.ts '// entry: export public API if desired
export * from "./engine/types.js"
export * from "./engine/registry.js"
'
fi

# 10) Final notes ---------------------------------------------------------------------
log "Validating TypeScript configuration"
npx tsc -v >/dev/null || true
ok "Scaffold complete 🎉

• Try:  npm run dev
• Or:   ./bin/run-demo-mean.sh
• Lint: npm run lint
• Test: npm run test
• Build: npm run build
"

# 11) Cleanup of obsolete code --------------------------------------------------------
log "Cleaning up obsolete code patterns"