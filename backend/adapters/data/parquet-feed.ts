// data/parquet feed.ts
// Lightweight market-data feed that can *ingest* Parquet data — without a Parquet decoder dependency.
// How? You pass already-decoded rows (e.g., from your own decoder) OR give us a custom `decoder`
// to turn an ArrayBuffer into rows. As a convenience, if the "Parquet" blob actually contains
// UTF-8 NDJSON or CSV (common in demos), we auto-detect and parse that too.
//
// Features (pure TypeScript, zero imports):
// - Append-only in-memory store, indexed by symbol + timestamp
// - Query last tick, time ranges, and resample to OHLCV bars
// - VWAP, rolling windows, basic column stats
// - Event listeners for "ingest" and "bar" (on resample)
// - Optional schema hints; flexible column mapping
//
// NOTE: True Parquet decoding requires a library or WASM. This module deliberately avoids that to stay dependency-free.
// In production, plug your Parquet decoder into `ingestParquet(buffer, { decoder })`.
//
// Canonical columns (but fully configurable via `ColumnMap`):
//   ts (ISO8601), symbol (string), price (number), volume (number), bid (number), ask (number)

type ISO8601 = string

export type TickRow = {
  ts: ISO8601 | number // ISO string or epoch millis
  symbol: string
  price?: number
  volume?: number
  bid?: number
  ask?: number
  // passthrough extras allowed
  [k: string]: any
}

export type Bar = { t: ISO8601; o: number; h: number; l: number; c: number; v: number }

export type ColumnMap = {
  ts?: string          // default "ts"
  symbol?: string      // default "symbol"
  price?: string       // default "price"
  volume?: string      // default "volume"
  bid?: string         // default "bid"
  ask?: string         // default "ask"
}

export type ParquetIngestOptions = {
  /** Custom decoder that turns raw ArrayBuffer into an array of TickRow-like objects. */
  decoder?: (buf: ArrayBuffer) => TickRow[] | Promise<TickRow[]>
  /** Column mapping if your fields don't match the defaults. */
  columns?: ColumnMap
  /** If true, silently skip rows that fail validation. */
  skipInvalid?: boolean
}

export type ResampleOptions = {
  /** Seconds per bar (e.g., 60 for 1-min). */
  intervalSec: number
  /** Emit a "bar" event on each bar update. Default true. */
  emit?: boolean
  /** Use "price" (trades) or mid of bid/ask when price is missing. */
  fallbackToMid?: boolean
}

export type FeedEvent =
  | { type: "ingest"; count: number; symbols: string[]; ts: ISO8601 }
  | { type: "bar"; symbol: string; intervalSec: number; bar: Bar }

type Listener = (e: FeedEvent) => void

class ParquetFeed {
  private bySymbol = new Map<string, TickRow[]>()
  private listeners: Listener[] = []
  private cols: Required<ColumnMap>
  private lastIngestAt: ISO8601 | undefined

  constructor(columns: ColumnMap = {}) {
    this.cols = {
      ts: columns.ts ?? "ts",
      symbol: columns.symbol ?? "symbol",
      price: columns.price ?? "price",
      volume: columns.volume ?? "volume",
      bid: columns.bid ?? "bid",
      ask: columns.ask ?? "ask",
    }
  }

