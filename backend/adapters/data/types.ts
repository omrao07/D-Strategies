// data/types.ts
// Shared primitives + lightweight utilities for market-data feeds (demo/parquet/rest/sql/paper).
// Pure TypeScript, zero imports. Keep this file dependency-free and small.

// ---------- Primitives ----------

export type ISO8601 = string

/** Canonical tick shape (superset most feeds can produce). */
export type Tick = {
  ts: ISO8601
  symbol: string
  /** Trade/last price if available. */
  price?: number
  /** Best bid/ask if available. */
  bid?: number
  ask?: number
  /** Trade size or rolling volume (vendor-dependent). */
  volume?: number
  /** Raw vendor row for debugging. */
  raw?: Record<string, any>
}

/** Canonical OHLCV candle. */
export type Bar = { t: ISO8601; o: number; h: number; l: number; c: number; v: number }

/** Column mapping hint when parsing vendor payloads. */
export type ColumnMap = {
  ts?: string
  symbol?: string
  price?: string
  bid?: string
  ask?: string
  volume?: string
}

/** Unified feed event stream. */
export type FeedEvent =
  | { type: "tick"; data: Tick }
  | { type: "bar"; data: { symbol: string; intervalSec: number; bar: Bar } }
  | { type: "heartbeat"; ts: ISO8601 }
  | { type: "error"; ts: ISO8601; message: string; endpoint?: string; symbol?: string; phase?: string }
  | { type: "ingest"; count: number; symbols: string[]; ts: ISO8601 }

/** Resampling configuration. */
export type ResampleOptions = {
  intervalSec: number
  /** When price is missing, use (bid+ask)/2 if true (default true). */
  fallbackToMid?: boolean
}

/** Rolling window helper for analytics. */
export type RollingWindow<T = number> = {
  /** Window size (in ticks). */
  size: number
  /** Current filled length (≤ size). */
  filled: number
  /** Push a new value; returns the evicted value (if any). */
  push(value: T): T | undefined
  /** Clear the window. */
  clear(): void
  /** Snapshot copy of current values (oldest→newest). */
  values(): T[]
}

/** Common interface for our feed adapters (DemoFeed, RestFeed, ParquetFeed, SQLFeed, PaperBroker-as-feed). */
export interface DataFeed {
  /** Subscribe to events. Returns an unsubscribe function. */
  on(fn: (e: FeedEvent) => void): () => void
  /** Optional: remove a listener explicitly. */
  off?(fn: (e: FeedEvent) => void): void

  /** Begin streaming/polling a symbol (if applicable). */
  start?(symbol: string): void
  /** Stop streaming/polling a symbol (if applicable). */
  stop?(symbol: string): void
  /** Stop all activity (if applicable). */
  stopAll?(): void

  /** Pull APIs (best-effort). */
  lastTick(symbol: string): Tick | undefined
  range(symbol: string, from?: ISO8601 | number, to?: ISO8601 | number): Tick[]
  resample(symbol: string, intervalSec: number): Bar[]
  /** Convenience: many feeds implement a more efficient recent-bar path. */
  recentBars?(symbol: string, intervalSec: number, limit?: number): Promise<Bar[]> | Bar[]
  /** VWAP over stored ticks/time window. */
  vwap?(symbol: string, from?: ISO8601 | number, to?: ISO8601 | number): number | undefined
}

// ---------- Normalization helpers ----------

/** True if x is a finite number. */
export function isFiniteNum(x: any): x is number {
  return typeof x === "number" && isFinite(x)
}

/** Parse an ISO/date-like or epoch millis into ISO8601. Returns undefined on failure. */
export function toISO(x: any): ISO8601 | undefined {
  if (x === null || x === undefined) return undefined
  if (typeof x === "string") {
    const t = Date.parse(x)
    if (isFinite(t)) return new Date(t).toISOString()
  }
  const n = typeof x === "number" ? x : parseFloat(String(x))
  if (isFinite(n)) return new Date(n).toISOString()
  return undefined
}

/** Convert ISO8601 or epoch-millis to number (ms since epoch). Returns NaN on failure. */
export function tsNum(x: ISO8601 | number | undefined): number {
  if (x === undefined) return NaN
  if (typeof x === "number") return x
  const t = Date.parse(x)
  return isFinite(t) ? t : NaN
}

