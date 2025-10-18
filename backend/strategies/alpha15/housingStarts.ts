// alpha15/gdpgrowth.ts
// Pure TypeScript (no imports).
// GDP growth–based alpha. Positive score = stronger growth/risk-on; Negative = weaker/risk-off.

export type GrowthBasis = "YoY" | "QoQ"; // rate of change basis (percent)
export type Periodicity = "quarterly" | "monthly"; // GDP typically quarterly; monthly for nowcasts

export type GrowthPoint = {
  date: string;     // YYYY-MM-DD (period end)
  value: number;    // growth rate in percent (e.g., 3.2 means +3.2%)
  basis: GrowthBasis;
  annualized?: boolean; // for QoQ prints; true if value already SAAR. Ignored for YoY.
  // Optional decomposition contributions (in percentage points) for breadth
  contributions?: {
    // e.g., C (consumption), I (investment), G (government), NX (net exports), Inv (inventories)
    [bucket: string]: number;
  };
};

export type Options = {
  periodicity?: Periodicity;      // default "quarterly"
  preferAnnualizedQoQ?: boolean;  // if QoQ and not annualized, convert to SAAR; default true
  neutralYoY?: number | null;     // neutral/potential growth on YoY basis (e.g., 2.0–6.0 depending country); null to disable
  neutralQoQ_SAAR?: number | null;// neutral growth for QoQ SAAR basis (e.g., 2.0)
  lookbackShort?: number;         // periods for short momentum; default 2 (quarters)
  lookbackLong?: number;          // periods for long momentum; default 8
  zWindow?: number;               // trailing window for regime z; default 20
  weightOverrides?: Partial<Weights>;
};

export type Surprise = {
  consensus?: number | null; // same basis as latest normalized series (YoY or QoQ SAAR depending)
};

export type Components = {
  level: number;     // vs neutral/potential growth
  surprise: number;  // latest vs consensus
  momentumS: number; // short-term acceleration
  momentumL: number; // long-term acceleration
  regime: number;    // distributional position (z)
  breadth: number;   // contribution breadth (% of positive minus negative)
};

export type Weights = {
  level: number;
  surprise: number;
  momentumS: number;
  momentumL: number;
  regime: number;
  breadth: number;
};

export type GdpAlpha = {
  score: number;          // composite -1..+1
  components: Components;
  meta: {
    latest: number;               // latest growth (%), normalized basis (YoY or QoQ SAAR if set)
    basis: GrowthBasis;
    annualized: boolean;
    prevS?: number | null;
    prevL?: number | null;
    neutralUsed?: number | null;
    zWindow: number;
    nPoints: number;
    warnings: string[];
  };
};

// ------------------------------- utils --------------------------------

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

function get<T>(arr: T[], idxFromEnd: number): T | undefined {
  const i = arr.length - 1 - idxFromEnd;
  return i >= 0 ? arr[i] : undefined;
}

// percent difference normalized by |ref|
function pctDiff(a: number, b: number): number {
  if (b === 0) return 0;
  return (a - b) / abs(b);
}

// smooth saturation to [-1,1]
function squash(x: number, scale = 3): number {
  const y = x / scale;
  const y3 = y * y * y;
  return clamp(y - y3 / 3);
}

// Convert QoQ (non-annualized, %) → SAAR (%)
function qoqToSAAR(qoqPct: number): number {
  const q = qoqPct / 100;
  const saar = (Math.pow(1 + q, 4) - 1) * 100;
  return saar;
}

// Normalize series to a coherent basis:
// - If any YoY points exist, prefer YoY track for stability across cycles when mixed.
// - Else use QoQ; annualize if preferAnnualizedQoQ && not annualized.
function normalizeSeries(points: GrowthPoint[], preferAnnualizedQoQ: boolean): { values: number[]; basis: GrowthBasis; annualized: boolean } {
  const anyYoY = points.some(p => p.basis === "YoY");
  if (anyYoY) {
    const vals = points.filter(p => p.basis === "YoY").map(p => p.value);
    return { values: vals, basis: "YoY", annualized: false };
  }
  // Use QoQ path
  const vals = points.map(p => {
    if (p.basis === "QoQ") {
      if (preferAnnualizedQoQ && !p.annualized) return qoqToSAAR(p.value);
      return p.value;
    }
    return p.value;
  });
  const ann = preferAnnualizedQoQ || points.every(p => p.annualized === true);
  return { values: vals, basis: "QoQ", annualized: ann };
}

// Breadth: share of positive contributions minus negative, clipped to [-1,1].
// If contributions missing, returns 0.
function breadthFromContribs(latestPoint?: GrowthPoint): number {
  if (!latestPoint || !latestPoint.contributions) return 0;
  const vals = Object.values(latestPoint.contributions);
  if (vals.length === 0) return 0;
  let pos = 0, neg = 0;
  for (const v of vals) {
    if (v > 0) pos++;
    else if (v < 0) neg++;
  }
  const total = pos + neg;
  if (total === 0) return 0;
  const breadth = (pos - neg) / total; // -1..+1
  return clamp(breadth);
}

// -------------------------------- core ---------------------------------

function levelComponent(latest: number, neutral: number | null, hist: number[]): number {
  if (neutral == null) return 0;
  const s = std(hist);
  const denom = s > 0 ? 2 * s : 4; // 2σ band; fallback 4pp
  return clamp((latest - neutral) / denom);
}

function surpriseComponent(latest: number, consensus?: number | null): number {
  if (consensus == null) return 0;
  return clamp(pctDiff(latest, consensus));
}

