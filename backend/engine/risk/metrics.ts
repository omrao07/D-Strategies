// risk/metrics.ts
// Core risk/performance metrics for strategies/portfolios.
// Dependency-free, ESM/TS friendly. No external imports.
//
// Includes:
// - Basic stats: mean, stdev, skew, kurtosis
// - Risk: volatility, downside deviation, VaR/CVaR (historical + normal + Cornish–Fisher)
// - Performance: Sharpe, Sortino, Calmar, Omega, Information Ratio, Treynor, Alpha/Beta (CAPM)
// - Drawdowns: series, max DD, time-under-water
// - Rolling windows helpers
// - Portfolio combiner from asset return matrix + weights

/* ============================== Types =============================== */

export interface MetricsOpts {
  periodsPerYear?: number; // e.g., 252 daily, 12 monthly
  riskFree?: number;       // per-period risk-free rate (already aligned to series frequency)
  targetReturn?: number;   // for Sortino downside target (default rf)
  cl?: number;             // VaR/CVaR confidence (default 0.99)
  varMethod?: "historical" | "parametric" | "cornish-fisher";
  scale?: number;          // VaR scaling (e.g., 1 for raw returns, 100 for %)
}

export interface SummaryMetrics {
  mean: number;
  stdev: number;
  annReturn: number;
  annVol: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  omega: number;
  maxDrawdown: number;
  maxDDStart?: number;
  maxDDEnd?: number;
  tau: number;           // time-under-water fraction [0..1]
  hitRate: number;       // % positive returns
  winLoss: number;       // avg win / avg loss (abs)
  skew: number;
  kurt: number;          // excess kurtosis
  var: number;           // VaR (positive loss)
  cvar: number;          // CVaR/ES (positive loss)
  alpha?: number;        // CAPM alpha per period (if benchmark provided)
  beta?: number;         // CAPM beta (if benchmark provided)
  infoRatio?: number;    // Information ratio vs benchmark (if provided)
  treynor?: number;      // Treynor ratio (if beta provided and non-zero)
}

export interface RollingPoint<T = number> {
  index: number; // end index (inclusive) of window
  value: T;
}

/* ============================== Utils =============================== */

const SQ = Math.sqrt;
const ABS = Math.abs;

export function mean(x: number[]): number {
  if (!x.length) return NaN;
  let s = 0; for (const v of x) s += v;
  return s / x.length;
}

export function stdev(x: number[]): number {
  const n = x.length; if (n < 2) return 0;
  const m = mean(x);
  let v = 0; for (const a of x) v += (a - m) * (a - m);
  return SQ(v / (n - 1));
}

export function skew(x: number[]): number {
  const n = x.length; if (n < 3) return 0;
  const m = mean(x), s = stdev(x) || 1e-12;
  let z3 = 0;
  for (const a of x) z3 += Math.pow((a - m) / s, 3);
  return (n / ((n - 1) * (n - 2))) * z3;
}

export function kurtosisExcess(x: number[]): number {
  const n = x.length; if (n < 4) return 0;
  const m = mean(x), s = stdev(x) || 1e-12;
  let z4 = 0;
  for (const a of x) z4 += Math.pow((a - m) / s, 4);
  return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * z4
       - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
}

export function covariance(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n));
  let s = 0; for (let i = 0; i < n; i++) s += (x[i] - mx) * (y[i] - my);
  return s / (n - 1);
}

export function correlation(x: number[], y: number[]): number {
  const sx = stdev(x), sy = stdev(y);
  if (sx === 0 || sy === 0) return 0;
  return covariance(x, y) / (sx * sy);
}

export function quantile(x: number[], p: number): number {
  if (!x.length) return NaN;
  const arr = x.slice().sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(arr.length - 1, Math.floor(p * arr.length)));
  return arr[idx];
}

export function normInv(p: number): number {
  // Acklam approximation
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687,
    138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866,
    66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996,
    3.754408661907416];
  const plow = 0.02425, phigh = 1 - plow;
  if (p <= 0 || p >= 1) return NaN;
  let q, r;
  if (p < plow) {
    q = SQ(-2 * Math.log(p));
    return (((((c[0]*q + c[1])*q + c[2])*q + c[3])*q + c[4])*q + c[5]) /
           ((((d[0]*q + d[1])*q + d[2])*q + d[3])*q + 1);
  } else if (p > phigh) {
    q = SQ(-2 * Math.log(1 - p));
    return -(((((c[0]*q + c[1])*q + c[2])*q + c[3])*q + c[4])*q + c[5]) /
             ((((d[0]*q + d[1])*q + d[2])*q + d[3])*q + 1);
  } else {
    q = p - 0.5; r = q*q;
    return (((((a[0]*r + a[1])*r + a[2])*r + a[3])*r + a[4])*r + a[5]) * q /
           (((((b[0]*r + b[1])*r + b[2])*r + b[3])*r + b[4])*r + 1);
  }
}

