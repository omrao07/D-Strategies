// specials/dispersions.ts
// Pure TypeScript utilities for cross-sectional and pairwise dispersion analytics.
// No imports, single-file drop-in. Designed to be numeric-safe and allocation-ready.

/**
 * Core idea:
 *  - Cross-sectional dispersion is the spread of constituent returns around a
 *    benchmark/aggregate return (cap-weighted, equal-weight, or custom).
 *  - Often used for dispersion trading (short index vol, long single-name vol),
 *    sector-neutral stock picking, and risk decomposition.
 *
 * This module provides:
 *  - Basic stats (mean, stdev, covariance, correlation).
 *  - Cross-sectional dispersion (equal- and custom-weight).
 *  - Pair dispersion (spread volatility).
 *  - Rolling windows with numerically stable updates (Welford).
 *  - Sector-neutral and group-neutral dispersion (via mapping).
 *  - Contribution analysis (which names/groups drive dispersion).
 *  - Simple portfolio weights for dispersion strategies (beta/market-neutral).
 */

// -------- Types --------

export type Num = number;
export type Ticker = string;

export type Vector = Num[];
export type Matrix = Num[][];

export type Weights = { [t: string]: Num };               // arbitrary weights (not required to be normalized)
export type Series = { [t: string]: Num };                // one snapshot across tickers (e.g., 1-day returns)
export type TimeSeries = Array<Series>;                   // time-ordered snapshots (t0..tN-1)

export type GroupMap = { [t: string]: string };           // ticker -> group key (e.g., sector code)
export type BetaMap = { [t: string]: Num };               // ticker -> beta vs. index
export type CapMap = { [t: string]: Num };                // ticker -> market cap (or liquidity proxy)

export type DispersionSnapshot = {
  timestamp?: string | number | Date;
  n: number;
  mean: Num;             // equal-weight mean
  wmean: Num;            // custom-weight mean (if weights given; else = mean)
  stdev: Num;            // equal-weight cross-sectional standard deviation
  wstdev: Num;           // weight-aware (see note)
  variance: Num;
  wvariance: Num;
};

export type Contribution = {
  ticker: Ticker;
  value: Num;            // signed contribution to variance (approx)
  weight: Num;           // analysis weight used
  deviation: Num;        // (r_i - mean)
};

export type GroupContribution = {
  group: string;
  value: Num;
  weight: Num;
};

export type PairDispersion = {
  a: Ticker;
  b: Ticker;
  spreadStd: Num;        // stdev of (r_a - r_b)
  corr: Num;             // correlation estimate if both series provided
};

// -------- Helpers --------

function isFiniteNumber(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function sum(v: Vector): Num {
  let s = 0;
  for (let i = 0; i < v.length; i++) if (isFiniteNumber(v[i])) s += v[i];
  return s;
}

function mean(v: Vector): Num {
  let s = 0, n = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (isFiniteNumber(x)) { s += x; n++; }
  }
  return n > 0 ? s / n : NaN;
}

function variance(v: Vector, useSample: boolean = true): Num {
  let m = 0, s2 = 0, n = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (!isFiniteNumber(x)) continue;
    n++;
    const d = x - m;
    m += d / n;
    s2 += d * (x - m);
  }
  if (n < 1) return NaN;
  return useSample ? (n > 1 ? s2 / (n - 1) : 0) : s2 / n;
}

function stdev(v: Vector, useSample: boolean = true): Num {
  const v2 = variance(v, useSample);
  return isFiniteNumber(v2) ? Math.sqrt(Math.max(0, v2)) : NaN;
}

// Weighted mean using arbitrary non-negative weights
function wmean(xs: Vector, ws: Vector): Num {
  let sw = 0, sxw = 0;
  for (let i = 0; i < xs.length && i < ws.length; i++) {
    const x = xs[i], w = ws[i];
    if (!isFiniteNumber(x) || !isFiniteNumber(w) || w < 0) continue;
    sw += w; sxw += w * x;
  }
  return sw > 0 ? sxw / sw : NaN;
}

// Weighted variance (bias-corrected, analogous to sample variance)
// Note: When weights are arbitrary (not normalized, not frequency), several conventions exist.
// Here we use effective sample size correction: var_w = sum(w*(x-m)^2) / (sw - sw2/sw)
// where sw = sum(w), sw2 = sum(w^2). This matches common portfolio analytics practice.
function wvariance(xs: Vector, ws: Vector): Num {
  let sw = 0, sw2 = 0, m = 0, q = 0;
  let nEff = 0; // effective N proxy
  for (let i = 0; i < xs.length && i < ws.length; i++) {
    const x = xs[i], w = ws[i];
    if (!isFiniteNumber(x) || !isFiniteNumber(w) || w <= 0) continue;
    const prevSw = sw;
    sw += w;
    sw2 += w * w;
    const d = x - m;
    m += (w / sw) * d;
    q += w * d * (x - m);
    nEff++;
  }
  if (sw <= 0) return NaN;
  const denom = sw - (sw2 / sw);
  return denom > 0 ? q / denom : 0;
}

