// backtester/regime.ts
// Tiny, dependency-free regime detection helpers for backtests.
// Provides: trend/vol/drawdown regimes, simple combiner, per-regime stats,
// and a Markov transition matrix. Designed to work with price/equity/returns
// arrays (and optional timestamps).

export type Regime =
  | "bull"
  | "bear"
  | "neutral"
  | "crash"
  | "rally"
  | "highVol"
  | "lowVol";

export type Series = number[];                // price, equity, or returns
export type Timestamps = Array<number | Date | string> | undefined;

export type TrendOpts = {
  short?: number;   // short MA length (default 50)
  long?: number;    // long MA length (default 200)
  bandPct?: number; // buffer % band to reduce churning (default 0.0)
};

export type VolOpts = {
  window?: number;    // rolling stdev window on returns (default 21)
  hiPct?: number;     // percentile threshold for high vol (0..1, default .8)
  loPct?: number;     // percentile threshold for low vol  (0..1, default .2)
};

export type DrawdownOpts = {
  window?: number;      // rolling peak window (default 252)
  crashThresh?: number; // e.g. -0.2 => -20% from peak (default -0.2)
  rallyThresh?: number; // recover above peak by this % => "rally" (default +0.01)
};

export type CombineOpts = {
  /** When set, “crash” from drawdown overrides everything. Default true. */
  crashDominates?: boolean;
  /** Map your own priorities if needed (higher = stronger). */
  priorities?: Partial<Record<Regime, number>>;
};

/* ----------------------------------------------------------------------------
 * Public API
 * --------------------------------------------------------------------------*/

/** Trend regime via SMA cross with an optional dead-band to reduce churn. */
export function regimeByTrend(
  prices: Series,
  opts: TrendOpts = {}
): (Regime | null)[] {
  const n = prices.length;
  const s = Math.max(1, Math.floor(opts.short ?? 50));
  const l = Math.max(2, Math.floor(opts.long ?? 200));
  if (n === 0 || s >= n || l >= n) return Array(n).fill(null);

  const maS = sma(prices, s);
  const maL = sma(prices, l);
  const band = opts.bandPct ?? 0;

  const out: (Regime | null)[] = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const a = maS[i], b = maL[i];
    if (a == null || b == null) continue;
    // dead-band around long MA
    const up = b * (1 + band);
    const dn = b * (1 - band);
    if (a > up) out[i] = "bull";
    else if (a < dn) out[i] = "bear";
    else out[i] = "neutral";
  }
  return out;
}

/** Volatility regime via rolling stdev of returns and percentile bands. */
export function regimeByVol(
  returns: Series,
  opts: VolOpts = {}
): (Regime | null)[] {
  const n = returns.length;
  if (n === 0) return [];
  const w = Math.max(2, Math.floor(opts.window ?? 21));
  const st = rollingStdev(returns, w);
  const hi = percentile(st, opts.hiPct ?? 0.8);
  const lo = percentile(st, opts.loPct ?? 0.2);
  const out: (Regime | null)[] = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const v = st[i];
    if (v == null) continue;
    if (v >= hi) out[i] = "highVol";
    else if (v <= lo) out[i] = "lowVol";
    else out[i] = "neutral";
  }
  return out;
}

/** Drawdown regime on an equity (or price) curve. */
export function regimeByDrawdown(
  equity: Series,
  opts: DrawdownOpts = {}
): (Regime | null)[] {
  const n = equity.length;
  if (n === 0) return [];
  const w = Math.max(2, Math.floor(opts.window ?? 252));
  const crash = opts.crashThresh ?? -0.2;
  const rally = opts.rallyThresh ?? 0.01;

  const peaks: number[] = Array(n).fill(NaN);
  let rollingPeak = Number.NEGATIVE_INFINITY;

  const out: (Regime | null)[] = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i < w) rollingPeak = Math.max(rollingPeak, equity[i]);
    else {
      // recompute peak in window [i-w+1..i]
      rollingPeak = Math.max(...equity.slice(i - w + 1, i + 1));
    }
    peaks[i] = rollingPeak;
    if (!Number.isFinite(rollingPeak) || rollingPeak === 0) continue;

    const dd = (equity[i] - rollingPeak) / rollingPeak; // <= 0 when under water
    if (dd <= crash) out[i] = "crash";
    else if (dd >= rally) out[i] = "rally"; // above recent peak
    else out[i] = "neutral";
  }
  return out;
}

/** Combine multiple regime labellings into a single label per bar. */
export function combineRegimes(
  parts: Array<(Regime | null)[]>,
  opts: CombineOpts = {}
): (Regime | null)[] {
  const n = Math.max(0, Math.max(...parts.map((p) => p.length)));
  const priority: Record<Regime, number> = {
    crash: 100,
    bear: 80,
    bull: 70,
    rally: 60,
    highVol: 50,
    lowVol: 40,
    neutral: 10,
    ...(opts.priorities ?? {}),
  };
  const crashWins = opts.crashDominates ?? true;

  const out: (Regime | null)[] = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    let best: Regime | null = null;
    let bestP = -Infinity;
    for (const p of parts) {
      const r = p[i];
      if (!r) continue;
      if (crashWins && r === "crash") { best = r; bestP = Infinity; break; }
      const pr = priority[r] ?? 0;
      if (pr > bestP) { best = r; bestP = pr; }
    }
    out[i] = best;
  }
  return out;
}

