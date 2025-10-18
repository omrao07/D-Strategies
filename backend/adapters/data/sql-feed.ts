// data/sql feed.ts
// Dependency-free market data feed that polls a SQL source via a user-provided executor.
// Works with any DB (SQLite, DuckDB, Postgres, etc.) as long as you pass an async `execute(sql, params?)`.
//
// Features
// - Polls quotes and/or candles using templated SQL per symbol
// - Flexible column mapping; JSON envelope handling
// - Dedup by (symbol, ts, price)
// - In-memory store with range queries, VWAP, and OHLCV resampling
// - Event listeners for ticks and bars
//
// NOTE: We don't ship a DB driver—YOU provide `execute()` in the constructor.

type ISO8601 = string

export type ColumnMap = {
  ts?: string           // timestamp column (default: "ts" | "time" | "timestamp")
  symbol?: string       // symbol column (default: "symbol" | "ticker")
  price?: string        // trade/last (default: "price" | "last" | "close")
  bid?: string          // bid
  ask?: string          // ask
  volume?: string       // volume
}

export type QueryBuild = { sql: string; params?: any[] }
export type QueryTemplate =
  | string
  | ((symbol: string, opts?: { intervalSec?: number; since?: ISO8601; limit?: number }) => QueryBuild)

export type QueryConfig = {
  /** SQL string or builder. May reference {symbol}, {interval}, {since}, {limit} if string. */
  query: QueryTemplate
  /** Poll cadence per symbol. */
  intervalMs?: number
  /** Randomize cadence by ±jitter ratio (0..1) to spread requests. */
  jitter?: number
  /** Max rows to keep per symbol (memory bound). */
  maxRows?: number
  /** Column mapping (if DB column names differ). */
  columns?: ColumnMap
  /** If your DB returns an envelope (e.g., a JSON column), drill down via path like "data.items". */
  jsonPath?: string
  /** For candle queries (optional): override if columns are o/h/l/c/v + t names differ (kept simple). */
  candleMap?: { t?: string; o?: string; h?: string; l?: string; c?: string; v?: string }
}

export type SQLFeedConfig = {
  /** Required executor: run a query and return rows (objects). */
  execute: (sql: string, params?: any[]) => Promise<any[]>
  /** Required quotes (tick) query. */
  quotes: QueryConfig
  /** Optional prebuilt candles query; if absent, candles are resampled locally. */
  candles?: QueryConfig
  /** Fallback column names for both queries. */
  defaultColumns?: ColumnMap
  /** Global retry/backoff and timeout are left to your executor. We keep it simple here. */
  softFail?: boolean
}

export type Tick = {
  ts: ISO8601
  symbol: string
  price?: number
  bid?: number
  ask?: number
  volume?: number
  raw?: any
}

export type Bar = { t: ISO8601; o: number; h: number; l: number; c: number; v: number }

export type FeedEvent =
  | { type: "tick"; data: Tick }
  | { type: "bar"; data: { symbol: string; intervalSec: number; bar: Bar } }
  | { type: "error"; ts: ISO8601; message: string; symbol?: string; phase?: "quotes" | "candles" }

type Listener = (e: FeedEvent) => void

class SQLFeed {
  private exec: SQLFeedConfig["execute"]
  private cfg: Required<Omit<SQLFeedConfig, "execute">>
  private timers = new Map<string, any>() // key = symbol or symbol.__candles__
  private listeners: Listener[] = []
  private store = new Map<string, Tick[]>() // symbol -> ticks sorted by ts
  private seen = new Set<string>()          // dedup: symbol|ts|price
  private lastTs = new Map<string, string>() // symbol -> last tick ts ISO (for incremental polls)

  constructor(config: SQLFeedConfig) {
    if (!config?.execute) throw new Error("SQLFeed: execute(sql, params?) is required")
    if (!config?.quotes?.query) throw new Error("SQLFeed: quotes.query is required")
    this.exec = config.execute
    this.cfg = {
      quotes: { ...config.quotes },
      candles: config.candles ? { ...config.candles } : undefined as any,
      defaultColumns: config.defaultColumns || {},
      softFail: !!config.softFail,
    } as any

    // defaults
    this.cfg.quotes.intervalMs ??= 1000
    this.cfg.quotes.jitter ??= 0.2
    this.cfg.quotes.maxRows ??= 50_000
    if (this.cfg.candles) {
      this.cfg.candles.intervalMs ??= 10_000
      this.cfg.candles.jitter ??= 0.2
      this.cfg.candles.maxRows ??= 50_000
    }
  }