function wstdev(xs: Vector, ws: Vector): Num {
  const v = wvariance(xs, ws);
  return isFiniteNumber(v) ? Math.sqrt(Math.max(0, v)) : NaN;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// -------- Cross-Sectional Dispersion --------

/**
 * Compute cross-sectional dispersion of a single snapshot of returns.
 * @param snapshot map of ticker -> return (e.g., daily log or simple return)
 * @param weights optional weights map (e.g., cap weights). If omitted, equal weight is used.
 */
export function crossSectionalDispersion(snapshot: Series, weights?: Weights, timestamp?: string | number | Date): DispersionSnapshot {
  const tickers = Object.keys(snapshot);
  const x: Vector = [];
  const w: Vector = [];
  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i];
    const r = snapshot[t];
    if (!isFiniteNumber(r)) continue;
    x.push(r);
    w.push(weights && isFiniteNumber(weights[t]) && weights[t] > 0 ? weights[t] : 1);
  }
  const n = x.length;
  if (n === 0) {
    return { timestamp, n: 0, mean: NaN, wmean: NaN, stdev: NaN, wstdev: NaN, variance: NaN, wvariance: NaN };
  }
  const m = mean(x);
  const wm = weights ? wmean(x, w) : m;
  const v = variance(x, true);
  const wv = wvariance(x, w);
  return {
    timestamp,
    n,
    mean: m,
    wmean: wm,
    stdev: Math.sqrt(Math.max(0, v)),
    wstdev: Math.sqrt(Math.max(0, wv)),
    variance: v,
    wvariance: wv,
  };
}

/**
 * Contribution analysis to equal-weight variance.
 * Approximate each name’s contribution as (r_i - mean)^2 / (N-1) (sample variance numerator share).
 * For weights, uses provided weights in the wvariance identity to return weighted contributions.
 */
export function dispersionContributions(snapshot: Series, weights?: Weights): Contribution[] {
  const keys = Object.keys(snapshot);
  const xs: Vector = [];
  const ws: Vector = [];
  const validTickers: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const t = keys[i];
    const r = snapshot[t];
    if (!isFiniteNumber(r)) continue;
    xs.push(r);
    ws.push(weights && isFiniteNumber(weights[t]) && weights[t] > 0 ? weights[t] : 1);
    validTickers.push(t);
  }
  if (xs.length === 0) return [];

  const m = weights ? wmean(xs, ws) : mean(xs);
  const out: Contribution[] = [];
  if (!weights) {
    const n = xs.length;
    const denom = Math.max(1, n - 1);
    for (let i = 0; i < xs.length; i++) {
      const dev = xs[i] - m;
      out.push({ ticker: validTickers[i], value: (dev * dev) / denom, weight: 1, deviation: dev });
    }
  } else {
    // Weighted contribution via q_i = w_i * (x_i - m)^2 / (sw - sw2/sw)
    let sw = 0, sw2 = 0;
    for (let i = 0; i < ws.length; i++) { sw += ws[i]; sw2 += ws[i] * ws[i]; }
    const denom = sw - (sw2 / sw);
    const safeDenom = denom > 0 ? denom : 1;
    for (let i = 0; i < xs.length; i++) {
      const dev = xs[i] - m;
      const c = ws[i] * dev * dev / safeDenom;
      out.push({ ticker: validTickers[i], value: c, weight: ws[i], deviation: dev });
    }
  }
  return out;
}

/**
 * Group/sector contributions: sums contributions by group key.
 */
export function groupContributions(snapshot: Series, groupMap: GroupMap, weights?: Weights): GroupContribution[] {
  const perName = dispersionContributions(snapshot, weights);
  const agg: { [g: string]: { v: number; w: number } } = {};
  for (let i = 0; i < perName.length; i++) {
    const c = perName[i];
    const g = (groupMap && groupMap[c.ticker]) || "OTHER";
    const a = agg[g] || { v: 0, w: 0 };
    a.v += c.value;
    a.w += c.weight;
    agg[g] = a;
  }
  const groups = Object.keys(agg);
  const out: GroupContribution[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const { v, w } = agg[g];
    out.push({ group: g, value: v, weight: w });
  }
  // optional: sort by contribution descending
  out.sort((a, b) => b.value - a.value);
  return out;
}

