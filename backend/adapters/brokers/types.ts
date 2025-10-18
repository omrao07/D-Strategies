// brokers/types.ts
// Shared type system for broker adapters (Alpaca, IBKR, Kite, Paper, etc.).
// Pure TypeScript, zero imports. Keep in sync across adapters.

// ---------- Common primitives ----------

export type ISO8601 = string

export type Side = "BUY" | "SELL" | "buy" | "sell"
export type TimeInForce = "DAY" | "GTC" | "IOC" | "FOK" | "opg" | "cls" | "gtc" | "day" | "ioc" | "fok"
export type OrderType =
  | "MKT" | "LMT" | "STP" | "STP_LMT" | "MIT" | "MTL" | "REL" | "MOC" | "LOC"
  | "market" | "limit" | "stop" | "stop_limit" | "trailing_stop"
  | "MARKET" | "LIMIT" | "SL" | "SL-M"

export type Exchange =
  | "NSE" | "BSE" | "NFO" | "BFO" | "CDS" | "BCD" | "MCX"      // India
  | "NYSE" | "NASDAQ" | "AMEX" | "ARCA" | "BATS"               // US cash
  | "SMART" | "ISLAND" | "IEX" | "MEMX"                        // US smart/ECNs
  | "CME" | "CBOT" | "NYMEX" | "COMEX" | "ICE"                 // Futures
  | "TSE" | "LSE" | "SEHK" | "SSE" | "SZSE" | "JPX"            // Intl
  | string

export type Currency = "USD" | "INR" | "EUR" | "GBP" | "JPY" | "CNY" | "HKD" | "CAD" | "AUD" | string

/** Generic instrument identifier. Prefer "EXCHANGE:SYMBOL" for multi-venue brokers (e.g., "NSE:INFY"). */
export type Instrument = string

// ---------- Normalized order model ----------

export type NormalizedOrderStatus =
  | "new" | "accepted" | "pending_new" | "working"
  | "partially_filled" | "filled"
  | "canceled" | "expired" | "replaced" | "rejected"
  | "pending_cancel" | "pending_replace"
  | "stopped" | "done_for_day" | "error"

export type NormalizedOrder = {
  id: string                 // broker order id
  clientOrderId?: string
  parentOrderId?: string
  symbol: string             // e.g., "AAPL" or tradingsymbol
  instrument?: Instrument    // optional fully-qualified instrument (e.g., "NSE:INFY")
  exchange?: Exchange
  side: "BUY" | "SELL"
  type: "MKT" | "LMT" | "STP" | "STP_LMT" | "TRAIL" | "OTHER"
  tif: "DAY" | "GTC" | "IOC" | "FOK" | "OPG" | "CLS" | "OTHER"
  quantity: number
  filledQty: number
  leavesQty: number
  avgFillPrice?: number
  limitPrice?: number
  stopPrice?: number
  status: NormalizedOrderStatus
  tags?: string[]
  extendedHours?: boolean
  createdAt?: ISO8601
  submittedAt?: ISO8601
  updatedAt?: ISO8601
  filledAt?: ISO8601
  canceledAt?: ISO8601
  rejectedAt?: ISO8601
  raw?: Record<string, any>   // original broker payload for debugging
}

export type PlaceOrderInput = {
  symbol: string
  instrument?: Instrument
  exchange?: Exchange
  side: "BUY" | "SELL"
  type: "MKT" | "LMT" | "STP" | "STP_LMT" | "TRAIL"
  quantity?: number
  notional?: number
  tif?: "DAY" | "GTC" | "IOC" | "FOK" | "OPG" | "CLS"
  limitPrice?: number
  stopPrice?: number
  trailPrice?: number
  trailPercent?: number
  extendedHours?: boolean
  clientOrderId?: string
  tag?: string
  // broker-specific passthrough
  extra?: Record<string, any>
}

export type CancelResult = { id: string; status: "canceled" | "not_found" | "error"; message?: string }

// ---------- Portfolio & market types ----------

export type AccountSummary = {
  id?: string
  name?: string
  currency: Currency
  cash: number
  equity: number
  buyingPower?: number
  marginMultiplier?: number
  patternDayTrader?: boolean
  status?: string
  createdAt?: ISO8601
  raw?: Record<string, any>
}

export type Position = {
  symbol: string
  instrument?: Instrument
  exchange?: Exchange
  quantity: number       // signed, >0 long, <0 short
  avgEntryPrice: number
  marketPrice?: number
  marketValue?: number
  costBasis?: number
  unrealizedPnl?: number
  unrealizedPnlPct?: number
  realizedPnl?: number
  currency?: Currency
  raw?: Record<string, any>
}

export type Holding = {
  symbol: string
  quantity: number
  avgPrice: number
  lastPrice?: number
  pnl?: number
  currency?: Currency
  instrument?: Instrument
  exchange?: Exchange
  raw?: Record<string, any>
}

export type Quote = {
  symbol: string
  instrument?: Instrument
  last: number
  bid?: number
  ask?: number
  volume?: number
  ohlc?: { o: number; h: number; l: number; c: number }
  ts: ISO8601
  raw?: Record<string, any>
}

export type Candle = { t: ISO8601; o: number; h: number; l: number; c: number; v: number }

export type HistoricalQuery = {
  symbol: string
  instrument?: Instrument
  interval: "1Min" | "5Min" | "15Min" | "1Hour" | "1Day" | "week" | "month"
  start?: ISO8601
  end?: ISO8601
  limit?: number
  includeOI?: boolean
}