  /** Register a listener. Returns an unsubscribe fn. */
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
      try { fn(e) } catch {}
    }
  }

  /** Append pre-decoded rows (e.g., from CSV/Parquet reader you control). */
  ingestRows(rows: any[], opts: { skipInvalid?: boolean } = {}): number {
    const mapped: TickRow[] = []
    for (const r of rows || []) {
      const t = this.mapRow(r)
      if (this.valid(t)) mapped.push(t)
      else if (!opts.skipInvalid) throw new Error("Invalid row encountered: " + safeJSON(r))
    }
    return this._append(mapped)
  }

  /**
   * Ingest a raw buffer. If you supply `options.decoder`, we'll use it.
   * Otherwise we'll try UTF-8 NDJSON (one JSON object per line) or CSV ("ts,symbol,price,volume,bid,ask").
   */
  async ingestParquet(buf: ArrayBuffer, options: ParquetIngestOptions = {}): Promise<number> {
    if (options.decoder) {
      const out = await options.decoder(buf)
      return this.ingestRows(out, { skipInvalid: !!options.skipInvalid })
    }
    // Fallback text sniffing
    const text = tryDecodeUtf8(buf)
    if (text !== undefined) {
      const trimmed = text.trim()
      // Heuristics: NDJSON if first line starts with { or ends with }
      if (trimmed.startsWith("{") || trimmed.split("\n", 1)[0]?.trim().endsWith("}")) {
        const rows = parseNDJSON(trimmed)
        return this.ingestRows(rows, { skipInvalid: !!options.skipInvalid })
      }
      // CSV if header mentions ts,symbol or similar
      if (/ts|time/i.test(trimmed.split("\n", 1)[0]) && /symbol/i.test(trimmed.split("\n", 1)[0])) {
        const rows = parseCSV(trimmed)
        return this.ingestRows(rows, { skipInvalid: !!options.skipInvalid })
      }
      // Maybe it's a single JSON array
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          const arr = JSON.parse(trimmed)
          if (Array.isArray(arr)) return this.ingestRows(arr, { skipInvalid: !!options.skipInvalid })
        } catch {}
      }
    }
    // If we reach here, we can't decode it.
    throw new Error("No decoder provided and buffer did not look like UTF-8 NDJSON/CSV/JSON.")
  }

  /** List known symbols. */
  symbols(): string[] {
    return Array.from(this.bySymbol.keys()).sort()
  }

  /** Last tick for a symbol (if any). */
  lastTick(symbol: string): TickRow | undefined {
    const rows = this.bySymbol.get(symbol.toUpperCase())
    if (!rows || rows.length === 0) return undefined
    return { ...rows[rows.length - 1] }
  }

  /** Get ticks in [from, to] inclusive (ISO or epoch millis). */
  range(symbol: string, from?: ISO8601 | number, to?: ISO8601 | number): TickRow[] {
    const rows = this.bySymbol.get(symbol.toUpperCase()) || []
    const a = tsNum(from) ?? Number.NEGATIVE_INFINITY
    const b = tsNum(to) ?? Number.POSITIVE_INFINITY
    // binary search would be faster; linear is simpler and fine for demos
    const out: TickRow[] = []
    for (const r of rows) {
      const t = tsNum(r[this.cols.ts])
      if (t >= a && t <= b) out.push(r)
      if (t > b) break
    }
    return out
  }

  /** Quick stats on a column over a time window. */
  stats(symbol: string, col: keyof TickRow = this.cols.price, from?: ISO8601 | number, to?: ISO8601 | number): { count: number; min?: number; max?: number; mean?: number; std?: number } {
    const rows = this.range(symbol, from, to)
    const xs: number[] = []
    for (const r of rows) {
      const v = num(r[col as string])
      if (v !== undefined) xs.push(v)
    }
    if (xs.length === 0) return { count: 0 }
    const min = Math.min(...xs)
    const max = Math.max(...xs)
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    let s = 0
    for (const x of xs) s += (x - mean) * (x - mean)
    const std = Math.sqrt(s / Math.max(1, xs.length - 1))
    return { count: xs.length, min, max, mean, std }
  }

  /**
   * Resample ticks to OHLCV bars.
   * - Uses `price` when available; if missing and `fallbackToMid`, uses (bid+ask)/2.
   * - Volume sums `volume` field when available.
   * - Emits "bar" events for each bar iff `emit !== false`.
   */
  resample(symbol: string, opts: ResampleOptions): Bar[] {
    const { intervalSec, emit = true, fallbackToMid = true } = opts
    const rows = this.bySymbol.get(symbol.toUpperCase()) || []
    const out: Bar[] = []
    let cur: Bar | undefined
    let curBucket = -1

    for (const r of rows) {
      const t = tsNum(r[this.cols.ts])
      const bucket = Math.floor(t / 1000 / intervalSec) * intervalSec * 1000
      const px = this.pickPrice(r, fallbackToMid)
      const vol = num(r[this.cols.volume]) ?? 0
      if (px === undefined) continue

      if (bucket !== curBucket) {
        // close previous
        if (cur) {
          out.push(cur)
          if (emit) this.emit({ type: "bar", symbol: symbol.toUpperCase(), intervalSec, bar: { ...cur } })
        }
        curBucket = bucket
        const iso = new Date(bucket).toISOString()
        cur = { t: iso, o: px, h: px, l: px, c: px, v: vol }
      } else {
        cur!.h = Math.max(cur!.h, px)
        cur!.l = Math.min(cur!.l, px)
        cur!.c = px
        cur!.v += vol
      }
    }
    if (cur) {
      out.push(cur)
      if (emit) this.emit({ type: "bar", symbol: symbol.toUpperCase(), intervalSec, bar: { ...cur } })
    }
    return out
  }

  /** Convenience: return the most recent N bars (builds if not built yet). */
  recentBars(symbol: string, intervalSec: number, limit: number = 100): Bar[] {
    const all = this.resample(symbol, { intervalSec, emit: false })
    return all.length > limit ? all.slice(-limit) : all
  }

  /** Naive VWAP over a range: sum(p*v)/sum(v), where v defaults to 1 if volume missing. */
  vwap(symbol: string, from?: ISO8601 | number, to?: ISO8601 | number): number | undefined {
    const rows = this.range(symbol, from, to)
    let n = 0, d = 0
    for (const r of rows) {
      const px = this.pickPrice(r, true)
      if (px === undefined) continue
      const v = num(r[this.cols.volume]) ?? 1
      n += px * v
      d += v
    }
    if (d <= 0) return undefined
    return n / d
  }

  /** Rolling reduction over ticks (e.g., moving average). Returns series of { t, value }. */
  rolling<T = number>(
    symbol: string,
    window: number, // in ticks (not time)
    reducer: (windowRows: TickRow[]) => T,
    from?: ISO8601 | number,
    to?: ISO8601 | number
  ): Array<{ t: ISO8601; value: T }> {
    const rows = this.range(symbol, from, to)
    const out: Array<{ t: ISO8601; value: T }> = []
    const q: TickRow[] = []
    for (const r of rows) {
      q.push(r)
      if (q.length > window) q.shift()
      if (q.length === window) {
        const v = reducer(q)
        out.push({ t: toISO(r[this.cols.ts]), value: v })
      }
    }
    return out
  }

  /** Last time we ingested anything. */
  lastIngestTime(): ISO8601 | undefined {
    return this.lastIngestAt
  }

  // -------- Internals --------

  private _append(rows: TickRow[]): number {
    if (!rows || rows.length === 0) return 0
    // Normalize symbol casing and timestamp numbers; ensure per-symbol sort & append
    const bySym = new Map<string, TickRow[]>()
    for (const r of rows) {
      const sym = String(r[this.cols.symbol]).toUpperCase()
      const copy: TickRow = { ...r }
      copy[this.cols.symbol] = sym
      copy[this.cols.ts] = tsNum(copy[this.cols.ts])
      if (!bySym.has(sym)) bySym.set(sym, [])
      bySym.get(sym)!.push(copy)
    }

    let total = 0
    const touched: string[] = []
    for (const [sym, list] of bySym) {
      list.sort((a, b) => (a[this.cols.ts] as number) - (b[this.cols.ts] as number))
      const cur = this.bySymbol.get(sym) || []
      // Append while keeping sorted order (lists are sorted; cur is assumed sorted from previous ingests)
      // Fast path: if last cur ts <= first new ts, we can concat; else merge.
      if (!cur.length || (cur[cur.length - 1][this.cols.ts] as number) <= (list[0][this.cols.ts] as number)) {
        this.bySymbol.set(sym, cur.concat(list))
      } else {
        this.bySymbol.set(sym, mergeSorted(cur, list, this.cols.ts))
      }
      total += list.length
      touched.push(sym)
    }

    this.lastIngestAt = new Date().toISOString()
    this.emit({ type: "ingest", count: total, symbols: touched.sort(), ts: this.lastIngestAt })
    return total
  }

  private mapRow(r: any): TickRow {
    // Map arbitrary keys to canonical TickRow via column map
    const tsKey = this.cols.ts, symKey = this.cols.symbol
    const priceKey = this.cols.price, volKey = this.cols.volume, bidKey = this.cols.bid, askKey = this.cols.ask
    return {
      ...r,
      [tsKey]: r[tsKey] ?? r.ts ?? r.time ?? r.timestamp,
      [symKey]: r[symKey] ?? r.symbol ?? r.ticker,
      [priceKey]: num(r[priceKey] ?? r.price ?? r.close ?? r.last),
      [volKey]: num(r[volKey] ?? r.volume ?? r.vol),
      [bidKey]: num(r[bidKey] ?? r.bid),
      [askKey]: num(r[askKey] ?? r.ask),
    }
  }

  private valid(r: TickRow): boolean {
    const sym = r[this.cols.symbol]
    const tsVal = r[this.cols.ts]
    if (!sym || (!isFiniteNum(tsVal) && !isISO(String(tsVal)))) return false
    // price/bid/ask may be missing; we tolerate as long as at least one price proxy exists later
    return true
  }

  private pickPrice(r: TickRow, fallbackToMid: boolean): number | undefined {
    const px = num(r[this.cols.price])
    if (px !== undefined) return px
    if (!fallbackToMid) return undefined
    const bid = num(r[this.cols.bid])
    const ask = num(r[this.cols.ask])
    if (bid !== undefined && ask !== undefined) return (bid + ask) / 2
    if (bid !== undefined) return bid
    if (ask !== undefined) return ask
    return undefined
  }
}

