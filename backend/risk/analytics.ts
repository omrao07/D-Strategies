// risk/analytics.ts
// Pure TypeScript utilities for risk & performance analytics. Zero external imports.
//
// Focus:
// - Position/portfolio exposure
// - PnL series utilities (cumulative, drawdown, turnover)
// - Risk metrics: Volatility, Sharpe, Sortino, Calmar, MaxDD
// - VaR/ES (parametric & historical)
// - Beta/Alpha to a benchmark; correlation/covariance
// - Kelly fraction (mean/var estimator)
// - Simple slippage/impact estimators
//
// All functions are side-effect free and tolerate empty/NaN inputs.
// Conventions:
// - Returns are simple arithmetic returns (r_t = P_t / P_{t-1} - 1).
// - Unless stated otherwise, results assume daily periodicity; annualization
//   can be adjusted via `periodsPerYear` argument.

// ---------- Types ----------

export type ISO8601 = string

export type Position = {
  symbol: string
  quantity: number       // signed; <0 short
  price: number          // current mark
  avgEntry?: number
  currency?: string
}

export type PortfolioSnapshot = {
  ts?: ISO8601
  cash?: number
  positions: Position[]
}

export type Exposure = {
  gross: number
  net: number
  long: number
  short: number
  leverage?: number      // gross / equity (if equity provided)
}

export type PnLPoint = { t: ISO8601 | number; value: number }

export type VaRMethod = "parametric" | "historical"
export type TailSide = "both" | "left" | "right"

export type VaRResult = {
  var: number          // Value at Risk (loss is positive number)
  es?: number          // Expected Shortfall / CVaR (loss is positive)
  level: number        // confidence level, e.g., 0.99
  method: VaRMethod
  annualized?: boolean
}

export type BetaAlpha = {
  beta: number
  alpha: number         // per period unless annualize=true
  r2: number
  corr: number
  sdResidual: number
}

export type ImpactModel = {
  /** fixed bps of notional per trade (commissions, fees) */
  fixedBps?: number
  /** linear coefficient c1: impact ≈ c1 * (size/ADV) [bps] */
  linearADVb?: number
  /** square-root law coefficient c2: impact ≈ c2 * sqrt(size/ADV) [bps] */
  sqrtADVb?: number
}

// ---------- Small helpers (no imports) ----------

function isFiniteNum(x: any): x is number {
  return typeof x === "number" && isFinite(x)
}

function sum(xs: number[]): number {
  let s = 0; for (const x of xs) if (isFiniteNum(x)) s += x; return s
}
function mean(xs: number[]): number {
  const n = xs.filter(isFiniteNum).length
  return n ? sum(xs as number[]) / n : NaN
}
function variance(xs: number[], ddof = 1): number {
  const m = mean(xs)
  let s = 0, n = 0
  for (const x of xs) if (isFiniteNum(x)) { const d = x - m; s += d * d; n++ }
  return n > ddof ? s / (n - ddof) : NaN
}
function std(xs: number[], ddof = 1): number {
  const v = variance(xs, ddof); return isFiniteNum(v) ? Math.sqrt(v) : NaN
}
function clamp01(x: number): number { return Math.max(0, Math.min(1, x)) }
function percentile(xs: number[], p: number): number {
  const a = xs.filter(isFiniteNum).slice().sort((x, y) => x - y)
  if (!a.length) return NaN
  const r = clamp01(p) * (a.length - 1)
  const i = Math.floor(r), j = Math.min(a.length - 1, i + 1)
  const w = r - i
  return a[i] * (1 - w) + a[j] * w
}
function cov(x: number[], y: number[], ddof = 1): number {
  const n = Math.min(x.length, y.length)
  if (n <= ddof) return NaN
  const xs: number[] = [], ys: number[] = []
  for (let i = 0; i < n; i++) {
    const xi = x[i], yi = y[i]
    if (isFiniteNum(xi) && isFiniteNum(yi)) { xs.push(xi); ys.push(yi) }
  }
  const mx = mean(xs), my = mean(ys)
  let s = 0
  for (let i = 0; i < xs.length; i++) s += (xs[i] - mx) * (ys[i] - my)
  return xs.length > ddof ? s / (xs.length - ddof) : NaN
}
function corr(x: number[], y: number[]): number {
  const c = cov(x, y, 1), sx = std(x, 1), sy = std(y, 1)
  return isFiniteNum(c) && sx > 0 && sy > 0 ? c / (sx * sy) : NaN
}
function toArray<T>(x?: T[] | null): T[] { return Array.isArray(x) ? x : [] }

