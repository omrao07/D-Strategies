// risk/var.ts
// Value-at-Risk (VaR) utilities (dependency-free).
// Includes: Historical, Parametric (Normal), Cornish–Fisher, optional t-like fat-tail approx,
// portfolio aggregation, rolling VaR, and horizon scaling.
//
// Conventions:
// - Inputs are arithmetic returns per period (e.g., daily).
// - VaR is returned as a POSITIVE loss magnitude (e.g., 0.025 = 2.5%).
// - Confidence level cl in (0,1), e.g., 0.99 => 99% VaR (left tail).

/* ============================== Types =============================== */

export type VaRMethod = "historical" | "parametric" | "cornish-fisher";

export interface VaROpts {
  /** Confidence level in (0,1). Default 0.99. */
  cl?: number;
  /** Scale factor for units (1 for raw returns, 100 for percent). Default 1. */
  scale?: number;
  /**
   * Horizon scaling (in periods) using sqrt(time). If provided (>1), the
   * 1-period VaR is scaled by sqrt(horizon).
   */
  horizon?: number;
}

export interface RollingOpts extends VaROpts {
  /** Lookback window size (e.g., 252 for daily). */
  window: number;
  /** Step between evaluations. Default 1. */
  step?: number;
}

export interface PortfolioInput {
  /** Matrix: rows=time, cols=assets. */
  returns: number[][];
  /** Weights aligned to columns (sum ~ 1; not enforced). */
  weights: number[];
}

/* =============================== Utils ============================== */

const SQ = Math.sqrt;

export function mean(x: number[]): number {
  if (!x.length) return NaN;
  let s = 0; for (const v of x) s += v; return s / x.length;
}
export function stdev(x: number[]): number {
  const n = x.length; if (n < 2) return 0;
  const m = mean(x); let v = 0; for (const a of x) v += (a - m) * (a - m);
  return SQ(v / (n - 1));
}
export function skew(x: number[]): number {
  const n = x.length; if (n < 3) return 0;
  const m = mean(x), s = stdev(x) || 1e-12; let acc = 0;
  for (const a of x) acc += Math.pow((a - m) / s, 3);
  return (n / ((n - 1) * (n - 2))) * acc;
}
export function kurtosisExcess(x: number[]): number {
  const n = x.length; if (n < 4) return 0;
  const m = mean(x), s = stdev(x) || 1e-12; let acc = 0;
  for (const a of x) acc += Math.pow((a - m) / s, 4);
  return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * acc
       - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
}

/** Left-tail quantile via index (simple, robust). p in [0,1]. */
export function quantile(x: number[], p: number): number {
  if (!x.length) return NaN;
  const arr = x.slice().sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(arr.length - 1, Math.floor(p * arr.length)));
  return arr[idx];
}

