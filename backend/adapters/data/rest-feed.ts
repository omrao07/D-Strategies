// data/rest feed.ts
// Minimal, dependency-free REST market-data feed that polls JSON/CSV endpoints and
// exposes a uniform tick/bar interface with listeners.
//
// Goals
// - Zero imports; works in browser/Node (uses global fetch; falls back to mock mode if absent)
// - Flexible endpoint templating per symbol: e.g. "https://api.example/quote?symbol={symbol}"
// - JSON or CSV autodetect; column mapping for price/bid/ask/volume/time
// - Polling with per-endpoint cadence, jitter, retry with exponential backoff
// - Dedup by (symbol, ts) so repeated responses don’t spam listeners
// - Resampling to OHLCV bars; VWAP; quick stats
//
// NOTE: This is a pragmatic test/feed adapter. Real vendor APIs differ (auth, pagination, limits).
// Plug your vendor specifics by customizing EndpointConfig/ColumnMap or overriding `parseResponse`.

type ISO8601 = string

export type ColumnMap = {
  ts?: string           // default "ts" | "time" | "timestamp"
  symbol?: string       // default "symbol" | "ticker"
  price?: string        // default "price" | "last" | "close"
  bid?: string          // default "bid"
  ask?: string          // default "ask"
  volume?: string       // default "volume" | "vol"
}

export type EndpointConfig = {
  /** URL template. {symbol} and {interval} will be replaced. */
  url: string
  /** HTTP method (GET default). If POST, bodyTemplate is used below. */
  method?: "GET" | "POST"
  /** Extra headers (e.g., { Authorization: "Bearer …" }). */
  headers?: Record<string, string>
  /** POST body template. {symbol}/{interval} interpolated; otherwise literal JSON string. */
  bodyTemplate?: string
  /** Poll cadence in milliseconds (per symbol). */
  intervalMs?: number
  /** Optional jitter ratio (0..1) to spread out calls; 0.2 → ±20%. */
  jitter?: number
  /** Maximum rows to keep per symbol to bound memory. */
  maxRows?: number
  /** How to interpret data: "auto" (default), "json", "csv" */
  format?: "auto" | "json" | "csv"
  /** Column mapping when vendor keys differ. */
  columns?: ColumnMap
  /** If the endpoint returns an envelope, provide a JSON pointer-ish selector (e.g., "data.items"). */
  jsonPath?: string
}