// ---------- Exposure & PnL ----------

export function portfolioExposure(s: PortfolioSnapshot, equityHint?: number): Exposure {
  const longs = s.positions.filter(p => isFiniteNum(p.quantity) && isFiniteNum(p.price) && p.quantity > 0)
  const shorts = s.positions.filter(p => isFiniteNum(p.quantity) && isFiniteNum(p.price) && p.quantity < 0)
  const long = sum(longs.map(p => p.quantity * p.price))
  const short = Math.abs(sum(shorts.map(p => p.quantity * p.price)))
  const gross = long + short
  const net = long - short
  const equity = isFiniteNum(equityHint)
    ? equityHint!
    : (s.cash ?? 0) + sum(s.positions.map(p => p.quantity * p.price))
  return {
    gross,
    net,
    long,
    short,
    leverage: equity > 0 ? gross / equity : undefined,
  }
}

/** Convert cumulative wealth series to arithmetic returns. */
export function returnsFromPrices(prices: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1], p1 = prices[i]
    if (isFiniteNum(p0) && isFiniteNum(p1) && p0 !== 0) out.push(p1 / p0 - 1)
    else out.push(NaN)
  }
  return out
}

/** Cumulative curve from returns, starting at 1.0 */
export function equityCurveFromReturns(returns: number[], start = 1): number[] {
  const out = [start]
  for (const r of returns) out.push(out[out.length - 1] * (isFiniteNum(r) ? (1 + r) : 1))
  return out
}

/** Max drawdown and related stats from an equity curve. */
export function drawdownStats(curve: number[]): { maxDD: number; maxDDPct: number; peakIndex: number; troughIndex: number; recovIndex?: number } {
  let peak = -Infinity, peakIdx = -1
  let troughIdx = -1, maxDrop = 0
  const n = curve.length
  for (let i = 0; i < n; i++) {
    const x = curve[i]
    if (!isFiniteNum(x)) continue
    if (x > peak) { peak = x; peakIdx = i }
    const drop = peak - x
    if (drop > maxDrop) { maxDrop = drop; troughIdx = i }
  }
  const maxDDPct = peak > 0 && isFiniteNum(maxDrop) ? maxDrop / peak : NaN
  // recovery index (first time new high is reached after trough)
  let recov: number | undefined
  if (troughIdx >= 0) {
    let hi = -Infinity
    for (let i = 0; i <= peakIdx; i++) if (isFiniteNum(curve[i]) && curve[i] > hi) hi = curve[i]
    for (let i = troughIdx; i < n; i++) {
      if (isFiniteNum(curve[i]) && curve[i] >= hi) { recov = i; break }
    }
  }
  return { maxDD: maxDrop, maxDDPct, peakIndex: peakIdx, troughIndex: troughIdx, recovIndex: recov }
}

/** Turnover: sum of absolute weight changes / 2 (per period). */
export function turnoverFromWeights(weights: number[][]): number[] {
  // weights[t][i] = weight of asset i at time t
  const out: number[] = []
  for (let t = 1; t < weights.length; t++) {
    const prev = toArray(weights[t - 1]), cur = toArray(weights[t])
    const n = Math.max(prev.length, cur.length)
    let s = 0
    for (let i = 0; i < n; i++) s += Math.abs((cur[i] ?? 0) - (prev[i] ?? 0))
    out.push(s / 2)
  }
  return out
}

// ---------- Risk & Performance ----------

export function annualizedVol(returns: number[], periodsPerYear = 252): number {
  const s = std(returns)
  return isFiniteNum(s) ? s * Math.sqrt(periodsPerYear) : NaN
}

export function sharpe(returns: number[], rfPerPeriod = 0, periodsPerYear = 252): number {
  // excess returns
  const ex: number[] = []
  for (const r of returns) ex.push(isFiniteNum(r) ? (r - rfPerPeriod) : NaN)
  const m = mean(ex), v = std(ex)
  if (!isFiniteNum(m) || !isFiniteNum(v) || v === 0) return NaN
  return (m / v) * Math.sqrt(periodsPerYear)
}