  // ---- Control ----

  start(symbol: string): void {
    const key = symbol.toUpperCase()
    if (this.timers.has(key)) return
    // run immediately, then schedule
    this.pollQuotes(key)
    const qHandle = setInterval(
      () => this.pollQuotes(key),
      withJitter(this.cfg.quotes.intervalMs!, this.cfg.quotes.jitter!)
    )
    this.timers.set(key, qHandle)

    if (this.cfg.candles) {
      const ck = key + ".__candles__"
      this.pollCandles(key)
      const cHandle = setInterval(
        () => this.pollCandles(key),
        withJitter(this.cfg.candles.intervalMs!, this.cfg.candles.jitter!)
      )
      this.timers.set(ck, cHandle)
    }
  }

  stop(symbol: string): void {
    const key = symbol.toUpperCase()
    const h = this.timers.get(key)
    if (h) { clearInterval(h); this.timers.delete(key) }
    const ck = key + ".__candles__"
    const hc = this.timers.get(ck)
    if (hc) { clearInterval(hc); this.timers.delete(ck) }
  }

  stopAll(): void {
    for (const h of this.timers.values()) clearInterval(h)
    this.timers.clear()
  }

  // ---- Events ----

  on(fn: Listener): () => void {
    this.listeners.push(fn)
    return () => this.off(fn)
  }
  off(fn: Listener): void {
    const i = this.listeners.indexOf(fn)
    if (i >= 0) this.listeners.splice(i, 1)
  }
  private emit(e: FeedEvent): void {
    for (const fn of this.listeners) {
      try { fn(e) } catch { /* swallow */ }
    }
  }

  // ---- Data access ----

  lastTick(symbol: string): Tick | undefined {
    const rows = this.store.get(symbol.toUpperCase())
    if (!rows?.length) return undefined
    return { ...rows[rows.length - 1] }
  }

  range(symbol: string, from?: ISO8601 | number, to?: ISO8601 | number): Tick[] {
    const rows = this.store.get(symbol.toUpperCase()) || []
    const a = tsNum(from) ?? Number.NEGATIVE_INFINITY
    const b = tsNum(to) ?? Number.POSITIVE_INFINITY
    const out: Tick[] = []
    for (const r of rows) {
      const t = Date.parse(r.ts)
      if (t >= a && t <= b) out.push(r)
      if (t > b) break
    }
    return out
  }

  resample(symbol: string, intervalSec: number): Bar[] {
    const rows = this.store.get(symbol.toUpperCase()) || []
    const out: Bar[] = []
    let cur: Bar | undefined
    let bucket = -1
    for (const r of rows) {
      const px = pickPx(r)
      if (px === undefined) continue
      const ts = Date.parse(r.ts)
      const b = Math.floor(ts / 1000 / intervalSec) * intervalSec * 1000
      if (b !== bucket) {
        if (cur) out.push(cur)
        bucket = b
        cur = { t: new Date(b).toISOString(), o: px, h: px, l: px, c: px, v: r.volume ?? 0 }
      } else {
        cur!.h = Math.max(cur!.h, px)
        cur!.l = Math.min(cur!.l, px)
        cur!.c = px
        cur!.v += r.volume ?? 0
      }
    }
    if (cur) out.push(cur)
    return out
  }

  async recentBars(symbol: string, intervalSec: number, limit = 100): Promise<Bar[]> {
    if (this.cfg.candles) {
      try {
        const rows = await this.runQuery(this.cfg.candles.query, symbol, { intervalSec })
        const bars = this.parseCandles(rows, this.cfg.candles.candleMap)
        return bars.length > limit ? bars.slice(-limit) : bars
      } catch (e) {
        this.emit({ type: "error", ts: new Date().toISOString(), message: String(e?.message || e), symbol, phase: "candles" })
        if (!this.cfg.softFail) throw e
      }
    }
    const all = this.resample(symbol, intervalSec)
    return all.length > limit ? all.slice(-limit) : all
  }

  vwap(symbol: string, from?: ISO8601 | number, to?: ISO8601 | number): number | undefined {
    const rows = this.range(symbol, from, to)
    let n = 0, d = 0
    for (const r of rows) {
      const px = pickPx(r)
      if (px === undefined) continue
      const v = r.volume ?? 1
      n += px * v
      d += v
    }
    if (d <= 0) return undefined
    return n / d
  }

  // ---- Pollers ----

