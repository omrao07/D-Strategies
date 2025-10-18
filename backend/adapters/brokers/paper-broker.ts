// brokers/paper broker.ts
// Pure TypeScript in-memory paper broker for fast local testing. Zero imports.
// Features:
// - Cash ledger, positions, simple P&L
// - Market/Limit/Stop/Stop-Limit orders (DAY/GTC/IOC/FOK)
// - Good-enough matching engine against a simulated tick stream or user-pushed quotes
// - Basic OHLCV history generator + LTP/quote endpoints
// - Deterministic RNG by symbol for reproducible tests
//
// Notes:
// - Time is wall-clock (new Date()) unless you feed `now` in public methods.
// - Prices are floats; no fees/slippage by default (configurable).
// - This is *not* exchange-accurate; it’s a pragmatic test double.

type ISO8601 = string

type Side = "BUY" | "SELL"
type TimeInForce = "DAY" | "GTC" | "IOC" | "FOK"
type OrderType = "MKT" | "LMT" | "STP" | "STP_LMT"

type PaperConfig = {
  baseCurrency?: string
  startingCash?: number
  feeBps?: number                // commission in bps of notional
  slippageBps?: number           // fill slippage in bps on market/marketable
  lotSize?: number               // default lot size when omitted (used by convenience)
  priceDecimals?: number         // rounding on fills/marks
  allowShort?: boolean
}

type OrderInput = {
  symbol: string
  side: Side
  qty: number
  type: OrderType
  tif?: TimeInForce
  limitPrice?: number
  stopPrice?: number
  clientOrderId?: string
  tag?: string
}

type OrderStatus =
  | "new" | "accepted" | "rejected"
  | "partially_filled" | "filled"
  | "canceled" | "expired"

type Order = {
  id: string
  clientOrderId?: string
  ts: ISO8601
  symbol: string
  side: Side
  qty: number
  leavesQty: number
  filledQty: number
  avgFillPrice?: number
  type: OrderType
  tif: TimeInForce
  limitPrice?: number
  stopPrice?: number
  status: OrderStatus
  tag?: string
  reason?: string
}

type Fill = {
  orderId: string
  ts: ISO8601
  symbol: string
  qty: number
  price: number
  side: Side
  notional: number
  fee: number
}

type Position = {
  symbol: string
  qty: number
  avgPrice: number
  realizedPnl: number
  unrealizedPnl: number
  marketPrice: number
  marketValue: number
}

type Account = {
  currency: string
  cash: number
  equity: number
  buyingPower: number
  dayPnl: number
  totalPnl: number
}

type Quote = {
  symbol: string
  last: number
  bid?: number
  ask?: number
  volume?: number
  ts: ISO8601
}

type Candle = { t: ISO8601; o: number; h: number; l: number; c: number; v: number }

type PushQuote = {
  symbol: string
  last?: number
  bid?: number
  ask?: number
  volume?: number
  ts?: ISO8601
}

type HistoricalQuery = {
  symbol: string
  interval: "1Min" | "5Min" | "15Min" | "1Hour" | "1Day"
  start?: ISO8601
  end?: ISO8601
  limit?: number
}

class PaperBroker {
  private cfg: Required<PaperConfig>
  private orders: Map<string, Order> = new Map()
  private fills: Fill[] = []
  private positions: Map<string, Position> = new Map()
  private cash: number
  private startCash: number
  private seq = 0
  private ltp: Map<string, Quote> = new Map()
  private ohlc: Map<string, Candle[]> = new Map() // synthetic candles
  private todayKey = dayISO(new Date())

  constructor(cfg: PaperConfig = {}) {
    this.cfg = {
      baseCurrency: cfg.baseCurrency ?? "USD",
      startingCash: cfg.startingCash ?? 100_000,
      feeBps: cfg.feeBps ?? 0,
      slippageBps: cfg.slippageBps ?? 0,
      lotSize: cfg.lotSize ?? 1,
      priceDecimals: cfg.priceDecimals ?? 2,
      allowShort: cfg.allowShort ?? true,
    }
    this.cash = this.cfg.startingCash
    this.startCash = this.cfg.startingCash
  }

  // ===== Public API =====

  account(now?: Date): Account {
    const t = now || new Date()
    this.markToMarket(t)
    const equity = this.cash + this.totalMarketValue()
    const bp = this.cfg.allowShort ? equity * 2 : this.cash * 2 // simple 2x
    return {
      currency: this.cfg.baseCurrency,
      cash: round(this.cash, 2),
      equity: round(equity, 2),
      buyingPower: round(bp, 2),
      dayPnl: round(this.dayPnl(), 2),
      totalPnl: round(equity - this.startCash, 2),
    }
  }

