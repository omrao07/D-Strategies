// ml/selection.ts
// Model selection utilities: CV splits, grid/random search, walk-forward validation,
// scoring (IC/Sharpe/MSE/MAE/Accuracy), early stopping, and compact reporting.
// No external deps; TS/ESM friendly.

export type Timestamp = number | string | Date;
export type Num = number;

export interface Sample {
  t: Timestamp;     // time (used for time-series split ordering)
  x: number[];      // features
  y: number;        // target
  w?: number;       // optional sample weight
}

export type Dataset = Sample[];

export type ScorerKind =
  | "ic_spearman"
  | "ic_pearson"
  | "sharpe"
  | "mse"
  | "mae"
  | "accuracy_sign";

export interface ScorerSpec {
  kind: ScorerKind;
  annualizeK?: number; // for sharpe: periods per year (e.g., 252)
}

export interface FitResult {
  /** model-specific state to reuse for predict */
  model: any;
  /** optional clean-up hook */
  dispose?: () => void;
}

export interface Estimator {
  /** Train a model on (X,y,weights) + params */
  fit(samples: Dataset, params: Record<string, any>): Promise<FitResult> | FitResult;
  /** Predict yhat for provided samples */
  predict(model: any, samples: Dataset): Promise<number[]> | number[];
  /** Optional: score directly (if provided, overrides generic scoring) */
  score?(
    model: any,
    train: Dataset,
    valid: Dataset,
    spec: ScorerSpec
  ): Promise<number> | number;
  /** Optional: free model resources */
  dispose?(fit: FitResult): void;
}

export interface Split {
  trainIdx: number[];
  validIdx: number[];
}

export interface CVPlan {
  name: string;            // "kfold-1/5", "wf-3/8", ...
  splits: Split[];
}

/* =============================== Utils =============================== */

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function toEpoch(t: Timestamp): number {
  if (typeof t === "number") return t;
  if (t instanceof Date) return t.getTime();
  const ms = new Date(t).getTime();
  if (!Number.isFinite(ms)) throw new Error(`Bad timestamp: ${t}`);
  return ms;
}

export function argsort<T>(xs: T[], key: (x: T) => number): number[] {
  return xs.map((v, i) => [i, key(v)] as const).sort((a, b) => a[1] - b[1]).map(p => p[0]);
}

export function mean(xs: number[]): number { return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : NaN; }
export function std(xs: number[]): number {
  const n = xs.length; if (n < 2) return 0;
  const m = mean(xs);
  let s = 0; for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (n - 1));
}

export function percentile(xs: number[], q: number): number {
  const s = xs.slice().sort((a,b)=>a-b);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos), rest = pos - base;
  return s[base + 1] !== undefined ? s[base] + rest * (s[base+1]-s[base]) : s[base];
}

function rank01(xs: number[]): number[] {
  const n = xs.length; if (!n) return [];
  const pairs = xs.map((v,i)=>({v,i})).sort((a,b)=>a.v-b.v);
  const out = new Array(n).fill(0);
  for (let r=0;r<n;r++) out[pairs[r].i] = n===1 ? 0.5 : r/(n-1);
  return out;
}

/* ============================== Scorers =============================== */

export function scoreIC(yhat: number[], y: number[], method: "spearman"|"pearson" = "spearman"): number {
  const a: number[] = [], b: number[] = [];
  for (let i=0;i<y.length;i++) if (isNum(yhat[i]) && isNum(y[i])) { a.push(yhat[i]); b.push(y[i]); }
  if (a.length < 3) return NaN;
  if (method === "pearson") {
    const n = a.length;
    const ma = mean(a), mb = mean(b);
    let nx=0, ny=0, c=0;
    for (let i=0;i<n;i++){ const da=a[i]-ma, db=b[i]-mb; nx+=da*da; ny+=db*db; c+=da*db; }
    return c / Math.sqrt((nx||1e-12)*(ny||1e-12));
  } else {
    const ra = rank01(a), rb = rank01(b);
    // Pearson on ranks
    const n = ra.length;
    const ma = mean(ra), mb = mean(rb);
    let nx=0, ny=0, c=0;
    for (let i=0;i<n;i++){ const da=ra[i]-ma, db=rb[i]-mb; nx+=da*da; ny+=db*db; c+=da*db; }
    return c / Math.sqrt((nx||1e-12)*(ny||1e-12));
  }
}