/* ============================= Drawdowns ============================= */

export function equityCurve(returns: number[], startEquity = 1): number[] {
  const out = new Array(returns.length);
  let eq = startEquity;
  for (let i = 0; i < returns.length; i++) {
    eq = eq * (1 + (returns[i] ?? 0));
    out[i] = eq;
  }
  return out;
}

export function drawdownSeries(returns: number[], startEquity = 1): number[] {
  const eq = equityCurve(returns, startEquity);
  const out = new Array(eq.length);
  let peak = -Infinity;
  for (let i = 0; i < eq.length; i++) {
    peak = Math.max(peak, eq[i]);
    out[i] = (eq[i] - peak) / (peak || 1); // negative or zero
  }
  return out;
}

export function maxDrawdown(returns: number[], startEquity = 1): { mdd: number; start?: number; end?: number } {
  const eq = equityCurve(returns, startEquity);
  let peak = eq[0] ?? 1, mdd = 0, start = 0, end = 0, peakIdx = 0;
  for (let i = 0; i < eq.length; i++) {
    if (eq[i] > peak) { peak = eq[i]; peakIdx = i; }
    const dd = (eq[i] - peak) / peak; // ≤ 0
    if (dd < mdd) { mdd = dd; start = peakIdx; end = i; }
  }
  return { mdd: Math.abs(mdd), start, end };
}

/** Time-under-water fraction: proportion of periods below running peak. */
export function timeUnderWater(returns: number[], startEquity = 1): number {
  const dd = drawdownSeries(returns, startEquity);
  const underwater = dd.filter(x => x < 0).length;
  return dd.length ? underwater / dd.length : 0;
}

/* ============================= VaR / CVaR ============================ */

export function varHistorical(returns: number[], cl = 0.99, scale = 1): number {
  const p = 1 - cl;
  const q = quantile(returns, p); // left tail (negative)
  return Math.max(0, -q * scale);
}

export function cvarHistorical(returns: number[], cl = 0.99, scale = 1): number {
  const p = 1 - cl;
  const q = quantile(returns, p);
  const tail = returns.filter(r => r <= q);
  if (!tail.length) return NaN;
  return Math.max(0, -mean(tail) * scale);
}

export function varParametricNormal(returns: number[], cl = 0.99, scale = 1): number {
  const mu = mean(returns);
  const sd = stdev(returns);
  const z = normInv(1 - cl); // negative
  return Math.max(0, -(mu + sd * z) * scale);
}

export function cvarParametricNormal(returns: number[], cl = 0.99, scale = 1): number {
  const mu = mean(returns);
  const sd = stdev(returns) || 1e-12;
  const z = normInv(1 - cl);
  const alpha = 1 - cl;
  const phi = (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z);
  const es = mu - sd * (phi / alpha);
  return Math.max(0, -es * scale);
}

export function varCornishFisher(returns: number[], cl = 0.99, scale = 1): number {
  const m = mean(returns), s = stdev(returns);
  const sk = skew(returns), ku = kurtosisExcess(returns);
  const z = normInv(1 - cl), z2 = z*z, z3 = z2*z;
  const zcf = z + (sk/6)*(z2-1) + (ku/24)*(z3-3*z) - (sk*sk/36)*(2*z3-5*z);
  return Math.max(0, -(m + s * zcf) * scale);
}

export function cvarCornishFisher(returns: number[], cl = 0.99, scale = 1): number {
  const v = varCornishFisher(returns, cl, 1);
  const thr = -v; // threshold in raw return units since scale=1 above
  const tail = returns.filter(r => r <= thr);
  if (!tail.length) return NaN;
  return Math.max(0, -mean(tail) * scale);
}

/* ============================ Risk Metrics ============================ */

export function downsideDeviation(returns: number[], mar = 0): number {
  const neg = returns.map(r => Math.min(0, r - mar));
  const sq = neg.map(x => x * x);
  return SQ(mean(sq));
}

export function omegaRatio(returns: number[], mar = 0): number {
  let gains = 0, losses = 0;
  for (const r of returns) {
    const g = Math.max(0, r - mar);
    const l = Math.max(0, mar - r);
    gains += g; losses += l;
  }
  return losses > 0 ? gains / losses : Infinity;
}

