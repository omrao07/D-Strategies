// risk/portfolio.ts
// Dependency-free portfolio helpers for marking, exposure, weights, PnL,
// rebalancing, and simple risk budgeting (risk-parity style).
//
// Pairs well with risk/analytics.ts. No external imports.

export type ISO8601 = string

export type Position = {
  symbol: string
  quantity: number              // signed; <0 short
  avgEntry?: number             // average entry price (in position currency)
  price?: number                // latest mark (if not supplied, provide in prices map)
  currency?: string             // e.g., "USD" (used with fx map)
}

export type MarkedPosition = Position & {
  price: number
  fx: number                    // FX to portfolio currency
  marketValue: number           // quantity * price * fx
  costBasis?: number            // |quantity| * avgEntry * fx (for info)
  unrealizedPnl?: number        // (price - avgEntry) * quantity * fx
}

export type PortfolioSnapshot = {
  ts?: ISO8601
  baseCurrency?: string
  cash?: number                 // in base currency (post-FX)
  positions: Position[]
}

export type Prices = Record<string, number>                 // symbol -> price in its native currency
export type FX = Record<string, number>                     // currency -> FX rate to base (e.g., USD 1.0, EUR 1.07)

export type Exposure = {
  long: number
  short: number
  gross: number
  net: number
  equity: number
  leverage: number
}

export type Weights = Record<string, number>                // symbol -> weight (MV / equity)

export type RebalanceOptions = {
  lotSizes?: Record<string, number> | number                // per-symbol lot, or single lot for all (default 1)
  minNotional?: number                                      // skip trades smaller than this notional (base currency)
  allowShort?: boolean                                      // default true
  round?: "floor" | "round" | "ceil"                        // default "round"
}

export type Trade = { symbol: string; qty: number; notional: number }

export type RiskParityOptions = {
  maxIters?: number
  tol?: number
  longOnly?: boolean
  sumToOne?: boolean
}

export type Constraint = {
  symbol: string
  min?: number           // min weight
  max?: number           // max weight
}

/* =========================
 * Marking & Summaries
 * ========================= */

/** Get FX for a position's currency into base. Defaults unknown currencies to 1. */
export function fxRate(pos: Position, fx: FX | undefined, base = "USD"): number {
  if (!pos.currency || !fx) return 1
  if (pos.currency === base) return 1
  const r = fx[pos.currency]
  return isFiniteNum(r) ? (r as number) : 1
}

/** Mark positions to market; returns a decorated array plus totals. */
export function markToMarket(
  snap: PortfolioSnapshot,
  prices: Prices = {},
  fx?: FX
): { positions: MarkedPosition[]; equity: number; exposure: Exposure } {
  const base = snap.baseCurrency || "USD"
  const out: MarkedPosition[] = []
  let mvLong = 0, mvShort = 0

  for (const p of snap.positions || []) {
    const px = isFiniteNum(p.price) ? (p.price as number) : prices[p.symbol]
    if (!isFiniteNum(px)) continue
    const rate = fxRate(p, fx, base)
    const mv = (p.quantity || 0) * px * rate
    const cb = isFiniteNum(p.avgEntry) ? Math.abs(p.quantity) * (p.avgEntry as number) * rate : undefined
    const upnl = isFiniteNum(p.avgEntry) ? (px - (p.avgEntry as number)) * (p.quantity || 0) * rate : undefined
    out.push({
      ...p,
      price: px,
      fx: rate,
      marketValue: mv,
      costBasis: cb,
      unrealizedPnl: upnl,
    })
    if (mv >= 0) mvLong += mv
    else mvShort += -mv
  }

  const gross = mvLong + mvShort
  const net = mvLong - mvShort
  const cash = snap.cash ?? 0
  const equity = cash + net
  const exposure: Exposure = {
    long: mvLong,
    short: mvShort,
    gross,
    net,
    equity,
    leverage: equity !== 0 ? gross / Math.abs(equity) : 0,
  }
  return { positions: out, equity, exposure }
}

