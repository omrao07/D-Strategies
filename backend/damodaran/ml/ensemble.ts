// ml/ensemble.ts
// Lightweight ensembling for alpha signals/strategies.
// - Normalization: zscore, rank, minmax, winsor
// - Combine: equal / value-weighted / IC-weighted (with decay)
// - Rank aggregation: median rank, Borda
// - Stacking: ridge regression (closed-form) with L2 regularization
// - Rolling fit/combine for OOS evaluations
// - Metrics: IC, IR, hit rate, turnover
//
// Data layout: a time-indexed panel of signals per strategy per symbol.

export type Num = number;
export type Symbol = string;
export type Strategy = string;
export type Timestamp = number | string | Date;

export interface PanelPoint {
  t: Timestamp;     // timestamp (aligned across inputs)
  s: Symbol;        // symbol
  v: Num;           // value (signal or return)
}

export type Panel = PanelPoint[];

export interface NormalizationOpts {
  method?: "zscore" | "rank" | "minmax" | "identity";
  winsorPct?: number;    // two-sided e.g. 0.02
  clipMin?: number;      // hard clip after normalization
  clipMax?: number;
}

export interface ICSpec {
  method?: "spearman" | "pearson";
}

export interface ICWeightSpec extends ICSpec {
  halfLife?: number;   // exponential decay half-life (in periods) for rolling IC
  floor?: number;      // minimal absolute weight
  cap?: number;        // max weight magnitude
}

export interface RidgeSpec {
  lambda?: number;     // L2 strength
  intercept?: boolean; // include intercept term
}

export interface RollingSpec {
  lookback: number;    // training window size
  step?: number;       // step between windows
  ridge?: RidgeSpec;   // for stacking
  icWeight?: ICWeightSpec; // for IC weighting
}

export interface CombineOpts {
  norm?: NormalizationOpts;
  method:
    | { kind: "equal" }
    | { kind: "value"; weights: Record<Strategy, number> }
    | { kind: "ic"; ic: ICWeightSpec }        // IC-weighted
    | { kind: "rank"; agg: "median" | "borda" }
    | { kind: "stack"; ridge?: RidgeSpec };   // ridge stacking
}

/* ============================== Utils =============================== */

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function toEpoch(t: Timestamp): number {
  if (typeof t === "number") return t;
  if (t instanceof Date) return t.getTime();
  const ms = new Date(t).getTime();
  if (!Number.isFinite(ms)) throw new Error(`Bad timestamp: ${t}`);
  return ms;
}

function groupBy<T, K extends string | number>(xs: T[], key: (x: T) => K): Record<string, T[]> {
  const m: Record<string, T[]> = {};
  for (const x of xs) {
    const k = String(key(x));
    (m[k] ||= []).push(x);
  }
  return m;
}

function uniq<T>(xs: T[]): T[] { return Array.from(new Set(xs)); }

function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a,b)=>a-b);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos), rest = pos - base;
  return s[base + 1] !== undefined ? s[base] + rest*(s[base+1]-s[base]) : s[base];
}

function winsor(xs: number[], p = 0.02): number[] {
  if (!p || p <= 0) return xs.slice();
  const lo = quantile(xs, p), hi = quantile(xs, 1 - p);
  return xs.map(v => Math.min(Math.max(v, lo), hi));
}

function zscore(xs: number[]): number[] {
  const n = xs.length; if (!n) return [];
  const m = xs.reduce((a,b)=>a+b,0)/n;
  const v = xs.reduce((a,b)=>a+(b-m)*(b-m),0)/Math.max(1, n-1);
  const s = Math.sqrt(v || 1e-12);
  return xs.map(x => (x - m)/s);
}

function rank01(xs: number[]): number[] {
  const n = xs.length; if (!n) return [];
  const pairs = xs.map((v,i)=>({v,i})).sort((a,b)=>a.v-b.v);
  const out = new Array(n).fill(0);
  for (let r=0;r<n;r++) out[pairs[r].i] = n===1 ? 0.5 : r/(n-1);
  return out;
}