export function sortino(returns: number[], rfPerPeriod = 0, periodsPerYear = 252): number {
  const ex: number[] = []
  for (const r of returns) ex.push(isFiniteNum(r) ? (r - rfPerPeriod) : NaN)
  const m = mean(ex)
  const downside = ex.filter(x => isFiniteNum(x) && x < 0) as number[]
  const dd = std(downside.length ? downside : [0]) // protect against empty
  if (!isFiniteNum(m) || !isFiniteNum(dd) || dd === 0) return NaN
  return (m / dd) * Math.sqrt(periodsPerYear)
}

export function calmar(returns: number[], periodsPerYear = 252): number {
  const eq = equityCurveFromReturns(returns)
  const annRet = Math.pow(eq[eq.length - 1] / (eq[0] || 1), periodsPerYear / Math.max(1, returns.length)) - 1
  const dd = drawdownStats(eq).maxDDPct
  return isFiniteNum(annRet) && isFiniteNum(dd) && dd > 0 ? annRet / dd : NaN
}

// ---------- VaR & ES ----------

/** Parametric (normal) or historical VaR/ES on a return series. Loss is reported as positive number. */
export function valueAtRisk(
  returns: number[],
  level = 0.99,
  method: VaRMethod = "parametric",
  side: TailSide = "left"
): VaRResult {
  const p = clamp01(level)
  const r = returns.filter(isFiniteNum) as number[]
  if (!r.length) return { var: NaN, es: NaN, level: p, method }
  if (method === "parametric") {
    const mu = mean(r), s = std(r)
    if (!isFiniteNum(mu) || !isFiniteNum(s)) return { var: NaN, es: NaN, level: p, method }
    const z = normInv(side === "both" ? (1 + p) / 2 : p)
    // Left tail VaR is -(mu + z*s) if mu+z*s < 0 else 0; generalize by side:
    const q = mu + (side === "left" ? -1 : 1) * z * s
    const VaR = Math.max(0, side === "left" ? -q : q)
    // ES for normal: mu ± s * φ(z) / (1 - p)  (left uses -, right +)
    const phi = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
    const esVal = mu + (side === "left" ? -1 : 1) * (s * phi(z) / (1 - p))
    const ES = Math.max(0, side === "left" ? -esVal : esVal)
    return { var: VaR, es: ES, level: p, method }
  } else {
    // historical
    const sorted = r.slice().sort((a, b) => a - b)
    if (side === "both") {
      const leftQ = percentile(sorted, 1 - p)
      const rightQ = percentile(sorted, p)
      const VaR = Math.max(0, Math.max(-leftQ, rightQ))
      // ES (two-tail): average of tail magnitudes
      const leftTail = sorted.filter(x => x <= leftQ)
      const rightTail = sorted.filter(x => x >= rightQ)
      const esLeft = leftTail.length ? -mean(leftTail) : 0
      const esRight = rightTail.length ? mean(rightTail) : 0
      const ES = Math.max(esLeft, esRight)
      return { var: VaR, es: ES, level: p, method }
    } else if (side === "left") {
      const q = percentile(sorted, 1 - p)
      const VaR = Math.max(0, -q)
      const tail = sorted.filter(x => x <= q)
      const ES = tail.length ? Math.max(0, -mean(tail)) : 0
      return { var: VaR, es: ES, level: p, method }
    } else {
      const q = percentile(sorted, p)
      const VaR = Math.max(0, q)
      const tail = sorted.filter(x => x >= q)
      const ES = tail.length ? Math.max(0, mean(tail)) : 0
      return { var: VaR, es: ES, level: p, method }
    }
  }
}

// ---------- Beta / Alpha / Regression ----------

