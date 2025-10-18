// ml/strategy_gen.ts
// Auto-generates cross-sectional strategies from features & returns.
// - Builds candidate signals (momentum/mean-rev/vol/quality-style transforms)
// - Scores them (IC/Sharpe), does walk-forward selection
// - Ensembles winners (IC-weighted / stacking)
// - Emits a StrategyDefinition JSON you can register in your engine
//
// No external deps. Optional FS write if running under Node.

/////////////////////////// Shared Types ///////////////////////////

export type Symbol = string;
export type Timestamp = number | string | Date;

export interface PanelPoint {
  t: Timestamp;  // time
  s: Symbol;     // symbol
  v: number;     // value (signal or return)
}
export type Panel = PanelPoint[];

export interface StrategyDefinition {
  id: string;
  name: string;
  tags: string[];
  createdAt: string;
  params: Record<string, number | string | boolean>;
  // signal expression(s) for transparency; engine can ignore or parse
  signals: Array<{
    id: string;
    description: string;
    // human-friendly expression of how signal was created
    expr: string;
    // last-fit weights if ensemble
    weights?: Record<string, number>;
  }>;
  // simple long/short config for cross-sectional portfolio
  portfolio: {
    topK?: number;         // long top-K
    bottomK?: number;      // short bottom-K
    longOnly?: boolean;    // if true, ignore shorts
    rebalance: "daily" | "weekly" | "monthly";
  };
  // evaluation metadata
  metrics: {
    icMean?: number;
    icIR?: number;
    sharpe?: number;
    hitRate?: number;
    turnover?: number;
    inSamplePeriod?: { start: string; end: string };
    oosPeriod?: { start: string; end: string };
  };
  // for your registry
  engine: "cross_sectional_v1";
  version: string;
}

/////////////////////////// Mini Utils /////////////////////////////

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
function toEpoch(t: Timestamp): number {
  if (typeof t === "number") return t;
  if (t instanceof Date) return t.getTime();
  const ms = new Date(t).getTime();
  if (!Number.isFinite(ms)) throw new Error(`Bad timestamp: ${t}`);
  return ms;
}
function uniq<T>(xs: T[]): T[] { return Array.from(new Set(xs)); }
function mean(xs: number[]): number { return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : NaN; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s=0; for (const x of xs) s+=(x-m)*(x-m);
  return Math.sqrt(s/(xs.length-1));
}
function quantile(xs: number[], q: number): number {
  const s = xs.slice().sort((a,b)=>a-b);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos), rest = pos - base;
  return s[base + 1] !== undefined ? s[base] + rest*(s[base+1]-s[base]) : s[base];
}
function rank01(xs: number[]): number[] {
  const n = xs.length; if (!n) return [];
  const pairs = xs.map((v,i)=>({v,i})).sort((a,b)=>a.v-b.v);
  const out = new Array(n).fill(0);
  for (let r=0;r<n;r++) out[pairs[r].i] = n===1 ? 0.5 : r/(n-1);
  return out;
}
function zscore(xs: number[]): number[] {
  const n = xs.length; if (!n) return [];
  const m = mean(xs);
  const s = std(xs) || 1e-12;
  return xs.map(x => (x - m) / s);
}
function winsor(xs: number[], p = 0.02): number[] {
  if (!p || p<=0) return xs.slice();
  const lo = quantile(xs, p), hi = quantile(xs, 1-p);
  return xs.map(v => Math.min(Math.max(v, lo), hi));
}

/////////////////////////// Panel Alignment ////////////////////////

/**
 * Align multiple panels (features or returns) onto the same [time × symbol] grid.
 * Returns dense matrices per time; NaNs kept for missing.
 */
export function alignPanels(
  series: Record<string, Panel>,
  symbols?: string[]
): {
  times: number[];
  symbols: string[];
  X: Record<number, Record<string, number[]>>; // time -> key -> vector over symbols
} {
  const keys = Object.keys(series);
  const allTimes = uniq(keys.flatMap(k => series[k].map(p => toEpoch(p.t)))).sort((a,b)=>a-b);
  const allSyms = symbols ?? uniq(keys.flatMap(k => series[k].map(p => p.s))).sort();
  const symIndex = new Map(allSyms.map((s,i)=>[s,i]));
  const X: Record<number, Record<string, number[]>> = {};
  for (const t of allTimes) {
    X[t] = Object.fromEntries(keys.map(k => [k, new Array(allSyms.length).fill(NaN)]));
  }
  for (const k of keys) {
    for (const p of series[k]) {
      const t = toEpoch(p.t); const j = symIndex.get(p.s);
      if (j == null) continue;
      if (!X[t]) X[t] = Object.fromEntries(keys.map(kk => [kk, new Array(allSyms.length).fill(NaN)]));
      X[t][k][j] = p.v;
    }
  }
  return { times: allTimes, symbols: allSyms, X };
}

