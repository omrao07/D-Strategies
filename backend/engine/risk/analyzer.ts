// engine/risk/analyzer.ts
// Zero-deps risk analytics. ESM/NodeNext friendly. Works even if libs/curve is JS.

import * as Curve from "../../libs/curve.js";

/* ======================================
   Local structural types (do NOT import
   types from JS modules to avoid TS2307)
   ====================================== */

export type EquityPt = { date: string; equity: number };
export type RetPt    = { date: string; ret: number };
export type Series   = RetPt[];
export type SeriesMap = Record<string, Series>;

export type ExposureResult = {
  beta: number;
  alphaAnn: number;
  r2: number;
  n: number;
  stderrBeta?: number;
  stderrAlpha?: number;
};

export type MultiFactorResult = {
  betas: Record<string, number>;
  alphaAnn: number;
  r2: number;
  n: number;
  stderr?: Record<string, number>;
};

export type CorrMatrix = { keys: string[]; matrix: number[][] };
export type RollingStat = { date: string; value: number };

export type VarEs = {
  var: number;     // positive magnitude (e.g. 0.02 = 2%)
  es: number;      // positive magnitude
  mean: number;
  sd: number;
  cl: number;
  method: "parametric" | "historical";
};

/* ======================================
   Access JS helpers via a typed alias
   ====================================== */
const C: any = Curve; // C.toReturns(..), C.sanitize(..), C.maxDrawdown(..)
const DAYS: number = (C?.DEFAULT_DAYS ?? 252) as number;
const SQ = Math.sqrt;

/* ======================================
   Math helpers
   ====================================== */
function mean(xs: number[]) { return xs.length ? xs.reduce((a,b)=>a+b,0) / xs.length : 0; }

function variance(xs: number[], mu = mean(xs)) {
  if (xs.length < 2) return 0;
  let s = 0;
  for (const x of xs) s += (x - mu) * (x - mu);
  return s / (xs.length - 1);
}
function stdev(xs: number[], mu = mean(xs)) { return Math.sqrt(Math.max(0, variance(xs, mu))); }

function covariance(x: number[], y: number[]) {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let s = 0;
  for (let i = 0; i < n; i++) s += (x[i] - mx) * (y[i] - my);
  return s / (n - 1);
}
function correlate(x: number[], y: number[]) {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  const sx = stdev(x.slice(0, n), mx);
  const sy = stdev(y.slice(0, n), my);
  if (sx === 0 || sy === 0) return 0;
  return covariance(x.slice(0, n), y.slice(0, n)) / (sx * sy);
}
function dot(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}
function transpose(A: number[][]) {
  const m = A.length, n = A[0]?.length ?? 0;
  const T = Array.from({ length: n }, () => Array(m).fill(0));
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) T[j][i] = A[i][j];
  return T;
}
function multiply(A: number[][], B: number[][]) {
  const m = A.length, n = B[0]?.length ?? 0, k = B.length;
  const out = Array.from({ length: m }, () => Array(n).fill(0));
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
    let s = 0;
    for (let t = 0; t < k; t++) s += (A[i][t] ?? 0) * (B[t][j] ?? 0);
    out[i][j] = s;
  }
  return out;
}
function multiplyVec(A: number[][], v: number[]) {
  return A.map(row => dot(row, v));
}
function invertSymmetric(A: number[][]): number[][] | null {
  const n = A.length;
  if (!n || A[0].length !== n) return null;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let i = 0; i < n; i++) {
    let piv = M[i][i];
    if (Math.abs(piv) < 1e-12) return null;
    for (let j = 0; j < 2*n; j++) M[i][j] /= piv;
    for (let r = 0; r < n; r++) if (r !== i) {
      const f = M[r][i];
      for (let c = 0; c < 2*n; c++) M[r][c] -= f * M[i][c];
    }
  }
  const Inv = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Inv[i][j] = M[i][j + n];
  return Inv;
}

/* ======================================
   Alignment helpers
   ====================================== */
export function alignSeries(a: Series, b: Series): [Series, Series] {
  const map = new Map(b.map(r => [r.date, r.ret]));
  const A: Series = [], B: Series = [];
  for (const r of a) if (map.has(r.date)) { A.push(r); B.push({ date: r.date, ret: map.get(r.date)! }); }
  return [A, B];
}

