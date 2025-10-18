// utils/lookback.ts
// Pure TypeScript rolling/exponential statistics for time series (no imports).

// ---------- Type guards & helpers ----------
function isFiniteNumber(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
function safe(x: any, d = 0): number {
  return isFiniteNumber(x) ? x : d;
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// ---------- Core aggregators ----------
export function sum(arr: number[]): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += safe(arr[i], 0);
  return s;
}

export function mean(arr: number[]): number {
  return arr.length ? sum(arr) / arr.length : 0;
}

export function variance(arr: number[]): number {
  const n = arr.length;
  if (n <= 1) return 0;
  const m = mean(arr);
  let v = 0;
  for (let i = 0; i < n; i++) {
    const d = safe(arr[i], 0) - m;
    v += d * d;
  }
  return v / (n - 1);
}

export function stddev(arr: number[]): number {
  return Math.sqrt(Math.max(variance(arr), 0));
}

export function covariance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n <= 1) return 0;
  const ma = mean(a.slice(-n));
  const mb = mean(b.slice(-n));
  let c = 0;
  for (let i = 0; i < n; i++) c += (safe(a[i], 0) - ma) * (safe(b[i], 0) - mb);
  return c / (n - 1);
}

export function correlation(a: number[], b: number[]): number {
  const cov = covariance(a, b);
  const sa = stddev(a);
  const sb = stddev(b);
  return sa > 0 && sb > 0 ? cov / (sa * sb) : 0;
}

// ---------- Rolling window utilities ----------
export function rolling<T>(arr: T[], window: number): T[][] {
  const w = Math.max(1, Math.floor(window));
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    if (i + 1 >= w) out.push(arr.slice(i + 1 - w, i + 1));
    else out.push([]);
  }
  return out;
}

export function rollingApply(
  arr: number[],
  window: number,
  fn: (windowSlice: number[]) => number
): number[] {
  const w = Math.max(1, Math.floor(window));
  const out: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    if (i + 1 >= w) out.push(fn(arr.slice(i + 1 - w, i + 1)));
    else out.push(NaN);
  }
  return out;
}

export function rollingSum(arr: number[], window: number): number[] {
  return rollingApply(arr, window, sum);
}

export function rollingMean(arr: number[], window: number): number[] {
  return rollingApply(arr, window, mean);
}

export function rollingVar(arr: number[], window: number): number[] {
  return rollingApply(arr, window, variance);
}

export function rollingStd(arr: number[], window: number): number[] {
  return rollingApply(arr, window, stddev);
}

export function rollingMin(arr: number[], window: number): number[] {
  return rollingApply(arr, window, (w) => {
    let m = Infinity;
    for (let i = 0; i < w.length; i++) m = Math.min(m, safe(w[i], Infinity));
    return m;
  });
}

export function rollingMax(arr: number[], window: number): number[] {
  return rollingApply(arr, window, (w) => {
    let m = -Infinity;
    for (let i = 0; i < w.length; i++) m = Math.max(m, safe(w[i], -Infinity));
    return m;
  });
}

export function rollingZScore(arr: number[], window: number): number[] {
  const out: number[] = [];
  const w = Math.max(2, Math.floor(window));
  for (let i = 0; i < arr.length; i++) {
    if (i + 1 < w) { out.push(NaN); continue; }
    const slice = arr.slice(i + 1 - w, i + 1);
    const m = mean(slice);
    const s = stddev(slice);
    const z = s > 0 ? (safe(arr[i], 0) - m) / s : 0;
    out.push(z);
  }
  return out;
}

// ---------- Exponential moving metrics ----------
/** Simple EMA with smoothing α in (0,1]. If alpha omitted, uses 2/(n+1). */
export function ema(arr: number[], n: number, alpha?: number): number[] {
  const N = Math.max(1, Math.floor(n));
  const a = isFiniteNumber(alpha) && alpha! > 0 && alpha! <= 1 ? alpha! : 2 / (N + 1);
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < arr.length; i++) {
    const x = safe(arr[i], 0);
    if (i === 0) prev = x;
    else prev = a * x + (1 - a) * prev;
    out.push(prev);
  }
  return out;
}

/** EWMA variance with decay λ (0<λ<1), per RiskMetrics; returns variance (not stdev). */
export function ewmaVariance(returns: number[], lambda: number = 0.94): number[] {
  const l = clamp(lambda, 0.000001, 0.999999);
  const out: number[] = [];
  let v = 0;
  for (let i = 0; i < returns.length; i++) {
    const r = safe(returns[i], 0);
    v = l * v + (1 - l) * r * r;
    out.push(v);
  }
  return out;
}

export function ewmaStd(returns: number[], lambda: number = 0.94): number[] {
  return ewmaVariance(returns, lambda).map((v) => Math.sqrt(Math.max(v, 0)));
}

/** Wilder's smoothing (RMA) commonly used for RSI etc. */
export function rma(arr: number[], n: number): number[] {
  const N = Math.max(1, Math.floor(n));
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < arr.length; i++) {
    const x = safe(arr[i], 0);
    if (i < N) {
      prev = (prev * i + x) / (i + 1); // simple average for warmup
    } else {
      prev = (prev * (N - 1) + x) / N;
    }
    out.push(prev);
  }
  return out;
}

// ---------- Returns & risk ----------
/** Convert price series to log returns; NaN for first element. */
export function logReturns(prices: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (i === 0) out.push(NaN);
    else {
      const p0 = Math.max(1e-12, safe(prices[i - 1], 0));
      const p1 = Math.max(1e-12, safe(prices[i], 0));
      out.push(Math.log(p1 / p0));
    }
  }
  return out;
}