function minmax(xs: number[]): number[] {
  const mi = Math.min(...xs), ma = Math.max(...xs);
  const den = (ma - mi) || 1e-12;
  return xs.map(v => (v - mi)/den * 2 - 1); // scale to [-1,1]
}

function pearson(x: number[], y: number[]): number {
  const n = x.length; if (n !== y.length || n === 0) return NaN;
  const mx = x.reduce((a,b)=>a+b,0)/n, my = y.reduce((a,b)=>a+b,0)/n;
  let nx=0, ny=0, c=0;
  for (let i=0;i<n;i++){ const dx=x[i]-mx, dy=y[i]-my; nx+=dx*dx; ny+=dy*dy; c+=dx*dy; }
  return c / Math.sqrt((nx||1e-12)*(ny||1e-12));
}

function spearman(x: number[], y: number[]): number {
  // compute ranks and pearson on ranks
  const rx = rank01(x), ry = rank01(y);
  return pearson(rx, ry);
}

/* ============================== Panels =============================== */

/** Converts a nested map signals[strategy][t][symbol] -> matrix form per timestamp. */
export function alignPanel(
  signals: Record<Strategy, Panel>,
  returns?: Panel
): {
  times: number[];
  symbols: string[];
  S: Strategy[];
  X: Record<number, Record<Strategy, number[]>>; // time -> strategy -> vector over symbols
  Y?: Record<number, number[]>;                  // time -> realized return vector over symbols
} {
  const S = Object.keys(signals);
  const allTimes = uniq(S.flatMap(k => signals[k].map(p => toEpoch(p.t)))).sort((a,b)=>a-b);
  const allSyms = uniq(S.flatMap(k => signals[k].map(p => p.s))).sort();
  const symIndex = new Map(allSyms.map((s,i)=>[s,i]));

  const X: Record<number, Record<Strategy, number[]>> = {};
  for (const t of allTimes) {
    X[t] = Object.fromEntries(S.map(k => [k, new Array(allSyms.length).fill(NaN)]));
  }

  for (const k of S) {
    for (const p of signals[k]) {
      const t = toEpoch(p.t); const j = symIndex.get(p.s)!;
      if (!X[t]) X[t] = Object.fromEntries(S.map(s => [s, new Array(allSyms.length).fill(NaN)]));
      X[t][k][j] = p.v;
    }
  }

  let Y: Record<number, number[]> | undefined;
  if (returns) {
    Y = {};
    for (const p of returns) {
      const t = toEpoch(p.t); const j = symIndex.get(p.s)!;
      (Y[t] ||= new Array(allSyms.length).fill(NaN))[j] = p.v;
    }
  }

  return { times: allTimes, symbols: allSyms, S, X, Y };
}

/* ============================ Normalization =========================== */

export function normalizeVector(xs: number[], opt: NormalizationOpts = {}): number[] {
  const wins = opt.winsorPct ? winsor(xs, opt.winsorPct) : xs.slice();
  let out: number[];
  switch (opt.method) {
    case "zscore": out = zscore(wins); break;
    case "rank": out = rank01(wins).map(v => v*2 - 1); break; // rank to [-1,1]
    case "minmax": out = minmax(wins); break;
    case "identity":
    default: out = wins;
  }
  if (isNum(opt.clipMin) || isNum(opt.clipMax)) {
    const lo = opt.clipMin ?? -Infinity, hi = opt.clipMax ?? Infinity;
    out = out.map(v => Math.min(Math.max(v, lo), hi));
  }
  return out;
}

/* ============================ Metrics ================================= */

export interface Perf {
  ic: number;      // cross-sectional (per timestamp)
  ir: number;      // IC mean / std
  hit: number;     // fraction correct sign
}

export function crossSectionalIC(x: number[], y: number[], spec: ICSpec = {}): number {
  const valid: number[] = [];
  const validY: number[] = [];
  for (let i=0;i<x.length;i++) if (isNum(x[i]) && isNum(y[i])) { valid.push(x[i]); validY.push(y[i]); }
  if (valid.length < 3) return NaN;
  return (spec.method === "pearson") ? pearson(valid, validY) : spearman(valid, validY);
}