export type FeedConfig = {
  quotes: EndpointConfig        // required: quote/tick endpoint
  candles?: EndpointConfig      // optional: prebuilt OHLC endpoint (used by `recentBars` if present)
  defaultColumns?: ColumnMap    // fallback columns for both endpoints
  timeoutMs?: number
  retries?: number
  backoffBaseMs?: number
  softFail?: boolean            // swallow network errors and just skip until next tick
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
  | { type: "heartbeat"; ts: ISO8601 }
  | { type: "error"; ts: ISO8601; message: string; endpoint?: string; symbol?: string }

type Listener = (e: FeedEvent) => void

class RestFeed {
  private cfg: Required<FeedConfig>
  private timers = new Map<string, any>() // symbol -> interval handle
  private listeners: Listener[] = []
  private store = new Map<string, Tick[]>() // symbol -> ticks sorted by ts
  private seen = new Set<string>()          // dedup key: symbol|ts|price

  constructor(config: FeedConfig) {
    if (!config?.quotes?.url) throw new Error("quotes endpoint.url is required")
    this.cfg = {
      quotes: { ...config.quotes },
      candles: config.candles ? { ...config.candles } : undefined as any,
      defaultColumns: config.defaultColumns || {},
      timeoutMs: config.timeoutMs ?? 12_000,
      retries: config.retries ?? 2,
      backoffBaseMs: config.backoffBaseMs ?? 120,
      softFail: !!config.softFail,
    } as Required<FeedConfig>
    // sensible defaults
    this.cfg.quotes.intervalMs ??= 1_000
    this.cfg.quotes.jitter ??= 0.2
    this.cfg.quotes.format ??= "auto"
    this.cfg.quotes.maxRows ??= 50_000
    if (this.cfg.candles) {
      this.cfg.candles.intervalMs ??= 10_000
      this.cfg.candles.jitter ??= 0.2
      this.cfg.candles.format ??= "auto"
      this.cfg.candles.maxRows ??= 50_000
    }
  }

  // ---- Public API ----

  /** Begin polling a symbol for quotes (and candles if configured). */
  start(symbol: string): void {
    const key = symbol.toUpperCase()
    if (this.timers.has(key)) return
    // Run once immediately, then schedule
    this.pollQuotes(key)
    const handle = setInterval(() => this.pollQuotes(key), this.withJitter(this.cfg.quotes.intervalMs!, this.cfg.quotes.jitter!))
    this.timers.set(key, handle)
    // Optional candles polling
    if (this.cfg.candles?.url) {
      const cKey = key + ".__candles__"
      this.pollCandles(key)
      const cHandle = setInterval(() => this.pollCandles(key), this.withJitter(this.cfg.candles.intervalMs!, this.cfg.candles.jitter!))
      this.timers.set(cKey, cHandle)
    }
  }

  /** Stop polling a symbol. */
  stop(symbol: string): void {
    const key = symbol.toUpperCase()
    const h = this.timers.get(key)
    if (h) { clearInterval(h); this.timers.delete(key) }
    const cKey = key + ".__candles__"
    const hc = this.timers.get(cKey)
    if (hc) { clearInterval(hc); this.timers.delete(cKey) }
  }

  /** Stop all. */
  stopAll(): void {
    for (const h of this.timers.values()) clearInterval(h)
    this.timers.clear()
  }

  /** Subscribe an event listener. Returns an unsubscribe fn. */
  on(fn: Listener): () => void {
    this.listeners.push(fn)
    return () => this.off(fn)
  }
  off(fn: Listener): void {
    const i = this.listeners.indexOf(fn)
    if (i >= 0) this.listeners.splice(i, 1)
  }

  /** Last tick for symbol (if any). */
  lastTick(symbol: string): Tick | undefined {
    const rows = this.store.get(symbol.toUpperCase())
    if (!rows || !rows.length) return undefined
    return { ...rows[rows.length - 1] }
  }

 

  /** Resample stored ticks into bars. */
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

  /** Convenience: either use vendor candle endpoint (if configured) or resample locally. */
  async recentBars(symbol: string, intervalSec: number, limit = 100): Promise<Bar[]> {
    if (this.cfg.candles?.url) {
      try {
        const rows = await this.fetchOnce(this.cfg.candles, symbol, { intervalSec })
        const parsed = this.parseBarsFromCandles(rows, symbol, intervalSec)
        return parsed.length > limit ? parsed.slice(-limit) : parsed
      } catch {
        // fall back to local resample
      }
    }
    const all = this.resample(symbol, intervalSec)
    return all.length > limit ? all.slice(-limit) : all
  }

  /** VWAP over stored ticks in window. */
  vwap(symbol: string, from?: ISO8601 | number, to?: ISO8601 | number): number | undefined {
    const rows = this.store.get(symbol.toUpperCase()) || []
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

  // ---- Internals ----

  private async pollQuotes(symbol: string): Promise<void> {
    try {
      const rows = await this.fetchOnce(this.cfg.quotes, symbol)
      const ticks = this.parseTicks(rows, symbol, this.cfg.quotes.columns || this.cfg.defaultColumns)
      if (ticks.length) this.append(symbol, ticks, this.cfg.quotes.maxRows!)
    } catch (e: any) {
      this.handleErr(e, this.cfg.quotes.url, symbol)
      if (!this.cfg.softFail) throw e
    }
  }

  private async pollCandles(symbol: string): Promise<void> {
    try {
      const rows = await this.fetchOnce(this.cfg.candles, symbol)
      const bars = this.parseBarsFromCandles(rows, symbol)
      // emit most recent as event (optional)
      const last = bars[bars.length - 1]
      if (last) {
        this.emit({ type: "bar", data: { symbol: symbol.toUpperCase(), intervalSec: guessIntervalSec(bars), bar: last } })
      }
    } catch (e: any) {
      this.handleErr(e, this.cfg.candles.url, symbol)
      if (!this.cfg.softFail) throw e
    }
  }

  private async fetchOnce(endpoint: EndpointConfig, symbol: string, extra?: { intervalSec?: number }): Promise<any> {
    const has = typeof (globalThis as any).fetch === "function"
    if (!has) return this.mockPayload(endpoint, symbol, extra)

    const url = this.interpolate(endpoint.url, symbol, extra?.intervalSec)
    const method = endpoint.method || "GET"
    const headers = endpoint.headers || {}
    let body: string | undefined
    if (method === "POST" && endpoint.bodyTemplate) {
      body = this.interpolate(endpoint.bodyTemplate, symbol, extra?.intervalSec)
      // try to detect JSON body & set header if not set
      if (!headers["Content-Type"] && looksLikeJson(body)) headers["Content-Type"] = "application/json"
    }

    let lastErr: any
    for (let attempt = 0; attempt <= (this.cfg.retries ?? 0); attempt++) {
      const ctl = newAbort(this.cfg.timeoutMs)
      try {
        const res = await (globalThis as any).fetch(url, { method, headers, body, signal: ctl.signal } as any)
        const buf = await res.arrayBuffer()
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status} ${res.statusText}: ${decodeUtf8(buf)?.slice(0, 200) || ""}`)
          if (isRetryable(res.status) && attempt < this.cfg.retries) {
            await delay(backoff(this.cfg.backoffBaseMs, attempt))
            continue
          }
          throw lastErr
        }
        return this.autoDecode(buf, endpoint.format || "auto")
      } catch (e) {
        lastErr = e
        if (attempt < this.cfg.retries) {
          await delay(backoff(this.cfg.backoffBaseMs, attempt))
          continue
        }
        throw lastErr
      }
    }
    throw lastErr
  }

  private parseTicks(rows: any, symbol: string, columns?: ColumnMap): Tick[] {
    // Accept: an array of objects; an object with array under jsonPath; a single object
    const arr = toArray(rows, this.cfg.quotes.jsonPath)
    const c = this.resolveCols(columns)
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
    return out
  }

  private parseBarsFromCandles(rows: any, symbol: string, intervalSec?: number): Bar[] {
    const arr = toArray(rows, this.cfg.candles?.jsonPath)
    const c = this.resolveCols(this.cfg.candles?.columns || this.cfg.defaultColumns)
    // Accept either candle objects with o/h/l/c/v and t, or ticks we can resample
    const looksLikeCandles = arr.length && ("o" in arr[0] || ("open" in arr[0] && "high" in arr[0]))
    if (looksLikeCandles) {
      const bars: Bar[] = []
      for (const r of arr) {
        const t = toISO(r["t"] ?? r[c.ts] ?? r["time"])
        const o = num(r["o"] ?? r["open"])
        const h = num(r["h"] ?? r["high"])
        const l = num(r["l"] ?? r["low"])
        const close = num(r["c"] ?? r["close"])
        const v = num(r["v"] ?? r["volume"])
        if (t && isFiniteNum(o) && isFiniteNum(h) && isFiniteNum(l) && isFiniteNum(close)) {
          bars.push({ t, o, h, l, c: close, v: v ?? 0 })
        }
      }
      bars.sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
      return bars
    }
    // else treat as ticks and resample
    const ticks = this.parseTicks(arr, symbol, this.cfg.candles?.columns || this.cfg.defaultColumns)
    const key = symbol.toUpperCase()
    this.append(key, ticks, this.cfg.candles?.maxRows ?? 50_000)
    return this.resample(key, intervalSec ?? 60)
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
      // emit tick
      this.emit({ type: "tick", data: { ...t } })
    }
    cur.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    // bound memory
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

  private resolveCols(p?: ColumnMap): Required<ColumnMap> {
    const d = this.cfg.defaultColumns || {}
    const out: Required<ColumnMap> = {
      ts: p?.ts || d.ts || "ts",
      symbol: p?.symbol || d.symbol || "symbol",
      price: p?.price || d.price || "price",
      bid: p?.bid || d.bid || "bid",
      ask: p?.ask || d.ask || "ask",
      volume: p?.volume || d.volume || "volume",
    }
    return out
  }

  private interpolate(tpl: string, symbol: string, intervalSec?: number): string {
    return tpl
      .replaceAll("{symbol}", encodeURIComponent(symbol))
      .replaceAll("{interval}", encodeURIComponent(String(intervalSec ?? "")))
  }

  private autoDecode(buf: ArrayBuffer, format: "auto" | "json" | "csv"): any {
    if (format === "json") return safeJsonDecode(buf)
    if (format === "csv") return csvToObjects(decodeUtf8(buf) || "")
    // auto: try JSON → CSV → text
    const j = safeJsonDecode(buf)
    if (j !== undefined) return j
    const text = decodeUtf8(buf) || ""
    if (/[,;\n]/.test(text) && /(\bts\b|\btime\b|\btimestamp\b).*?(\bsymbol\b|\bticker\b)/i.test(text.split(/\r?\n/, 1)[0] || "")) {
      return csvToObjects(text)
    }
    return text
  }

  private withJitter(ms: number, jitter: number): number {
    const r = (Math.random() * 2 - 1) * (jitter || 0) // -j..+j
    return Math.max(50, Math.round(ms * (1 + r)))
  }

  private emit(e: FeedEvent): void {
    for (const fn of this.listeners) {
      try { fn(e) } catch { /* swallow */ }
    }
  }

  private handleErr(e: any, endpoint: string, symbol?: string): void {
    this.emit({ type: "error", ts: new Date().toISOString(), message: String(e?.message || e), endpoint, symbol })
  }

  // ---- Mocks (only used if fetch is unavailable) ----

  private mockPayload(endpoint: EndpointConfig, symbol: string, extra?: { intervalSec?: number }): any {
    // Tiny synthetic tick/candle generator for offline demos
    const now = Date.now()
    if (endpoint === this.cfg.quotes) {
      const last = 100 + (hash(symbol) % 50)
      return [{ ts: new Date(now).toISOString(), symbol, last, bid: last - 0.05, ask: last + 0.05, volume: 1000 }]
    }
    if (endpoint === this.cfg.candles) {
      const bars: any[] = []
      const base = 100 + (hash(symbol) % 50)
      const step = (extra?.intervalSec ?? 60) * 1000
      for (let i = 20; i >= 1; i--) {
        const t = now - i * step
        const o = base + i * 0.1
        bars.push({ t: new Date(t).toISOString(), o, h: o + 1, l: o - 1, c: o + 0.5, v: 1000 + i })
      }
      return bars
    }
    return []
  }
}

// ---- Small utilities (no imports) ----

function pickPx(t: Tick): number | undefined {
  if (isFiniteNum(t.price)) return t.price!
  const b = t.bid, a = t.ask
  if (isFiniteNum(b) && isFiniteNum(a)) return (b! + a!) / 2
  return isFiniteNum(b) ? b : isFiniteNum(a) ? a : undefined
}

function toArray(x: any, path?: string): any[] {
  let v = x
  if (path) {
    for (const k of path.split(".").filter(Boolean)) {
      v = v?.[k]
    }
  }
  if (Array.isArray(v)) return v
  if (v === undefined || v === null) return []
  return [v]
}

function num(x: any): number | undefined {
  if (x === null || x === undefined) return undefined
  const n = typeof x === "number" ? x : parseFloat(String(x))
  return isFinite(n) ? n : undefined
}

function isFiniteNum(x: any): x is number {
  return typeof x === "number" && isFinite(x)
}

function toISO(x: any): ISO8601 | undefined {
  if (typeof x === "string" && /^\d{4}-\d{2}-\d{2}T/.test(x)) return new Date(x).toISOString()
  const t = num(x)
  if (t !== undefined) return new Date(t).toISOString()
  return undefined
}

function looksLikeJson(s: string): boolean {
  const t = s.trim()
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))
}

function decodeUtf8(buf: ArrayBuffer): string | undefined {
  try {
    // @ts-ignore
    const dec = new TextDecoder("utf-8", { fatal: false })
    return dec.decode(new Uint8Array(buf))
  } catch { return undefined }
}

function safeJsonDecode(buf: ArrayBuffer): any {
  try {
    const text = decodeUtf8(buf)
    if (!text) return undefined
    return JSON.parse(text)
  } catch { return undefined }
}

function csvToObjects(text: string): any[] {
  const lines = text.split(/\r?\n/).filter(Boolean)
  if (!lines.length) return []
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
      const asNum = parseFloat(obj[k])
      if (!Number.isNaN(asNum) && /(^price$|^last$|^close$|^bid$|^ask$|^volume$|^vol$|^o$|^h$|^l$|^c$|^v$)/i.test(k)) {
        obj[k] = asNum
      }
    }
    rows.push(obj)
  }
  return rows
}

function splitCSVLine(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++ } else inQ = !inQ
    } else if (ch === "," && !inQ) {
      out.push(cur); cur = ""
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map(s => s.trim())
}

function isRetryable(code: number): boolean {
  return code === 408 || code === 425 || code === 429 || (code >= 500 && code <= 599)
}

function delay(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms))
}

function backoff(base: number, attempt: number): number {
  const jitter = Math.floor(Math.random() * base)
  return base * Math.pow(2, Math.max(0, attempt)) + jitter
}

function newAbort(timeoutMs: number): AbortController {
  const ctl = new (globalThis as any).AbortController()
  const t = setTimeout(() => { try { ctl.abort() } catch {} }, Math.max(1, timeoutMs))
  ctl.signal.addEventListener?.("abort", () => { try { clearTimeout(t) } catch {} })
  return ctl
}

function hash(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

function guessIntervalSec(bars: Bar[]): number {
  if (bars.length < 2) return 60
  const a = Date.parse(bars[0].t), b = Date.parse(bars[1].t)
  return Math.max(1, Math.round((b - a) / 1000))
}

// ---- Exports ----