/* ======================== Performance Metrics ========================= */

export function sharpeRatio(returns: number[], opts: MetricsOpts = {}): number {
  const rf = opts.riskFree ?? 0;
  const ex = returns.map(r => r - rf);
  const a = mean(ex), b = stdev(ex) || 1e-12;
  const k = SQ(Math.max(1, opts.periodsPerYear ?? 252));
  return (a / b) * k;
}

export function sortinoRatio(returns: number[], opts: MetricsOpts = {}): number {
  const rf = opts.riskFree ?? 0;
  const mar = opts.targetReturn ?? rf;
  const ex = returns.map(r => r - rf);
  const down = downsideDeviation(returns, mar);
  const k = SQ(Math.max(1, opts.periodsPerYear ?? 252));
  return (mean(ex) / (down || 1e-12)) * k;
}

export function calmarRatio(returns: number[], opts: MetricsOpts = {}): number {
  const annRet = annualizedReturn(returns, opts.periodsPerYear ?? 252);
  const { mdd } = maxDrawdown(returns);
  return mdd > 0 ? annRet / mdd : Infinity;
}

export function informationRatio(returns: number[], benchmark: number[], opts: MetricsOpts = {}): number {
  const ex = excessReturns(returns, benchmark);
  const k = SQ(Math.max(1, opts.periodsPerYear ?? 252));
  return (mean(ex) / (stdev(ex) || 1e-12)) * k;
}

export function capmBetaAlpha(
  returns: number[],
  benchmark: number[],
  opts: MetricsOpts = {}
): { beta: number; alpha: number } {
  const rf = opts.riskFree ?? 0;
  const exR = returns.map(r => r - rf);
  const exB = benchmark.map(r => r - rf);
  const beta = (covariance(exR, exB) / (stdev(exB) ** 2 || 1e-12));
  // alpha per period: E[R] - rf - beta(E[B]-rf)
  const alpha = mean(exR) - beta * mean(exB);
  return { beta, alpha };
}

export function treynorRatio(returns: number[], benchmark: number[], opts: MetricsOpts = {}): number {
  const { beta } = capmBetaAlpha(returns, benchmark, opts);
  const rf = opts.riskFree ?? 0;
  const ex = returns.map(r => r - rf);
  return beta !== 0 ? mean(ex) / beta : Infinity;
}

export function annualizedReturn(returns: number[], periodsPerYear = 252): number {
  const eq = equityCurve(returns, 1);
  if (!eq.length) return NaN;
  const total = eq[eq.length - 1];
  const n = returns.length;
  if (n <= 0) return NaN;
  return Math.pow(total, (periodsPerYear / n)) - 1;
}

export function annualizedVol(returns: number[], periodsPerYear = 252): number {
  return stdev(returns) * SQ(periodsPerYear);
}

export function hitRate(returns: number[]): number {
  if (!returns.length) return NaN;
  const wins = returns.filter(r => r > 0).length;
  return wins / returns.length;
}

export function winLossRatio(returns: number[]): number {
  const wins = returns.filter(r => r > 0);
  const losses = returns.filter(r => r < 0).map(Math.abs);
  const avgWin = wins.length ? mean(wins) : 0;
  const avgLoss = losses.length ? mean(losses) : 0;
  return avgLoss > 0 ? avgWin / avgLoss : Infinity;
}

export function excessReturns(returns: number[], benchmark: number[]): number[] {
  const n = Math.min(returns.length, benchmark.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = (returns[i] ?? 0) - (benchmark[i] ?? 0);
  return out;
}

/* ============================ Portfolio ============================== */

export function portfolioReturns(returns: number[][], weights: number[]): number[] {
  const n = returns.length; if (!n) return [];
  const m = returns[0].length;
  if (weights.length !== m) throw new Error("weights length must match columns");
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0; for (let j = 0; j < m; j++) s += (returns[i][j] ?? 0) * (weights[j] ?? 0);
    out[i] = s;
  }
  return out;
}

/* =========================== Summary API ============================= */