// -------- Small helpers (no imports) --------

function mergeSorted(a: TickRow[], b: TickRow[], tsKey: string): TickRow[] {
  const out: TickRow[] = new Array(a.length + b.length)
  let i = 0, j = 0, k = 0
  while (i < a.length && j < b.length) {
    if ((a[i][tsKey] as number) <= (b[j][tsKey] as number)) out[k++] = a[i++]
    else out[k++] = b[j++]
  }
  while (i < a.length) out[k++] = a[i++]
  while (j < b.length) out[k++] = b[j++]
  return out
}

function num(x: any): number | undefined {
  if (x === null || x === undefined) return undefined
  const n = typeof x === "number" ? x : parseFloat(String(x))
  return isFinite(n) ? n : undefined
}

function isFiniteNum(x: any): x is number {
  return typeof x === "number" && isFinite(x)
}

function isISO(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s)
}

function tsNum(x: ISO8601 | number | undefined): number {
  if (x === undefined) return NaN
  if (typeof x === "number") return x
  const t = Date.parse(x)
  return isFinite(t) ? t : NaN
}

function toISO(x: ISO8601 | number): ISO8601 {
  const n = typeof x === "number" ? x : Date.parse(x)
  return new Date(n).toISOString()
}

function tryDecodeUtf8(buf: ArrayBuffer): string | undefined {
  try {
    // @ts-ignore: TextDecoder may not exist in all runtimes
    if (typeof TextDecoder === "function") {
      const dec = new TextDecoder("utf-8", { fatal: false })
      return dec.decode(new Uint8Array(buf))
    }
  } catch {}
  return undefined
}