  listOrders(): Order[] {
    return Array.from(this.orders.values()).sort((a, b) => a.ts.localeCompare(b.ts))
  }

  listFills(): Fill[] {
    return [...this.fills]
  }

  listPositions(now?: Date): Position[] {
    this.markToMarket(now || new Date())
    return Array.from(this.positions.values()).map(p => ({ ...p }))
  }

  /** Push or override a quote for matching/marking. Useful for deterministic tests. */
  pushQuote(q: PushQuote): Quote {
    const prev = this.ltp.get(q.symbol)?.last ?? this.defaultPrice(q.symbol)
    const last = isFiniteN(q.last) ? q.last! : prev
    const bid = isFiniteN(q.bid) ? q.bid! : last * (1 - 0.0005)
    const ask = isFiniteN(q.ask) ? q.ask! : last * (1 + 0.0005)
    const out: Quote = { symbol: q.symbol, last: last, bid, ask, volume: q.volume, ts: (q.ts ? new Date(q.ts) : new Date()).toISOString() }
    this.ltp.set(q.symbol, out)
    this.appendOHLC(q.symbol, last, out.ts)
    this.matchAll(new Date(out.ts))
    return out
  }

  /** Get best-effort quote. If none exists, a synthetic path is generated. */
  quote(symbol: string, now?: Date): Quote {
    const t = now || new Date()
    const q = this.ltp.get(symbol) || this.syntheticQuote(symbol, t)
    return { ...q }
  }

  /** LTP/Quote for many symbols. */
  quotes(symbols: string[], now?: Date): Record<string, Quote> {
    const out: Record<string, Quote> = {}
    for (const s of symbols) out[s] = this.quote(s, now)
    return out
  }

  /** Historical candles (synthetic if not pushed). */
  historical(q: HistoricalQuery): Candle[] {
    const series = this.ensureSeries(q.symbol)
    const { startTs, endTs } = range(q.start, q.end)
    const out = series.filter(c => {
      const ts = Date.parse(c.t)
      return ts >= startTs && ts <= endTs
    })
    if (q.limit && out.length > q.limit) return out.slice(-q.limit)
    return out
  }

  /** Place an order. Returns the created order (which may be immediately filled). */
  placeOrder(input: OrderInput, now?: Date): Order {
    const t = now || new Date()
    this.rollDay(t)

    // Validate
    if (!input.symbol) return this.reject("symbol required", input, t)
    if (!isFiniteN(input.qty) || input.qty! <= 0) return this.reject("qty must be > 0", input, t)
    if (!["MKT","LMT","STP","STP_LMT"].includes(input.type)) return this.reject("unsupported order type", input, t)
    const tif: TimeInForce = input.tif ?? "DAY"
    if ((input.type === "LMT" || input.type === "STP_LMT") && !isFiniteN(input.limitPrice)) return this.reject("limitPrice required", input, t)
    if ((input.type === "STP" || input.type === "STP_LMT") && !isFiniteN(input.stopPrice)) return this.reject("stopPrice required", input, t)

    const ord: Order = {
      id: this.newId(),
      clientOrderId: input.clientOrderId,
      ts: t.toISOString(),
      symbol: input.symbol.toUpperCase(),
      side: input.side,
      qty: Math.floor(input.qty / this.cfg.lotSize) * this.cfg.lotSize || input.qty, // align lot
      leavesQty: input.qty,
      filledQty: 0,
      type: input.type,
      tif,
      limitPrice: input.limitPrice,
      stopPrice: input.stopPrice,
      status: "accepted",
      tag: input.tag,
    }

    // Immediate-or-cancel/fill-or-kill behaviour is handled inside matcher.
    this.orders.set(ord.id, ord)

    // Try instant match
    this.matchOne(ord, t)

    return { ...ord }
  }

  /** Cancel an active order. */
  cancelOrder(orderId: string, now?: Date): Order | undefined {
    const ord = this.orders.get(orderId)
    if (!ord) return undefined
    if (ord.status === "filled" || ord.status === "canceled" || ord.status === "expired" || ord.status === "rejected") {
      return { ...ord }
    }
    ord.status = "canceled"
    ord.leavesQty = Math.max(0, ord.qty - ord.filledQty)
    ord.ts = (now || new Date()).toISOString()
    return { ...ord }
  }