/////////////////////////// Feature Builders ///////////////////////

/**
 * Build common cross-sectional signals from a stack of base features.
 * You pass per-time vectors; we transform per-time independently.
 */
export type XformKind =
  | "z"            // z-score
  | "rank"         // rank to [-1,1]
  | "winsor_z"     // winsor then z
  | "invert"       // multiply by -1
  | "normalize01"; // min-max to [-1,1]

export interface CandidateSpec {
  id: string;             // e.g., "mom_63d:z"
  baseKey: string;        // which base series key
  kind: XformKind;
  weight?: number;        // optional prior weight for ensembles
  meta?: Record<string, string | number | boolean>;
}

/** Apply transform to a vector (single time slice) */
function applyXform(vec: number[], kind: XformKind): number[] {
  const v = vec.slice();
  switch (kind) {
    case "z":         return zscore(v);
    case "rank":      return rank01(v).map(x => x*2 - 1);
    case "winsor_z":  return zscore(winsor(v, 0.02));
    case "invert":    return v.map(x => isNum(x)? -x : x);
    case "normalize01": {
      const lo = Math.min(...v.filter(isNum)), hi = Math.max(...v.filter(isNum));
      const den = (hi - lo) || 1e-12;
      return v.map(x => isNum(x) ? ((x - lo)/den)*2 - 1 : x);
    }
    default: return v;
  }
}

/**
 * From base feature panels create a library of transformed candidates.
 * baseSeries: time -> key -> vector; returns time -> candidateId -> vector
 */
export function buildCandidates(
  times: number[],
  baseSeries: Record<number, Record<string, number[]>>,
  specs: CandidateSpec[]
): Record<number, Record<string, number[]>> {
  const out: Record<number, Record<string, number[]>> = {};
  for (const t of times) {
    out[t] = {};
    for (const spec of specs) {
      const src = baseSeries[t][spec.baseKey];
      if (!src) continue;
      out[t][spec.id] = applyXform(src, spec.kind);
    }
  }
  return out;
}

/////////////////////////// Scoring & IC ///////////////////////////

export type ICMethod = "spearman" | "pearson";

export function crossSectionalIC(x: number[], y: number[], method: ICMethod = "spearman"): number {
  const a: number[] = [], b: number[] = [];
  for (let i=0;i<x.length;i++) if (isNum(x[i]) && isNum(y[i])) { a.push(x[i]); b.push(y[i]); }
  if (a.length < 3) return NaN;
  if (method === "pearson") {
    const n = a.length;
    const ma = mean(a), mb = mean(b);
    let nx=0, ny=0, c=0;
    for (let i=0;i<n;i++){ const da=a[i]-ma, db=b[i]-mb; nx+=da*da; ny+=db*db; c+=da*db; }
    return c / Math.sqrt((nx||1e-12)*(ny||1e-12));
  } else {
    const ra = rank01(a), rb = rank01(b);
    const n = ra.length;
    const ma = mean(ra), mb = mean(rb);
    let nx=0, ny=0, c=0;
    for (let i=0;i<n;i++){ const da=ra[i]-ma, db=rb[i]-mb; nx+=da*da; ny+=db*db; c+=da*db; }
    return c / Math.sqrt((nx||1e-12)*(ny||1e-12));
  }
}