export function scoreSharpe(yhat: number[], y: number[], annualizeK = 252): number {
  // treat residual (yhat as signal weights * y as return) => realized "portfolio" = yhat * y
  const r = yhat.map((w,i)=> (isNum(w) && isNum(y[i])) ? w*y[i] : NaN).filter(isNum);
  if (!r.length) return NaN;
  const mu = mean(r), sd = std(r) || 1e-12;
  return Math.sqrt(Math.max(1, annualizeK)) * (mu / sd);
}

export function scoreMSE(yhat: number[], y: number[]): number {
  const n = Math.min(yhat.length, y.length);
  let s = 0, k = 0;
  for (let i=0;i<n;i++) if (isNum(yhat[i]) && isNum(y[i])) { const e=yhat[i]-y[i]; s+=e*e; k++; }
  return k ? s / k : NaN;
}

export function scoreMAE(yhat: number[], y: number[]): number {
  const n = Math.min(yhat.length, y.length);
  let s = 0, k = 0;
  for (let i=0;i<n;i++) if (isNum(yhat[i]) && isNum(y[i])) { s+=Math.abs(yhat[i]-y[i]); k++; }
  return k ? s / k : NaN;
}

export function scoreAccuracySign(yhat: number[], y: number[]): number {
  let ok=0, n=0;
  for (let i=0;i<y.length;i++){
    const a=yhat[i], b=y[i];
    if (!isNum(a) || !isNum(b)) continue;
    n++; if ((a>=0 && b>=0) || (a<0 && b<0)) ok++;
  }
  return n ? ok/n : NaN;
}

export function scoreBy(spec: ScorerSpec, yhat: number[], y: number[]): number {
  switch (spec.kind) {
    case "ic_spearman":  return scoreIC(yhat, y, "spearman");
    case "ic_pearson":   return scoreIC(yhat, y, "pearson");
    case "sharpe":       return scoreSharpe(yhat, y, spec.annualizeK ?? 252);
    case "mse":          return -scoreMSE(yhat, y); // higher is better
    case "mae":          return -scoreMAE(yhat, y);
    case "accuracy_sign":return scoreAccuracySign(yhat, y);
    default:             return NaN;
  }
}

/* ============================ CV Splitters ============================ */

export function kFoldPlan(n: number, k = 5, shuffle = true, seed = 42): CVPlan {
  const idx = Array.from({length:n}, (_,i)=>i);
  if (shuffle) knuthShuffle(idx, seed);
  const folds: number[][] = Array.from({length:k}, () => []);
  for (let i=0;i<n;i++) folds[i % k].push(idx[i]);
  const splits: Split[] = [];
  for (let i=0;i<k;i++){
    const validIdx = folds[i].slice();
    const trainIdx = ([] as number[]).concat(...folds.filter((_,j)=>j!==i));
    splits.push({ trainIdx, validIdx });
  }
  return { name: `kfold-${k}`, splits };
}

export function timeSeriesPlan(samples: Dataset, nFolds = 5, minTrain = 32): CVPlan {
  const sorted = samples.map((s,i)=>({i, t: toEpoch(s.t)})).sort((a,b)=>a.t-b.t);
  const n = sorted.length;
  const foldSize = Math.max(1, Math.floor((n - minTrain) / nFolds));
  const splits: Split[] = [];
  for (let f=0; f<nFolds; f++) {
    const end = minTrain + (f+1)*foldSize;
    const trainIdx = sorted.slice(0, Math.min(end - foldSize, n)).map(o=>o.i);
    const validIdx = sorted.slice(Math.min(end - foldSize, n), Math.min(end, n)).map(o=>o.i);
    if (trainIdx.length && validIdx.length) splits.push({ trainIdx, validIdx });
  }
  return { name: `wf-${splits.length}`, splits };
}

/* ========================== Search Routines =========================== */

export interface SearchSpace {
  [param: string]: any[]; // candidate values
}

export interface SearchOpts {
  plan: CVPlan;
  scorer: ScorerSpec;
  maximize?: boolean;       // default true
  earlyStopRounds?: number; // stop if no improvement over N candidate param sets
  reportTopN?: number;      // keep top-N in report
  randomPick?: number;      // if set, pick this many random combos from the grid
  seed?: number;
}

export interface CandidateReport {
  params: Record<string, any>;
  meanScore: number;
  stdevScore: number;
  foldScores: number[];
}

export interface SearchReport {
  best: CandidateReport | undefined;
  top: CandidateReport[];
  allTried: number;
  planName: string;
  scorer: ScorerSpec;
}