  private async pollQuotes(symbol: string): Promise<void> {
    try {
      const since = this.lastTs.get(symbol)
      const rows = await this.runQuery(this.cfg.quotes.query, symbol, { since })
      const ticks = this.parseTicks(rows, symbol, this.cfg.quotes.columns || this.cfg.defaultColumns)
      if (ticks.length) {
        // advance lastTs
        const last = ticks[ticks.length - 1]
        if (last?.ts) this.lastTs.set(symbol, last.ts)
        this.append(symbol, ticks, this.cfg.quotes.maxRows!)
      }
    } catch (e: any) {
      this.emit({ type: "error", ts: new Date().toISOString(), message: String(e?.message || e), symbol, phase: "quotes" })
      if (!this.cfg.softFail) throw e
    }
  }

  private async pollCandles(symbol: string): Promise<void> {
    try {
      if (!this.cfg.candles) return
      const rows = await this.runQuery(this.cfg.candles.query, symbol)
      const bars = this.parseCandles(rows, this.cfg.candles.candleMap)
      const last = bars[bars.length - 1]
      if (last) this.emit({ type: "bar", data: { symbol: symbol.toUpperCase(), intervalSec: guessIntervalSec(bars), bar: last } })
    } catch (e: any) {
      this.emit({ type: "error", ts: new Date().toISOString(), message: String(e?.message || e), symbol, phase: "candles" })
      if (!this.cfg.softFail) throw e
    }
  }

  // ---- Query & Parse ----

  private async runQuery(tpl: QueryTemplate, symbol: string, extra?: { intervalSec?: number; since?: ISO8601; limit?: number }): Promise<any[]> {
    if (typeof tpl === "function") {
      const { sql, params } = tpl(symbol, extra)
      return this.exec(sql, params)
    }
    // Interpolate a string template.
    const sql = tpl
      .replaceAll("{symbol}", escapeSqlLiteral(symbol))
      .replaceAll("{interval}", String(extra?.intervalSec ?? ""))
      .replaceAll("{since}", extra?.since ? escapeSqlLiteral(extra.since) : "NULL")
      .replaceAll("{limit}", String(extra?.limit ?? ""))
    return this.exec(sql)
  }

  private parseTicks(rows: any[], symbol: string, columns?: ColumnMap): Tick[] {
    const arr = drill(rows, this.cfg.quotes.jsonPath)
    const c = resolveCols(columns, this.cfg.defaultColumns)
    const out: Tick[] = []
    for (const r of arr) {
      const sym = String(r[c.symbol] ?? symbol).toUpperCase()
      const ts = toISO(r[c.ts] ?? r["ts"] ?? r["time"] ?? r["timestamp"])
      const price = num(r[c.price] ?? r["price"] ?? r["last"] ?? r["close"])
      const bid = num(r[c.bid] ?? r["bid"])
      const ask = num(r[c.ask] ?? r["ask"])
      const volume = num(r[c.volume] ?? r["volume"] ?? r["vol"])
      if (!sym || !ts) continue
      out.push({ ts, symbol: sym, price, bid, ask, volume, raw: r })
    }
    out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    return out
  }

  private parseCandles(rows: any[], map?: { t?: string; o?: string; h?: string; l?: string; c?: string; v?: string }): Bar[] {
    const arr = drill(rows, this.cfg.candles?.jsonPath)
    const key = {
      t: map?.t || "t",
      o: map?.o || "o",
      h: map?.h || "h",
      l: map?.l || "l",
      c: map?.c || "c",
      v: map?.v || "v",
    }
    const out: Bar[] = []
    for (const r of arr) {
      const t = toISO(r[key.t] ?? r["time"] ?? r["ts"])
      const o = num(r[key.o] ?? r["open"])
      const h = num(r[key.h] ?? r["high"])
      const l = num(r[key.l] ?? r["low"])
      const c = num(r[key.c] ?? r["close"])
      const v = num(r[key.v] ?? r["volume"])
      if (t && isFiniteNum(o) && isFiniteNum(h) && isFiniteNum(l) && isFiniteNum(c)) {
        out.push({ t, o, h, l, c, v: v ?? 0 })
      }
    }
    out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
    return out
  }

