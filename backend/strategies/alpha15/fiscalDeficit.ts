// alpha15/fiscaldeeficits.ts
// Pure TypeScript (no imports).
// Alpha from fiscal position: improving deficits → risk-on (+), worsening → risk-off (−).

export type Periodicity = "monthly" | "quarterly" | "annual";

export type FiscalPoint = {
  date: string;          // YYYY-MM-DD (period end)
  deficitPctGDP: number; // General gov. fiscal balance as % of GDP (negative for deficit, positive for surplus)
  primaryPctGDP?: number | null; // Optional: primary balance (% GDP)
  debtPctGDP?: number | null;    // Optional: gross public debt (% GDP)
};

export type Projections = {
  // Optional projections/targets for surprise calc (e.g., budget/MOF target, IMF WEO)
  targetDeficitPctGDP?: number | null; // target (same sign convention)
  consensusDeficitPctGDP?: number | null; // street consensus
};

export type Options = {
  periodicity?: Periodicity; // default "quarterly"
  lookbackShort?: number;    // periods for short momentum, default 2
  lookbackLong?: number;     // periods for long momentum, default 8
  zWindow?: number;          // trailing window for regime z, default 20
  neutralDeficit?: number | null; // anchor as %GDP (e.g., -3 for Maastricht), null to disable
  smooth?: number;           // EMA smoothing periods for final score; default 0 (off)
  weightOverrides?: Partial<Weights>;
};

export type Components = {
  level: number;     // where current sits vs neutral (less negative → higher)
  surprise: number;  // beat vs target/consensus
  momentumS: number; // short-term improvement/worsening
  momentumL: number; // long-term improvement/worsening
  regime: number;    // position vs trailing history
  debt: number;      // debt burden signal (lower debt → higher)
  primary: number;   // primary balance signal (less negative → higher)
};

export type Weights = {
  level: number;
  surprise: number;
  momentumS: number;
  momentumL: number;
  regime: number;
  debt: number;
  primary: number;
};

export type FiscalAlpha = {
  score: number;          // composite -1..+1
  components: Components;
  meta: {
    latestDeficit: number;
    lastDebt?: number | null;
    lastPrimary?: number | null;
    prevS?: number | null;
    prevL?: number | null;
    usedNeutral?: number | null;
    nPoints: number;
    warnings: string[];
  };
};

// ------------------------- utils -----------------------------

function clamp(x: number, lo = -1, hi = 1): number {
  return Math.max(lo, Math.min(hi, x));
}

function abs(x: number): number { return x < 0 ? -x : x; }

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s / xs.length;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let v = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = xs[i] - m;
    v += d * d;
  }
  return Math.sqrt(v / (xs.length - 1));
}

function zScore(x: number, xs: number[]): number {
  const s = std(xs);
  if (s === 0) return 0;
  return (x - mean(xs)) / s;
}

function pctChange(curr: number, past: number): number {
  const denom = abs(past) < 1e-9 ? (past >= 0 ? 1e-9 : -1e-9) : past;
  return (curr - past) / abs(denom);
}

function get<T>(arr: T[], idxFromEnd: number): T | undefined {
  const i = arr.length - 1 - idxFromEnd;
  return i >= 0 ? arr[i] : undefined;
}

function ema(prev: number, x: number, k: number): number {
  return prev + k * (x - prev);
}

function squash(x: number, scale = 3): number {
  const y = x / scale;
  const y3 = y * y * y;
  return clamp(y - y3 / 3);
}

// ------------------------- core components -----------------------------

// Level vs neutral (e.g., Maastricht -3%): less negative than neutral → positive.
function levelComponent(latest: number, neutral: number | null, hist: number[]): number {
  if (neutral == null) return 0;
  // Normalize by historical vol for scale robustness
  const s = std(hist);
  const denom = s > 0 ? 2 * s : 4; // fallback width
  const norm = (latest - neutral) / denom;
  return clamp(norm);
}