export function summarizeRisk(
  returns: number[],
  benchmark?: number[],
  opts: MetricsOpts = {}
): SummaryMetrics {
  const ppY = Math.max(1, opts.periodsPerYear ?? 252);
  const rf = opts.riskFree ?? 0;
  const cl = opts.cl ?? 0.99;
  const scale = opts.scale ?? 1;
  const varMethod = opts.varMethod ?? "historical";

  const mu = mean(returns);
  const sd = stdev(returns);
  const annVol = sd * SQ(ppY);
  const annRet = annualizedReturn(returns, ppY);

  // Ratios
  const sharpe = sharpeRatio(returns, { periodsPerYear: ppY, riskFree: rf });
  const sortino = sortinoRatio(returns, { periodsPerYear: ppY, riskFree: rf, targetReturn: opts.targetReturn });
  const calmar = calmarRatio(returns, { periodsPerYear: ppY });
  const omega = omegaRatio(returns, opts.targetReturn ?? rf);

  // Drawdowns
  const { mdd, start, end } = maxDrawdown(returns);
  const tau = timeUnderWater(returns);

  // Distribution shape
  const sk = skew(returns);
  const ku = kurtosisExcess(returns);

  // VaR/CVaR
  let v = 0, cv = 0;
  if (varMethod === "historical") {
    v = varHistorical(returns, cl, scale);
    cv = cvarHistorical(returns, cl, scale);
  } else if (varMethod === "parametric") {
    v = varParametricNormal(returns, cl, scale);
    cv = cvarParametricNormal(returns, cl, scale);
  } else {
    v = varCornishFisher(returns, cl, scale);
    cv = cvarCornishFisher(returns, cl, scale);
  }

  // Benchmark-relative
  let alpha: number | undefined = undefined;
  let beta: number | undefined = undefined;
  let infoRatio: number | undefined = undefined;
  let treynor: number | undefined = undefined;

  if (benchmark && benchmark.length && returns.length) {
    const n = Math.min(returns.length, benchmark.length);
    const r = returns.slice(0, n);
    const b = benchmark.slice(0, n);
    infoRatio = informationRatio(r, b, { periodsPerYear: ppY });
    const capm = capmBetaAlpha(r, b, { riskFree: rf });
    alpha = capm.alpha;
    beta = capm.beta;
    treynor = (beta && beta !== 0) ? (mean(r.map(x => x - rf)) / beta) : undefined;
  }

  return {
    mean: mu,
    stdev: sd,
    annReturn: annRet,
    annVol,
    sharpe,
    sortino,
    calmar,
    omega,
    maxDrawdown: mdd,
    maxDDStart: start,
    maxDDEnd: end,
    tau,
    hitRate: hitRate(returns),
    winLoss: winLossRatio(returns),
    skew: sk,
    kurt: ku,
    var: v,
    cvar: cv,
    alpha,
    beta,
    infoRatio,
    treynor,
  };
}

/* ============================ Rolling API ============================ */

export function rollingMetric(
  returns: number[],
  window: number,
  fn: (slice: number[]) => number,
  step = 1
): RollingPoint[] {
  const out: RollingPoint[] = [];
  for (let end = window; end <= returns.length; end += step) {
    const slice = returns.slice(end - window, end);
    out.push({ index: end - 1, value: fn(slice) });
  }
  return out;
}

export function rollingSharpe(returns: number[], window: number, opts: MetricsOpts = {}, step = 1): RollingPoint[] {
  const ppY = Math.max(1, opts.periodsPerYear ?? 252);
  const rf = opts.riskFree ?? 0;
  return rollingMetric(returns, window, (s) => sharpeRatio(s, { periodsPerYear: ppY, riskFree: rf }), step);
}

export function rollingDrawdown(returns: number[], window: number, step = 1): RollingPoint[] {
  return rollingMetric(returns, window, (s) => maxDrawdown(s).mdd, step);
}

export function rollingVol(returns: number[], window: number, opts: MetricsOpts = {}, step = 1): RollingPoint[] {
  const ppY = Math.max(1, opts.periodsPerYear ?? 252);
  return rollingMetric(returns, window, (s) => stdev(s) * SQ(ppY), step);
}

export function rollingVaR(returns: number[], window: number, opts: MetricsOpts = {}, step = 1): RollingPoint[] {
  const cl = opts.cl ?? 0.99;
  const scale = opts.scale ?? 1;
  const method = opts.varMethod ?? "historical";
  const fn = (s: number[]) => {
    if (method === "historical") return varHistorical(s, cl, scale);
    if (method === "parametric") return varParametricNormal(s, cl, scale);
    return varCornishFisher(s, cl, scale);
  };
  return rollingMetric(returns, window, fn, step);
}

/* ============================== Example ============================== */
/*
const r = [0.01,-0.02,0.005,-0.01,0.012,0.003,-0.015,0.02,-0.005];
const m = summarizeRisk(r, undefined, { periodsPerYear: 252, riskFree: 0, cl: 0.99 });
console.log(m);
console.log(rollingSharpe(r, 5, { periodsPerYear: 252 }));
*/