export function alignMany(series: SeriesMap): { dates: string[]; byKey: Record<string, number[]> } {
  const keys = Object.keys(series);
  const dateSet = new Set<string>();
  keys.forEach(k => series[k].forEach(r => dateSet.add(r.date)));
  const dates = Array.from(dateSet).sort();
  const byKey: Record<string, number[]> = {};
  for (const k of keys) {
    const map = new Map(series[k].map(r => [r.date, r.ret]));
    byKey[k] = dates.map(d => (map.get(d) ?? NaN));
  }
  return { dates, byKey };
}

/* ======================================
   Single- & Multi-factor exposure
   ====================================== */
export function factorExposure(
  asset: Series,
  factor: Series,
  rfDaily = 0,
  daysPerYear = DAYS
): ExposureResult {
  const [A, F] = alignSeries(asset, factor);
  if (!A.length) return { beta: 0, alphaAnn: 0, r2: 0, n: 0 };

  const y = A.map(r => r.ret - rfDaily);
  const x = F.map(r => r.ret - rfDaily);

  const mx = mean(x), my = mean(y);
  const varx = variance(x, mx);
  const covxy = covariance(x, y);
  const beta = varx ? covxy / varx : 0;
  const alphaDaily = my - beta * mx;

  const n = x.length;
  const yhat = x.map(v => alphaDaily + beta * v);
  const myy = mean(y);
  let sst = 0, ssr = 0, sse = 0;
  for (let i = 0; i < n; i++) {
    sst += (y[i] - myy) ** 2;
    ssr += (yhat[i] - myy) ** 2;
    sse += (y[i] - yhat[i]) ** 2;
  }
  const r2 = sst ? ssr / sst : 0;

  const sigma2 = n > 2 ? sse / (n - 2) : 0;
  const stderrBeta  = n > 0 && varx > 0 ? Math.sqrt(sigma2 / (n * varx)) : undefined;
  const stderrAlpha = n > 0 && varx > 0 ? Math.sqrt(sigma2 * (1/n + (mx*mx)/(n*varx))) : undefined;

  return { beta, alphaAnn: alphaDaily * daysPerYear, r2, n, stderrBeta, stderrAlpha };
}

export function multiFactorExposure(
  asset: Series,
  factors: SeriesMap,
  rfDaily = 0,
  daysPerYear = DAYS
): MultiFactorResult {
  const names = Object.keys(factors);
  if (!names.length) return { betas: {}, alphaAnn: 0, r2: 0, n: 0 };

  const aligned = alignMany({ asset, ...factors });
  const yRaw = aligned.byKey["asset"].map(v => v - rfDaily);
  const Xcols = names.map(k => aligned.byKey[k].map(v => v - rfDaily));

  // keep rows with all-finite values
  const nRows = Math.min(yRaw.length, ...Xcols.map(c => c.length));
  const rows: number[][] = [];
  for (let i = 0; i < nRows; i++) {
    const row = [yRaw[i], ...Xcols.map(c => c[i])];
    if (row.every(Number.isFinite)) rows.push(row);
  }
  if (!rows.length) return { betas: Object.fromEntries(names.map(n => [n, 0])), alphaAnn: 0, r2: 0, n: 0 };

  const y = rows.map(r => r[0]);
  const X = rows.map(r => [1, ...r.slice(1)]);
  const Xt = transpose(X);
  const XtX = multiply(Xt, X);
  const XtXinv = invertSymmetric(XtX);
  if (!XtXinv) return { betas: Object.fromEntries(names.map(n => [n, 0])), alphaAnn: 0, r2: 0, n: rows.length };

  const Xty = multiplyVec(Xt, y);
  const theta = multiplyVec(XtXinv, Xty); // [alpha, beta1..]

  const alphaDaily = theta[0] || 0;
  const betas: Record<string, number> = {};
  names.forEach((nm, i) => betas[nm] = theta[i + 1] || 0);

  const yhat = X.map(r => dot(r, theta));
  const my = mean(y);
  let sst = 0, ssr = 0, sse = 0;
  for (let i = 0; i < y.length; i++) {
    sst += (y[i] - my) ** 2;
    ssr += (yhat[i] - my) ** 2;
    sse += (y[i] - yhat[i]) ** 2;
  }
  const r2 = sst ? ssr / sst : 0;

  const k = 1 + names.length;
  const sigma2 = y.length > k ? sse / (y.length - k) : 0;
  const stderr: Record<string, number> = {};
  for (let i = 0; i < names.length; i++) {
    const varBeta = sigma2 * XtXinv[i + 1][i + 1];
    stderr[names[i]] = varBeta > 0 ? Math.sqrt(varBeta) : 0;
  }

  return { betas, alphaAnn: alphaDaily * daysPerYear, r2, n: y.length, stderr };
}