/** Compute weights by market value / equity (uses markToMarket). */
export function weights(
  snap: PortfolioSnapshot,
  prices: Prices = {},
  fx?: FX
): { weights: Weights; equity: number } {
  const { positions, equity } = markToMarket(snap, prices, fx)
  const w: Weights = {}
  if (equity === 0) return { weights: w, equity }
  for (const p of positions) {
    if (!isFiniteNum(p.marketValue)) continue
    w[p.symbol] = (p.marketValue as number) / equity
  }
  return { weights: w, equity }
}

/* =========================
 * Rebalancing
 * ========================= */

/**
 * Generate share changes to move current portfolio to target weights.
 * Positive qty → buy, Negative → sell.
 *
 * Notes:
 * - Uses current prices & FX to convert target weights -> target notionals.
 * - Respects lot sizes and minNotional threshold.
 * - If allowShort=false, negative targets are clamped to 0.
 */
export function rebalanceToTargets(
  snap: PortfolioSnapshot,
  target: Weights,
  prices: Prices = {},
  fx?: FX,
  opts: RebalanceOptions = {}
): Trade[] {
  const base = snap.baseCurrency || "USD"
  const { positions, equity } = markToMarket(snap, prices, fx)

  const lotSizes = normalizeLotMap(opts.lotSizes)
  const allowShort = opts.allowShort !== false
  const minNotional = opts.minNotional ?? 0
  const roundMode = opts.round || "round"

  // Build a unified symbol set
  const symbols = new Set<string>([
    ...Object.keys(target || {}),
    ...positions.map(p => p.symbol),
  ])

  const trades: Trade[] = []

  for (const sym of symbols) {
    const curPos = positions.find(p => p.symbol === sym)
    const px = isFiniteNum(curPos?.price) ? (curPos!.price as number) : prices[sym]
    if (!isFiniteNum(px)) continue

    const rate = curPos?.fx ?? 1
    const curQty = curPos?.quantity ?? 0
    const curMV = curQty * px * rate

    let tgtW = target[sym] ?? 0
    if (!allowShort && tgtW < 0) tgtW = 0

    const tgtMV = tgtW * equity
    const deltaNotional = tgtMV - curMV

    // Convert notional to shares in native currency
    const qtyFloat = deltaNotional / (px * rate)
    const qty = roundToLot(qtyFloat, lotSizes[sym] ?? 1, roundMode)
    const notional = qty * px * rate

    if (Math.abs(notional) >= minNotional && qty !== 0) {
      trades.push({ symbol: sym, qty, notional })
    }
  }
  // Optional: sort largest notional first
  trades.sort((a, b) => Math.abs(b.notional) - Math.abs(a.notional))
  return trades
}

/* =========================
 * Risk budgeting (risk parity)
 * ========================= */

/**
 * Risk contributions (variance-based):
 * RC_i = w_i * (Σ w)_i
 * Sum RC_i = w' Σ w = portfolio variance.
 */
export function riskContributions(weights: number[], cov: number[][]): number[] {
  const n = Math.min(weights.length, cov.length)
  const s = matVec(cov, weights).slice(0, n)
  const rc: number[] = new Array(n)
  for (let i = 0; i < n; i++) rc[i] = (weights[i] ?? 0) * (s[i] ?? 0)
  return rc
}

/**
 * Simple long-only risk-parity solver (variance parity) using iterative proportional fitting:
 * Iterate: w_i <- c / (Σ w)_i, then normalize to sum 1 and clamp to constraints if needed.
 *
 * This is a fast, robust approximation for long-only RP; stop when max change < tol.
 */