function parseNDJSON(text: string): any[] {
  const out: any[] = []
  const lines = text.split(/\r?\n/)
  for (const ln of lines) {
    const s = ln.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch {}
  }
  return out
}

function parseCSV(text: string): any[] {
  const lines = text.split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) return []
  const header = splitCSVLine(lines[0])
  const idx = new Map<string, number>()
  header.forEach((h, i) => idx.set(h.trim(), i))
  const rows: any[] = []
  for (let i = 1; i < lines.length; i++) {
    const parts = splitCSVLine(lines[i])
    const obj: any = {}
    for (const [k, j] of idx) obj[k] = parts[j]
    // numeric coercion for common fields
    for (const k of Object.keys(obj)) {
      const v = obj[k]
      const asNum = parseFloat(v)
      if (!Number.isNaN(asNum) && /(^price$|^volume$|^bid$|^ask$|^close$|^open$|^high$|^low$|^v$)/i.test(k)) {
        obj[k] = asNum
      }
    }
    rows.push(obj)
  }
  return rows
}

function splitCSVLine(line: string): string[] {
  // minimal CSV splitter (no imports): handles quotes and commas
  const out: string[] = []
  let cur = ""
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++ } // escaped quote
      else inQ = !inQ
    } else if (ch === "," && !inQ) {
      out.push(cur); cur = ""
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map(s => s.trim())
}

function safeJSON(x: any): string {
  try { return JSON.stringify(x) } catch { return String(x) }
}

// -------- Example usage (comment out in production) --------
/*
const feed = new ParquetFeed()
// 1) Ingest NDJSON masquerading as "parquet" for demo:
const ndjson = `
{"ts":"2025-01-01T09:30:00Z","symbol":"AAPL","price":100,"volume":500}
{"ts":"2025-01-01T09:30:10Z","symbol":"AAPL","price":100.2,"volume":200}
{"ts":"2025-01-01T09:30:20Z","symbol":"AAPL","price":99.9,"volume":300}
`.trim()
await feed.ingestParquet(new TextEncoder().encode(ndjson).buffer)
// 2) Resample to 60s bars
console.log(feed.resample("AAPL", { intervalSec: 60 }))
// 3) VWAP across all
console.log("VWAP", feed.vwap("AAPL"))
*/

export { ParquetFeed }