/* ======================================
   Correlations
   ====================================== */
export function correlationMatrix(map: SeriesMap): CorrMatrix {
  const { byKey } = alignMany(map);
  const keys = Object.keys(byKey);
  const matrix: number[][] = [];
  for (let i = 0; i < keys.length; i++) {
    matrix[i] = [];
    for (let j = 0; j < keys.length; j++) {
      const a = byKey[keys[i]].filter(Number.isFinite);
      const b = byKey[keys[j]].filter(Number.isFinite);
      matrix[i][j] = a.length && b.length ? correlate(a, b) : 0;
    }
  }
  return { keys, matrix };
}

/* ======================================
   Rolling metrics
   ====================================== */
export function rollingSharpe(series: Series, window = 63, daysPerYear = DAYS): RollingStat[] {
  const out: RollingStat[] = [];
  for (let i = 0; i < series.length; i++) {
    const from = Math.max(0, i - window + 1);
    const slice = series.slice(from, i + 1).map(r => r.ret);
    const mu = mean(slice);
    const sd = stdev(slice, mu);
    const sharpe = sd ? (mu * daysPerYear) / (sd * SQ(daysPerYear)) : 0;
    out.push({ date: series[i].date, value: sharpe });
  }
  return out;
}

export function rollingVol(series: Series, window = 63, daysPerYear = DAYS): RollingStat[] {
  const out: RollingStat[] = [];
  for (let i = 0; i < series.length; i++) {
    const from = Math.max(0, i - window + 1);
    const slice = series.slice(from, i + 1).map(r => r.ret);
    out.push({ date: series[i].date, value: stdev(slice) * SQ(daysPerYear) });
  }
  return out;
}

export function rollingMaxDD(curve: EquityPt[], window = 252): RollingStat[] {
  const c: EquityPt[] = Array.isArray(curve) ? C.sanitize(curve) : [];
  const out: RollingStat[] = [];
  for (let i = 0; i < c.length; i++) {
    const from = Math.max(0, i - window + 1);
    const slice = c.slice(from, i + 1);
    out.push({ date: c[i].date, value: Math.abs(C.maxDrawdown(slice)) });
  }
  return out;
}

/* ======================================
   VaR / ES
   ====================================== */
function invNorm(cl: number) {
  // Acklam inverse CDF approximation
  const p = Math.min(1 - 1e-12, Math.max(1e-12, cl));
  const a1=-39.69683028665376,a2=220.9460984245205,a3=-275.9285104469687,a4=138.3577518672690,a5=-30.66479806614716,a6=2.506628277459239;
  const b1=-54.47609879822406,b2=161.5858368580409,b3=-155.6989798598866,b4=66.80131188771972,b5=-13.28068155288572;
  const c1=-0.007784894002430293,c2=-0.3223964580411365,c3=-2.400758277161838,c4=-2.549732539343734,c5=4.374664141464968,c6=2.938163982698783;
  const d1=0.007784695709041462,d2=0.3224671290700398,d3=2.445134137142996,d4=3.754408661907416;
  const pl = 0.02425, ph = 1 - pl;
  let q, r: number;
  if (p < pl) {
    q = Math.sqrt(-2*Math.log(p));
    return (((((c1*q+c2)*q+c3)*q+c4)*q+c5)*q+c6)/((((d1*q+d2)*q+d3)*q+d4)*q+1);
  }
  if (p > ph) {
    q = Math.sqrt(-2*Math.log(1-p));
    return -(((((c1*q+c2)*q+c3)*q+c4)*q+c5)*q+c6)/((((d1*q+d2)*q+d3)*q+d4)*q+1);
  }
  q = p - 0.5; r = q*q;
  return (((((a1*r+a2)*r+a3)*r+a4)*r+a5)*r+a6)*q/(((((b1*r+b2)*r+b3)*r+b4)*r+b5)*r+1);
}
function pdfStdNorm(z: number) { return Math.exp(-0.5*z*z) / Math.sqrt(2*Math.PI); }