export function panelIC(
  X: Record<number, number[]>, // strategy or combined vector per time
  Y: Record<number, number[]>, // realized returns per time
  spec: ICSpec = {}
): { mean: number; stdev: number; series: Array<{ t: number; ic: number }> } {
  const out: Array<{ t: number; ic: number }> = [];
  for (const tStr of Object.keys(X)) {
    const t = Number(tStr);
    if (!Y[t]) continue;
    const ic = crossSectionalIC(X[t], Y[t], spec);
    if (isNum(ic)) out.push({ t, ic });
  }
  const n = out.length;
  const mean = n ? out.reduce((a,b)=>a+b.ic,0)/n : NaN;
  const sd = n>1 ? Math.sqrt(out.reduce((a,b)=>a+(b.ic-mean)**2,0)/(n-1)) : NaN;
  return { mean, stdev: sd, series: out };
}

export function hitRate(pred: number[], realized: number[]): number {
  let ok=0, n=0;
  for (let i=0;i<pred.length;i++){
    const a=pred[i], b=realized[i];
    if (!isNum(a) || !isNum(b)) continue;
    n++; if ((a>=0 && b>=0) || (a<0 && b<0)) ok++;
  }
  return n ? ok/n : NaN;
}

/* ============================ Combiners =============================== */

/** Equal-weight average across strategies. */
export function combineEqual(vectors: Record<Strategy, number[]>): number[] {
  const S = Object.keys(vectors); if (!S.length) return [];
  const n = vectors[S[0]].length;
  const out = new Array(n).fill(0);
  for (const k of S) {
    const x = vectors[k];
    for (let i=0;i<n;i++) out[i] += (x[i] ?? 0);
  }
  for (let i=0;i<n;i++) out[i] /= S.length;
  return out;
}

/** Value-weighted average with explicit weights. */
export function combineValue(vectors: Record<Strategy, number[]>, weights: Record<Strategy, number>): number[] {
  const S = Object.keys(vectors);
  const n = vectors[S[0]].length;
  const out = new Array(n).fill(0);
  let wsum = 0;
  for (const k of S) {
    const w = weights[k] ?? 0; wsum += Math.abs(w);
    const x = vectors[k];
    for (let i=0;i<n;i++) out[i] += w * (x[i] ?? 0);
  }
  const norm = wsum || 1;
  for (let i=0;i<n;i++) out[i] /= norm;
  return out;
}

/** IC-weighted average using exponential decay of recent ICs. */
export function icWeights(
  icSeries: Record<Strategy, Array<{ t: number; ic: number }>>,
  spec: ICWeightSpec
): Record<Strategy, number> {
  const { halfLife = 20, floor = 0, cap = 5 } = spec;
  const w: Record<Strategy, number> = {};
  for (const k of Object.keys(icSeries)) {
    const ser = icSeries[k];
    if (!ser?.length) { w[k] = floor; continue; }
    // exponential weights from most recent to oldest
    const lam = Math.log(2) / Math.max(1, halfLife);
    let num = 0, den = 0;
    const tMax = Math.max(...ser.map(x=>x.t));
    for (const { t, ic } of ser) {
      const age = Math.max(0, (tMax - t) / 86400000); // days approx; only relative matters
      const a = Math.exp(-lam * age);
      num += a * ic;
      den += a;
    }
    let wi = den ? num/den : 0;
    if (Math.abs(wi) < floor) wi = Math.sign(wi) * floor;
    if (Math.abs(wi) > cap) wi = Math.sign(wi) * cap;
    w[k] = wi;
  }
  // normalize L1
  const sumAbs = Object.values(w).reduce((a,b)=>a+Math.abs(b),0) || 1;
  for (const k of Object.keys(w)) w[k] = w[k] / sumAbs;
  return w;
}

