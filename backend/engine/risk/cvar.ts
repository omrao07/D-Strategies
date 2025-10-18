// risk/cvar.ts
// Value-at-Risk (VaR) and Conditional VaR / Expected Shortfall (CVaR)
// – Historical, Parametric (Normal), and Cornish–Fisher.
// No external deps. All inputs are daily returns unless stated otherwise.

export type Method = "historical" | "parametric" | "cornish-fisher";

export interface VaROptions {
  /** Confidence level in (0,1). e.g. 0.99 -> 99% */
  cl?: number;
  /** If returns are in % units, set to 100 so scaling is consistent (defaults 1). */
  scale?: number;
}

export interface RollingOptions extends VaROptions {
  /** lookback window (e.g., 252). */
  window: number;
  /** step size between windows (default 1). */
  step?: number;
}

export interface PortfolioInput {
  /** Matrix of returns by time (rows) and asset (cols). */
  returns: number[][];
  /** Portfolio weights aligned to columns, sum to 1 (not enforced). */
  weights: number[];
}

export interface Stats {
  mean: number;
  stdev: number;
  skew: number;
  kurt: number; // excess kurtosis
}

/* ========================= Utilities ========================= */

const SQ = Math.sqrt;
const ABS = Math.abs;

export function mean(x: number[]): number {
  if (!x.length) return NaN;
  let s = 0;
  for (const v of x) s += v;
  return s / x.length;
}

export function stdev(x: number[]): number {
  if (x.length < 2) return 0;
  const m = mean(x);
  let v = 0;
  for (const a of x) v += (a - m) * (a - m);
  return SQ(v / (x.length - 1));
}

export function skew(x: number[]): number {
  if (x.length < 3) return 0;
  const m = mean(x), s = stdev(x) || 1e-12;
  let n3 = 0, n = x.length;
  for (const a of x) n3 += Math.pow((a - m) / s, 3);
  return (n / ((n - 1) * (n - 2))) * n3;
}

export function kurtosisExcess(x: number[]): number {
  if (x.length < 4) return 0;
  const m = mean(x), s = stdev(x) || 1e-12;
  let n4 = 0, n = x.length;
  for (const a of x) n4 += Math.pow((a - m) / s, 4);
  // unbiased excess kurtosis (Fisher)
  return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * n4 - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
}

/** Sample stats bundle. */
export function sampleStats(x: number[]): Stats {
  return { mean: mean(x), stdev: stdev(x), skew: skew(x), kurt: kurtosisExcess(x) };
}

/** Left-tail quantile (e.g., p=0.01) using sorted index. */
export function quantile(x: number[], p: number): number {
  if (!x.length) return NaN;
  const arr = x.slice().sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(arr.length - 1, Math.floor(p * arr.length)));
  return arr[idx];
}