  /** Run matching against current quotes (call this in a loop/scheduler for sim time). */
  tick(symbols: string[] | undefined = undefined, now?: Date): void {
    const t = now || new Date()
    this.rollDay(t)
    const symList = symbols && symbols.length ? symbols : Array.from(new Set([...this.orders.values()].map(o => o.symbol)))
    for (const s of symList) {
      this.syntheticQuote(s, t) // advances path
    }
    this.matchAll(t)
  }

  // ===== Matching / Accounting =====

  private matchAll(now: Date): void {
    // Try fills for all live orders
    for (const ord of this.orders.values()) {
      if (ord.status === "accepted" || ord.status === "partially_filled" || ord.status === "new") {
        this.matchOne(ord, now)
      }
    }
    this.markToMarket(now)
  }

  private matchOne(ord: Order, now: Date): void {
    const q = this.quote(ord.symbol, now)
    let triggerOK = true
    if (ord.type === "STP" || ord.type === "STP_LMT") {
      if (ord.side === "BUY") triggerOK = q.last >= (ord.stopPrice ?? Number.POSITIVE_INFINITY)
      else triggerOK = q.last <= (ord.stopPrice ?? Number.NEGATIVE_INFINITY)
      if (!triggerOK) return
    }

    const marketable =
      ord.type === "MKT" ||
      (ord.type === "LMT" && this.isMarketableLimit(ord, q)) ||
      (ord.type === "STP_LMT" && this.isMarketableLimit(ord, q))

    if (!marketable) return

    // Determine fill price
    const px = this.fillPrice(ord, q)
    const canFillQty = this.availableQty(ord)
    const qty = Math.min(ord.leavesQty, canFillQty)
    if (qty <= 0) {
      // If cannot fill due to BP/short constraints -> reject remaining
      this.rejectInsufficient(ord, now)
      return
    }

    // IOC/FOK handling
    if (ord.tif === "FOK" && qty < ord.qty) return // wait for full
    if (ord.tif === "IOC" && qty <= 0) {
      ord.status = ord.filledQty > 0 ? "partially_filled" : "canceled"
      return
    }

    this.applyFill(ord, qty, px, now)

    // Post-fill state
    if (ord.filledQty >= ord.qty) {
      ord.status = "filled"
      ord.leavesQty = 0
    } else {
      ord.status = "partially_filled"
      ord.leavesQty = ord.qty - ord.filledQty
      if (ord.tif === "IOC") {
        // cancel rest
        ord.status = ord.filledQty > 0 ? "partially_filled" : "canceled"
        ord.leavesQty = 0
      }
    }
  }

  private isMarketableLimit(ord: Order, q: Quote): boolean {
    const lp = ord.limitPrice!
    if (ord.side === "BUY") return (q.ask ?? q.last) <= lp
    return (q.bid ?? q.last) >= lp
  }

  private fillPrice(ord: Order, q: Quote): number {
    const slip = (this.cfg.slippageBps / 10_000)
    const last = q.last
    let px = last
    if (ord.type === "LMT" || ord.type === "STP_LMT") {
      if (ord.side === "BUY") px = Math.min(ord.limitPrice!, (q.ask ?? last) * (1 + slip))
      else px = Math.max(ord.limitPrice!, (q.bid ?? last) * (1 - slip))
    } else {
      // market or stop -> use mid with slippage
      const mid = this.mid(q)
      if (ord.side === "BUY") px = mid * (1 + slip)
      else px = mid * (1 - slip)
    }
    return round(px, this.cfg.priceDecimals)
  }

  private availableQty(ord: Order): number {
    // Simple BP/short check
    const q = this.quote(ord.symbol)
    const px = this.fillPrice(ord, q)
    const notional = px * ord.leavesQty
    const fee = notional * (this.cfg.feeBps / 10_000)
    if (ord.side === "BUY") {
      const needed = notional + fee
      if (this.cash >= needed) return ord.leavesQty
      return Math.max(0, Math.floor(this.cash / (px * 1.0001))) // approximate
    } else {
      if (!this.cfg.allowShort) {
        // Can only sell up to position
        const pos = this.positions.get(ord.symbol)?.qty ?? 0
        return Math.max(0, Math.min(ord.leavesQty, pos))
      }
      // allowShort: assume margin available; cap by 2x equity heuristic
      const equity = this.cash + this.totalMarketValue()
      const capNotional = equity * 2
      return notional <= capNotional ? ord.leavesQty : Math.floor(capNotional / px)
    }
  }