/** Rank aggregation (median rank or Borda count). */
export function combineRank(vectors: Record<Strategy, number[]>, method: "median" | "borda" = "median"): number[] {
  const S = Object.keys(vectors); const n = vectors[S[0]].length;
  const ranks: number[][] = S.map(k => rank01(vectors[k])); // [0,1]
  const out = new Array(n).fill(0);
  if (method === "median") {
    for (let i=0;i<n;i++) {
      const col = ranks.map(r => r[i]).sort((a,b)=>a-b);
      const m = col.length%2? col[(col.length-1)/2] : 0.5*(col[col.length/2-1]+col[col.length/2]);
      out[i] = m*2 - 1; // back to [-1,1]
    }
  } else {
    // Borda: average rank
    for (let i=0;i<n;i++) {
      let s = 0; for (const r of ranks) s += r[i];
      out[i] = (s / ranks.length)*2 - 1;
    }
  }
  return out;
}

/* =============================== Stacking ============================= */

function addIntercept(X: number[][]): number[][] { return X.map(row => [1, ...row]); }
function transpose(A: number[][]): number[][] {
  if (!A.length) return []; const m=A.length, n=A[0].length;
  const T = Array.from({length:n},()=>Array(m).fill(0));
  for (let i=0;i<m;i++) for (let j=0;j<n;j++) T[j][i]=A[i][j];
  return T;
}
function matMul(A: number[][], B: number[][]): number[][] {
  const m=A.length, n=A[0].length, p=B[0].length;
  const C = Array.from({length:m},()=>Array(p).fill(0));
  for (let i=0;i<m;i++) for (let k=0;k<n;k++){ const aik=A[i][k]; for (let j=0;j<p;j++) C[i][j]+=aik*B[k][j]; }
  return C;
}
function matVec(A: number[][], v: number[]): number[] {
  const m=A.length, n=A[0].length; const out = new Array(m).fill(0);
  for (let i=0;i<m;i++){ let s=0; for (let j=0;j<n;j++) s+=A[i][j]*v[j]; out[i]=s; }
  return out;
}
function invert(M: number[][]): number[][] {
  const n = M.length; const A=M.map(r=>r.slice()); const I = Array.from({length:n},(_,i)=>{const r=Array(n).fill(0); r[i]=1; return r;});
  for (let i=0;i<n;i++){
    let piv=A[i][i]; if (Math.abs(piv)<1e-12){ let sw=i+1; for(;sw<n;sw++) if (Math.abs(A[sw][i])>Math.abs(piv)) break;
      if (sw===n) throw new Error("Singular"); [A[i],A[sw]]=[A[sw],A[i]]; [I[i],I[sw]]=[I[sw],I[i]]; piv=A[i][i]; }
    const invP=1/piv; for(let j=0;j<n;j++){A[i][j]*=invP; I[i][j]*=invP;}
    for(let r=0;r<n;r++) if(r!==i){ const f=A[r][i]; for(let c=0;c<n;c++){A[r][c]-=f*A[i][c]; I[r][c]-=f*I[i][c];}}
  }
  return I;
}

/** Ridge regression stacking: y ~ X w (+ intercept) with L2 λ */
export function ridgeStacking(
  X: number[][], // rows = observations, cols = strategies
  y: number[],   // target (e.g., realized cross-sec returns per symbol or portfolio return)
  spec: RidgeSpec = {}
): { weights: number[]; intercept: number } {
  const lambda = spec.lambda ?? 1e-2;
  const withB = spec.intercept !== false;
  const Xr = withB ? addIntercept(X) : X;
  const Xt = transpose(Xr);
  // (X'X + λI)^{-1} X'y
  const XtX = matMul(Xt, Xr);
  for (let i=0;i<XtX.length;i++) XtX[i][i] += lambda; // ridge penalty (also on intercept)
  const XtX_inv = invert(XtX);
  const Xty = matVec(Xt, y);
  const beta = matVec(XtX_inv, Xty);
  const intercept = withB ? beta[0] : 0;
  const weights = withB ? beta.slice(1) : beta.slice();
  // L1 normalize weights for stability (optional)
  const s = weights.reduce((a,b)=>a+Math.abs(b),0) || 1;
  for (let i=0;i<weights.length;i++) weights[i] /= s;
  return { weights, intercept };
}

/* ===================== High-level Combine API ======================== */

/**
 * Combine per-time cross-sectional vectors across strategies using a chosen method.
 * `vectorsAtT` is strategy -> vector (aligned by symbol).
 */
