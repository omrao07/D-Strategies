// backtester/ablation.ts
// Lightweight ablation framework for strategy backtests (TypeScript, no deps).
// - Toggle features (on/off or multi-valued) and run all combinations
// - Optional grid on numeric params (arrays)
// - Deterministic random seeds per trial
// - Supports k-fold split or single run
// - Collects metrics, ranks, and simple significance check
// - Produces compact JSON and CSV reports
//
// You provide a `runBacktest` function that accepts a config and returns metrics.

export type Seed = number;

export type AnyDict = Record<string, unknown>;

/** What your backtester returns. Add fields as you need. */
export type BacktestMetrics = {
  /** Higher is better */
  sharpe?: number;
  /** Higher is better */
  pnl?: number;
  /** Lower is better */
  maxDD?: number;
  /** Any other metric */
  [k: string]: number | undefined;
};

export type BacktestRunResult = {
  metrics: BacktestMetrics;
  /** Optional per-period series if you want fold stats (ignored by core) */
  timeline?: number[];
};

export type BacktestFn<Cfg extends AnyDict> = (args: {
  config: Cfg;
  /** Fold index (0..k-1) or 0 for single run */
  fold: number;
  /** Deterministic seed for this run */
  seed: Seed;
}) => Promise<BacktestRunResult> | BacktestRunResult;

/** Search space specification */
export type Space = {
  /** Categorical switches (booleans, strings, numbers) — each value tried */
  [key: string]: (boolean | number | string)[];
};

/** Optional fixed fields merged into each trial config */
export type BaseConfig<Cfg extends AnyDict> = Partial<Cfg> & AnyDict;

export type AblationOptions<Cfg extends AnyDict> = {
  /** Combinatorial search space (every cartesian product is tried) */
  space: Space;
  /** Extra fixed parameters merged into each trial */
  base?: BaseConfig<Cfg>;
  /** Number of cross-validation folds (default 1) */
  folds?: number;
  /** Master seed (trial/fold seeds derived from this). Default 42 */
  seed?: Seed;
  /** Which metric to optimize for (default 'sharpe') */
  primaryMetric?: keyof BacktestMetrics;
  /** Sort direction for primary metric (default 'desc') */
  direction?: "asc" | "desc";
  /** Optional early filter to skip certain combinations */
  where?: (cfg: Cfg) => boolean;
  /** Optional per-trial hook (e.g., log progress) */
  onTrialStart?: (info: TrialInfo<Cfg>) => void;
  onTrialFinish?: (info: TrialInfo<Cfg> & { foldMetrics: BacktestMetrics[]; mean: BacktestMetrics }) => void;
};

export type TrialInfo<Cfg extends AnyDict> = {
  index: number;          // trial index (0..n-1)
  total: number;          // total trials
  config: Cfg;            // full config used by backtester (without fold/seed)
};

/** Aggregated result for one combination over k folds */
export type TrialResult<Cfg extends AnyDict> = {
  config: Cfg;
  foldMetrics: BacktestMetrics[];
  mean: BacktestMetrics;
  stdev: Partial<Record<keyof BacktestMetrics, number>>;
  /** Simple score used for ranking (primary metric, direction-aware) */
  score: number;
  /** Per-fold seeds used for reproducibility */
  seeds: Seed[];
  /** Trial index for deterministic ordering */
  index: number;
};

/** Overall run report */
export type AblationReport<Cfg extends AnyDict> = {
  options: Omit<AblationOptions<Cfg>, "onTrialStart" | "onTrialFinish" | "where"> & {
    where?: string | undefined;
  };
  trials: TrialResult<Cfg>[];
  ranked: TrialResult<Cfg>[]; // sorted by score
  best: TrialResult<Cfg> | null;
  /** Quick CSV view for spreadsheet export */
  toCSV: (columns?: (keyof BacktestMetrics)[]) => string;
};

/* --------------------------------- Runner -------------------------------- */