export function varEsParametric(series: Series, cl = 0.99): VarEs {
  const xs = series.map(r => r.ret).filter(Number.isFinite);
  const mu = mean(xs), sd = stdev(xs, mu);
  const z = invNorm(cl);
  const VaR = Math.max(0, z * sd - mu);                           // magnitude
  const ES  = Math.max(0, (sd * pdfStdNorm(z)) / (1 - cl) - mu);  // magnitude
  return { var: VaR, es: ES, mean: mu, sd, cl, method: "parametric" };
}

export function varEsHistorical(series: Series, cl = 0.99): VarEs {
  const xs = series.map(r => r.ret).filter(Number.isFinite).sort((a,b)=>a-b);
  const mu = mean(xs), sd = stdev(xs, mu);
  if (!xs.length) return { var: 0, es: 0, mean: 0, sd: 0, cl, method: "historical" };
  const k = Math.max(0, Math.min(xs.length - 1, Math.floor((1 - cl) * xs.length)));
  const varLoss = -xs[k];
  const tail = xs.slice(0, k + 1);
  const esLoss = tail.length ? -mean(tail) : varLoss;
  return { var: Math.max(0, varLoss), es: Math.max(0, esLoss), mean: mu, sd, cl, method: "historical" };
}

export function varEsBoth(series: Series, cl = 0.99) {
  return { parametric: varEsParametric(series, cl), historical: varEsHistorical(series, cl) };
}

/* ======================================
   Attribution (simple)
   ====================================== */
export type Position = { symbol: string; qty: number; price?: number };
export type PositionSnapshot = { date: string; positions: Position[] };

export function pnlAttribution(prev: PositionSnapshot, next: PositionSnapshot) {
  const byPrev = new Map(prev.positions.map(p => [p.symbol, p]));
  const byNext = new Map(next.positions.map(p => [p.symbol, p]));
  const symbols = Array.from(new Set([...byPrev.keys(), ...byNext.keys()]));
  const out: Array<{ symbol: string; holding: number; trading: number; total: number }> = [];
  let hold = 0, trade = 0;

  for (const s of symbols) {
    const a = byPrev.get(s) || { symbol: s, qty: 0, price: 0 };
    const b = byNext.get(s) || { symbol: s, qty: 0, price: 0 };
    const pa = Number(a.price ?? 0), pb = Number(b.price ?? 0);
    const qa = Number(a.qty || 0), qb = Number(b.qty || 0);

    const holding = qa * (pb - pa);
    const trading = (qb - qa) * pb;

    hold += holding; trade += trading;
    out.push({ symbol: s, holding, trading, total: holding + trading });
  }

  out.sort((x, y) => Math.abs(y.total) - Math.abs(x.total));
  return { holding: hold, trading: trade, total: hold + trade, bySymbol: out };
}

/* ======================================
   Convenience wrappers
   ====================================== */
export function exposureFromEquity(curve: EquityPt[], bench: EquityPt[], rfDaily = 0, daysPerYear = DAYS) {
  const a: Series = Array.isArray(curve) ? C.toReturns(curve) : [];
  const b: Series = Array.isArray(bench) ? C.toReturns(bench) : [];
  return factorExposure(a, b, rfDaily, daysPerYear);
}

export function corrFromEquity(curves: Record<string, EquityPt[]>) {
  const map: SeriesMap = {};
  for (const k of Object.keys(curves)) map[k] = C.toReturns(curves[k]);
  return correlationMatrix(map);
}

export function seriesFromEquity(curve: EquityPt[]): Series {
  const c = (curve ?? []).filter(p => Number.isFinite(p.equity));
  const out: Series = [];
  for (let i = 1; i < c.length; i++) {
    const prev = c[i-1].equity, next = c[i].equity;
    out.push({ date: c[i].date, ret: prev > 0 ? (next/prev - 1) : 0 });
  }
  return out;
}

/* ======================================
   Default export (optional)
   ====================================== */
export default {
  factorExposure,
  multiFactorExposure,
  exposureFromEquity,
  correlationMatrix,
  corrFromEquity,
  rollingSharpe,
  rollingVol,
  rollingMaxDD,
  varEsParametric,
  varEsHistorical,
  varEsBoth,
  pnlAttribution,
  alignSeries,
  alignMany,
  seriesFromEquity,
};