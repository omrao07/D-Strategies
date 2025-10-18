// tests/selection.unit.test.ts
// Self-contained: implements selection utilities + unit tests (no imports)

import assert from "assert";

/* ===================== Types ===================== */

export type Sample = { t: number; x: number[]; y: number };
export type Dataset = Sample[];

export interface Estimator {
  fit(samples: Dataset, params: Record<string, any>): { model: any };
  predict(model: any, samples: Dataset): number[];
}

export type ScorerSpec =
  | { kind: "ic"; method?: "spearman" | "pearson" }
  | { kind: "sharpe"; daysPerYear?: number }
  | { kind: "mse" }
  | { kind: "mae" }
  | { kind: "sign" };

/* ===================== Helpers ===================== */

function rng(seed = 1234) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function std(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let v = 0;
  for (const x of xs) v += (x - m) * (x - m);
  return Math.sqrt(v / (xs.length - 1));
}
function rank01(xs: number[]) {
  const n = xs.length;
  if (!n) return [];
  const pairs = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array(n).fill(0);
  for (let r = 0; r < n; r++) out[pairs[r].i] = n === 1 ? 0.5 : r / (n - 1);
  return out;
}

/* ===================== Splitters ===================== */

export function kFoldPlan(n: number, k: number, shuffle = false, seed = 0) {
  const idx = Array.from({ length: n }, (_, i) => i);
  if (shuffle) {
    const r = rng(seed);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
  }
  const folds: number[][] = Array.from({ length: k }, () => []);
  idx.forEach((v, i) => folds[i % k].push(v));
  const splits = folds.map((valid) => {
    const vset = new Set(valid);
    const train = idx.filter((i) => !vset.has(i));
    return { trainIdx: train, validIdx: valid };
  });
  return { splits };
}

export function timeSeriesPlan(ds: Dataset, trainWindow: number, validWindow: number, step = validWindow) {
  const n = ds.length;
  const splits: Array<{ trainIdx: number[]; validIdx: number[] }> = [];
  for (let start = 0; start + trainWindow + validWindow <= n; start += step) {
    const trainIdx = Array.from({ length: trainWindow }, (_, i) => start + i);
    const validIdx = Array.from({ length: validWindow }, (_, i) => start + trainWindow + i);
    if (trainIdx.length && validIdx.length) splits.push({ trainIdx, validIdx });
  }
  return { splits };
}

/* ===================== Scorers ===================== */

export function scoreIC(yhat: number[], y: number[], method: "spearman" | "pearson" = "spearman") {
  const a: number[] = [], b: number[] = [];
  for (let i = 0; i < y.length && i < yhat.length; i++) {
    if (Number.isFinite(y[i]) && Number.isFinite(yhat[i])) { a.push(yhat[i]); b.push(y[i]); }
  }
  if (a.length < 3) return NaN;
  if (method === "spearman") {
    const ra = rank01(a), rb = rank01(b);
    const ma = mean(ra), mb = mean(rb);
    let c = 0, va = 0, vb = 0;
    for (let i = 0; i < ra.length; i++) {
      const da = ra[i] - ma, db = rb[i] - mb;
      c += da * db; va += da * da; vb += db * db;
    }
    return c / Math.sqrt((va || 1e-12) * (vb || 1e-12));
  } else {
    const ma = mean(a), mb = mean(b);
    let c = 0, va = 0, vb = 0;
    for (let i = 0; i < a.length; i++) {
      const da = a[i] - ma, db = b[i] - mb;
      c += da * db; va += da * da; vb += db * db;
    }
    return c / Math.sqrt((va || 1e-12) * (vb || 1e-12));
  }
}

export function scoreSharpe(yhat: number[], y: number[], daysPerYear = 252) {
  const r = y.map((v, i) => (Number.isFinite(v) && Number.isFinite(yhat[i]) ? (yhat[i] * v) : 0));
  const mu = mean(r), sd = std(r) || 1e-12;
  const daily = mu / sd;
  return daily * Math.sqrt(daysPerYear);
}
export const scoreMSE = (yhat: number[], y: number[]) => {
  let s = 0, n = 0;
  for (let i = 0; i < y.length && i < yhat.length; i++) {
    const e = (yhat[i] ?? 0) - (y[i] ?? 0);
    s += e * e; n++;
  }
  return n ? s / n : NaN;
};
export const scoreMAE = (yhat: number[], y: number[]) => {
  let s = 0, n = 0;
  for (let i = 0; i < y.length && i < yhat.length; i++) {
    const e = Math.abs((yhat[i] ?? 0) - (y[i] ?? 0));
    s += e; n++;
  }
  return n ? s / n : NaN;
};
export const scoreAccuracySign = (yhat: number[], y: number[]) => {
  let ok = 0, n = 0;
  for (let i = 0; i < y.length && i < yhat.length; i++) {
    const a = Math.sign(yhat[i] ?? 0), b = Math.sign(y[i] ?? 0);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (a === b) ok++;
    n++;
  }
  return n ? ok / n : NaN;
};

