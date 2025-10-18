// demo-seed.ts
// Deterministic demo data seeder for local development.
// - Generates synthetic OHLCV bars (GBM-style) and optional ticks
// - Writes JSON (default) or CSV; SQLite is supported if `sqlite` + `sqlite3` are installed
// - No runtime deps required for JSON/CSV paths
//
// Examples:
//   npx ts-node --esm demo-seed.ts --out data/demo.json --symbols AAPL,MSFT,TSLA --bars 500
//   npx ts-node --esm demo-seed.ts --csv data/demo.csv --symbols BTC-USD,ETH-USD --interval 30
//   npx ts-node --esm demo-seed.ts --sqlite data/demo.sqlite --symbols ES,CL --bars 1000 --seed 1337 --verbose
//
// Flags:
//   --out <file.json>     write bars as JSON (array of rows)
//   --csv <file.csv>      write bars as CSV
//   --sqlite <file.db>    write bars to SQLite (if driver available)
//   --symbols <a,b,c>     comma-separated symbols (default: AAPL,MSFT,TSLA)
//   --bars <N>            bars per symbol (default: 200)
//   --interval <sec>      bar interval seconds (default: 60)
//   --seed <n>            RNG seed for reproducibility (default: 42)
//   --ticks               also emit a light tick stream (midpoint ticks from bars)
//   --verbose             print a short summary
//
// Schema (bars):
//   { ts, symbol, open, high, low, close, volume }
//
// Schema (ticks when --ticks):
//   { ts, symbol, price, bid, ask, volume }
//
// NOTE: This is a self-contained script; SQLite writing is optional and loaded
//       dynamically so you can still run without sqlite packages installed.

import { promises as fs } from "node:fs"
import * as path from "node:path"

// ---------- Types ----------

type Bar = {
  ts: string
  symbol: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

type Tick = {
  ts: string
  symbol: string
  price: number
  bid?: number
  ask?: number
  volume?: number
}

type Options = {
  out?: string
  csv?: string
  sqlite?: string
  symbols: string[]
  bars: number
  interval: number
  seed: number
  ticks: boolean
  verbose: boolean
}

// ---------- Small utils (no deps) ----------

function isFiniteNum(x: any): x is number {
  return typeof x === "number" && isFinite(x)
}

// Linear-congruential PRNG (deterministic)
function makePRNG(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

// Box–Muller Normal(0,1) from a [0,1) PRNG
function makeNormal01(u: () => number) {
  return () => {
    let a = u(), b = u()
    a = a <= 1e-12 ? 1e-12 : a
    b = b <= 1e-12 ? 1e-12 : b
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b)
  }
}

// ---------- Synthetic data generators ----------

/** GBM-ish bar generator with tiny microstructure noise. */
function genBars(symbol: string, bars: number, intervalSec: number, seed: number): Bar[] {
  const u = makePRNG(seed)
  const z = makeNormal01(u)

  const out: Bar[] = []
  const now = Date.now()
  let px = 50 + Math.floor(u() * 450) // 50..499 start

  for (let i = bars - 1; i >= 0; i--) {
    const t = new Date(now - i * intervalSec * 1000)

    // dynamics (daily-ish drift scaled down to interval, random vol)
    const drift = 0 // flat drift
    const vol = 0.01 + 0.02 * u() // 1–3% per interval (overstated for demo)
    const ret = drift + vol * z()
    const close = Math.max(0.01, px * Math.exp(ret))

    // H/L jitter
    const w = Math.abs(0.0025 * px) + 0.0025 * px * Math.abs(z())
    const open = px
    const high = Math.max(open, close) + w * u()
    const low = Math.min(open, close) - w * u()
    const volume = Math.floor(1000 + u() * 9000)

    out.push({
      ts: t.toISOString(),
      symbol,
      open: round(open, 2),
      high: round(high, 2),
      low: round(low, 2),
      close: round(close, 2),
      volume,
    })
    px = close
  }
  return out
}

/** Optional lightweight tick stream: 1 mid tick per bar plus bid/ask spread. */
function ticksFromBars(bars: Bar[], spreadBps = 8): Tick[] {
  const out: Tick[] = []
  const s = spreadBps / 10_000
  for (const b of bars) {
    const mid = (b.open + b.high + b.low + b.close) / 4
    const bid = mid * (1 - s / 2)
    const ask = mid * (1 + s / 2)
    out.push({
      ts: b.ts,
      symbol: b.symbol,
      price: round(mid, 4),
      bid: round(bid, 4),
      ask: round(ask, 4),
      volume: Math.floor(b.volume / 10),
    })
  }
  return out
}

// ---------- Writers ----------

async function writeJSON(file: string, rows: any[], verbose: boolean) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(rows, null, 2))
  if (verbose) console.log(`Wrote ${rows.length.toLocaleString()} rows to ${file}`)
}

async function writeCSV(file: string, rows: any[], headers: string[], verbose: boolean) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const lines = [headers.join(",")]
  for (const r of rows) {
    lines.push(headers.map((h) => formatCsv(r[h])).join(","))
  }
  await fs.writeFile(file, lines.join("\n"))
  if (verbose) console.log(`Wrote ${rows.length.toLocaleString()} rows to ${file}`)
}