  private applyFill(ord: Order, qty: number, price: number, now: Date): void {
    const sideMult = ord.side === "BUY" ? +1 : -1
    const notional = price * qty
    const fee = notional * (this.cfg.feeBps / 10_000)
    const pos = this.positions.get(ord.symbol) || {
      symbol: ord.symbol,
      qty: 0,
      avgPrice: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      marketPrice: price,
      marketValue: 0,
    }

    // Realized PnL on crossing the sign
    if (sideMult > 0) {
      // Buy: increasing qty or reducing short
      if (pos.qty < 0) {
        const cover = Math.min(qty, Math.abs(pos.qty))
        const pnl = (pos.avgPrice - price) * cover // short avg - buy px
        pos.realizedPnl += pnl
      }
      pos.avgPrice = weightedAvgPrice(pos.avgPrice, Math.abs(pos.qty), price, qty, pos.qty >= 0)
      pos.qty += qty
      this.cash -= notional + fee
    } else {
      // Sell
      if (pos.qty > 0) {
        const close = Math.min(qty, Math.max(0, pos.qty))
        const pnl = (price - pos.avgPrice) * close
        pos.realizedPnl += pnl
      }
      // If going short, avgPrice resets on sign change
      pos.avgPrice = weightedAvgPrice(pos.avgPrice, Math.abs(pos.qty), price, qty, pos.qty <= 0)
      pos.qty -= qty
      this.cash += notional - fee
    }

    pos.marketPrice = price
    pos.marketValue = pos.qty * price
    this.positions.set(ord.symbol, pos)

    // Order updates
    ord.filledQty += qty
    ord.avgFillPrice = avgPxAfter(ord.avgFillPrice, ord.filledQty - qty, price, qty)

    const fill: Fill = {
      orderId: ord.id,
      ts: now.toISOString(),
      symbol: ord.symbol,
      qty,
      price,
      side: ord.side,
      notional,
      fee: round(fee, 4),
    }
    this.fills.push(fill)
  }

  private reject(reason: string, input: OrderInput, now: Date): Order {
    const ord: Order = {
      id: this.newId(),
      clientOrderId: input.clientOrderId,
      ts: now.toISOString(),
      symbol: (input.symbol || "").toUpperCase(),
      side: input.side || "BUY",
      qty: input.qty || 0,
      leavesQty: 0,
      filledQty: 0,
      type: input.type,
      tif: input.tif ?? "DAY",
      limitPrice: input.limitPrice,
      stopPrice: input.stopPrice,
      status: "rejected",
      tag: input.tag,
      reason,
    }
    this.orders.set(ord.id, ord)
    return { ...ord }
  }

  private rejectInsufficient(ord: Order, now: Date): void {
    ord.status = ord.filledQty > 0 ? "partially_filled" : "rejected"
    ord.reason = ord.filledQty > 0 ? "insufficient capacity for remaining qty" : "insufficient buying power/shorting disabled"
    ord.leavesQty = Math.max(0, ord.qty - ord.filledQty)
    ord.ts = now.toISOString()
  }

  private markToMarket(now: Date): void {
    for (const p of this.positions.values()) {
      const q = this.quote(p.symbol, now)
      p.marketPrice = q.last
      p.marketValue = round(p.qty * q.last, 2)
      const dir = Math.sign(p.qty)
      p.unrealizedPnl = dir >= 0
        ? (q.last - p.avgPrice) * p.qty
        : (p.avgPrice - q.last) * Math.abs(p.qty)
    }
  }

  private dayPnl(): number {
    // crude day PnL: equity now - equity at start-of-day (assumed startCash + realized mark reset)
    // For simplicity, assume day start was when `todayKey` set; we don't store morning equity -> approximate with unrealized only changes
    let unreal = 0
    for (const p of this.positions.values()) unreal += p.unrealizedPnl
    let realized = 0
    for (const p of this.positions.values()) realized += p.realizedPnl
    return unreal + realized
  }

  private totalMarketValue(): number {
    let mv = 0
    for (const p of this.positions.values()) mv += p.marketValue
    return mv
  }

  // ===== Quote / Synthetic series =====