export function betaAlpha(
  assetReturns: number[],
  benchReturns: number[],
  rfPerPeriod = 0,
  annualize = false,
  periodsPerYear = 252
): BetaAlpha {
  const n = Math.min(assetReturns.length, benchReturns.length)
  const a: number[] = [], b: number[] = []
  for (let i = 0; i < n; i++) {
    const ra = assetReturns[i], rb = benchReturns[i]
    if (isFiniteNum(ra) && isFiniteNum(rb)) { a.push(ra - rfPerPeriod); b.push(rb - rfPerPeriod) }
  }
  const beta = cov(a, b) / variance(b)
  const alphaPer = mean(a) - beta * mean(b)
  const r2 = Math.pow(corr(a, b), 2)
  const sdResid = std(a.map((x, i) => x - (alphaPer + beta * b[i])))
  const alpha = annualize ? alphaPer * periodsPerYear : alphaPer
  return { beta, alpha, r2, corr: Math.sqrt(r2), sdResidual: sdResid }
}

// ---------- Kelly ----------

/** Kelly fraction estimate using mean/variance of returns. */
export function kellyFraction(returns: number[]): number {
  const m = mean(returns), v = variance(returns, 1)
  if (!isFiniteNum(m) || !isFiniteNum(v) || v <= 0) return NaN
  return m / v
}

// ---------- Correlation / Covariance Matrix ----------

export function covarianceMatrix(series: number[][], ddof = 1): number[][] {
  const k = series.length
  const out: number[][] = Array.from({ length: k }, () => Array(k).fill(0))
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      const c = cov(series[i], series[j], ddof)
      out[i][j] = c
      out[j][i] = c
    }
  }
  return out
}

export function correlationMatrix(series: number[][]): number[][] {
  const k = series.length
  const out: number[][] = Array.from({ length: k }, () => Array(k).fill(1))
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const c = corr(series[i], series[j])
      out[i][j] = c
      out[j][i] = c
    }
  }
  return out
}

// ---------- Impact / Slippage ----------

/**
 * Estimate total cost in bps for trading `notional` given ADV and a model.
 * Combines fixed + linear(size/ADV) + sqrt(size/ADV) terms.
 */
export function impactBps(notional: number, adv: number, model: ImpactModel): number {
  if (!isFiniteNum(notional) || !isFiniteNum(adv) || adv <= 0) return NaN
  const x = Math.max(0, notional / adv)
  const fixed = model.fixedBps ?? 0
  const linear = (model.linearADVb ?? 0) * x
  const root = (model.sqrtADVb ?? 0) * Math.sqrt(x)
  return fixed + linear + root
}

/** Convert bps cost to absolute currency value. */
export function costFromBps(notional: number, bps: number): number {
  if (!isFiniteNum(notional) || !isFiniteNum(bps)) return NaN
  return notional * (bps / 10_000)
}

// ---------- Normal distribution helpers (for parametric VaR) ----------

/** Standard normal inverse CDF via Acklam's approximation (good enough for risk). */
function normInv(p: number): number {
  const a = [ -3.969683028665376e+01,  2.209460984245205e+02, -2.759285104469687e+02,
               1.383577518672690e+02, -3.066479806614716e+01,  2.506628277459239e+00 ]
  const b = [ -5.447609879822406e+01,  1.615858368580409e+02, -1.556989798598866e+02,
               6.680131188771972e+01, -1.328068155288572e+01 ]
  const c = [ -7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
              -2.549732539343734e+00,  4.374664141464968e+00,  2.938163982698783e+00 ]
  const d = [ 7.784695709041462e-03,  3.224671290700398e-01,  2.445134137142996e+00,
              3.754408661907416e+00 ]
  // Define break-points.
  const plow = 0.02425
  const phigh = 1 - plow
  let q, r
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
  }
  if (phigh < p) {
    q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
             ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
  }
  q = p - 0.5
  r = q * q
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q /
         (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)
}

// ---------- Convenience bundles ----------

export function summaryFromReturns(returns: number[], periodsPerYear = 252) {
  const m = mean(returns)
  const s = std(returns)
  const annVol = annualizedVol(returns, periodsPerYear)
  const sh = sharpe(returns, 0, periodsPerYear)
  const so = sortino(returns, 0, periodsPerYear)
  const eq = equityCurveFromReturns(returns)
  const dd = drawdownStats(eq)
  const cal = calmar(returns, periodsPerYear)
  return {
    mean: m,
    stdev: s,
    annVol,
    sharpe: sh,
    sortino: so,
    calmar: cal,
    maxDrawdown: dd.maxDD,
    maxDrawdownPct: dd.maxDDPct,
  }
}