/** Choose a best-effort price from a Tick. Uses price, else mid(bid,ask), else bid/ask. */
export function pickPx(t: Pick<Tick, "price" | "bid" | "ask">): number | undefined {
  if (isFiniteNum(t.price)) return t.price as number
  const b = t.bid, a = t.ask
  if (isFiniteNum(b) && isFiniteNum(a)) return (b! + a!) / 2
  return isFiniteNum(b) ? (b as number) : isFiniteNum(a) ? (a as number) : undefined
}

/** Simple in-memory resampler for a tick array (already sorted by ts). */
export function resampleTicks(ticks: Tick[], opts: ResampleOptions): Bar[] {
  const intervalSec = Math.max(1, Math.floor(opts.intervalSec))
  const fallback = opts.fallbackToMid !== false
  const out: Bar[] = []
  let cur: Bar | undefined
  let bucket = -1
  for (const r of ticks) {
    const px = isFiniteNum(r.price) ? (r.price as number)
      : fallback ? pickPx(r) : undefined
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

/** Compute VWAP over ticks (defaults each tick's volume to 1 when absent). */
export function vwapOfTicks(ticks: Tick[]): number | undefined {
  let n = 0, d = 0
  for (const r of ticks) {
    const px = pickPx(r)
    if (px === undefined) continue
    const v = isFiniteNum(r.volume) ? (r.volume as number) : 1
    n += px * v
    d += v
  }
  return d > 0 ? n / d : undefined
}

/** Guess bar interval (seconds) from a sequence of bars (fallback 60s). */
export function guessIntervalSec(bars: Bar[]): number {
  if (bars.length < 2) return 60
  const a = Date.parse(bars[0].t), b = Date.parse(bars[1].t)
  return Math.max(1, Math.round((b - a) / 1000))
}

// ---------- Rolling window helper ----------

export function createRollingWindow<T = number>(size: number): RollingWindow<T> {
  const n = Math.max(1, Math.floor(size))
  const buf = new Array<T>(n)
  let head = 0
  let len = 0
  return {
    size: n,
    get filled() { return len },
    push(value: T) {
      const evicted = len === n ? buf[head] : undefined
      buf[head] = value
      head = (head + 1) % n
      if (len < n) len++
      return evicted
    },
    clear() { head = 0; len = 0 },
    values() {
      const out: T[] = []
      for (let i = 0; i < len; i++) {
        const idx = (head - len + i + n) % n
        out.push(buf[idx])
      }
      return out
    }
  }
}

// ---------- Lightweight stats helpers (optional) ----------

export type BasicStats = { count: number; min?: number; max?: number; mean?: number; std?: number }

/** Stats over an array of numbers. */
export function stats(xs: number[]): BasicStats {
  const n = xs.length
  if (!n) return { count: 0 }
  let min = xs[0], max = xs[0], sum = 0
  for (const x of xs) { if (x < min) min = x; if (x > max) max = x; sum += x }
  const mean = sum / n
  let s = 0
  for (const x of xs) s += (x - mean) * (x - mean)
  const std = Math.sqrt(s / Math.max(1, n - 1))
  return { count: n, min, max, mean, std }
}

/** Extract a numeric series from ticks by a selector and produce stats. */
export function tickStats(ticks: Tick[], select: (t: Tick) => number | undefined): BasicStats {
  const xs: number[] = []
  for (const t of ticks) {
    const v = select(t)
    if (isFiniteNum(v)) xs.push(v as number)
  }
  return stats(xs)
}
/** Save a 2D array as CSV (with header). */
export function toCSV(rows: Array<Record<string, any>>): string {
  if (!rows.length) return ""
  const headers = Object.keys(rows[0])
  const lines = [headers.join(",")]
  for (const r of rows) {
    const line = headers.map(h => {
      const v = r[h]
      if (v === null || v === undefined) return ""
      const s = String(v)
      return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s
    }).join(",")
    lines.push(line)
  }
  return lines.join("\n") + "\n"
}


/* ---------------- grid pipeline ---------------- */
//  • parses CLI args like --param name:v1,v2,v3 --out=outputs/grid.csv --strategy=examples.my_strategy --start=2024-01-01 --end=2024-12-31
//  • runs the specified strategy over all param combos
//  • saves each run's detailed results to outputs/runs/{timestamp}-{paramcombo}.json
//  • saves each run's equity curve to outputs/curves/{timestamp}-{paramcombo}.csv
//  • prints a small ASCII chart of each run's equity curve to console
//  • writes a summary CSV (params + metrics) to --out

import * as fs from "fs";
import * as path from "path";

/* ---------------- small utils ---------------- */
type Dict<T = any> = Record<string, T>;
const asStr = (x: any, d = "") => (typeof x === "string" ? x : d    );  