export async function gridSearch(
  est: Estimator,
  data: Dataset,
  space: SearchSpace,
  opt: SearchOpts
): Promise<SearchReport> {
  const combos = enumerateGrid(space);
  const picks = (opt.randomPick && opt.randomPick > 0)
    ? sampleCombos(combos, opt.randomPick, opt.seed ?? 1337)
    : combos;

  return runSearch(est, data, picks, opt);
}

export async function randomSearch(
  est: Estimator,
  data: Dataset,
  space: SearchSpace,
  nSamples: number,
  opt: Omit<SearchOpts, "randomPick">
): Promise<SearchReport> {
  const combos = enumerateGrid(space);
  const picks = sampleCombos(combos, Math.min(nSamples, combos.length), opt.seed ?? 1337);
  return runSearch(est, data, picks, { ...opt, randomPick: picks.length });
}

async function runSearch(
  est: Estimator,
  data: Dataset,
  candidates: Record<string, any>[],
  opt: SearchOpts
): Promise<SearchReport> {
  const maximize = opt.maximize !== false;
  const plan = opt.plan;
  const records: CandidateReport[] = [];
  let best: CandidateReport | undefined;
  let roundsSinceBest = 0;

  for (const params of candidates) {
    const foldScores: number[] = [];
    for (const split of plan.splits) {
      const train = split.trainIdx.map(i=>data[i]);
      const valid = split.validIdx.map(i=>data[i]);
      const fit = await est.fit(train, params);
      let score: number;
      if (est.score) {
        score = await est.score(fit.model, train, valid, opt.scorer);
      } else {
        const yhat = await est.predict(fit.model, valid);
        const y = valid.map(s=>s.y);
        score = scoreBy(opt.scorer, yhat, y);
      }
      if (est.dispose) est.dispose(fit);
      else if (fit.dispose) fit.dispose();
      foldScores.push(score);
    }
    const meanScore = mean(foldScores.filter(isNum));
    const stdevScore = std(foldScores.filter(isNum));
    const rec: CandidateReport = { params, meanScore, stdevScore, foldScores };
    records.push(rec);

    // track best
    if (!best || (maximize ? meanScore > best.meanScore : meanScore < best.meanScore)) {
      best = rec; roundsSinceBest = 0;
    } else {
      roundsSinceBest++;
      if (opt.earlyStopRounds && roundsSinceBest >= opt.earlyStopRounds) break;
    }
  }

  // order top
  const topN = opt.reportTopN ?? Math.min(10, records.length);
  const sorted = records.slice().sort((a,b) =>
    (maximize ? b.meanScore - a.meanScore : a.meanScore - b.meanScore)
  ).slice(0, topN);

  return { best, top: sorted, allTried: records.length, planName: plan.name, scorer: opt.scorer };
}

/* ============================ Walk-Forward ============================ */

export interface WFOpts {
  window: number;      // training size
  step?: number;       // step between validations
  scorer: ScorerSpec;
  maximize?: boolean;  // default true
}

export async function walkForward(
  est: Estimator,
  data: Dataset,
  params: Record<string, any>,
  opt: WFOpts
): Promise<{ meanScore: number; scores: Array<{ end: number; score: number }> }> {
  const sorted = data.map((s,i)=>({i, t: toEpoch(s.t)})).sort((a,b)=>a.t-b.t).map(o=>o.i);
  const step = opt.step ?? 1;
  const out: Array<{ end: number; score: number }> = [];
  for (let end = opt.window; end < sorted.length; end += step) {
    const trainIdx = sorted.slice(end - opt.window, end);
    const validIdx = [sorted[end]];
    const train = trainIdx.map(i=>data[i]);
    const valid = validIdx.map(i=>data[i]);
    const fit = await est.fit(train, params);
    const yhat = await est.predict(fit.model, valid);
    const y = valid.map(s=>s.y);
    const sc = scoreBy(opt.scorer, yhat, y);
    if (est.dispose) est.dispose(fit); else if (fit.dispose) fit.dispose();
    out.push({ end, score: sc });
  }
  return { meanScore: mean(out.map(x=>x.score).filter(isNum)), scores: out };
}

/* =============================== Helpers ============================== */