export function combineOne(
  vectorsAtT: Record<Strategy, number[]>,
  realizedAtT?: number[],
  opts: CombineOpts = { method: { kind: "equal" } }
): number[] {
  // normalize each strategy vector first
  const normed: Record<Strategy, number[]> = {};
  for (const k of Object.keys(vectorsAtT)) {
    normed[k] = normalizeVector(vectorsAtT[k], opts.norm);
  }

  switch (opts.method.kind) {
    case "equal":
      return combineEqual(normed);
    case "value":
      return combineValue(normed, opts.method.weights);
    case "rank":
      return combineRank(normed, opts.method.agg);
    case "ic": {
      if (!realizedAtT) throw new Error("IC combine requires realized vector at time t.");
      // local IC per strategy at this t (fallback to equal if NaN)
      const weights: Record<Strategy, number> = {};
      for (const k of Object.keys(normed)) {
        const ic = crossSectionalIC(normed[k], realizedAtT, { method: opts.method.ic.method ?? "spearman" });
        weights[k] = isNum(ic) ? ic : 0;
      }
      // simple L1 normalize
      const sumAbs = Object.values(weights).reduce((a,b)=>a+Math.abs(b),0) || 1;
      for (const k of Object.keys(weights)) weights[k] = weights[k] / sumAbs;
      return combineValue(normed, weights);
    }
    case "stack": {
      if (!realizedAtT) throw new Error("Stacking requires realized vector at time t.");
      // Build X (nSymbols × nStrategies)
      const S = Object.keys(normed);
      const n = normed[S[0]].length;
      const X = Array.from({ length: n }, (_, i) => S.map(k => normed[k][i]));
      const y = realizedAtT.slice();
      const { weights } = ridgeStacking(X, y, opts.method.ridge);
      const wMap: Record<Strategy, number> = Object.fromEntries(S.map((k, i) => [k, weights[i] ?? 0]));
      return combineValue(normed, wMap);
    }
    default:
      return combineEqual(normed);
  }
}

/**
 * Rolling out-of-sample combine across time.
 * For each time t, fit weights on [t-lookback, t) and apply to t.
 */
export function combineRolling(
  aligned: ReturnType<typeof alignPanel>,
  realized: Panel,     // realized returns panel (same grid)
  spec: RollingSpec,   // lookback, step, ridge/ic options
  baseCombine: Omit<CombineOpts, "method"> & { method?: CombineOpts["method"] } = {}
): { times: number[]; combined: Record<number, number[]> } {
  const { times, S, X } = aligned;
  // build realized map by time
  const rGrouped = groupBy(realized, p => toEpoch(p.t));
  const Y: Record<number, number[]> = {};
  const syms = aligned.symbols;
  const symIndex = new Map(syms.map((s,i)=>[s,i]));
  for (const [tStr, arr] of Object.entries(rGrouped)) {
    const vec = new Array(syms.length).fill(NaN);
    for (const p of arr) vec[symIndex.get(p.s)!] = p.v;
    Y[Number(tStr)] = vec;
  }

  const look = spec.lookback;
  const step = spec.step ?? 1;
  const out: Record<number, number[]> = {};

  for (let i = look; i < times.length; i += step) {
    const tTrain = times.slice(i - look, i);
    const tApply = times[i];
    // Build per-strategy training matrices
    const trainVectors: Record<Strategy, number[][]> = {};
    const trainY: number[] = [];
    for (const t of tTrain) {
      if (!Y[t]) continue;
      const y = Y[t];
      trainY.push(...y);
      for (const k of S) {
        (trainVectors[k] ||= []).push(X[t][k]);
      }
    }
    if (!trainY.length) continue;

    // For stacking: stack rows across times; for IC weighting: compute IC series
    let method: CombineOpts["method"] = baseCombine.method ?? { kind: "equal" };

    if (spec.ridge && (!baseCombine.method || baseCombine.method.kind === "stack")) {
      // Prepare stacking inputs
      const rows: number[][] = [];
      const y: number[] = [];
      for (const t of tTrain) {
        if (!Y[t]) continue;
        const n = X[t][S[0]].length;
        for (let j=0;j<n;j++) {
          rows.push(S.map(k => normalizeVector(X[t][k])[j]));
          y.push(Y[t][j]);
        }
      }
      const { weights } = ridgeStacking(rows, y, spec.ridge);
      const wMap: Record<Strategy, number> = Object.fromEntries(S.map((k,i)=>[k, weights[i] ?? 0]));
      method = { kind: "value", weights: wMap };
    } else if (spec.icWeight && (!baseCombine.method || baseCombine.method.kind === "ic")) {
      // Compute IC per strategy along the window
      const icSeries: Record<Strategy, Array<{ t: number; ic: number }>> = {};
      for (const t of tTrain) {
        if (!Y[t]) continue;
        for (const k of S) {
          const x = normalizeVector(X[t][k]);
          const ic = crossSectionalIC(x, Y[t], { method: spec.icWeight.method ?? "spearman" });
          (icSeries[k] ||= []).push({ t, ic });
        }
      }
      const wMap = icWeights(icSeries, spec.icWeight);
      method = { kind: "value", weights: wMap };
    }

    // Apply at time tApply
    const combined = combineOne(
      Object.fromEntries(S.map(k => [k, X[tApply][k]])),
      Y[tApply],
      { ...baseCombine, method }
    );
    out[tApply] = combined;
  }

  return { times: Object.keys(out).map(n=>Number(n)).sort((a,b)=>a-b), combined: out };
}