/** Convert returns to cumulative equity curve (starting at 1.0). */
export function cumCurve(returns: number[]): number[] {
  const out: number[] = [];
  let c = 1;
  for (let i = 0; i < returns.length; i++) {
    const r = safe(returns[i], 0);
    c *= 1 + r;
    out.push(c);
  }
  return out;
}

/** Annualized volatility from daily returns (uses 252). */
export function annualizedVol(dailyReturns: number[]): number {
  const v = variance(dailyReturns.filter(isFiniteNumber));
  return Math.sqrt(v) * Math.sqrt(252);
}

/** Annualized geometric return from daily returns. */
export function annualizedReturn(dailyReturns: number[]): number {
  const d = dailyReturns.filter(isFiniteNumber);
  if (!d.length) return 0;
  let c = 1;
  for (let i = 0; i < d.length; i++) c *= (1 + d[i]);
  const yrs = d.length / 252;
  return yrs > 0 ? Math.pow(c, 1 / yrs) - 1 : 0;
}

/** Rolling realized volatility (annualized). */
export function rollingRealizedVol(dailyReturns: number[], window: number): number[] {
  return rollingApply(dailyReturns, Math.max(2, window), (w) => {
    const v = variance(w);
    return Math.sqrt(v) * Math.sqrt(252);
  });
}

/** Rolling Sharpe ratio using mean/vol (annualized), risk-free assumed 0. */
export function rollingSharpe(dailyReturns: number[], window: number): number[] {
  const w = Math.max(2, Math.floor(window));
  const out: number[] = [];
  for (let i = 0; i < dailyReturns.length; i++) {
    if (i + 1 < w) { out.push(NaN); continue; }
    const slice = dailyReturns.slice(i + 1 - w, i + 1);
    const mu = mean(slice) * 252;
    const vol = Math.sqrt(Math.max(variance(slice), 0)) * Math.sqrt(252);
    out.push(vol > 0 ? mu / vol : 0);
  }
  return out;
}

// ---------- Drawdown analytics ----------
export function drawdowns(curve: number[]): { dd: number[]; peakIndex: number[] } {
  const dd: number[] = [];
  const peakIndex: number[] = [];
  let peak = -Infinity;
  let pIdx = -1;
  for (let i = 0; i < curve.length; i++) {
    const v = safe(curve[i], 0);
    if (v > peak) { peak = v; pIdx = i; }
    dd.push(peak > 0 ? (v / peak - 1) : 0);
    peakIndex.push(pIdx);
  }
  return { dd, peakIndex };
}

export function maxDrawdown(curve: number[]): { mdd: number; start: number; end: number } {
  const { dd } = drawdowns(curve);
  let mdd = 0, end = -1;
  for (let i = 0; i < dd.length; i++) {
    if (dd[i] < mdd) { mdd = dd[i]; end = i; }
  }
  if (end < 0) return { mdd: 0, start: 0, end: 0 };
  // find peak before end
  let peak = -Infinity, start = 0;
  for (let i = 0; i <= end; i++) {
    if (safe(curve[i], 0) > peak) { peak = safe(curve[i], 0); start = i; }
  }
  return { mdd, start, end };
}

// ---------- Rolling beta & z of spread (for pairs/stat-arb) ----------
export function rollingBeta(seriesA: number[], seriesB: number[], window: number): number[] {
  const w = Math.max(2, Math.floor(window));
  const out: number[] = [];
  for (let i = 0; i < seriesA.length; i++) {
    if (i + 1 < w) { out.push(NaN); continue; }
    const a = seriesA.slice(i + 1 - w, i + 1);
    const b = seriesB.slice(i + 1 - w, i + 1);
    const vB = variance(b);
    out.push(vB > 0 ? covariance(a, b) / vB : 1);
  }
  return out;
}

export function rollingSpreadZ(
  seriesA: number[],
  seriesB: number[],
  window: number
): { z: number[]; beta: number[]; spread: number[] } {
  const w = Math.max(2, Math.floor(window));
  const z: number[] = [], bet: number[] = [], spr: number[] = [];
  for (let i = 0; i < seriesA.length; i++) {
    if (i + 1 < w) { z.push(NaN); bet.push(NaN); spr.push(NaN); continue; }
    const a = seriesA.slice(i + 1 - w, i + 1);
    const b = seriesB.slice(i + 1 - w, i + 1);
    const vB = variance(b);
    const beta = vB > 0 ? covariance(a, b) / vB : 1;
    const spread = a[a.length - 1] - beta * b[b.length - 1];
    const m = mean(a.map((x, k) => x - beta * b[k]));
    const s = stddev(a.map((x, k) => x - beta * b[k]));
    z.push(s > 0 ? (spread - m) / s : 0);
    bet.push(beta);
    spr.push(spread);
  }
  return { z, beta: bet, spread: spr };
}

// ---------- Utility transforms ----------
export function difference(arr: number[], lag: number = 1): number[] {
  const L = Math.max(1, Math.floor(lag));
  const out: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < L) out.push(NaN);
    else out.push(safe(arr[i], 0) - safe(arr[i - L], 0));
  }
  return out;
}

export function pctChange(arr: number[], lag: number = 1): number[] {
  const L = Math.max(1, Math.floor(lag));
  const out: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < L) out.push(NaN);
    else {
      const prev = safe(arr[i - L], 0);
      const cur = safe(arr[i], 0);
      out.push(prev !== 0 ? cur / prev - 1 : NaN);
    }
  }
  return out;
}