// ---------- Broker capabilities & interface ----------

export type BrokerCapabilities = {
  name: "alpaca" | "ibkr" | "kite" | "paper" | string
  paperTrading?: boolean
  supportsExtendedHours?: boolean
  supportsTrailing?: boolean
  supportsBrackets?: boolean
  markets?: Array<"equities" | "options" | "futures" | "fx" | "crypto" | string>
  exchanges?: Exchange[]
  rateLimits?: { rpm?: number; burst?: number }
}

export type BrokerEvent =
  | { type: "connected" | "disconnected" | "heartbeat"; ts: ISO8601 }
  | { type: "order_update"; order: NormalizedOrder }
  | { type: "fill"; orderId: string; symbol: string; qty: number; price: number; ts: ISO8601; raw?: any }
  | { type: "error"; message: string; code?: string; ts: ISO8601; raw?: any }

/**
 * Minimal broker client surface area to standardize adapters.
 * All methods return normalized shapes. Adapters may expose extra APIs separately.
 */
export interface BrokerClient {
  /** Unique name/id for this adapter instance (e.g., "alpaca-paper", "ibkr-local"). */
  id(): string

  /** Static capability descriptor. */
  capabilities(): BrokerCapabilities

  /** Optional event stream hook (polling adapters may no-op). */
  on?(listener: (e: BrokerEvent) => void): () => void

  // --- Portfolio ---
  account(): Promise<AccountSummary | undefined>
  positions(): Promise<Position[] | undefined>
  holdings?(): Promise<Holding[] | undefined>

  // --- Orders ---
  placeOrder(input: PlaceOrderInput): Promise<NormalizedOrder | undefined>
  cancelOrder(orderId: string): Promise<CancelResult>
  getOrder(orderId: string): Promise<NormalizedOrder | undefined>
  orders(params?: {
    status?: "open" | "closed" | "all"
    symbol?: string
    limit?: number
    from?: ISO8601
    to?: ISO8601
  }): Promise<NormalizedOrder[] | undefined>

  // --- Market Data (best-effort, may proxy to broker or local cache) ---
  quote(symbol: string): Promise<Quote | undefined>
  quotes?(symbols: string[]): Promise<Record<string, Quote> | undefined>
  historical?(q: HistoricalQuery): Promise<Candle[] | undefined>
}

// ---------- Normalization helpers (pure types + simple utils) ----------

/** Map various broker order types to normalized "core" set. */
export function normalizeOrderType(t: OrderType): NormalizedOrder["type"] {
  const s = String(t).toUpperCase()
  if (s === "MKT" || s === "MARKET") return "MKT"
  if (s === "LMT" || s === "LIMIT") return "LMT"
  if (s === "STP" || s === "SL" || s === "SL-M") return "STP"
  if (s === "STP_LMT" || s === "STOP_LIMIT") return "STP_LMT"
  if (s === "TRAIL" || s === "TRAILING_STOP") return "TRAIL"
  return "OTHER"
}

/** Map TIF strings to normalized set. */
export function normalizeTIF(tif?: TimeInForce): NormalizedOrder["tif"] {
  const s = String(tif || "DAY").toUpperCase()
  if (s === "DAY") return "DAY"
  if (s === "GTC") return "GTC"
  if (s === "IOC") return "IOC"
  if (s === "FOK") return "FOK"
  if (s === "OPG") return "OPG"
  if (s === "CLS") return "CLS"
  return "OTHER"
}

/** Uppercase side to "BUY"/"SELL". */
export function normalizeSide(side: Side): "BUY" | "SELL" {
  return String(side).toUpperCase() === "SELL" ? "SELL" : "BUY"
}

/** Create a normalized order skeleton from raw pieces. */
export function makeOrderSkeleton(p: {
  id: string
  symbol: string
  side: Side
  type: OrderType
  tif?: TimeInForce
  quantity: number
  filledQty?: number
  limitPrice?: number
  stopPrice?: number
  status?: NormalizedOrderStatus
  clientOrderId?: string
  exchange?: Exchange
  instrument?: Instrument
  timestamps?: Partial<Pick<NormalizedOrder, "createdAt" | "submittedAt" | "updatedAt" | "filledAt" | "canceledAt" | "rejectedAt">>
  raw?: Record<string, any>
}): NormalizedOrder {
  const filled = p.filledQty ?? 0
  return {
    id: p.id,
    clientOrderId: p.clientOrderId,
    symbol: p.symbol,
    instrument: p.instrument,
    exchange: p.exchange,
    side: normalizeSide(p.side),
    type: normalizeOrderType(p.type),
    tif: normalizeTIF(p.tif),
    quantity: p.quantity,
    filledQty: filled,
    leavesQty: Math.max(0, p.quantity - filled),
    limitPrice: isFiniteNum(p.limitPrice) ? p.limitPrice : undefined,
    stopPrice: isFiniteNum(p.stopPrice) ? p.stopPrice : undefined,
    status: p.status ?? "working",
    createdAt: p.timestamps?.createdAt,
    submittedAt: p.timestamps?.submittedAt,
    updatedAt: p.timestamps?.updatedAt,
    filledAt: p.timestamps?.filledAt,
    canceledAt: p.timestamps?.canceledAt,
    rejectedAt: p.timestamps?.rejectedAt,
    raw: p.raw,
  }
}

// ---------- Tiny runtime helpers (no imports) ----------

export function isFiniteNum(x: any): x is number {
  return typeof x === "number" && isFinite(x)
}

export function nowISO(): ISO8601 {
  return new Date().toISOString()
}
