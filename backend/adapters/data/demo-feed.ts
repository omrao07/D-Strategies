// data/demo feed.ts
// Dependency-free, deterministic synthetic market-data feed.
// - Emits ticks and builds OHLCV bars for configured intervals
// - Per-symbol config (base, drift, vol, spread, lot)
// - Works in Node or browser (no imports)

type ISO8601 = string

export type Tick = {
  ts: ISO8601
  symbol: string
  last: number
  bid?: number
  ask?: number
  volume?: number
}

export type Bar = { t: ISO8601; o: number; h: number; l: number; c: number; v: number }

export type FeedEvent =
  | { type: "tick"; data: Tick }
  | { type: "bar"; data: { symbol: string; intervalSec: number; bar: Bar } }
  | { type: "heartbeat"; ts: ISO8601 }

type Listener = (e: FeedEvent) => void

export type SymbolConfig = {
  base?: number              // starting price (auto if omitted)
  driftBpsPerMin?: number    // mean drift per minute (bps)
  volBpsPerStep?: number     // stddev per step (bps)
  spreadBps?: number         // quoted spread (bps)
  lot?: number               // synthetic volume scale
}

export type FeedConfig = {
  stepMs?: number                    // tick cadence when running
  barIntervalsSec?: number[]         // which bar intervals to build
  defaultSymbol?: SymbolConfig       // defaults for new symbols
  priceDecimals?: number
  maxBarsPerInterval?: number
  heartbeatMs?: number
}

class DemoFeed {
  private cfg: Required<FeedConfig>
  private timers: { tick?: any; hb?: any } = {}
  private live = false
  private listeners: Listener[] = []

  private symbols = new Map<
    string,
    {
      conf: Required<SymbolConfig>
      last: Tick
      bars: Map<number, Bar[]>
    }
  >()

  constructor(config: FeedConfig = {}) {
    this.cfg = {
      stepMs: config.stepMs ?? 250,
      barIntervalsSec:
        config.barIntervalsSec && config.barIntervalsSec.length
          ? config.barIntervalsSec
          : [60, 300],
      defaultSymbol: {
        base: config.defaultSymbol?.base,
        driftBpsPerMin: config.defaultSymbol?.driftBpsPerMin ?? 0,
        volBpsPerStep: config.defaultSymbol?.volBpsPerStep ?? 6, // ~0.06% per step
        spreadBps: config.defaultSymbol?.spreadBps ?? 8,
        lot: config.defaultSymbol?.lot ?? 10_000,
      },
      priceDecimals: config.priceDecimals ?? 2,
      maxBarsPerInterval: config.maxBarsPerInterval ?? 10_000,
      heartbeatMs: config.heartbeatMs ?? 1500,
    }
  }

  // ---- Control ----

  start(): void {
    if (this.live) return
    this.live = true
    this.loop()
    this.timers.hb = setInterval(
      () => this.emit({ type: "heartbeat", ts: nowISO() }),
      this.cfg.heartbeatMs
    )
  }

  stop(): void {
    this.live = false
    if (this.timers.tick) {
      clearTimeout(this.timers.tick)
      this.timers.tick = undefined
    }
    if (this.timers.hb) {
      clearInterval(this.timers.hb)
      this.timers.hb = undefined
    }
  }

  /** Advance a single synthetic step (useful for tests). */
  step(now?: Date): void {
    this.poke(undefined, now)
  }

  /** Force a single tick for a symbol (or all subscribed symbols). */
  poke(symbol?: string, now?: Date): void {
    const t = now || new Date()
    if (symbol) this.ensureSymbol(symbol)
    const list = symbol ? [symbol.toUpperCase()] : Array.from(this.symbols.keys())
    for (const s of list) this.genTick(s, t)
  }

  // ---- Symbols ----

  subscribe(symbol: string, conf: SymbolConfig = {}): void {
    this.ensureSymbol(symbol, conf)
  }

  unsubscribe(symbol: string): void {
    this.symbols.delete(symbol.toUpperCase())
  }

  setSymbolConfig(symbol: string, patch: Partial<SymbolConfig>): void {
    const key = symbol.toUpperCase()
    const st = this.symbols.get(key)
    if (!st) return
    
  }

  listSymbols(): string[] {
    return Array.from(this.symbols.keys())
  }

  // ---- Data access ----

  lastTick(symbol: string): Tick | undefined {
    const st = this.symbols.get(symbol.toUpperCase())
    return st ? { ...st.last } : undefined
  }