  private syntheticQuote(symbol: string, now: Date): Quote {
    const prev = this.ltp.get(symbol)
    const base = prev?.last ?? this.defaultPrice(symbol)
    const walk = this.noise(symbol, now) // multiplicative tiny step
    const last = Math.max(0.01, round(base * (1 + walk), this.cfg.priceDecimals))
    const bid = round(last * (1 - 0.0004), this.cfg.priceDecimals)
    const ask = round(last * (1 + 0.0004), this.cfg.priceDecimals)
    const out: Quote = { symbol, last, bid, ask, volume: Math.floor(10_000 * (1 + Math.abs(walk) * 20)), ts: now.toISOString() }
    this.ltp.set(symbol, out)
    this.appendOHLC(symbol, last, out.ts)
    return out
  }

  private defaultPrice(symbol: string): number {
    // cheap deterministic base from hash
    const h = hash(symbol)
    const base = 50 + (h % 300) // 50..349
    return round(base, this.cfg.priceDecimals)
  }

  private ensureSeries(symbol: string): Candle[] {
    let arr = this.ohlc.get(symbol)
    if (!arr) {
      arr = []
      this.ohlc.set(symbol, arr)
    }
    return arr
  }

  private appendOHLC(symbol: string, price: number, iso: ISO8601): void {
    const arr = this.ensureSeries(symbol)
    const t = truncToMinute(new Date(iso))
    const last = arr[arr.length - 1]
    if (last && last.t === t) {
      last.h = Math.max(last.h, price)
      last.l = Math.min(last.l, price)
      last.c = price
      last.v += Math.floor(1 + Math.abs(price - last.c) * 100)
    } else {
      arr.push({ t, o: price, h: price, l: price, c: price, v: 1 })
      if (arr.length > 10_000) arr.shift()
    }
  }

  private mid(q: Quote): number {
    if (isFiniteN(q.bid) && isFiniteN(q.ask)) return (q.bid! + q.ask!) / 2
    return q.last
  }

  // ===== Time/day roll =====

  private rollDay(now: Date): void {
    const k = dayISO(now)
    if (k !== this.todayKey) {
      this.todayKey = k
      // could snapshot day-open equity here for better dayPnL
    }
  }

  // ===== Utils =====

  private newId(): string {
    this.seq++
    return "PB-" + Date.now().toString(36) + "-" + this.seq.toString(36)
  }

  private noise(symbol: string, now: Date): number {
    // bounded random walk step +- ~8bps with slight mean reversion
    const seed = (hash(symbol) ^ (Math.floor(now.getTime() / 60000))) >>> 0
    const r = lcg(seed)
    const step = (r - 0.5) * 0.0016 // +/- 8 bps
    return step
  }
}

// ===== Helpers (no imports) =====

function round(n: number, d: number): number {
  const f = Math.pow(10, d)
  return Math.round(n * f) / f
}
function isFiniteN(x: any): x is number { return typeof x === "number" && isFinite(x) }

function dayISO(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10)
}

function truncToMinute(d: Date): ISO8601 {
  return new Date(Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    0, 0
  )).toISOString()
}

function range(start?: ISO8601, end?: ISO8601): { startTs: number; endTs: number } {
  const endTs = isFinite(Date.parse(end || "")) ? Date.parse(end!) : Date.now()
  const startTs = isFinite(Date.parse(start || "")) ? Date.parse(start!) : endTs - 30 * 24 * 3600 * 1000
  return { startTs, endTs }
}

function weightedAvgPrice(pxA: number, qtyA: number, pxB: number, qtyB: number, sameSide: boolean): number {
  if (!sameSide || qtyA === 0) return pxB
  const num = pxA * Math.abs(qtyA) + pxB * qtyB
  const den = Math.abs(qtyA) + qtyB
  return den > 0 ? num / den : 0
}

function avgPxAfter(prevAvg: number | undefined, prevQty: number, addPx: number, addQty: number): number {
  if (!prevAvg || prevQty <= 0) return addPx
  return (prevAvg * prevQty + addPx * addQty) / (prevQty + addQty)
}

function hash(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function lcg(seed: number): number {
  // returns [0,1)
  let x = seed >>> 0
  x = (1664525 * x + 1013904223) >>> 0
  return (x & 0xffffffff) / 0x100000000
}

// ===== Exports =====

export {
  PaperBroker,
  type PaperConfig,
  type OrderInput,
  type Order,
  type OrderStatus,
  type Fill,
  type Position,
  type Account,
  type Quote,
  type Candle,
  type HistoricalQuery,
}