function formatCsv(v: any): string {
  if (v === null || v === undefined) return ""
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function writeSQLite(file: string, bars: Bar[], ticks?: Tick[], verbose?: boolean) {
  // Dynamically import so this script works without sqlite installed.
  let open: any, sqlite3: any
  try {
    // @ts-ignore - optional deps at runtime
    const modSqlite = await import("sqlite")
    // @ts-ignore
    const modSqlite3 = await import("sqlite3")
    open = modSqlite.open
    sqlite3 = modSqlite3.default || modSqlite3
  } catch {
    console.error("SQLite path requested but packages 'sqlite' and 'sqlite3' are not installed.")
    process.exit(1)
  }

  await fs.mkdir(path.dirname(file), { recursive: true })
  const db = await open({ filename: file, driver: sqlite3.Database })

  await db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS bars (
      ts TEXT NOT NULL,
      symbol TEXT NOT NULL,
      open REAL, high REAL, low REAL, close REAL, volume INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_bars_symbol_ts ON bars(symbol, ts);
  `)

  const insBar = await db.prepare(
    `INSERT INTO bars (ts,symbol,open,high,low,close,volume) VALUES (?,?,?,?,?,?,?)`
  )
  try {
    await db.exec("BEGIN")
    for (const b of bars) {
      await insBar.run(b.ts, b.symbol, b.open, b.high, b.low, b.close, b.volume)
    }
    await db.exec("COMMIT")
  } catch (e) {
    await db.exec("ROLLBACK")
    throw e
  } finally {
    await insBar.finalize()
  }

  if (ticks && ticks.length) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS ticks (
        ts TEXT NOT NULL,
        symbol TEXT NOT NULL,
        price REAL, bid REAL, ask REAL, volume INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_ticks_symbol_ts ON ticks(symbol, ts);
    `)
    const insTick = await db.prepare(
      `INSERT INTO ticks (ts,symbol,price,bid,ask,volume) VALUES (?,?,?,?,?,?)`
    )
    try {
      await db.exec("BEGIN")
      for (const t of ticks) {
        await insTick.run(t.ts, t.symbol, t.price, t.bid ?? null, t.ask ?? null, t.volume ?? null)
      }
      await db.exec("COMMIT")
    } catch (e) {
      await db.exec("ROLLBACK")
      throw e
    } finally {
      await insTick.finalize()
    }
  }

  if (verbose) {
    const [{ c: barCount }] = await db.all(`SELECT COUNT(*) as c FROM bars`)
    const [{ c: tickCount }] =
      ticks && ticks.length ? await db.all(`SELECT COUNT(*) as c FROM ticks`) : [{ c: 0 }]
    console.log(
      `Wrote ${Number(barCount).toLocaleString()} bars` +
        (tickCount ? ` and ${Number(tickCount).toLocaleString()} ticks` : "") +
        ` to ${file}`
    )
  }
  await db.close()
}

// ---------- CLI ----------

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    out: undefined,
    csv: undefined,
    sqlite: undefined,
    symbols: ["AAPL", "MSFT", "TSLA"],
    bars: 200,
    interval: 60,
    seed: 42,
    ticks: false,
    verbose: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--out" && argv[i + 1]) opts.out = argv[++i]
    else if (a === "--csv" && argv[i + 1]) opts.csv = argv[++i]
    else if (a === "--sqlite" && argv[i + 1]) opts.sqlite = argv[++i]
    else if (a === "--symbols" && argv[i + 1]) opts.symbols = argv[++i].split(",").map((s) => s.trim()).filter(Boolean)
    else if (a === "--bars" && argv[i + 1]) opts.bars = Math.max(1, parseInt(argv[++i], 10))
    else if (a === "--interval" && argv[i + 1]) opts.interval = Math.max(1, parseInt(argv[++i], 10))
    else if (a === "--seed" && argv[i + 1]) opts.seed = parseInt(argv[++i], 10)
    else if (a === "--ticks") opts.ticks = true
    else if (a === "--verbose") opts.verbose = true
  }
  return opts
}

// ---------- Main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  // Generate per-symbol bars (and optional ticks)
  const allBars: Bar[] = []
  const allTicks: Tick[] = []

  for (let i = 0; i < opts.symbols.length; i++) {
    const sym = opts.symbols[i]
    const bars = genBars(sym, opts.bars, opts.interval, opts.seed + i * 1009)
    allBars.push(...bars)
    if (opts.ticks) allTicks.push(...ticksFromBars(bars))
  }

  if (!opts.out && !opts.csv && !opts.sqlite) {
    // default to JSON preview to stdout (first 10)
    console.log(JSON.stringify(allBars.slice(0, 10), null, 2))
    console.log(`(showing 10 of ${allBars.length} bars)`)
    return
  }

  if (opts.out) {
    await writeJSON(opts.out, allBars, opts.verbose)
    if (opts.ticks) await writeJSON(addSuffix(opts.out, ".ticks"), allTicks, opts.verbose)
  }

  if (opts.csv) {
    await writeCSV(
      opts.csv,
      allBars,
      ["ts", "symbol", "open", "high", "low", "close", "volume"],
      opts.verbose
    )
    if (opts.ticks)
      await writeCSV(
        addSuffix(opts.csv, ".ticks"),
        allTicks,
        ["ts", "symbol", "price", "bid", "ask", "volume"],
        opts.verbose
      )
  }

  if (opts.sqlite) {
    await writeSQLite(opts.sqlite, allBars, opts.ticks ? allTicks : undefined, opts.verbose)
  }

  if (opts.verbose) {
    const symSet = new Set(allBars.map((b) => b.symbol))
    console.log(
      `Symbols: ${Array.from(symSet).join(", ")} | Bars: ${allBars.length.toLocaleString()}${
        opts.ticks ? ` | Ticks: ${allTicks.length.toLocaleString()}` : ""
      }`
    )
  }
}

// ---------- Helpers ----------

function round(n: number, d: number): number {
  const f = Math.pow(10, d)
  return Math.round(n * f) / f
}
function addSuffix(file: string, suffix: string): string {
  const ext = path.extname(file)
  const base = file.slice(0, -ext.length)
  return `${base}${suffix}${ext || ""}`
}

// Execute when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || String(err))
    process.exit(1)
  })
}