/** Build a mask for a desired regime label and return contiguous segments. */
export function maskByRegime(
  labels: (Regime | null)[],
  target: Regime
): { mask: boolean[]; segments: Array<{ start: number; end: number }> } {
  const n = labels.length;
  const mask = Array(n).fill(false);
  const segs: Array<{ start: number; end: number }> = [];
  let run = -1;
  for (let i = 0; i < n; i++) {
    if (labels[i] === target) {
      mask[i] = true;
      if (run < 0) run = i;
    } else if (run >= 0) {
      segs.push({ start: run, end: i - 1 });
      run = -1;
    }
  }
  if (run >= 0) segs.push({ start: run, end: n - 1 });
  return { mask, segments: segs };
}

/** Compute mean return and count per regime (returns series). */
export function returnsByRegime(
  returns: Series,
  labels: (Regime | null)[]
): Record<Regime | "neutral" | "other", { mean: number; n: number }> {
  const acc: Record<string, { s: number; n: number }> = {};
  const put = (k: string, v: number) => {
    const a = (acc[k] ??= { s: 0, n: 0 });
    a.s += v; a.n += 1;
  };
  const n = Math.min(returns.length, labels.length);
  for (let i = 0; i < n; i++) {
    const k = (labels[i] ?? "other") as string;
    put(k, returns[i]);
  }
  const out: Record<string, { mean: number; n: number }> = {};
  for (const [k, a] of Object.entries(acc)) out[k] = { mean: a.n ? a.s / a.n : 0, n: a.n };
  // cast with defaults
  const def = (k: Regime | "neutral" | "other") => out[k] ?? { mean: 0, n: 0 };
  return {
    bull: def("bull"),
    bear: def("bear"),
    crash: def("crash"),
    rally: def("rally"),
    highVol: def("highVol"),
    lowVol: def("lowVol"),
    neutral: def("neutral"),
    other: def("other"),
  };
}

/** Build a first-order Markov transition matrix from discrete labels. */
export function transitionMatrix(
  labels: (Regime | null)[]
): { states: Regime[]; matrix: number[][] } {
  const seq = labels.filter(Boolean) as Regime[];
  const states = Array.from(new Set(seq));
  const idx = new Map(states.map((s, i) => [s, i] as const));
  const k = states.length;
  const M = Array.from({ length: k }, () => Array(k).fill(0));
  for (let i = 1; i < seq.length; i++) {
    const a = idx.get(seq[i - 1])!, b = idx.get(seq[i])!;
    M[a][b] += 1;
  }
  // row-normalize
  for (let i = 0; i < k; i++) {
    const row = M[i];
    const sum = row.reduce((s, x) => s + x, 0);
    if (sum > 0) for (let j = 0; j < k; j++) row[j] /= sum;
  }
  return { states, matrix: M };
}

/* ----------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------*/

function sma(a: Series, w: number) {
  const n = a.length;
  const out: Array<number | null> = Array(n).fill(null);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += a[i];
    if (i >= w) s -= a[i - w];
    if (i >= w - 1) out[i] = s / w;
  }
  return out;
}

function rollingStdev(a: Series, w: number) {
  const n = a.length;
  const out: Array<number | null> = Array(n).fill(null);
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    s += x; s2 += x * x;
    if (i >= w) { const old = a[i - w]; s -= old; s2 -= old * old; }
    if (i >= w - 1) {
      const m = s / w;
      const v = Math.max(0, (s2 - w * m * m) / Math.max(1, w - 1));
      out[i] = Math.sqrt(v);
    }
  }
  return out;
}

function percentile(xs: Array<number | null>, p: number) {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const pos = (v.length - 1) * clamp01(p);
  const i = Math.floor(pos);
  const frac = pos - i;
  const a = v[i], b = v[i + 1] ?? a;
  return a + (b - a) * frac;
}

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }

/* ----------------------------------------------------------------------------
 * Quick examples (commented)
 * --------------------------------------------------------------------------*/
// const px = /* price series */ [];
// const ret = px.slice(1).map((p, i) => (p - px[i]) / px[i]);
// const trend = regimeByTrend(px, { short: 50, long: 200, bandPct: 0.01 });
// const vol = regimeByVol(ret, { window: 21, hiPct: 0.8, loPct: 0.2 });
// const dd = regimeByDrawdown(px, { window: 252, crashThresh: -0.2 });
// const label = combineRegimes([dd, trend, vol]);
// const perRegime = returnsByRegime(ret, label);
// const trans = transitionMatrix(label);