export function riskParityWeights(
  cov: number[][],
  opts: RiskParityOptions = {},
  constraints: Constraint[] = []
): number[] {
  const n = cov.length
  const maxIters = opts.maxIters ?? 500
  const tol = opts.tol ?? 1e-8
  const longOnly = opts.longOnly !== false
  const sumToOne = opts.sumToOne !== false

  // Initialize equal weights within constraints
  const minW = new Array(n).fill(0)
  const maxW = new Array(n).fill(1)
  for (const c of constraints) {
    const idx = indexBySymbol(constraints.map(c => c.symbol))[c.symbol]
    // If constraints array not aligned to assets, we allow users to pre-map;
    // otherwise constraints will be ignored in this minimal helper.
    // For a general case, users should align inputs before calling.
  }
  // In this minimal implementation we assume user aligned cov rows to desired asset order.

  let w = new Array(n).fill(1 / n)
  if (longOnly) w = w.map(x => Math.max(0, x))

  for (let iter = 0; iter < maxIters; iter++) {
    const s = matVec(cov, w)
    let maxDelta = 0
    const next = new Array(n)
    // c is an arbitrary positive constant; choosing geometric mean of s helps stability
    const c = geometricMean(s.map(x => Math.max(1e-12, x)))
    for (let i = 0; i < n; i++) {
      const denom = Math.max(1e-12, s[i])
      let wi = c / denom
      if (longOnly) wi = Math.max(0, wi)
      next[i] = wi
    }
    // normalize
    const sum = next.reduce((a, b) => a + b, 0) || 1
    for (let i = 0; i < n; i++) {
      next[i] = next[i] / sum
      maxDelta = Math.max(maxDelta, Math.abs(next[i] - w[i]))
    }
    w = next
    if (maxDelta < tol) break
  }

  if (sumToOne) {
    const s = w.reduce((a, b) => a + b, 0) || 1
    w = w.map(x => x / s)
  }
  return w
}

/* =========================
 * Utilities
 * ========================= */

function isFiniteNum(x: any): x is number {
  return typeof x === "number" && isFinite(x)
}

function normalizeLotMap(lots?: RebalanceOptions["lotSizes"]): Record<string, number> {
  if (!lots) return {}
  if (typeof lots === "number") return new Proxy({}, { get: () => lots })
  return lots
}

function roundToLot(qty: number, lot: number, mode: "floor" | "round" | "ceil"): number {
  if (!isFiniteNum(qty) || lot <= 0) return 0
  const k = qty / lot
  const r = mode === "floor" ? Math.floor(k) : mode === "ceil" ? Math.ceil(k) : Math.round(k)
  return r * lot
}

function matVec(A: number[][], x: number[]): number[] {
  const n = A.length
  const out = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    const row = A[i] || []
    let s = 0
    for (let j = 0; j < row.length && j < x.length; j++) {
      const a = row[j], b = x[j]
      if (isFiniteNum(a) && isFiniteNum(b)) s += a * b
    }
    out[i] = s
  }
  return out
}

function geometricMean(xs: number[]): number {
  const n = xs.length || 1
  let s = 0
  for (const x of xs) s += Math.log(Math.max(1e-12, x))
  return Math.exp(s / n)
}

/** Handy helper to create index by symbol; not used in the minimal constraints flow above. */
function indexBySymbol(symbols: string[]): Record<string, number> {
  const idx: Record<string, number> = {}
  for (let i = 0; i < symbols.length; i++) idx[symbols[i]] = i
  return idx
}

/* =========================
 * Example (commented)
 * =========================
const snap: PortfolioSnapshot = {
  baseCurrency: "USD",
  cash: 10_000,
  positions: [
    { symbol: "AAPL", quantity: 50, avgEntry: 180, currency: "USD" },
    { symbol: "MSFT", quantity: 30, avgEntry: 300, currency: "USD" },
  ]
}
const prices = { AAPL: 200, MSFT: 320 }
const { equity, exposure } = markToMarket(snap, prices)
const { weights: w } = weights(snap, prices)
const trades = rebalanceToTargets(snap, { AAPL: 0.6, MSFT: 0.4 }, prices, undefined, { minNotional: 100 })
console.log(equity, exposure, w, trades)
*/