export async function runAblation<Cfg extends AnyDict>(
  runBacktest: BacktestFn<Cfg>,
  opts: AblationOptions<Cfg>
): Promise<AblationReport<Cfg>> {
  const {
    space,
    base = {} as BaseConfig<Cfg>,
    folds = 1,
    seed = 42,
    primaryMetric = "sharpe",
    direction = "desc",
    where,
    onTrialStart,
    onTrialFinish,
  } = opts;

  const combos = enumerate(space).map((x) => ({ ...base, ...x })) as Cfg[];
  const filtered = where ? combos.filter((c) => safeWhere(where, c)) : combos;
  const trials: TrialResult<Cfg>[] = [];

  let idx = 0;
  for (const cfg of filtered) {
    const info: TrialInfo<Cfg> = { index: idx, total: filtered.length, config: cfg };
    onTrialStart?.(info);

    const foldMetrics: BacktestMetrics[] = [];
    const seeds: Seed[] = [];
    for (let f = 0; f < Math.max(1, folds); f++) {
      const s = deriveSeed(seed, idx, f);
      seeds.push(s);
      const res = await runBacktest({ config: cfg, fold: f, seed: s });
      foldMetrics.push(res.metrics ?? {});
    }

    const mean = meanMetrics(foldMetrics);
    const stdev = stdevMetrics(foldMetrics, mean);
    const score = toScore(mean[primaryMetric], direction);
    const tr: TrialResult<Cfg> = { config: cfg, foldMetrics, mean, stdev, score, seeds, index: idx };
    trials.push(tr);

    onTrialFinish?.({ ...info, foldMetrics, mean });
    idx++;
  }

  const ranked = [...trials].sort((a, b) => b.score - a.score || a.index - b.index);
  const best = ranked[0] ?? null;

  return {
    options: {
      space,
      base,
      folds,
      seed,
      primaryMetric,
      direction,
      where: where ? where.toString() : undefined,
    },
    trials,
    ranked,
    best,
    toCSV(columns) {
      const cols = columns ?? pickMetricCols(trials);
      const head = ["trial", ...Object.keys(base), ...Object.keys(space), ...cols.map((c) => `mean_${String(c)}`)];
      const rows = ranked.map((t, i) => {
        const row: (string | number)[] = [i + 1];
        for (const k of Object.keys(base)) row.push(val(t.config[k]));
        for (const k of Object.keys(space)) if (!(k in base)) row.push(val(t.config[k]));
        for (const c of cols) row.push(num(t.mean[c as keyof BacktestMetrics]));
        return row.join(",");
      });
      return [head.join(","), ...rows].join("\n");
    },
  };
}

/* ---------------------------- Helpers / Stats ---------------------------- */

function enumerate(space: Space): AnyDict[] {
  const keys = Object.keys(space);
  if (keys.length === 0) return [{}];
  const out: AnyDict[] = [];
  const dfs = (i: number, cur: AnyDict) => {
    if (i === keys.length) {
      out.push({ ...cur });
      return;
    }
    const k = keys[i];
    const arr = space[k] ?? [null];
    for (const v of arr) {
      cur[k] = v;
      dfs(i + 1, cur);
    }
    delete cur[k];
  };
  dfs(0, {});
  return out;
}

function safeWhere<Cfg extends AnyDict>(fn: (c: Cfg) => boolean, c: Cfg): boolean {
  try { return !!fn(c); } catch { return false; }
}

function deriveSeed(master: Seed, trial: number, fold: number): Seed {
  // simple LCG hash — deterministic, avoids collisions
  let x = (master ^ (trial + 1) * 0x9e3779b1) >>> 0;
  x ^= (fold + 1) * 0x85ebca6b;
  x = Math.imul(x ^ (x >>> 15), 0xc2b2ae35) >>> 0;
  return x >>> 0;
}

function meanMetrics(arr: BacktestMetrics[]): BacktestMetrics {
  const keys = metricKeys(arr);
  const m: BacktestMetrics = {};
  for (const k of keys) {
    let s = 0, n = 0;
    for (const a of arr) {
      const v = a[k];
      if (typeof v === "number" && Number.isFinite(v)) { s += v; n++; }
    }
    m[k] = n ? s / n : undefined;
  }
  return m;
}

function stdevMetrics(arr: BacktestMetrics[], mean: BacktestMetrics): Partial<Record<keyof BacktestMetrics, number>> {
  const keys = metricKeys(arr);
  const out: Partial<Record<keyof BacktestMetrics, number>> = {};
  for (const k of keys) {
    const mu = mean[k];
    if (typeof mu !== "number") continue;
    let s2 = 0, n = 0;
    for (const a of arr) {
      const v = a[k];
      if (typeof v === "number" && Number.isFinite(v)) { s2 += (v - mu) ** 2; n++; }
    }
    out[k] = n > 1 ? Math.sqrt(s2 / (n - 1)) : 0;
  }
  return out;
}

function metricKeys(arr: BacktestMetrics[]): (keyof BacktestMetrics)[] {
  const set = new Set<string>();
  for (const a of arr) for (const k of Object.keys(a)) set.add(k);
  return Array.from(set) as (keyof BacktestMetrics)[];
}