// Surprise vs target/consensus: deficit less negative than expected → positive.
function surpriseComponent(latest: number, proj: Projections, prev?: number | null): number {
  const cands: (number | null | undefined)[] = [
    proj.consensusDeficitPctGDP,
    proj.targetDeficitPctGDP
  ];
  const ref = cands.find(v => v != null) as number | undefined;
  if (ref != null) {
    // Improvement is latest - ref (e.g., -4 vs -5 → +1 → positive)
    const delta = latest - ref;
    // scale by |ref| to get relative surprise
    return clamp(delta / Math.max(1, abs(ref)));
  }
  // Fallback: use change vs previous print
  if (prev == null) return 0;
  return clamp(pctChange(latest, prev));
}

// Momentum: improvement (deficit becomes less negative) is positive.
// We use raw difference scaled by historical abs(mean) for stability.
function momentumComponent(latest: number, backVal?: number | null, scaleRef?: number): number {
  if (backVal == null) return 0;
  const diff = latest - backVal; // improvement if >0
  const denom = Math.max(1, abs(scaleRef ?? backVal));
  return clamp(diff / denom);
}

// Regime: where latest sits in its own distribution (higher = less negative → positive).
function regimeComponent(latest: number, hist: number[], win = 20): number {
  const tail = hist.slice(Math.max(0, hist.length - win));
  const z = zScore(latest, tail);
  return squash(z / 2);
}

// Debt burden: lower debt/GDP → positive; normalize.
function debtComponent(debtPctGDP?: number | null, histDebt?: (number | null | undefined)[]): number {
  if (debtPctGDP == null) return 0;
  const clean = (histDebt ?? []).filter((x): x is number => typeof x === "number");
  if (clean.length < 2) {
    // Simple anchor around 60% Maastricht if history missing
    const dev = (debtPctGDP - 60) / 40; // every 40pp ~ 1 unit
    return clamp(-dev);
  }
  const z = zScore(debtPctGDP, clean);
  // Lower-than-average debt (z<0) → positive
  return clamp(-z / 2);
}

// Primary balance: less negative → positive; scale by |mean| of history.
function primaryComponent(primary?: number | null, histPrimary?: (number | null | undefined)[]): number {
  if (primary == null) return 0;
  const clean = (histPrimary ?? []).filter((x): x is number => typeof x === "number");
  const m = clean.length ? abs(mean(clean)) : 2;
  const norm = primary / Math.max(1, m);
  return clamp(norm);
}

// ------------------------- public API ----------------------------------