function momentumComponent(latest: number, back?: number | null, scaleRef?: number): number {
  if (back == null) return 0;
  const denom = Math.max(1, abs(scaleRef ?? back));
  return clamp((latest - back) / denom);
}

function regimeComponent(latest: number, hist: number[], zWin: number): number {
  const tail = hist.slice(Math.max(0, hist.length - zWin));
  const z = zScore(latest, tail);
  return squash(z / 2); // softer mapping
}

// ------------------------------ public API -----------------------------

export function computeGdpGrowthAlpha(
  series: GrowthPoint[],
  surprise: Surprise = {},
  opts: Options = {}
): GdpAlpha {
  const warnings: string[] = [];
  if (!series || series.length === 0) {
    return {
      score: 0,
      components: { level: 0, surprise: 0, momentumS: 0, momentumL: 0, regime: 0, breadth: 0 },
      meta: { latest: NaN, basis: "YoY", annualized: false, zWindow: 0, nPoints: 0, warnings: ["Empty series"] }
    };
  }

  const periodicity: Periodicity = opts.periodicity ?? "quarterly";
  const preferSAAR = opts.preferAnnualizedQoQ ?? true;
  const lookS = Math.max(1, opts.lookbackShort ?? (periodicity === "monthly" ? 3 : 2));
  const lookL = Math.max(lookS + 1, opts.lookbackLong ?? (periodicity === "monthly" ? 12 : 8));
  const zWin = Math.max(8, opts.zWindow ?? (periodicity === "monthly" ? 24 : 12));

  const norm = normalizeSeries(series, preferSAAR);
  const hist = norm.values;
  const latest = hist[hist.length - 1];

  if (hist.length < lookL + 1) {
    warnings.push(`Short history: have ${hist.length}, suggested ≥ ${lookL + 1}.`);
  }

  // Determine neutral on the chosen basis
  let neutral: number | null = null;
  if (norm.basis === "YoY") {
    neutral = opts.neutralYoY ?? null;
  } else {
    // QoQ basis
    neutral = norm.annualized ? (opts.neutralQoQ_SAAR ?? null) : null;
    if (opts.neutralQoQ_SAAR != null && !norm.annualized) {
      warnings.push("Neutral provided as QoQ SAAR but series is non-annualized; level component disabled.");
      neutral = null;
    }
  }

  // Components
  const prevS = get(hist, lookS);
  const prevL = get(hist, lookL);
  const compLevel   = levelComponent(latest, neutral, hist);
  const compSurp    = surpriseComponent(latest, surprise.consensus ?? null);
  const scaleRef    = Math.max(1, abs(mean(hist)));
  const compMomS    = momentumComponent(latest, prevS ?? null, scaleRef);
  const compMomL    = momentumComponent(latest, prevL ?? null, scaleRef);
  const compRegime  = regimeComponent(latest, hist, zWin);
  const compBreadth = breadthFromContribs(series[series.length - 1]);

  // Weights
  const W: Weights = {
    level: 0.25,
    surprise: 0.25,
    momentumS: 0.20,
    momentumL: 0.15,
    regime: 0.10,
    breadth: 0.05
  };
  if (opts.weightOverrides) {
    const o = opts.weightOverrides;
    (W.level     = o.level     ?? W.level);
    (W.surprise  = o.surprise  ?? W.surprise);
    (W.momentumS = o.momentumS ?? W.momentumS);
    (W.momentumL = o.momentumL ?? W.momentumL);
    (W.regime    = o.regime    ?? W.regime);
    (W.breadth   = o.breadth   ?? W.breadth);
  }

  let raw =
      W.level    * compLevel   +
      W.surprise * compSurp    +
      W.momentumS* compMomS    +
      W.momentumL* compMomL    +
      W.regime   * compRegime  +
      W.breadth  * compBreadth;

  // Confidence penalties when components are missing
  const present =
    (neutral != null ? 1 : 0) +
    (surprise.consensus != null ? 1 : 0) +
    (prevS != null ? 1 : 0) +
    (prevL != null ? 1 : 0);

  if (present <= 1) raw *= 0.7;
  else if (present === 2) raw *= 0.85;

  const score = clamp(raw);

  return {
    score,
    components: {
      level: compLevel,
      surprise: compSurp,
      momentumS: compMomS,
      momentumL: compMomL,
      regime: compRegime,
      breadth: compBreadth
    },
    meta: {
      latest,
      basis: norm.basis,
      annualized: norm.annualized,
      prevS: prevS ?? null,
      prevL: prevL ?? null,
      neutralUsed: neutral,
      zWindow: zWin,
      nPoints: hist.length,
      warnings
    }
  };
}

// -------------------- cross-sectional helper ---------------------------

// Rank an array of alpha scores into [-1, +1] cross-sectionally.
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

// ------------------------------- examples ------------------------------
// const series: GrowthPoint[] = [
//   { date: "2022-12-31", value: 4.0, basis: "YoY" },
//   { date: "2023-03-31", value: 3.5, basis: "YoY" },
//   { date: "2023-06-30", value: 3.2, basis: "YoY" },
//   { date: "2023-09-30", value: 3.0, basis: "YoY" },
//   { date: "2023-12-31", value: 2.8, basis: "YoY" },
//   { date: "2024-03-31", value: 3.1, basis: "YoY", contributions: { C: 1.8, I: 0.9, G: 0.3, NX: 0.0, Inv: 0.1 } }
// ];
// const alpha = computeGdpGrowthAlpha(series, { consensus: 3.0 }, { neutralYoY: 3.0 });
// console.log(alpha);