  /** Get bars for a symbol at a given interval (seconds). */
  bars(symbol: string, intervalSec: number, limit?: number): Bar[] {
    const st = this.symbols.get(symbol.toUpperCase())
    if (!st) return []
    const arr = st.bars.get(intervalSec) || []
    return limit && arr.length > limit ? arr.slice(-limit) : [...arr]
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

  // ---- Internals ----

  private loop(): void {
    if (!this.live) return
    const t = new Date()
    for (const key of this.symbols.keys()) this.genTick(key, t)
    this.timers.tick = setTimeout(() => this.loop(), this.cfg.stepMs)
  }

  private ensureSymbol(symbol: string, conf?: SymbolConfig): void {
    const key = symbol.toUpperCase()
    if (this.symbols.has(key)) return

    const c = { ...this.cfg.defaultSymbol, ...(conf || {}) }
    const base = isFiniteNum(c.base) ? (c.base as number) : this.defaultBase(key)
    

    const barMap = new Map<number, Bar[]>()
    for (const k of this.cfg.barIntervalsSec) barMap.set(k, [])

    this.symbols.set(key, {
        conf: c as Required<SymbolConfig>,
        last: this.makeTick(key, base, new Date(), c as Required<SymbolConfig>),
      bars: barMap,
    })
  

  
  }

  private genTick(symbol: string, now: Date): void {
    const st = this.symbols.get(symbol)!
    const nextPx = this.nextPrice(symbol, st.last.last, st.conf, now)
    const next = this.makeTick(symbol, nextPx, now, st.conf)
    st.last = next
    this.emit({ type: "tick", data: next })
    this.updateBars(symbol, next)
  }

  private makeTick(
    symbol: string,
    last: number,
    now: Date,
    conf: Required<SymbolConfig>
  ): Tick {
    const decimals = this.cfg.priceDecimals
    const spread = conf.spreadBps / 10_000
    const bid = round(last * (1 - spread / 2), decimals)
    const ask = round(last * (1 + spread / 2), decimals)
    const vol = this.syntheticVolume(symbol, last, conf)

    return {
      ts: now.toISOString(),
      symbol,
      last: round(last, decimals),
      bid,
      ask,
      volume: vol,
    }
  }

  private updateBars(symbol: string, tick: Tick): void {
    const st = this.symbols.get(symbol)!
    for (const interval of this.cfg.barIntervalsSec) {
      const arr = st.bars.get(interval)!
      const bucket = this.barBucket(new Date(tick.ts), interval)
      const last = arr[arr.length - 1]
      if (!last || last.t !== bucket) {
        arr.push({ t: bucket, o: tick.last, h: tick.last, l: tick.last, c: tick.last, v: tick.volume || 0 })
        if (arr.length > this.cfg.maxBarsPerInterval) arr.shift()
      } else {
        last.h = Math.max(last.h, tick.last)
        last.l = Math.min(last.l, tick.last)
        last.c = tick.last
        last.v += tick.volume || 0
      }
      // emit on every update for demo purposes
      const cur = arr[arr.length - 1]
      if (cur) this.emit({ type: "bar", data: { symbol, intervalSec: interval, bar: { ...cur } } })
    }
  }

  private barBucket(d: Date, intervalSec: number): ISO8601 {
    const ts = Math.floor(d.getTime() / 1000 / intervalSec) * intervalSec * 1000
    const t = new Date(ts)
    return new Date(
      Date.UTC(
        t.getUTCFullYear(),
        t.getUTCMonth(),
        t.getUTCDate(),
        t.getUTCHours(),
        t.getUTCMinutes(),
        t.getUTCSeconds(),
        0
      )
    ).toISOString()
  }

  private nextPrice(
    symbol: string,
    prev: number,
    conf: Required<SymbolConfig>,
    now: Date
  ): number {
    // geometric random walk: P_next = P_prev * (1 + drift + noise)
    const stepMin = this.cfg.stepMs / 60000
    const drift = (conf.driftBpsPerMin / 10_000) * stepMin
    const volStd = conf.volBpsPerStep / 10_000
    const z = this.normal01(symbol, now) // ~N(0,1) approx
    const move = drift + z * volStd
    const px = Math.max(0.01, prev * (1 + move))
    return px
  }

  private syntheticVolume(
    symbol: string,
    _price: number,
    conf: Required<SymbolConfig>
  ): number {
    const base = conf.lot
    // deterministic, symbol-based noise factor 1..(~3)
    const noise = Math.floor(Math.max(1, Math.abs(Math.sin(hash(symbol) % 360)) * 3))
    return base * noise
  }

  // ---- PRNG / Determinism ----

  private seed(symbol: string, now: Date): number {
    // minute-granular seed: stable within a minute, changes next minute
    const minute = Math.floor(now.getTime() / 60000)
    let h = 2166136261 >>> 0
    const s = symbol + "|" + minute.toString(36)
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return h >>> 0
  }

  private prng(seed: number): () => number {
    let x = seed >>> 0
    return () => {
      x ^= x << 13; x >>>= 0
      x ^= x >> 17; x >>>= 0
      x ^= x << 5;  x >>>= 0
      return (x & 0xffffffff) / 0x100000000
    }
  }

  private normal01(symbol: string, now: Date): number {
    const r = this.prng(this.seed(symbol, now))
    let u = r(); let v = r()
    u = u <= 1e-9 ? 1e-9 : u
    v = v <= 1e-9 ? 1e-9 : v
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }

  private defaultBase(symbol: string): number {
    const h = hash(symbol)
    const base = 50 + (h % 400) // 50..449
    return round(base, this.cfg.priceDecimals)
  }

  // ---- Events ----

  private emit(e: FeedEvent): void {
    for (const fn of this.listeners) {
      try { fn(e) } catch { /* ignore listener errors */ }
    }
  }
}

// ---- Small utilities (no imports) ----

function round(n: number, d: number): number {
  const f = Math.pow(10, d)
  return Math.round(n * f) / f
}
function isFiniteNum(x: any): x is number {
  return typeof x === "number" && isFinite(x)
}
function nowISO(): ISO8601 { return new Date().toISOString() }
function hash(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}


// pipelines/single.ts