// -------- Pairwise Dispersion --------

/**
 * Pair dispersion: stdev of the return spread (r_a - r_b). If you also supply
 * both return series (aligned), it will compute correlation as well.
 */
export function pairDispersion(a: Vector, b: Vector): PairDispersion {
  const n = Math.min(a.length, b.length);
  const spread: Vector = [];
  const xa: Vector = [], xb: Vector = [];
  for (let i = 0; i < n; i++) {
    const ai = a[i], bi = b[i];
    if (!isFiniteNumber(ai) || !isFiniteNumber(bi)) continue;
    spread.push(ai - bi);
    xa.push(ai); xb.push(bi);
  }
  const sd = stdev(spread, true);
  let corr = NaN;
  // correlation
  const ma = mean(xa), mb = mean(xb);
  let cov = 0, na = 0;
  for (let i = 0; i < xa.length; i++) {
    const da = xa[i] - ma;
    const db = xb[i] - mb;
    cov += da * db;
    na++;
  }
  if (na > 1) {
    cov = cov / (na - 1);
    const sda = stdev(xa, true);
    const sdb = stdev(xb, true);
    const denom = sda * sdb;
    corr = denom > 0 ? clamp(cov / denom, -1, 1) : NaN;
  }
  return { a: "A", b: "B", spreadStd: sd, corr };
}

// -------- Rolling Dispersion (Welford-like) --------

export type RollingResult = {
  index: number;           // ending index at which window stat is computed
  stdev: number;
  variance: number;
  mean: number;
  n: number;
};

/**
 * Compute rolling cross-sectional dispersion over a window for a TimeSeries.
 * For each time t, we compute dispersion across names at that t (equal-weight by default).
 */
export function rollingDispersionAcrossNames(ts: TimeSeries, window: number, weights?: Weights[]): RollingResult[] {
  const out: RollingResult[] = [];
  if (window <= 0) return out;
  // For each t, compute snapshot dispersion; then roll a time-series stdev of that metric.
  const series: number[] = [];
  for (let t = 0; t < ts.length; t++) {
    const snap = ts[t];
    const w = weights && weights[t] ? weights[t] : undefined;
    const d = crossSectionalDispersion(snap, w);
    series.push(d.stdev); // you can pick wstdev if you prefer
  }
  // Now rolling stdev of "series"
  let m = 0, s2 = 0, n = 0;
  const q: number[] = []; // queue for window
  for (let i = 0; i < series.length; i++) {
    const x = series[i];
    if (!isFiniteNumber(x)) { out.push({ index: i, stdev: NaN, variance: NaN, mean: NaN, n: n }); continue; }
    // push
    q.push(x);
    n++;
    const d = x - m;
    m += d / n;
    s2 += d * (x - m);

    // pop if > window
    if (n > window) {
      const old = q.shift() as number;
      // Remove 'old' from Welford accumulator
      // Recompute safely for small windows (since window size usually modest)
      let mm = 0, ss2 = 0;
      for (let k = 0; k < q.length; k++) {
        const y = q[k];
        const dy = y - mm;
        mm += dy / (k + 1);
        ss2 += dy * (y - mm);
      }
      m = mm; s2 = ss2; n = q.length;
    }

    const varSample = n > 1 ? s2 / (n - 1) : 0;
    out.push({ index: i, stdev: Math.sqrt(Math.max(0, varSample)), variance: varSample, mean: m, n });
  }
  return out;
}

// -------- Group/Sector Neutral Dispersion --------

/**
 * Compute dispersion after de-meaning each group’s returns first (sector-neutral).
 * Steps:
 *  1) For each group g, compute (optionally weight-aware) mean return at this time.
 *  2) Replace each ticker’s return with its group deviation.
 *  3) Compute cross-sectional dispersion on those deviations.
 */
