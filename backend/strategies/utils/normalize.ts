// utils/normalize.ts
// Pure TypeScript normalization & scaling utilities (no imports).

// ---------- Guards & helpers ----------
function isFiniteNumber(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
function safe(x: any, d = 0): number {
  return isFiniteNumber(x) ? x : d;
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
function sum(a: number[]): number {
  let s = 0; for (let i = 0; i < a.length; i++) s += safe(a[i], 0);
  return s;
}
function mean(a: number[]): number {
  return a.length ? sum(a) / a.length : 0;
}
function variance(a: number[]): number {
  const n = a.length;
  if (n <= 1) return 0;
  const m = mean(a);
  let v = 0;
  for (let i = 0; i < n; i++) { const d = safe(a[i], 0) - m; v += d * d; }
  return v / (n - 1);
}
function std(a: number[]): number {
  return Math.sqrt(Math.max(variance(a), 0));
}
function median(a: number[]): number {
  if (!a.length) return 0;
  const v = a.map(x => safe(x, 0)).slice().sort((x, y) => x - y);
  const n = v.length, mid = Math.floor(n / 2);
  return n % 2 ? v[mid] : 0.5 * (v[mid - 1] + v[mid]);
}
function mad(a: number[]): number {
  const m = median(a);
  const devs = a.map(x => Math.abs(safe(x, 0) - m));
  return median(devs) || 0;
}

// ---------- Basic transforms ----------
export function clip(a: number[], lo: number, hi: number): number[] {
  const L = Math.min(lo, hi), H = Math.max(lo, hi);
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) out.push(clamp(safe(a[i], 0), L, H));
  return out;
}

export function winsorize(a: number[], pLow = 0.01, pHigh = 0.99): number[] {
  const v = a.map(x => safe(x, 0)).slice().sort((x, y) => x - y);
  const q = (p: number) => {
    const z = clamp(p, 0, 1) * (v.length - 1);
    const i = Math.floor(z), f = z - i;
    if (v.length === 0) return 0;
    if (i + 1 >= v.length) return v[v.length - 1];
    return v[i] * (1 - f) + v[i + 1] * f;
  };
  const lo = q(pLow), hi = q(pHigh);
  return a.map(x => clamp(safe(x, 0), lo, hi));
}

export function log1p(a: number[]): number[] {
  return a.map(x => Math.log1p(Math.max(-0.999999999999, safe(x, 0))));
}

export function demean(a: number[]): number[] {
  const m = mean(a);
  return a.map(x => safe(x, 0) - m);
}

export function unitVector(a: number[]): number[] {
  const norm = Math.sqrt(sum(a.map(x => safe(x, 0) * safe(x, 0))));
  return norm > 0 ? a.map(x => safe(x, 0) / norm) : a.map(_ => 0);
}

// ---------- Scaling ----------
export function minMaxScale(a: number[], minOut = 0, maxOut = 1): number[] {
  const mn = Math.min(...a.map(x => safe(x, 0)));
  const mx = Math.max(...a.map(x => safe(x, 0)));
  const range = mx - mn;
  if (range <= 0) return a.map(_ => (minOut + maxOut) / 2);
  const scale = (maxOut - minOut) / range;
  return a.map(x => (safe(x, 0) - mn) * scale + minOut);
}

export function zscore(a: number[]): number[] {
  const m = mean(a), s = std(a);
  return s > 0 ? a.map(x => (safe(x, 0) - m) / s) : a.map(_ => 0);
}

export function robustScale(a: number[]): number[] {
  const m = median(a), M = mad(a);
  const denom = M > 0 ? (1.4826 * M) : (std(a) || 1); // 1.4826 ≈ MAD→σ for normal
  return a.map(x => (safe(x, 0) - m) / denom);
}

/** Scale by realized volatility (target annual vol if provided). */
export function scaleByVol(
  dailyReturns: number[],
  targetAnnVol?: number
): number[] {
  const s = std(dailyReturns);
  const ann = s * Math.sqrt(252);
  const k = (isFiniteNumber(targetAnnVol) && ann > 0) ? targetAnnVol! / ann : (s > 0 ? 1 / s : 0);
  return dailyReturns.map(r => safe(r, 0) * k);
}

/** Rescale any signal vector to have unit stdev (or target stdev). */
export function rescaleToStd(a: number[], targetStd = 1): number[] {
  const s = std(a);
  const k = s > 0 ? targetStd / s : 0;
  return a.map(x => safe(x, 0) * k);
}

/** Affine rescale to hit desired mean and stdev. */
export function rescaleToMeanStd(a: number[], mu = 0, sigma = 1): number[] {
  const m = mean(a);
  const s = std(a);
  const k = s > 0 ? sigma / s : 0;
  return a.map(x => (safe(x, 0) - m) * k + mu);
}

// ---------- Ranking-based ----------
export function rankNormalize(a: number[], ties: "average" | "first" = "average"): number[] {
  const n = a.length;
  const idx = a.map((v, i) => ({ v: safe(v, 0), i }));
  idx.sort((x, y) => x.v - y.v);

  const ranks = new Array(n).fill(0);
  if (ties === "first") {
    for (let r = 0; r < n; r++) ranks[idx[r].i] = r + 1;
  } else {
    let r = 0;
    while (r < n) {
      let s = r, e = r;
      while (e + 1 < n && idx[e + 1].v === idx[r].v) e++;
      const avg = (s + e + 2) / 2; // 1-based average rank
      for (let k = s; k <= e; k++) ranks[idx[k].i] = avg;
      r = e + 1;
    }
  }
  // map to [-1, 1] by default using uniform quantiles
  return ranks.map(R => n > 1 ? (2 * (R - 1) / (n - 1) - 1) : 0);
}

export function softmax(a: number[]): number[] {
  if (!a.length) return [];
  const mx = Math.max(...a.map(x => safe(x, -Infinity)));
  const exps = a.map(x => Math.exp(safe(x, 0) - mx));
  const s = sum(exps);
  return s > 0 ? exps.map(x => x / s) : a.map(_ => 0);
}

// ---------- Weights normalization ----------
/** Normalize weights so that sum(|w|)=1 (common for dollar-neutral). */
export function normalizeWeightsL1(w: number[]): number[] {
  const S = sum(w.map(x => Math.abs(safe(x, 0))));
  return S > 0 ? w.map(x => safe(x, 0) / S) : w.map(_ => 0);
}

/** Normalize weights so that sum(w)=1; negatives allowed; if degenerate, return zeros. */
export function normalizeWeightsSum1(w: number[]): number[] {
  const S = sum(w);
  return Math.abs(S) > 1e-12 ? w.map(x => safe(x, 0) / S) : w.map(_ => 0);
}

/** Clip weights and renormalize to L1=1. */
export function clipAndNormalizeL1(w: number[], maxAbs = 0.1): number[] {
  const clipped = w.map(x => clamp(safe(x, 0), -Math.abs(maxAbs), Math.abs(maxAbs)));
  return normalizeWeightsL1(clipped);
}

/** Target portfolio volatility given covariance diagonal proxy (per-asset vol). */
export function targetVolByPerAssetVol(
  weights: number[],
  dailyReturnsMatrix: number[][], // rows: time, cols: asset
  targetAnnVol = 0.1
): number[] {
  // estimate per-asset daily vol
  const cols = weights.length;
  const vols: number[] = [];
  for (let j = 0; j < cols; j++) {
    const col: number[] = [];
    for (let t = 0; t < dailyReturnsMatrix.length; t++) {
      col.push(safe(dailyReturnsMatrix[t][j], 0));
    }
    const s = std(col);
    vols.push(s);
  }
  // naive: scale each weight inversely by vol, then L1-normalize and scale to target vol
  const inv = vols.map(v => (v > 0 ? 1 / v : 0));
  const wAdj = weights.map((w, i) => safe(w, 0) * inv[i]);
  const wNorm = normalizeWeightsL1(wAdj);

  // rough portfolio daily vol proxy: sum(|w| * vol)
  let portDailyVol = 0;
  for (let i = 0; i < cols; i++) portDailyVol += Math.abs(wNorm[i]) * vols[i];
  const portAnnVol = portDailyVol * Math.sqrt(252);
  const k = portAnnVol > 0 ? targetAnnVol / portAnnVol : 0;

  return wNorm.map(w => w * k);
}