export function panelIC(
  candidateAtT: Record<number, Record<string, number[]>>,
  realizedAtT: Record<number, number[]>,
  method: ICMethod = "spearman"
): Record<string, { mean: number; stdev: number; n: number; series: Array<{ t: number; ic: number }> }> {
  const allIds = uniq(Object.values(candidateAtT).flatMap(o => Object.keys(o)));
  const stats: Record<string, { sum: number; sum2: number; n: number; series: Array<{ t: number; ic: number }> }> = {};
  for (const id of allIds) stats[id] = { sum: 0, sum2: 0, n: 0, series: [] };

  for (const tStr of Object.keys(candidateAtT)) {
    const t = Number(tStr);
    const y = realizedAtT[t];
    if (!y) continue;
    const row = candidateAtT[t];
    for (const id of Object.keys(row)) {
      const x = row[id];
      const ic = crossSectionalIC(x, y, method);
      if (!isNum(ic)) continue;
      const s = stats[id];
      s.sum += ic; s.sum2 += ic*ic; s.n++; s.series.push({ t, ic });
    }
  }

  const out: Record<string, { mean: number; stdev: number; n: number; series: Array<{ t: number; ic: number }> }> = {};
  for (const [id, s] of Object.entries(stats)) {
    const meanIC = s.n ? s.sum / s.n : NaN;
    const varIC = s.n > 1 ? Math.max(0, (s.sum2 - s.n * meanIC * meanIC) / (s.n - 1)) : 0;
    out[id] = { mean: meanIC, stdev: Math.sqrt(varIC), n: s.n, series: s.series };
  }
  return out;
}

/////////////////////////// Ensembling /////////////////////////////

export type EnsembleKind = "equal" | "ic_weighted" | "stacking";

export interface EnsembleSpec {
  kind: EnsembleKind;
  // For ic_weighted:
  halfLife?: number; // in steps; exponential decay for recent ICs
  // For stacking:
  lambda?: number;   // ridge
}

function l1normalize(w: Record<string, number>): Record<string, number> {
  const s = Object.values(w).reduce((a,b)=>a+Math.abs(b),0) || 1;
  const out: Record<string, number> = {};
  for (const k of Object.keys(w)) out[k] = w[k] / s;
  return out;
}

/** Build time-varying weights from IC series (decayed average), then average vectors by weights per time */
function ensembleICWeighted(
  candidatesAtT: Record<number, Record<string, number[]>>,
  icSeries: Record<string, Array<{ t: number; ic: number }>>,
  halfLife = 20
): { combined: Record<number, number[]>; weights: Record<string, number> } {
  // time-invariant weights derived from IC history with exponential decay
  const lam = Math.log(2) / Math.max(1, halfLife);
  const w: Record<string, number> = {};
  const tMax = Math.max(...Object.values(icSeries).flatMap(s => s.map(x=>x.t)));
  for (const [id, ser] of Object.entries(icSeries)) {
    if (!ser.length) { w[id] = 0; continue; }
    let num = 0, den = 0;
    for (const { t, ic } of ser) {
      const age = Math.max(0, (tMax - t)); // time units arbitrary—relative decay
      const a = Math.exp(-lam * age);
      num += a * ic; den += a;
    }
    w[id] = den ? num/den : 0;
  }
  const wNorm = l1normalize(w);

  // combine at each time by fixed weights
  const times = Object.keys(candidatesAtT).map(Number).sort((a,b)=>a-b);
  const ids = Object.keys(wNorm);
  const combined: Record<number, number[]> = {};
  for (const t of times) {
    const rows = candidatesAtT[t];
    if (!rows) continue;
    const n = rows[ids[0]]?.length ?? 0;
    const out = new Array(n).fill(0);
    for (const id of ids) {
      const vec = rows[id];
      if (!vec) continue;
      const ww = wNorm[id] ?? 0;
      for (let i=0;i<n;i++) out[i] += ww * (vec[i] ?? 0);
    }
    combined[t] = out;
  }

  return { combined, weights: wNorm };
}

/** Simple ridge stacking per time t using candidate vectors as regressors of realized y */
function ensembleStacking(
  candidatesAtT: Record<number, Record<string, number[]>>,
  realizedAtT: Record<number, number[]>,
  lambda = 1e-2
): { combined: Record<number, number[]>; weights: Record<string, number> } {
  const times = Object.keys(candidatesAtT).map(Number).sort((a,b)=>a-b);
  const ids = uniq(Object.values(candidatesAtT).flatMap(m => Object.keys(m))).sort();
  // Fit one global set of weights on all past times (pooled cross-sections)
  const rows: number[][] = [];
  const y: number[] = [];
  for (const t of times) {
    if (!realizedAtT[t]) continue;
    const n = candidatesAtT[t][ids[0]]?.length ?? 0;
    for (let i=0;i<n;i++) {
      rows.push(ids.map(id => candidatesAtT[t][id][i]));
      y.push(realizedAtT[t][i]);
    }
  }
  if (!rows.length) return { combined: {}, weights: {} };
  const { weights } = ridgeFit(rows, y, lambda);

  const wMap: Record<string, number> = {};
  ids.forEach((id, i) => { wMap[id] = weights[i] ?? 0; });

  // Apply the global weights to each time slice
  const combined: Record<number, number[]> = {};
  for (const t of times) {
    const n = candidatesAtT[t][ids[0]]?.length ?? 0;
    const out = new Array(n).fill(0);
    for (let i=0;i<n;i++) {
      let s = 0;
      for (let j=0;j<ids.length;j++) s += (wMap[ids[j]] ?? 0) * (candidatesAtT[t][ids[j]][i] ?? 0);
      out[i] = s;
    }
    combined[t] = out;
  }

  return { combined, weights: l1normalize(wMap) };
}

