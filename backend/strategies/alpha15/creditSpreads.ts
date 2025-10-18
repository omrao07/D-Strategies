// alpha15/creditswaps.ts
// Pure TypeScript (no imports).
// Computes a CDS-spread-based alpha capturing spread momentum, curve slope, and regime.
// Positive score = tightening (risk-on); Negative = widening (risk-off).

export type Tenor = "1Y" | "3Y" | "5Y" | "7Y" | "10Y";

export type CdsPoint = {
  date: string;   // YYYY-MM-DD
  value: number;  // spread in bps
};

export type CdsCurveSeries = Partial<Record<Tenor, CdsPoint[]>>;

export type Options = {
  mainTenor?: Tenor;       // default "5Y"
  lookbackShort?: number;  // points for short momentum, default 5
  lookbackLong?: number;   // points for long momentum, default 20
  curveNear?: Tenor;       // default "1Y"
  curveFar?: Tenor;        // default "5Y"
  neutralLevelBps?: number | null; // optional external neutral anchor; if null, uses historical mean
  zWindow?: number;        // last N points for z/regime calc, default 60 (or available)
};

export type ComponentScores = {
  momentumS: number;   // -1..+1 (tightening/widening short-term)
  momentumL: number;   // -1..+1 (tightening/widening long-term)
  curve: number;       // -1..+1 (steep/wide vs flat/inverted) → flatter/inverted is risk-on
  regime: number;      // -1..+1 (where latest sits vs history; lower spreads = risk-on)
  carry: number;       // -1..+1 (roll-down: far - near; positive carry if curve downward to near)
};

export type CdsAlpha = {
  score: number;             // composite alpha -1..+1
  components: ComponentScores;
  meta: {
    latestBps: number | null;
    prevS?: number | null;
    prevL?: number | null;
    curveNear?: number | null;
    curveFar?: number | null;
    curveSlope?: number | null; // far - near
    usedTenor: Tenor;
    nPointsMain: number;
    warnings: string[];
  };
};

// --------------------------- utils ------------------------------------

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

function get<T>(arr: T[], idxFromEnd: number): T | undefined {
  const i = arr.length - 1 - idxFromEnd;
  return i >= 0 ? arr[i] : undefined;
}

// Percent change with safe denom (bps)
function pctChange(curr: number, past: number): number {
  const denom = abs(past) < 1e-9 ? (past >= 0 ? 1e-9 : -1e-9) : past;
  return (curr - past) / abs(denom);
}

// Squash to [-1,1] with gentle saturation
function squash(x: number, scale = 3): number {
  // scale controls steepness; higher = gentler
  const y = x / scale;
  // cubic approximation of tanh
  const y3 = y * y * y;
  return clamp(y - y3 / 3);
}

// Normalize by robust spread of history
function normVsHist(x: number, hist: number[]): number {
  const s = std(hist);
  if (s === 0) return 0;
  return (x - mean(hist)) / s;
}

// --------------------------- core -------------------------------------

/**
 * Compute CDS alpha from a set of tenor series.
 * Assumes each tenor series is sorted ascending by date.
 */