export function groupNeutralDispersion(snapshot: Series, groupMap: GroupMap, weights?: Weights): DispersionSnapshot {
  // group stats
  const groups: { [g: string]: { xs: number[]; ws: number[]; names: string[] } } = {};
  for (const t in snapshot) {
    const g = groupMap && groupMap[t] ? groupMap[t] : "OTHER";
    const w = (weights && isFiniteNumber(weights[t]) && weights[t] > 0) ? weights[t] : 1;
    const r = snapshot[t];
    if (!isFiniteNumber(r)) continue;
    const bucket = groups[g] || { xs: [], ws: [], names: [] };
    bucket.xs.push(r);
    bucket.ws.push(w);
    bucket.names.push(t);
    groups[g] = bucket;
  }
  // compute group means
  const gMean: { [g: string]: number } = {};
  for (const g in groups) {
    const { xs, ws } = groups[g];
    gMean[g] = weights ? wmean(xs, ws) : mean(xs);
  }
  // build de-meaned snapshot
  const devSnap: Series = {};
  for (const g in groups) {
    const bucket = groups[g];
    for (let i = 0; i < bucket.names.length; i++) {
      const t = bucket.names[i];
      devSnap[t] = (snapshot[t] as number) - gMean[g];
    }
  }
  return crossSectionalDispersion(devSnap, weights);
}

// -------- Simple Strategy Helpers --------

/**
 * Market-neutral dispersion portfolio weights:
 *  - Inputs: expected alphas (or last devs) per ticker, optional caps/betas.
 *  - Returns: dollar-neutral weights sum to 0, with gross normalized to 1.
 *  - If betas provided, enforces approximate beta-neutrality by subtracting
 *    a multiple of the beta vector (one-factor projection).
 */
export function marketNeutralWeights(
  alpha: Series,                         // signal per name (e.g., deviation from group mean)
  capHint?: CapMap,                      // scale by liquidity/cap if provided
  beta?: BetaMap                         // beta vs. market
): Weights {
  const ks = Object.keys(alpha);
  if (ks.length === 0) return {};

  // raw score = alpha * scale
  const raw: { [t: string]: number } = {};
  let gross = 0;
  for (let i = 0; i < ks.length; i++) {
    const t = ks[i];
    const a = alpha[t];
    if (!isFiniteNumber(a)) continue;
    const s = capHint && isFiniteNumber(capHint[t]) && capHint[t] > 0 ? Math.sqrt(capHint[t]) : 1;
    const r = a * s;
    raw[t] = r;
    gross += Math.abs(r);
  }
  // normalize gross to 1
  const w0: { [t: string]: number } = {};
  const g = gross > 0 ? gross : 1;
  for (const t in raw) w0[t] = raw[t] / g;

  // optional: beta-neutral projection
  if (beta) {
    // Compute portfolio beta then subtract lambda * beta to make sum(w * beta) ≈ 0
    let wb = 0, bb = 0;
    for (const t in w0) {
      const b = isFiniteNumber(beta[t]) ? beta[t] : 0;
      wb += w0[t] * b;
      bb += b * b;
    }
    const lambda = bb > 0 ? wb / bb : 0;
    for (const t in w0) {
      const b = isFiniteNumber(beta[t]) ? beta[t] : 0;
      w0[t] = w0[t] - lambda * b;
    }
    // re-normalize gross to 1
    let gross2 = 0;
    for (const t in w0) gross2 += Math.abs(w0[t]);
    const g2 = gross2 > 0 ? gross2 : 1;
    for (const t in w0) w0[t] = w0[t] / g2;
  }

  // enforce dollar-neutral (sum ≈ 0)
  let s = 0;
  for (const t in w0) s += w0[t];
  const adj = s / Object.keys(w0).length;
  for (const t in w0) w0[t] = w0[t] - adj;

  // final gross 1 normalization
  let gg = 0;
  for (const t in w0) gg += Math.abs(w0[t]);
  const g3 = gg > 0 ? gg : 1;
  const out: Weights = {};
  for (const t in w0) out[t] = w0[t] / g3;
  return out;
}

/**
 * Build a dispersion alpha from a single snapshot:
 *  - Option A: deviation from equal-weight mean
 *  - Option B: group-neutral deviation (sector-neutral)
 */
export function dispersionAlpha(
  snapshot: Series,
  opts?: { groupMap?: GroupMap; weights?: Weights; zscore?: boolean }
): Series {
  const groupMap = opts?.groupMap;
  const w = opts?.weights;
  let alpha: Series = {};
  if (groupMap) {
    const dev = groupNeutralDeviation(snapshot, groupMap, w);
    alpha = dev;
  } else {
    const keys = Object.keys(snapshot);
    const xs: number[] = [];
    const ws: number[] = [];
    for (let i = 0; i < keys.length; i++) {
      const r = snapshot[keys[i]];
      if (!isFiniteNumber(r)) continue;
      xs.push(r);
      ws.push(w && isFiniteNumber(w[keys[i]]) && w[keys[i]] > 0 ? w[keys[i]] : 1);
    }
    const m = w ? wmean(xs, ws) : mean(xs);
    for (let i = 0; i < keys.length; i++) {
      const t = keys[i];
      const r = snapshot[t];
      if (!isFiniteNumber(r)) continue;
      alpha[t] = r - m;
    }
  }
  if (opts?.zscore) {
    // z-standardize alpha
    const vals: number[] = [];
    const names = Object.keys(alpha);
    for (let i = 0; i < names.length; i++) vals.push(alpha[names[i]]);
    const v = stdev(vals, true);
    const s = v > 0 ? v : 1;
    const out: Series = {};
    for (let i = 0; i < names.length; i++) out[names[i]] = alpha[names[i]] / s;
    return out;
  }
  return alpha;
}