/** Standard normal CDF inverse (Acklam approx). */
export function normInv(p: number): number {
  // Coefficients from Peter John Acklam's approximation
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687,
    138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866,
    66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996,
    3.754408661907416];
  // Define break-points.
  const plow = 0.02425, phigh = 1 - plow;
  if (p <= 0 || p >= 1) return NaN;
  let q, r;
  if (p < plow) {
    q = SQ(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (phigh < p) {
    q = SQ(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
}

/* ========================= Historical ========================= */

/** Historical VaR (loss is negative return). */
export function varHistorical(returns: number[], opts: VaROptions = {}): number {
  const cl = opts.cl ?? 0.99;
  const scale = opts.scale ?? 1;
  const p = 1 - cl;
  const q = quantile(returns, p);
  // VaR is positive loss amount -> negative of quantile (since left tail negative)
  return Math.max(0, -q * scale);
}

/** Historical CVaR / ES: mean of losses beyond VaR threshold. */
export function cvarHistorical(returns: number[], opts: VaROptions = {}): number {
  const cl = opts.cl ?? 0.99;
  const scale = opts.scale ?? 1;
  const p = 1 - cl;
  const q = quantile(returns, p);
  const tail = returns.filter(r => r <= q);
  if (!tail.length) return NaN;
  const avg = mean(tail);
  return Math.max(0, -avg * scale);
}

/* ========================= Parametric (Normal) ========================= */

export function varParametricNormal(returns: number[], opts: VaROptions = {}): number {
  const cl = opts.cl ?? 0.99;
  const scale = opts.scale ?? 1;
  const mu = mean(returns);
  const sd = stdev(returns);
  const z = normInv(1 - cl); // negative
  const q = mu + sd * z;
  return Math.max(0, -q * scale);
}

export function cvarParametricNormal(returns: number[], opts: VaROptions = {}): number {
  const cl = opts.cl ?? 0.99;
  const scale = opts.scale ?? 1;
  const mu = mean(returns);
  const sd = stdev(returns) || 1e-12;
  const z = normInv(1 - cl); // negative
  // ES for Normal: ES = mu - sd * φ(z)/α, where α = 1 - cl, z = Φ^{-1}(α), φ pdf
  const alpha = 1 - cl;
  const phi = (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z);
  const es = mu - sd * (phi / alpha);
  return Math.max(0, -es * scale);
}

/* ========================= Cornish–Fisher ========================= */

/**
 * Cornish–Fisher adjusted quantile using sample skew/kurt. Useful when tails
 * deviate from normal. Returns VaR as positive loss.
 */
export function varCornishFisher(returns: number[], opts: VaROptions = {}): number {
  const cl = opts.cl ?? 0.99;
  const scale = opts.scale ?? 1;
  const s = sampleStats(returns);
  const z = normInv(1 - cl); // negative
  const z2 = z * z, z3 = z2 * z;
  // CF expansion: z_cf = z + (s/6)(z^2-1) + (k/24)(z^3-3z) - (s^2/36)(2z^3-5z)
  const zcf = z
    + (s.skew / 6) * (z2 - 1)
    + (s.kurt / 24) * (z3 - 3 * z)
    - (s.skew * s.skew / 36) * (2 * z3 - 5 * z);
  const q = s.mean + s.stdev * zcf;
  return Math.max(0, -q * scale);
}

/**
 * A pragmatic CF CVaR: average of tail beyond CF-VaR using historical series.
 * (Strict analytic CF-ES is uncommon; this hybrid is robust in practice.)
 */
export function cvarCornishFisher(returns: number[], opts: VaROptions = {}): number {
  const cl = opts.cl ?? 0.99;
  const scale = opts.scale ?? 1;
  const v = varCornishFisher(returns, opts);
  const thr = -v / (opts.scale ?? 1); // convert back to return threshold
  const tail = returns.filter(r => r <= thr);
  if (!tail.length) return NaN;
  return Math.max(0, -mean(tail) * scale);
}

/* ========================= Portfolio helpers ========================= */

/** Combine asset returns into portfolio returns by weights. */
export function portfolioReturns({ returns, weights }: PortfolioInput): number[] {
  const n = returns.length;
  if (!n) return [];
  const m = returns[0].length;
  if (weights.length !== m) throw new Error("weights length must match columns");
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const row = returns[i];
    for (let j = 0; j < m; j++) s += (row[j] ?? 0) * (weights[j] ?? 0);
    out[i] = s;
  }
  return out;
}

/** Loss series from returns (loss = -r). Positive => loss. */
export function lossesFromReturns(ret: number[]): number[] {
  return ret.map(r => -r);
}

/* ========================= Rolling windows ========================= */

export interface RollingPoint {
  index: number;     // end index (inclusive) of the window
  var: number;
  cvar: number;
}

export function rollingHistorical(ret: number[], opts: RollingOptions): RollingPoint[] {
  const { window, step = 1, cl = 0.99, scale = 1 } = opts;
  const out: RollingPoint[] = [];
  for (let end = window; end <= ret.length; end += step) {
    const slice = ret.slice(end - window, end);
    out.push({
      index: end - 1,
      var: varHistorical(slice, { cl, scale }),
      cvar: cvarHistorical(slice, { cl, scale }),
    });
  }
  return out;
}

export function rollingParametricNormal(ret: number[], opts: RollingOptions): RollingPoint[] {
  const { window, step = 1, cl = 0.99, scale = 1 } = opts;
  const out: RollingPoint[] = [];
  for (let end = window; end <= ret.length; end += step) {
    const slice = ret.slice(end - window, end);
    out.push({
      index: end - 1,
      var: varParametricNormal(slice, { cl, scale }),
      cvar: cvarParametricNormal(slice, { cl, scale }),
    });
  }
  return out;
}

export function rollingCornishFisher(ret: number[], opts: RollingOptions): RollingPoint[] {
  const { window, step = 1, cl = 0.99, scale = 1 } = opts;
  const out: RollingPoint[] = [];
  for (let end = window; end <= ret.length; end += step) {
    const slice = ret.slice(end - window, end);
    out.push({
      index: end - 1,
      var: varCornishFisher(slice, { cl, scale }),
      cvar: cvarCornishFisher(slice, { cl, scale }),
    });
  }
  return out;
}

/* ========================= Convenience API ========================= */

export function varSeries(
  returns: number[],
  method: Method = "historical",
  opts: VaROptions = {}
): number {
  if (method === "historical") return varHistorical(returns, opts);
  if (method === "parametric") return varParametricNormal(returns, opts);
  if (method === "cornish-fisher") return varCornishFisher(returns, opts);
  return NaN;
}

export function cvarSeries(
  returns: number[],
  method: Method = "historical",
  opts: VaROptions = {}
): number {
  if (method === "historical") return cvarHistorical(returns, opts);
  if (method === "parametric") return cvarParametricNormal(returns, opts);
  if (method === "cornish-fisher") return cvarCornishFisher(returns, opts);
  return NaN;
}

/* ========================= Examples ========================= */
/*
const r = [0.01, -0.02, 0.003, -0.015, 0.005, -0.03, 0.02];
console.log("Hist VaR(99%):", varHistorical(r, { cl: 0.99 }));
console.log("Hist CVaR(99%):", cvarHistorical(r, { cl: 0.99 }));
console.log("Param VaR:", varParametricNormal(r, { cl: 0.99 }));
console.log("CF VaR:", varCornishFisher(r, { cl: 0.99 }));
console.log("Rolling:", rollingHistorical(r, { window: 5, cl: 0.99 }));
*/