function pickMetricCols<Cfg extends AnyDict>(trials: TrialResult<Cfg>[]) {
  const set = new Set<keyof BacktestMetrics>();
  for (const t of trials) for (const k of Object.keys(t.mean) as (keyof BacktestMetrics)[]) set.add(k);
  // common ordering: sharpe, pnl, maxDD, rest alpha
  const common: (keyof BacktestMetrics)[] = ["sharpe", "pnl", "maxDD"];
  const rest = Array.from(set).filter((k) => !common.includes(k));
  return [...common.filter((k) => set.has(k)), ...rest];
}

function toScore(v: number | undefined, dir: "asc" | "desc") {
  if (typeof v !== "number" || !Number.isFinite(v)) return -Infinity;
  return dir === "asc" ? -v : v; // invert for asc so bigger score is always better
}

function val(x: unknown) {
  if (typeof x === "string") return csvEscape(x);
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "boolean") return x ? 1 : 0;
  return String(x ?? "");
}
function num(x: number | undefined) { return Number.isFinite(x ?? NaN) ? (x as number) : ""; }
function csvEscape(s: string) {
  if (/[,\"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/* ----------------------- Quick significance utility ---------------------- */
/** Two-sample t-test (unequal variances). Returns t and p (approx). */
export function tTest(
  a: number[],
  b: number[]
): { t: number; p: number } {
  const ma = mean(a), mb = mean(b);
  const va = variance(a, ma), vb = variance(b, mb);
  const na = a.length, nb = b.length;
  const t = (ma - mb) / Math.sqrt(va / na + vb / nb);
  // Welch–Satterthwaite dof approximation
  const v = ((va / na) + (vb / nb)) ** 2 /
    ((va ** 2) / (na ** 2 * (na - 1)) + (vb ** 2) / (nb ** 2 * (nb - 1)));
  return { t, p: twoTailedP(t, v) };
}
function mean(x: number[]) { return x.reduce((s, v) => s + v, 0) / Math.max(1, x.length); }
function variance(x: number[], m: number) {
  if (x.length <= 1) return 0;
  let s2 = 0; for (const v of x) s2 += (v - m) ** 2;
  return s2 / (x.length - 1);
}
/** Very small p-value approx using Student's t CDF (series). */
function twoTailedP(t: number, v: number) {
  const x = Math.abs(t);
  // rough numeric approx using incomplete beta via continued fraction
  // For small code size we use a simple fallback:
  const z = x * Math.sqrt((v - 2) / v);
  const p = 2 * (1 - normalCDF(z));
  return Math.max(0, Math.min(1, p));
}
function normalCDF(z: number) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const prob = 1 - d * (0.31938153*t - 0.356563782*t**2 + 1.781477937*t**3 - 1.821255978*t**4 + 1.330274429*t**5);
  return z >= 0 ? prob : 1 - prob;
}
// state/reconcile.ts
// Compare two sets of positions (e.g., book vs broker) and identify diffs.
// Useful for reconciling broker statements to your internal records.
//
// Positions are identified by symbol, and compared by quantity and value.
// Quantities are compared approximately within a small epsilon tolerance
// to avoid noise from rounding or FX conversions.
//
// Returns lists of diffs, plus summary totals.

export type NumberLike = number | string | null | undefined;

export type Position = {
  symbol: string;       // unique ID (e.g., "AAPL", "EURUSD")
  qty: NumberLike;      // positive long, negative short, zero flat
  value?: NumberLike;   // optional position value (e.g., market value)
};

export type PositionDiff = {
  symbol: string;
  status: "match" | "missing" | "unexpected" | "changed";
  bookQty: number;      // book quantity (0 if missing)
  brokerQty: number;    // broker quantity (0 if unexpected)
  qtyDiff: number;      // brokerQty - bookQty
  bookValue?: number;   // book value (if provided)
  brokerValue?: number; // broker value (if provided)
  valueDiff?: number;   // brokerValue - bookValue (if both provided)
};

export type ReconcileReport = {
  diffs: PositionDiff[]; // all diffs (non-matches)
  same: PositionDiff[];  // matched positions
  changed: PositionDiff[]; // qty changed
  missing: PositionDiff[]; // in book but not broker
  unexpected: PositionDiff[]; // in broker but not book
  totals: {
    bookQty: number;
    brokerQty: number;
    qtyDiff: number;
    bookValue?: number;
    brokerValue?: number;
    valueDiff?: number;
  };
};