// Helper: group-neutral deviations map
export function groupNeutralDeviation(snapshot: Series, groupMap: GroupMap, weights?: Weights): Series {
  const groups: { [g: string]: { xs: number[]; ws: number[]; names: string[] } } = {};
  for (const t in snapshot) {
    const r = snapshot[t];
    if (!isFiniteNumber(r)) continue;
    const g = (groupMap && groupMap[t]) || "OTHER";
    const w = weights && isFiniteNumber(weights[t]) && weights[t] > 0 ? weights[t] : 1;
    const bucket = groups[g] || { xs: [], ws: [], names: [] };
    bucket.xs.push(r); bucket.ws.push(w); bucket.names.push(t);
    groups[g] = bucket;
  }
  const gMean: { [g: string]: number } = {};
  for (const g in groups) {
    gMean[g] = weights ? wmean(groups[g].xs, groups[g].ws) : mean(groups[g].xs);
  }
  const out: Series = {};
  for (const g in groups) {
    const b = groups[g];
    for (let i = 0; i < b.names.length; i++) {
      const t = b.names[i];
      out[t] = (snapshot[t] as number) - gMean[g];
    }
  }
  return out;
}

// -------- Convenience: Index vs Constituents Dispersion --------

/**
 * Given an index return and constituent returns + weights, compute:
 *  - tracking dispersion: stdev of (r_i - r_index) across names
 *  - "breadth": fraction of names beating index (or > 0)
 */
export function indexTrackingDispersion(
  snapshot: Series,
  indexReturn: number,
  weights?: Weights
): { stdev: number; variance: number; breadthUp: number; breadthBeat: number } {
  const keys = Object.keys(snapshot);
  const diffs: number[] = [];
  let up = 0, beat = 0, n = 0;
  for (let i = 0; i < keys.length; i++) {
    const r = snapshot[keys[i]];
    if (!isFiniteNumber(r)) continue;
    diffs.push(r - indexReturn);
    if (r > 0) up++;
    if (r > indexReturn) beat++;
    n++;
  }
  const v = variance(diffs, true);
  return {
    stdev: Math.sqrt(Math.max(0, v)),
    variance: v,
    breadthUp: n > 0 ? up / n : NaN,
    breadthBeat: n > 0 ? beat / n : NaN,
  };
}

// -------- Small numeric utilities --------

export function zscoreVector(xs: Vector): Vector {
  const m = mean(xs);
  const sd = stdev(xs, true);
  const s = sd > 0 ? sd : 1;
  const out: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    out.push(isFiniteNumber(x) ? (x - m) / s : NaN);
  }
  return out;
}

export function normalizeWeights(w: Weights): Weights {
  let sw = 0;
  for (const k in w) sw += Math.abs(w[k]);
  const s = sw > 0 ? sw : 1;
  const out: Weights = {};
  for (const k in w) out[k] = w[k] / s;
  return out;
}

// -------- Example: one-shot all-in-one --------

/**
 * One-call convenience:
 *  - Computes dispersion snapshot
 *  - Sector-neutral dispersion (if groupMap provided)
 *  - Name and group contributions
 */
export function analyzeDispersion(
  snapshot: Series,
  opts?: { weights?: Weights; groupMap?: GroupMap; timestamp?: string | number | Date }
): {
  headline: DispersionSnapshot;
  sectorNeutral?: DispersionSnapshot;
  contributions: Contribution[];
  groupBreakdown?: GroupContribution[];
} {
  const headline = crossSectionalDispersion(snapshot, opts?.weights, opts?.timestamp);
  const contributions = dispersionContributions(snapshot, opts?.weights);
  if (opts?.groupMap) {
    const sectorNeutral = groupNeutralDispersion(snapshot, opts.groupMap, opts?.weights);
    const groupBreakdown = groupContributions(snapshot, opts.groupMap, opts?.weights);
    return { headline, sectorNeutral, contributions, groupBreakdown };
  }
  return { headline, contributions };
}