export function computeCdsAlpha(
  curve: CdsCurveSeries,
  opts: Options = {}
): CdsAlpha {
  const warnings: string[] = [];

  const mainTenor: Tenor = opts.mainTenor ?? "5Y";
  const lookS = Math.max(1, opts.lookbackShort ?? 5);
  const lookL = Math.max(lookS + 1, opts.lookbackLong ?? 20);
  const near: Tenor = opts.curveNear ?? "1Y";
  const far: Tenor = opts.curveFar ?? "5Y";
  const zWin = Math.max(10, opts.zWindow ?? 60);

  const mainSeries = curve[mainTenor] ?? [];
  const n = mainSeries.length;

  if (n === 0) {
    return {
      score: 0,
      components: { momentumS: 0, momentumL: 0, curve: 0, regime: 0, carry: 0 },
      meta: {
        latestBps: null,
        usedTenor: mainTenor,
        nPointsMain: 0,
        warnings: ["No data for main tenor."]
      }
    };
  }

  // Extract latest and history
  const histVals = mainSeries.map(p => p.value);
  const latest = histVals[n - 1];

  // Momentum components (tightening = negative pct change → risk-on → positive alpha)
  const pastS = get(histVals, lookS);
  const pastL = get(histVals, lookL);

  let mS = 0, mL = 0;
  if (pastS !== undefined) {
    const chS = pctChange(latest, pastS);
    mS = clamp(-chS); // invert sign: tightening (↓) → positive score
  } else {
    warnings.push(`Insufficient history for short momentum (${lookS}).`);
  }

  if (pastL !== undefined) {
    const chL = pctChange(latest, pastL);
    mL = clamp(-chL);
  } else {
    warnings.push(`Insufficient history for long momentum (${lookL}).`);
  }

  // Curve slope & carry (far - near)
  const nearSeries = curve[near] ?? [];
  const farSeries = curve[far] ?? [];
  const nearLast = nearSeries.length ? nearSeries[nearSeries.length - 1].value : null;
  const farLast = farSeries.length ? farSeries[farSeries.length - 1].value : null;

  let curveSlope: number | null = null;
  let compCurve = 0;
  let compCarry = 0;

  if (nearLast != null && farLast != null) {
    curveSlope = farLast - nearLast; // >0 = upward (worse credit), <0 = inverted (better)
    // Map slope to component: flatter/inverted (<=0) is risk-on → positive
    const slopeNorm = squash(-curveSlope / Math.max(10, abs(latest))); // scale by level
    compCurve = clamp(slopeNorm);

    // Carry proxy: roll-down benefit when curve downward towards near (far>near negative carry)
    // Positive carry when investor holds far tenor and expects roll toward lower near spreads (inverted)
    compCarry = clamp(-curveSlope / Math.max(25, abs(latest))); // milder scale
  } else {
    warnings.push("Missing near/far tenors for curve metrics.");
  }

  // Regime: where current spread sits vs trailing window
  const tail = histVals.slice(Math.max(0, n - zWin));
  const z = normVsHist(latest, tail);
  // Lower-than-average spreads (z<0) = risk-on → positive score
  const compRegime = clamp(-z / 2);

  // Optional anchor vs neutral level (if provided), blended into regime
  if (opts.neutralLevelBps != null) {
    const anchor = opts.neutralLevelBps;
    const dev = (latest - anchor) / Math.max(25, abs(anchor));
    const anchorComp = clamp(-dev); // below neutral → positive
    // blend with regime for stability
    const blend = 0.5 * compRegime + 0.5 * anchorComp;
    // replace regime with blend
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (void 0);
    // ts no-op, assign:
    (compRegime as number) = blend;
  }

  // Weighting
  const wS = 0.35;
  const wL = 0.25;
  const wCurve = 0.20;
  const wReg = 0.15;
  const wCarry = 0.05;

  let raw =
    wS * mS +
    wL * mL +
    wCurve * compCurve +
    wReg * compRegime +
    wCarry * compCarry;

  // Confidence penalty if too few components available
  const present =
    (pastS !== undefined ? 1 : 0) +
    (pastL !== undefined ? 1 : 0) +
    (nearLast != null && farLast != null ? 1 : 0);

  if (present <= 1) raw *= 0.6;
  else if (present === 2) raw *= 0.85;

  const score = clamp(raw);

  return {
    score,
    components: {
      momentumS: mS,
      momentumL: mL,
      curve: compCurve,
      regime: compRegime,
      carry: compCarry
    },
    meta: {
      latestBps: latest,
      prevS: pastS ?? null,
      prevL: pastL ?? null,
      curveNear: nearLast ?? null,
      curveFar: farLast ?? null,
      curveSlope: curveSlope ?? null,
      usedTenor: mainTenor,
      nPointsMain: n,
      warnings
    }
  };
}

// ----------------------- helper: cross-sectional rank ------------------

// Rank an array of CDS alphas into [-1, +1] cross-sectionally.
export function rankToUnit(scores: number[]): number[] {
  const n = scores.length;
  if (n === 0) return [];
  const idx = scores.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out: number[] = new Array(n);
  for (let r = 0; r < n; r++) {
    const pos = n === 1 ? 0.5 : r / (n - 1); // 0..1
    const u = pos * 2 - 1; // -1..+1
    out[idx[r].i] = u;
  }
  return out;
}

// ------------------------------- examples ------------------------------
// const series5Y: CdsPoint[] = [...]; // ascending by date
// const series1Y: CdsPoint[] = [...];
// const alpha = computeCdsAlpha({ "5Y": series5Y, "1Y": series1Y }, { mainTenor: "5Y" });
// console.log(alpha);