export function applyScorer(spec: ScorerSpec, yhat: number[], y: number[]): number {
  switch (spec.kind) {
    case "ic":      return scoreIC(yhat, y, spec.method ?? "spearman");
    case "sharpe":  return scoreSharpe(yhat, y, spec.daysPerYear ?? 252);
    case "mse":     return -scoreMSE(yhat, y); // negative for maximization
    case "mae":     return -scoreMAE(yhat, y);
    case "sign":    return scoreAccuracySign(yhat, y);
  }
}

/* ===================== Grid & Random Search ===================== */

type Plan = { splits: Array<{ trainIdx: number[]; validIdx: number[] }> };

function cartesian(space: Record<string, any[]>): Record<string, any>[] {
  const keys = Object.keys(space);
  const out: Record<string, any>[] = [];
  const rec = (i: number, cur: Record<string, any>) => {
    if (i === keys.length) { out.push({ ...cur }); return; }
    const k = keys[i];
    for (const v of space[k]) { cur[k] = v; rec(i + 1, cur); }
  };
  rec(0, {});
  return out;
}

export async function gridSearch(
  est: Estimator,
  ds: Dataset,
  space: Record<string, any[]>,
  opts: { plan: Plan; scorer: ScorerSpec; reportTopN?: number }
) {
  const combos = cartesian(space);
  const results: Array<{ params: any; meanScore: number }> = [];
  for (const params of combos) {
    const scores: number[] = [];
    for (const sp of opts.plan.splits) {
      const train = sp.trainIdx.map(i => ds[i]);
      const valid = sp.validIdx.map(i => ds[i]);
      const { model } = est.fit(train, params);
      const pred = est.predict(model, valid);
      const y = valid.map(s => s.y);
      scores.push(applyScorer(opts.scorer, pred, y));
    }
    results.push({ params, meanScore: mean(scores) });
  }
  results.sort((a, b) => b.meanScore - a.meanScore);
  return { best: results[0], top: results.slice(0, opts.reportTopN ?? 5) };
}

export async function randomSearch(
  est: Estimator,
  ds: Dataset,
  space: Record<string, any[]>,
  trials: number,
  opts: { plan: Plan; scorer: ScorerSpec; reportTopN?: number; seed?: number }
) {
  const r = rng(opts.seed ?? 0);
  const keys = Object.keys(space);
  const pick = () => {
    const params: Record<string, any> = {};
    for (const k of keys) {
      const arr = space[k]; params[k] = arr[Math.floor(r() * arr.length)];
    }
    return params;
  };
  const results: Array<{ params: any; meanScore: number }> = [];
  for (let t = 0; t < trials; t++) {
    const params = pick();
    const scores: number[] = [];
    for (const sp of opts.plan.splits) {
      const train = sp.trainIdx.map(i => ds[i]);
      const valid = sp.validIdx.map(i => ds[i]);
      const { model } = est.fit(train, params);
      const pred = est.predict(model, valid);
      scores.push(applyScorer(opts.scorer, pred, valid.map(s => s.y)));
    }
    results.push({ params, meanScore: mean(scores) });
  }
  results.sort((a, b) => b.meanScore - a.meanScore);
  return { best: results[0], top: results.slice(0, opts.reportTopN ?? 5) };
}

/* ===================== Walk-Forward ===================== */

export async function walkForward(
  est: Estimator,
  ds: Dataset,
  params: Record<string, any>,
  opts: { window: number; step?: number; scorer: ScorerSpec }
) {
  const step = opts.step ?? 1;
  const scores: number[] = [];
  for (let end = opts.window; end + 1 < ds.length; end += step) {
    const train = ds.slice(end - opts.window, end);
    const valid = ds.slice(end, end + step);
    if (!train.length || !valid.length) continue;
    const { model } = est.fit(train, params);
    const pred = est.predict(model, valid);
    scores.push(applyScorer(opts.scorer, pred, valid.map(s => s.y)));
  }
  return { scores, meanScore: mean(scores) };
}

/* ===================== Tiny Linear Estimator ===================== */

const tinyLinear: Estimator = {
  fit(samples, params) {
    const lam = params.lambda ?? 1e-3;
    const withB = params.intercept !== false;
    const X = samples.map(s => (withB ? [1, ...s.x] : s.x));
    const y = samples.map(s => s.y);
    const Xt = transpose(X);
    const XtX = matMul(Xt, X);
    for (let i = 0; i < XtX.length; i++) XtX[i][i] += lam;
    const beta = matVec(invert(XtX), matVec(Xt, y));
    return { model: { beta, withB } };
  },
  predict(model, samples) {
    const X = samples.map(s => (model.withB ? [1, ...s.x] : s.x));
    return matVec(X, model.beta);
  },
};