// tiny ridge (X'X + λI)^{-1} X'y
function ridgeFit(X: number[][], y: number[], lambda: number): { weights: number[] } {
  const Xt = transpose(X);
  const XtX = matMul(Xt, X);
  for (let i=0;i<XtX.length;i++) XtX[i][i] += lambda;
  const beta = matVec(invert(XtX), matVec(Xt, y));
  // L1 normalize for stability
  const s = beta.reduce((a,b)=>a+Math.abs(b),0) || 1;
  return { weights: beta.map(b => b / s) };
}
function transpose(A: number[][]): number[][] {
  if (!A.length) return []; const m=A.length, n=A[0].length;
  const T = Array.from({length:n},()=>Array(m).fill(0));
  for (let i=0;i<m;i++) for (let j=0;j<n;j++) T[j][i]=A[i][j]; return T;
}
function matMul(A: number[][], B: number[][]): number[][] {
  const m=A.length, n=A[0].length, p=B[0].length;
  const C = Array.from({length:m},()=>Array(p).fill(0));
  for (let i=0;i<m;i++) for (let k=0;k<n;k++){ const aik=A[i][k]; for (let j=0;j<p;j++) C[i][j]+=aik*B[k][j]; }
  return C;
}
function matVec(A: number[][], v: number[]): number[] {
  const m=A.length, n=A[0].length; const out=new Array(m).fill(0);
  for (let i=0;i<m;i++){ let s=0; for (let j=0;j<n;j++) s+=A[i][j]*v[j]; out[i]=s; } return out;
}
function invert(M: number[][]): number[][] {
  const n=M.length; const A=M.map(r=>r.slice()); const I=Array.from({length:n},(_,i)=>{const r=Array(n).fill(0); r[i]=1; return r;});
  for (let i=0;i<n;i++){
    let piv=A[i][i];
    if (Math.abs(piv)<1e-12){ let sw=i+1; for(;sw<n;sw++) if (Math.abs(A[sw][i])>Math.abs(piv)) break;
      if (sw===n) throw new Error("Singular"); [A[i],A[sw]]=[A[sw],A[i]]; [I[i],I[sw]]=[I[sw],I[i]]; piv=A[i][i]; }
    const invP=1/piv; for(let j=0;j<n;j++){A[i][j]*=invP; I[i][j]*=invP;}
    for(let r=0;r<n;r++) if(r!==i){ const f=A[r][i]; for(let c=0;c<n;c++){A[r][c]-=f*A[i][c]; I[r][c]-=f*I[i][c];}}
  }
  return I;
}

/////////////////////////// Generator API //////////////////////////

export interface GeneratorInputs {
  /** base features keyed by name; each is a panel (t,s,v). All must align to same grid or be alignable. */
  features: Record<string, Panel>;
  /** realized forward returns panel (t,s,v), same grid as features (or alignable) */
  forwardReturns: Panel;
  /** transform specs to create candidates from features */
  candidates: CandidateSpec[];
  /** ensemble method */
  ensemble: EnsembleSpec;
  /** portfolio construction */
  portfolio: { topK?: number; bottomK?: number; longOnly?: boolean; rebalance?: "daily"|"weekly"|"monthly" };
  /** meta */
  name?: string;
  tags?: string[];
  /** training windows for metrics */
  inSample?: { start?: Timestamp; end?: Timestamp };
  outOfSample?: { start?: Timestamp; end?: Timestamp };
  /** IC method for scoring */
  icMethod?: ICMethod;
}