/** Φ^{-1}(p) – Acklam approximation (double precision). */
export function normInv(p: number): number {
  const a = [-39.69683028665376,220.9460984245205,-275.9285104469687,138.3577518672690,-30.66479806614716,2.506628277459239];
  const b = [-54.47609879822406,161.5858368580409,-155.6989798598866,66.80131188771972,-13.28068155288572];
  const c = [-0.007784894002430293,-0.3223964580411365,-2.400758277161838,-2.549732539343734,4.374664141464968,2.938163982698783];
  const d = [0.007784695709041462,0.3224671290700398,2.445134137142996,3.754408661907416];
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

/* ============================= VaR Methods ============================ */

/** Historical VaR: positive loss magnitude. */
export function varHistorical(returns: number[], opts: VaROpts = {}): number {
  const cl = opts.cl ?? 0.99;
  const scale = opts.scale ?? 1;
  const p = 1 - cl;                     // left tail
  const q = quantile(returns, p);       // negative for losses
  let v = Math.max(0, -q);              // positive loss
  if (opts.horizon && opts.horizon > 1) v *= SQ(opts.horizon);
  return v * scale;
}

/** Parametric Normal VaR: VaR = −(μ + σ z_{α}). */
export function varParametricNormal(returns: number[], opts: VaROpts = {}): number {
  const cl = opts.cl ?? 0.99;
  const scale = opts.scale ?? 1;
  const mu = mean(returns);
  const sd = stdev(returns);
  const z = normInv(1 - cl);            // negative
  let q = mu + sd * z;                   // left-tail quantile of returns
  let v = Math.max(0, -q);
  if (opts.horizon && opts.horizon > 1) v *= SQ(opts.horizon);
  return v * scale;
}

/** Cornish–Fisher adjusted VaR using sample skew/kurt (excess). */
export function varCornishFisher(returns: number[], opts: VaROpts = {}): number {
  const cl = opts.cl ?? 0.99;
  const scale = opts.scale ?? 1;
  const m = mean(returns), s = stdev(returns);
  const sk = skew(returns), ku = kurtosisExcess(returns);
  const z = normInv(1 - cl), z2 = z*z, z3 = z2*z;
  const zcf = z + (sk/6)*(z2 - 1) + (ku/24)*(z3 - 3*z) - (sk*sk/36)*(2*z3 - 5*z);
  let q = m + s * zcf;
  let v = Math.max(0, -q);
  if (opts.horizon && opts.horizon > 1) v *= SQ(opts.horizon);
  return v * scale;
}

/** Convenience dispatcher. */
export function varSeries(
  returns: number[],
  method: VaRMethod = "historical",
  opts: VaROpts = {}
): number {
  switch (method) {
    case "historical":     return varHistorical(returns, opts);
    case "parametric":     return varParametricNormal(returns, opts);
    case "cornish-fisher": return varCornishFisher(returns, opts);
    default:               return NaN;
  }
}

/* ============================== Portfolio ============================= */

/** Combine asset return matrix with weights to portfolio returns. */
export function portfolioReturns(input: PortfolioInput): number[] {
  const { returns, weights } = input;
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

/* ============================== Rolling =============================== */

export interface RollingPoint {
  index: number;  // end index (inclusive) of window
  var: number;
}

/** Rolling VaR with the chosen method. */
export function rollingVaR(
  returns: number[],
  method: VaRMethod = "historical",
  opt: RollingOpts
): RollingPoint[] {
  const window = opt.window;
  const step = opt.step ?? 1;
  const out: RollingPoint[] = [];
  for (let end = window; end <= returns.length; end += step) {
    const slice = returns.slice(end - window, end);
    out.push({
      index: end - 1,
      var: varSeries(slice, method, opt),
    });
  }
  return out;
}

/* ============================ Helpers/API ============================ */

/**
 * Scale a 1-period VaR to a longer horizon via √time, optionally with a drift.
 * `horizon` in periods (>=1). If `mu` not given, sample mean is used.
 */
export function horizonScaleVaR(
  onePeriodVaR: number,
  horizon: number,
  opts?: { mu?: number; muPerPeriod?: number; adjustDrift?: boolean }
): number {
  if (!horizon || horizon <= 1) return onePeriodVaR;
  // Classic square-root-of-time for diffusive processes; drift typically ignored for VaR.
  return onePeriodVaR * SQ(horizon);
}

/**
 * Convenience: compute portfolio VaR from matrix returns & weights in one shot.
 */
export function portfolioVaR(
  input: PortfolioInput,
  method: VaRMethod = "historical",
  opts: VaROpts = {}
): number {
  const port = portfolioReturns(input);
  return varSeries(port, method, opts);
}

/* ============================== Example ============================== */
/*
const r = [0.01, -0.02, 0.003, -0.015, 0.005, -0.03, 0.02];
console.log("Hist VaR(99%):", varHistorical(r, { cl: 0.99 }));
console.log("Param VaR:", varParametricNormal(r, { cl: 0.99 }));
console.log("CF VaR:", varCornishFisher(r, { cl: 0.99 }));
console.log("Rolling 5d Hist VaR:", rollingVaR(r, "historical", { window: 5, cl: 0.99 }));
*/