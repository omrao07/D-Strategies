// integration/strategies-run-spec.ts
// High-level integration spec: run selected strategies with demo feeds and paper broker.
//
// Goals:
// - Spin up engine context with demo feed + paper broker
// - Load strategies from manifest.json
// - Run them for N bars
// - Assert trades, PnL, risk stats shape
//
// Usage:
//   npx ts-node --esm integration/strategies-run-spec.ts
//
// Note: This is a test harness / example, not a full test suite.

import { readFile } from "node:fs/promises"
import * as path from "node:path"
import assert from "node:assert"

// --- Types (simplified mirror from engine/core) ---
type Bar = { ts: string; symbol: string; open: number; high: number; low: number; close: number; volume: number }
type Strategy = { id: string; run(bars: Bar[], ctx: any): Promise<any> }
type RunResult = { trades: any[]; pnl: number; equity: number; stats: any }

// --- Helpers ---
async function loadManifest(): Promise<{ entries: { id: string; path: string }[] }> {
  const p = path.resolve("strategies/manifest.json")
  const txt = await readFile(p, "utf8")
  return JSON.parse(txt)
}

async function loadStrategy(id: string, relPath: string): Promise<Strategy> {
  const mod = await import(path.resolve(relPath))
  if (!mod.default || typeof mod.default.run !== "function") {
    throw new Error(`Strategy ${id} missing default export with run()`)
  }
  return { id, run: mod.default.run }
}

function fakeFeed(symbols: string[], bars = 200): Bar[] {
  const out: Bar[] = []
  const now = Date.now()
  for (const sym of symbols) {
    let px = 100
    for (let i = 0; i < bars; i++) {
      const t = new Date(now - (bars - i) * 60 * 1000)
      const ret = (Math.random() - 0.5) * 0.02
      const close = px * (1 + ret)
      out.push({
        ts: t.toISOString(),
        symbol: sym,
        open: px,
        high: Math.max(px, close) * (1 + Math.random() * 0.005),
        low: Math.min(px, close) * (1 - Math.random() * 0.005),
        close,
        volume: 1000 + Math.floor(Math.random() * 1000),
      })
      px = close
    }
  }
  return out
}

// --- Main test harness ---
async function main() {
  const manifest = await loadManifest()
  assert(manifest.entries.length > 0, "No strategies in manifest")

  const feed = fakeFeed(["AAPL", "MSFT"], 150)

  for (const e of manifest.entries) {
    console.log(`\n=== Strategy ${e.id} ===`)
    try {
      const strat = await loadStrategy(e.id, e.path)
      const ctx = { capital: 100000, broker: "paper" }
      const result: RunResult = await strat.run(feed, ctx)
      console.log(`Trades: ${result.trades.length}, PnL: ${result.pnl.toFixed(2)}, Equity: ${result.equity.toFixed(2)}`)
      assert(isFinite(result.pnl), "PnL not finite")
      assert(isFinite(result.equity), "Equity not finite")
    } catch (err) {
      console.error(`Strategy ${e.id} failed:`, err)
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