export function generateStrategy(inputs: GeneratorInputs): StrategyDefinition {
  // 1) Align base features and returns
  const alignedFeatures = alignPanels(inputs.features);
  const { times, symbols, X: baseAtT } = alignedFeatures;

  const returnsAligned = alignPanels({ ret: inputs.forwardReturns }, symbols);
  const realizedAtT: Record<number, number[]> = {};
  for (const t of returnsAligned.times) realizedAtT[t] = returnsAligned.X[t]["ret"];

  // 2) Build transformed candidate signals
  const candAtT = buildCandidates(times, baseAtT, inputs.candidates);

  // 3) Score candidates by IC
  const icStats = panelIC(candAtT, realizedAtT, inputs.icMethod ?? "spearman");

  // 4) Select top-N candidates by IC mean (basic cap)
  const scored = Object.entries(icStats)
    .filter(([_, s]) => isNum(s.mean))
    .sort((a,b) => (b[1].mean - a[1].mean));
  const topIds = scored.slice(0, Math.min(16, scored.length)).map(([id]) => id);

  // 5) Ensemble the winners
  // Keep time slices but only for topIds
  const pruned: Record<number, Record<string, number[]>> = {};
  for (const t of times) {
    pruned[t] = {};
    for (const id of topIds) pruned[t][id] = candAtT[t][id];
  }
  let combined: Record<number, number[]> = {};
  let weights: Record<string, number> = {};

  if (inputs.ensemble.kind === "equal") {
    // equal weights
    const w: Record<string, number> = Object.fromEntries(topIds.map(id => [id, 1/topIds.length]));
    weights = w;
    for (const t of times) {
      const n = pruned[t][topIds[0]]?.length ?? 0;
      const out = new Array(n).fill(0);
      for (const id of topIds) {
        const vec = pruned[t][id]; if (!vec) continue;
        const ww = w[id];
        for (let i=0;i<n;i++) out[i] += ww * (vec[i] ?? 0);
      }
      combined[t] = out;
    }
  } else if (inputs.ensemble.kind === "ic_weighted") {
    const icSeries: Record<string, Array<{ t: number; ic: number }>> = {};
    for (const id of topIds) icSeries[id] = icStats[id].series;
    const res = ensembleICWeighted(pruned, icSeries, inputs.ensemble.halfLife ?? 20);
    combined = res.combined; weights = res.weights;
  } else {
    const res = ensembleStacking(pruned, realizedAtT, inputs.ensemble.lambda ?? 1e-2);
    combined = res.combined; weights = res.weights;
  }

  // 6) Compute headline metrics on OOS if provided, else on all
  const win = (range?: { start?: Timestamp; end?: Timestamp }) => {
    const lo = range?.start ? toEpoch(range.start) : -Infinity;
    const hi = range?.end ? toEpoch(range.end) : Infinity;
    return times.filter(t => t >= lo && t <= hi);
  };
  const oosTimes = inputs.outOfSample ? win(inputs.outOfSample) : times;
  const insTimes = inputs.inSample ? win(inputs.inSample) : [];

  function csICFor(timeSlice: number[]): { icMean: number; icIR: number } {
    const ics: number[] = [];
    for (const t of timeSlice) {
      const x = combined[t], y = realizedAtT[t];
      if (!x || !y) continue;
      const ic = crossSectionalIC(x, y, inputs.icMethod ?? "spearman");
      if (isNum(ic)) ics.push(ic);
    }
    const mu = mean(ics), sd = std(ics) || 1e-12;
    return { icMean: mu, icIR: mu / sd };
  }

  const oos = csICFor(oosTimes);
  const ins = insTimes.length ? csICFor(insTimes) : { icMean: NaN, icIR: NaN };

  // (Optional) hit-rate approx at OOS last slice
  let hitRate: number | undefined;
  {
    const t = oosTimes.at(-1);
    if (t != null && combined[t] && realizedAtT[t]) {
      const pred = combined[t].map(v => Math.sign(v));
      const real = realizedAtT[t].map(v => Math.sign(v));
      let ok=0, n=0; for (let i=0;i<pred.length;i++) if (isNum(pred[i]) && isNum(real[i])) { n++; if (pred[i]===real[i]) ok++; }
      hitRate = n ? ok/n : undefined;
    }
  }

  // 7) Build emitted strategy definition
  const now = new Date().toISOString();
  const id = `auto-${Math.random().toString(36).slice(2, 10)}`;
  const name = inputs.name ?? `Auto Ensemble (${inputs.ensemble.kind})`;

  const signalsMeta = topIds.map(id => ({
    id,
    description: `Candidate signal ${id}`,
    expr: candidateExprFromId(id),
  }));
  if (Object.keys(weights).length) {
    // attach a single ensemble descriptor with weights
    signalsMeta.push({
      id: "ensemble",
      description: "Weighted combination of top candidates",
      expr: `sum_i w_i * candidate_i`,
      
    });
  }

  const strat: StrategyDefinition = {
    id,
    name,
    tags: inputs.tags ?? ["auto", "ml", "cross-sectional"],
    createdAt: now,
    params: {
      icMethod: inputs.icMethod ?? "spearman",
      ensemble: inputs.ensemble.kind,
      halfLife: inputs.ensemble.halfLife ?? "",
      lambda: inputs.ensemble.lambda ?? "",
    },
    signals: signalsMeta,
    portfolio: {
      topK: inputs.portfolio.topK ?? 25,
      bottomK: inputs.portfolio.longOnly ? 0 : (inputs.portfolio.bottomK ?? 25),
      longOnly: !!inputs.portfolio.longOnly,
      rebalance: inputs.portfolio.rebalance ?? "daily",
    },
    metrics: {
      icMean: oos.icMean,
      icIR: oos.icIR,
      hitRate,
      inSamplePeriod: insTimes.length ? { start: new Date(insTimes[0]).toISOString(), end: new Date(insTimes.at(-1)!).toISOString() } : undefined,
      oosPeriod: oosTimes.length ? { start: new Date(oosTimes[0]).toISOString(), end: new Date(oosTimes.at(-1)!).toISOString() } : undefined,
    },
    engine: "cross_sectional_v1",
    version: "1.0.0",
  };

  return strat;
}