/* ============================== Turnover ============================== */

/** Turnover of ranking/weights between two cross-sectional vectors. */
export function turnover(prev: number[], next: number[], topK?: number): number {
  // compute rank sets
  const r1 = rank01(prev), r2 = rank01(next);
  const n = r1.length; if (n !== r2.length || n === 0) return NaN;
  const pick = (r: number[]) => {
    const pairs = r.map((v,i)=>({v,i})).sort((a,b)=>b.v-a.v);
    const k = topK ? Math.min(topK, n) : n;
    return new Set(pairs.slice(0, k).map(p=>p.i));
  };
  const A = pick(r1), B = pick(r2);
  let inter = 0;
  for (const i of A) if (B.has(i)) inter++;
  const k = topK ? Math.min(topK, n) : n;
  // turnover = 1 - overlap%
  return 1 - inter / k;
}

/* ============================== Example ============================== */
/*
const sA: Panel = [
  { t: "2025-10-01", s: "AAPL", v:  0.7 },
  { t: "2025-10-01", s: "MSFT", v: -0.2 },
  { t: "2025-10-02", s: "AAPL", v:  0.6 },
  { t: "2025-10-02", s: "MSFT", v:  0.1 },
];
const sB: Panel = [
  { t: "2025-10-01", s: "AAPL", v:  0.2 },
  { t: "2025-10-01", s: "MSFT", v:  0.4 },
  { t: "2025-10-02", s: "AAPL", v:  0.5 },
  { t: "2025-10-02", s: "MSFT", v: -0.3 },
];
const rets: Panel = [
  { t: "2025-10-01", s: "AAPL", v:  0.01 },
  { t: "2025-10-01", s: "MSFT", v: -0.005 },
  { t: "2025-10-02", s: "AAPL", v: -0.004 },
  { t: "2025-10-02", s: "MSFT", v:  0.007 },
];

const aligned = alignPanel({ A: sA, B: sB }, rets);
const t0 = aligned.times[0];
const combinedEq = combineOne(Object.fromEntries(aligned.S.map(k=>[k, aligned.X[t0][k]])), aligned.Y?.[t0], { method: { kind: "equal" }, norm: { method: "zscore", winsorPct: 0.02 } });
console.log("Equal:", combinedEq);

const combinedIC = combineOne(Object.fromEntries(aligned.S.map(k=>[k, aligned.X[t0][k]])), aligned.Y?.[t0], { method: { kind: "ic", ic: { method: "spearman" } } });

const rolling = combineRolling(aligned, rets, { lookback: 2, ridge: { lambda: 1e-2 }, step: 1 }, { norm: { method: "rank" }});
console.log("Rolling times:", rolling.times.length);
*/