// linalg helpers
function transpose(A: number[][]): number[][] {
  if (!A.length) return [];
  const m = A.length, n = A[0].length;
  const T = Array.from({ length: n }, () => Array(m).fill(0));
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) T[j][i] = A[i][j];
  return T;
}
function matMul(A: number[][], B: number[][]): number[][] {
  const m = A.length, n = A[0].length, p = B[0].length;
  const C = Array.from({ length: m }, () => Array(p).fill(0));
  for (let i = 0; i < m; i++) for (let k = 0; k < n; k++) {
    const aik = A[i][k];
    for (let j = 0; j < p; j++) C[i][j] += aik * B[k][j];
  }
  return C;
}
function matVec(A: number[][], v: number[]): number[] {
  const m = A.length, n = A[0].length;
  const out = new Array(m).fill(0);
  for (let i = 0; i < m; i++) {
    let s = 0; for (let j = 0; j < n; j++) s += A[i][j] * v[j];
    out[i] = s;
  }
  return out;
}
function invert(M: number[][]): number[][] {
  const n = M.length;
  const A = M.map(r => r.slice());
  const I = Array.from({ length: n }, (_, i) => { const r = Array(n).fill(0); r[i] = 1; return r; });
  for (let i = 0; i < n; i++) {
    let piv = A[i][i];
    if (Math.abs(piv) < 1e-12) {
      let sw = i + 1;
      for (; sw < n; sw++) if (Math.abs(A[sw][i]) > Math.abs(piv)) break;
      if (sw === n) throw new Error("Singular");
      [A[i], A[sw]] = [A[sw], A[i]];
      [I[i], I[sw]] = [I[sw], I[i]];
      piv = A[i][i];
    }
    const invP = 1 / piv;
    for (let j = 0; j < n; j++) { A[i][j] *= invP; I[i][j] *= invP; }
    for (let r = 0; r < n; r++) if (r !== i) {
      const f = A[r][i];
      for (let c = 0; c < n; c++) { A[r][c] -= f * A[i][c]; I[r][c] -= f * I[i][c]; }
    }
  }
  return I;
}

/* ===================== Test Data ===================== */

function makeToyDataset(n = 100, d = 3, seed = 7): Dataset {
  const r = rng(seed);
  const beta = Array.from({ length: d }, (_, i) => (i + 1) / d);
  const data: Dataset = [];
  for (let i = 0; i < n; i++) {
    const x = Array.from({ length: d }, () => r() * 2 - 1);
    const yClean = x.reduce((s, v, j) => s + v * beta[j], 0);
    const y = yClean + (r() - 0.5) * 0.05;
    data.push({ t: i, x, y });
  }
  return data;
}

/* ===================== Tests ===================== */

(function test_kFoldPlan() {
  const n = 37, k = 5;
  const plan = kFoldPlan(n, k, true, 123);
  assert.strictEqual(plan.splits.length, k, "k folds created");
  const cover = new Set<number>();
  for (const sp of plan.splits) {
    const setV = new Set(sp.validIdx);
    assert.strictEqual(setV.size, sp.validIdx.length, "no dup in valid");
    sp.validIdx.forEach(i => cover.add(i));
  }
  assert.strictEqual(cover.size, n, "coverage across folds");
})();

(function test_timeSeriesPlan() {
  const ds = makeToyDataset(100, 3, 9);
  const plan = timeSeriesPlan(ds, 6, 24);
  assert.ok(plan.splits.length >= 3, "has multiple splits");
  for (const sp of plan.splits) {
    assert.ok(Math.max(...sp.trainIdx) < Math.min(...sp.validIdx), "train < valid");
  }
})();

(function test_scorers() {
  const y = [1, 2, 3, 4, 5];
  const mono = [10, 20, 30, 40, 50];
  const anti = [50, 40, 30, 20, 10];
  assert.ok(scoreIC(mono, y, "spearman") > 0.99);
  assert.ok(scoreIC(anti, y, "spearman") < -0.99);
  assert.ok(scoreSharpe(y, y, 252) > 0);
  assert.strictEqual(scoreMSE([1,2,3],[1,2,3]), 0);
  assert.strictEqual(scoreMAE([1,2,3],[1,2,3]), 0);
  assert.ok(scoreAccuracySign([1,-2,0.1],[0.5,-3,-0.2]) > 0.66);
})();

(async function test_grid_and_random() {
  const ds = makeToyDataset(80, 4, 11);
  const plan = kFoldPlan(ds.length, 4, true, 42);
  const space = { lambda: [1e-4,1e-3,1e-2,1e-1], intercept: [true,false] };

  const repG = await gridSearch(tinyLinear, ds, space, {
    plan, scorer: { kind: "mse" }, reportTopN: 3
  });
  assert.ok(repG.best && Number.isFinite(repG.best.meanScore));
  assert.ok(repG.top.length <= 3);

  const repR = await randomSearch(tinyLinear, ds, space, 3, {
    plan, scorer: { kind: "mse" }, reportTopN: 3, seed: 7
  });
  assert.ok(repR.best && Number.isFinite(repR.best.meanScore));
})();

(async function test_walkForward() {
  const ds = makeToyDataset(60, 3, 21);
  const window = 20;
  const out = await walkForward(tinyLinear, ds, { lambda: 1e-2, intercept: true }, {
    window, step: 2, scorer: { kind: "mse" }
  });
  assert.ok(Number.isFinite(out.meanScore));
  const expect = Math.floor((ds.length - window) / 2);
  assert.strictEqual(out.scores.length, expect);
})();

// allow direct run
if (require.main === module) {
  console.log("[OK] selection.unit.test.ts (self-contained) passed");
}