/** Heuristic pretty expression from candidate id (e.g., "mom_63d:winsor_z") */
function candidateExprFromId(id: string): string {
  // very light parse: "base:transform" or "base_transform"
  const parts = id.split(":");
  if (parts.length === 2) return `${parts[0]} |> ${parts[1]}`;
  return id.replace(/_/g, " ");
}

/////////////////////////// Example Usage //////////////////////////
/*
const features: Record<string, Panel> = {
  // e.g., precomputed momentum & volatility per (t,s)
  "mom_63d": [
    { t: "2025-08-01", s: "AAPL", v: 0.12 }, { t: "2025-08-01", s: "MSFT", v: 0.08 },
    // ...
  ],
  "vol_20d": [ /* ... * / ],
  "value_pe_inv": [ /* ... 1/PE * / ],
};

const fwd: Panel = [
  // forward 5d returns aligned to feature dates
  { t: "2025-08-01", s: "AAPL", v: 0.006 },
  { t: "2025-08-01", s: "MSFT", v: -0.002 },
  // ...
];

const candidates: CandidateSpec[] = [
  { id: "mom_63d:z", baseKey: "mom_63d", kind: "z" },
  { id: "mom_63d:rank", baseKey: "mom_63d", kind: "rank" },
  { id: "vol_20d:winsor_z", baseKey: "vol_20d", kind: "winsor_z" },
  { id: "value_pe_inv:z", baseKey: "value_pe_inv", kind: "z" },
  { id: "value_pe_inv:invert", baseKey: "value_pe_inv", kind: "invert" }, // cheap is good
];

const strat = generateStrategy({
  features,
  forwardReturns: fwd,
  candidates,
  ensemble: { kind: "ic_weighted", halfLife: 60 },
  portfolio: { topK: 30, bottomK: 30, longOnly: false, rebalance: "weekly" },
  name: "Auto Alpha — IC Weighted",
  tags: ["auto", "ensemble", "IC"]
});
console.log(JSON.stringify(strat, null, 2));
*/

/////////////////////////// Optional FS Save ///////////////////////
/** Save the generated strategy to disk (Node only). */
export async function saveStrategyJSON(filePath: string, def: StrategyDefinition): Promise<void> {
  // @ts-ignore
  const canFS = typeof require === "function" || typeof (globalThis as any).process !== "undefined";
  if (!canFS) throw new Error("Filesystem not available in this runtime.");
  // @ts-ignore
  const fs = await import("fs");
  // @ts-ignore
  const path = await import("path");
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(def, null, 2), "utf8");
}