export function computeFiscalDeficitAlpha(
  series: FiscalPoint[],
  projections: Projections = {},
  opts: Options = {}
): FiscalAlpha {
  const warnings: string[] = [];
  if (!series || series.length === 0) {
    return {
      score: 0,
      components: { level: 0, surprise: 0, momentumS: 0, momentumL: 0, regime: 0, debt: 0, primary: 0 },
      meta: { latestDeficit: NaN, nPoints: 0, warnings: ["Empty series"] }
    };
  }

  const periodicity: Periodicity = opts.periodicity ?? "quarterly";
  const lookS = Math.max(1, opts.lookbackShort ?? (periodicity === "monthly" ? 3 : 2));
  const lookL = Math.max(lookS + 1, opts.lookbackLong ?? (periodicity === "monthly" ? 12 : 8));
  const zWin = Math.max(8, opts.zWindow ?? (periodicity === "monthly" ? 24 : 12));
  const neutral = opts.neutralDeficit ?? null;
  const smooth = Math.max(0, opts.smooth ?? 0);

  const histDef = series.map(p => p.deficitPctGDP);
  const histDebt = series.map(p => p.debtPctGDP ?? null);
  const histPrim = series.map(p => p.primaryPctGDP ?? null);

  const latest = histDef[histDef.length - 1];
  const prevS = get(histDef, lookS);
  const prevL = get(histDef, lookL);

  if (histDef.length < lookL + 1) {
    warnings.push(`Short history: have ${histDef.length}, suggested ≥ ${lookL + 1}.`);
  }

  // Components
  const compLevel   = levelComponent(latest, neutral, histDef);
  const compSurp    = surpriseComponent(latest, projections, prevS ?? null);
  const compMomS    = momentumComponent(latest, prevS ?? null, mean(histDef.map(abs)));
  const compMomL    = momentumComponent(latest, prevL ?? null, mean(histDef.map(abs)));
  const compRegime  = regimeComponent(latest, histDef, zWin);
  const compDebt    = debtComponent(series[series.length - 1].debtPctGDP ?? null, histDebt);
  const compPrimary = primaryComponent(series[series.length - 1].primaryPctGDP ?? null, histPrim);

  // Weights (default)
  const W: Weights = {
    level: 0.20,
    surprise: 0.25,
    momentumS: 0.15,
    momentumL: 0.15,
    regime: 0.10,
    debt: 0.10,
    primary: 0.05
  };

  // Apply overrides
  if (opts.weightOverrides) {
    const o = opts.weightOverrides;
    (W.level    = o.level    ?? W.level);
    (W.surprise = o.surprise ?? W.surprise);
    (W.momentumS= o.momentumS?? W.momentumS);
    (W.momentumL= o.momentumL?? W.momentumL);
    (W.regime   = o.regime   ?? W.regime);
    (W.debt     = o.debt     ?? W.debt);
    (W.primary  = o.primary  ?? W.primary);
  }

  let raw =
      W.level    * compLevel
    + W.surprise * compSurp
    + W.momentumS* compMomS
    + W.momentumL* compMomL
    + W.regime   * compRegime
    + W.debt     * compDebt
    + W.primary  * compPrimary;

  // Optional EMA smoothing (over "smooth" periods)
  if (smooth > 0 && series.length > 1) {
    const k = 2 / (smooth + 1);
    // Build a quick synthetic EMA over historical raw signals using available points
    // For lack of historical component weights, approximate with deficit-only regime proxy:
    let est = 0; // start at 0 neutral
    const histApprox = histDef.map((x, i) => {
      const r = clamp(-zScore(x, histDef.slice(Math.max(0, i - zWin + 1), i + 1)) / 2);
      est = ema(est, r, k);
      return est;
    });
    // Blend final with smoothed proxy to reduce noise
    raw = 0.7 * raw + 0.3 * (histApprox[histApprox.length - 1] ?? 0);
  }

  const score = clamp(raw);

  return {
    score,
    components: {
      level: compLevel,
      surprise: compSurp,
      momentumS: compMomS,
      momentumL: compMomL,
      regime: compRegime,
      debt: compDebt,
      primary: compPrimary
    },
    meta: {
      latestDeficit: latest,
      lastDebt: series[series.length - 1].debtPctGDP ?? null,
      lastPrimary: series[series.length - 1].primaryPctGDP ?? null,
      prevS: prevS ?? null,
      prevL: prevL ?? null,
      usedNeutral: neutral,
      nPoints: series.length,
      warnings
    }
  };
}

// ---------------------- cross-sectional helpers ------------------------

// Ranks scores into [-1, +1] across a universe.
export function rankToUnit(scores: number[]): number[] {
  const n = scores.length;
  if (n === 0) return [];
  const idx = scores.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out: number[] = new Array(n);
  for (let r = 0; r < n; r++) {
    const pos = n === 1 ? 0.5 : r / (n - 1); // 0..1
    out[idx[r].i] = pos * 2 - 1;            // -1..+1
  }
  return out;
}

// ---------------------- example usage ----------------------------------
// const series: FiscalPoint[] = [
//   { date: "2022-12-31", deficitPctGDP: -6.4, primaryPctGDP: -3.0, debtPctGDP: 88 },
//   { date: "2023-03-31", deficitPctGDP: -6.1, primaryPctGDP: -2.7, debtPctGDP: 87.5 },
//   // ...
//   { date: "2024-12-31", deficitPctGDP: -5.2, primaryPctGDP: -1.8, debtPctGDP: 84.0 }
// ];
// const projections: Projections = { targetDeficitPctGDP: -5.4 };
// const alpha = computeFiscalDeficitAlpha(series, projections, { neutralDeficit: -3, periodicity: "quarterly" });
// console.log(alpha);