export function enumerateGrid(space: SearchSpace): Record<string, any>[] {
  const keys = Object.keys(space);
  if (!keys.length) return [{}];
  const results: Record<string, any>[] = [];
  function backtrack(i: number, acc: Record<string, any>) {
    if (i === keys.length) { results.push({ ...acc }); return; }
    const k = keys[i]; const vals = space[k] ?? [undefined];
    for (const v of vals) { acc[k] = v; backtrack(i+1, acc); }
  }
  backtrack(0, {});
  return results;
}

export function sampleCombos(
  combos: Record<string, any>[],
  n: number,
  seed = 1337
): Record<string, any>[] {
  const idx = Array.from({length: combos.length}, (_,i)=>i);
  knuthShuffle(idx, seed);
  return idx.slice(0, n).map(i => combos[i]);
}

/** Deterministic in-place shuffle (Knuth) with LCG RNG */
export function knuthShuffle<T>(arr: T[], seed = 1337): T[] {
  let s = seed >>> 0;
  const rand = () => {
    // LCG: x_{n+1} = (a x_n + c) mod 2^32
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ============================== Reporting ============================= */

export function formatReport(rep: SearchReport, digits = 4): string {
  const lines: string[] = [];
  lines.push(`plan: ${rep.planName}`);
  lines.push(`scorer: ${rep.scorer.kind}`);
  lines.push(`tried: ${rep.allTried}`);
  if (rep.best) {
    lines.push(`best.mean: ${rep.best.meanScore.toFixed(digits)} ± ${rep.best.stdevScore.toFixed(digits)}`);
    lines.push(`best.params: ${JSON.stringify(rep.best.params)}`);
  }
  lines.push(`top:`);
  rep.top.forEach((r, i) => {
    lines.push(`  ${i+1}. ${r.meanScore.toFixed(digits)} ± ${r.stdevScore.toFixed(digits)}  params=${JSON.stringify(r.params)}`);
  });
  return lines.join("\n");
}

/* ============================== Example =============================== */
/*
Example estimator (linear ridge with closed-form):

const ridgeEstimator: Estimator = {
  fit(samples, params) {
    const X = samples.map(s=>s.x);
    const y = samples.map(s=>s.y);
    const lambda = params.lambda ?? 1e-2;
    const withB = params.intercept !== false;
    const Xr = withB ? addIntercept(X) : X;
    const Xt = transpose(Xr);
    const XtX = matMul(Xt, Xr);
    for (let i=0;i<XtX.length;i++) XtX[i][i] += lambda;
    const beta = matVec(invert(XtX), matVec(Xt, y));
    return { model: { beta, withB } };
  },
  predict(model, samples) {
    const X = samples.map(s=>s.x);
    const Xr = model.withB ? addIntercept(X) : X;
    return matVec(Xr, model.beta);
  }
};

(async () => {
  const data: Dataset = Array.from({length:200}, (_,i)=>({
    t: i,
    x: [Math.sin(i/10), Math.cos(i/15)],
    y: Math.sin(i/10) + 0.1*Math.random()
  }));
  const plan = timeSeriesPlan(data, 5, 100);
  const space = { lambda: [1e-4, 1e-3, 1e-2, 1e-1], intercept: [true, false] };
  const rep = await gridSearch(ridgeEstimator, data, space, { plan, scorer: { kind: "mse" }, reportTopN: 3 });
  console.log(formatReport(rep));
})();
*/

/* ======== Minimal linear algebra helpers for the example estimator ======= */
export function addIntercept(X: number[][]): number[][] { return X.map(r => [1, ...r]); }
export function transpose(A: number[][]): number[][] {
  if (!A.length) return []; const m=A.length, n=A[0].length;
  const T = Array.from({length:n},()=>Array(m).fill(0));
  for (let i=0;i<m;i++) for (let j=0;j<n;j++) T[j][i]=A[i][j]; return T;
}
export function matMul(A: number[][], B: number[][]): number[][] {
  const m=A.length, n=A[0].length, p=B[0].length;
  const C = Array.from({length:m},()=>Array(p).fill(0));
  for (let i=0;i<m;i++) for (let k=0;k<n;k++){ const aik=A[i][k]; for (let j=0;j<p;j++) C[i][j]+=aik*B[k][j]; }
  return C;
}
export function matVec(A: number[][], v: number[]): number[] {
  const m=A.length, n=A[0].length; const out=new Array(m).fill(0);
  for (let i=0;i<m;i++){ let s=0; for (let j=0;j<n;j++) s+=A[i][j]*v[j]; out[i]=s; } return out;
}
export function invert(M: number[][]): number[][] {
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