  private append(symbol: string, ticks: Tick[], maxRows: number): void {
    if (!ticks.length) return
    const key = symbol.toUpperCase()
    const cur = this.store.get(key) || []
    for (const t of ticks) {
      const k = `${key}|${t.ts}|${t.price ?? ""}`
      if (this.seen.has(k)) continue
      this.seen.add(k)
      cur.push(t)
      this.emit({ type: "tick", data: { ...t } })
    }
    cur.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    if (cur.length > maxRows) {
      const cut = cur.length - maxRows
      for (let i = 0; i < cut; i++) {
        const k = `${key}|${cur[i].ts}|${cur[i].price ?? ""}`
        this.seen.delete(k)
      }
      this.store.set(key, cur.slice(-maxRows))
    } else {
      this.store.set(key, cur)
    }
  }
}

// ---- Utilities (no imports) ----

function resolveCols(p?: ColumnMap, d?: ColumnMap): Required<ColumnMap> {
  return {
    ts: p?.ts || d?.ts || "ts",
    symbol: p?.symbol || d?.symbol || "symbol",
    price: p?.price || d?.price || "price",
    bid: p?.bid || d?.bid || "bid",
    ask: p?.ask || d?.ask || "ask",
    volume: p?.volume || d?.volume || "volume",
  }
}

function drill(x: any, path?: string): any[] {
  let v = x
  if (path) for (const k of path.split(".").filter(Boolean)) v = v?.[k]
  if (Array.isArray(v)) return v
  if (v === undefined || v === null) return []
  return [v]
}

function pickPx(t: Tick): number | undefined {
  if (isFiniteNum(t.price)) return t.price
  const b = t.bid, a = t.ask
  if (isFiniteNum(b) && isFiniteNum(a)) return (b! + a!) / 2
  return isFiniteNum(b) ? b : isFiniteNum(a) ? a : undefined
}

function toISO(x: any): ISO8601 | undefined {
  if (!x && x !== 0) return undefined
  if (typeof x === "string" && /^\d{4}-\d{2}-\d{2}T/.test(x)) return new Date(x).toISOString()
  const n = num(x)
  if (n !== undefined) return new Date(n).toISOString()
  const s = String(x)
  const t = Date.parse(s)
  return isFinite(t) ? new Date(t).toISOString() : undefined
}

function num(x: any): number | undefined {
  if (x === null || x === undefined) return undefined
  const n = typeof x === "number" ? x : parseFloat(String(x))
  return isFinite(n) ? n : undefined
}

function isFiniteNum(x: any): x is number {
  return typeof x === "number" && isFinite(x)
}

function tsNum(x?: ISO8601 | number): number | undefined {
  if (x === undefined) return undefined
  if (typeof x === "number") return x
  const t = Date.parse(x)
  return isFinite(t) ? t : undefined
}

function withJitter(ms: number, jitter: number): number {
  const r = (Math.random() * 2 - 1) * (jitter || 0)
  return Math.max(50, Math.round(ms * (1 + r)))
}

function guessIntervalSec(bars: Bar[]): number {
  if (bars.length < 2) return 60
  const a = Date.parse(bars[0].t), b = Date.parse(bars[1].t)
  return Math.max(1, Math.round((b - a) / 1000))
}

function escapeSqlLiteral(s: string): string {
  // Basic single-quote escaping; prefer parameterized queries in production.
  return s.replace(/'/g, "''")
}

// ---- Example usage (comment out in prod) ----
/*
const execute = async (sql: string, params?: any[]) => {
  console.log("SQL>", sql, params)
  // Return rows like: [{ ts: '2025-01-01T09:30:00Z', symbol: 'AAPL', price: 100, volume: 500 }, ...]
  return []
}

const feed = new SQLFeed({
  execute,
  quotes: {
    query: (symbol, { since }) => ({
      sql: `SELECT ts, symbol, price, volume FROM ticks WHERE symbol = ? AND ts > ? ORDER BY ts ASC LIMIT 1000`,
      params: [symbol, since || '1970-01-01T00:00:00Z'],
    }),
    columns: { ts: "ts", symbol: "symbol", price: "price", volume: "volume" },
    intervalMs: 1000,
  },
  // candles: {
  //   query: (symbol, { intervalSec = 60 }) => ({
  //     sql: `SELECT t as t, o, h, l, c, v FROM bars_${intervalSec} WHERE symbol = ? ORDER BY t ASC LIMIT 200`,
  //     params: [symbol],
  //   }),
  //   candleMap: { t: "t", o: "o", h: "h", l: "l", c: "c", v: "v" },
  // },
})

feed.on(e => { if (e.type === "tick") console.log("TICK", e.data.symbol, e.data.price, e.data.ts) })
feed.start("AAPL")
*/

