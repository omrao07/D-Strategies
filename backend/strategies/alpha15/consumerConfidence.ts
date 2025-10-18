// alpha15/consumerconfidence.ts
// Pure TypeScript, no external imports.
// Computes a consumer-confidence-based alpha signal using level, surprise, and momentum components.

export type ConfidencePoint = {
  date: string;        // YYYY-MM-DD
  value: number;       // headline consumer confidence index value
};

export type ConfidenceInput = {
  series: ConfidencePoint[]; // sorted ascending by date; ≥ 13 monthly points recommended
  latestActual?: number;     // optional override of last value if not yet in series
  latestConsensus?: number | null; // street consensus for latestActual (if available)
  neutralLevel?: number;     // long-run neutral anchor; default 100
  lookbackShort?: number;    // months for short momentum; default 3
  lookbackLong?: number;     // months for long momentum; default 12
};

export type ComponentScores = {
  level: number;      // -1..+1 (above/below neutral)
  surprise: number;   // -1..+1 (below/above consensus)
  momentumS: number;  // -1..+1 short-term momentum
  momentumL: number;  // -1..+1 long-term momentum
  regime: number;     // -1..+1 (regime z vs long history)
};

export type ConfidenceAlpha = {
  score: number;          // final composite, -1 (bearish) .. +1 (bullish risk sentiment)
  components: ComponentScores;
  meta: {
    latest: number;
    consensus?: number | null;
    prev1?: number | null;
    prevS?: number | null;
    prevL?: number | null;
    zLatest?: number | null;
    usedNeutral: number;
    nPoints: number;
    warnings: string[];
  };
};

// ------------------------------- utils --------------------------------

function clamp(x: number, lo = -1, hi = 1): number {
  return Math.max(lo, Math.min(hi, x));
}

function abs(x: number): number {
  return x < 0 ? -x : x;
}

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

function pctChange(a: number, b: number): number {
  // (a - b)/|b|
  if (b === 0) return 0;
  return (a - b) / abs(b);
}

function get<T>(arr: T[], idxFromEnd: number): T | undefined {
  const i = arr.length - 1 - idxFromEnd;
  return i >= 0 ? arr[i] : undefined;
}

// Smooth saturation: map x (z-space) → (-1..+1)
function tanhLike(x: number, k = 0.9): number {
  // polynomial approximation to tanh for speed, keeps within [-1,1]
  const y = x * k;
  const y3 = y * y * y;
  return clamp(y - (y3 / 3));
}

// --------------------------- core components ---------------------------

function levelComponent(latest: number, neutral: number, hist: number[]): number {
  // Level vs neutral, normalized by historical volatility
  const s = std(hist);
  const norm = s > 0 ? (latest - neutral) / (2 * s) : (latest - neutral) / 50; // fallback scale
  return clamp(norm);
}

function surpriseComponent(latest: number, consensus?: number | null, prev?: number | null): number {
  if (consensus == null) {
    // fallback: use vs previous print if consensus absent
    if (prev == null) return 0;
    return clamp(pctChange(latest, prev));
  }
  // Positive surprise → bullish (risk-on)
  return clamp(pctChange(latest, consensus));
}

function momentumComponent(latest: number, backVal?: number | null): number {
  if (backVal == null) return 0;
  // Momentum as pct change with gentle cap
  return clamp(pctChange(latest, backVal));
}

function regimeComponent(latest: number, hist: number[]): number {
  // Where is latest in its long-run distribution? Use z-score and squash.
  const z = zScore(latest, hist);
  return tanhLike(z / 2); // soften
}

// --------------------------- public API --------------------------------

export function computeConsumerConfidenceAlpha(input: ConfidenceInput): ConfidenceAlpha {
  const {
    series,
    latestActual,
    latestConsensus = null,
    neutralLevel = 100,
    lookbackShort = 3,
    lookbackLong = 12
  } = input;

  const warnings: string[] = [];
  if (!series || series.length === 0) {
    return {
      score: 0,
      components: { level: 0, surprise: 0, momentumS: 0, momentumL: 0, regime: 0 },
      meta: { latest: NaN, consensus: latestConsensus, prev1: null, prevS: null, prevL: null, zLatest: null, usedNeutral: neutralLevel, nPoints: 0, warnings: ["Empty series"] }
    };
  }

  // Build working historical vector
  const histVals = series.map(p => p.value);
  let latest = latestActual != null ? latestActual : histVals[histVals.length - 1];

  // Previous points
  const prev1 = get(histVals, latestActual != null ? 0 : 1); // if latestActual overrides, prev1 is last in series; else previous value in series
  const prevS = get(histVals, lookbackShort);
  const prevL = get(histVals, lookbackLong);

  if (histVals.length < lookbackLong + 1) {
    warnings.push(`Short history: have ${histVals.length}, suggested ≥ ${lookbackLong + 1}.`);
  }

  // Components
  const compLevel = levelComponent(latest, neutralLevel, histVals);
  const compSurprise = surpriseComponent(latest, latestConsensus, prev1 ?? null);
  const compMomS = momentumComponent(latest, prevS ?? null);
  const compMomL = momentumComponent(latest, prevL ?? null);
  const compRegime = regimeComponent(latest, histVals);

  // Weights: emphasize surprise & level; include momentum and regime for stability
  const wLevel = 0.30;
  const wSurp  = 0.35;
  const wMomS  = 0.15;
  const wMomL  = 0.10;
  const wReg   = 0.10;

  let raw = (
    wLevel * compLevel +
    wSurp  * compSurprise +
    wMomS  * compMomS +
    wMomL  * compMomL +
    wReg   * compRegime
  );

  // Confidence penalty if too few signals present
  const present =
    (compLevel !== 0 ? 1 : 0) +
    (compSurprise !== 0 ? 1 : 0) +
    (compMomS !== 0 ? 1 : 0) +
    (compMomL !== 0 ? 1 : 0) +
    (compRegime !== 0 ? 1 : 0);

  if (present <= 2) raw *= 0.7;

  const score = clamp(raw);

  return {
    score,
    components: {
      level: compLevel,
      surprise: compSurprise,
      momentumS: compMomS,
      momentumL: compMomL,
      regime: compRegime
    },
    meta: {
      latest,
      consensus: latestConsensus,
      prev1: prev1 ?? null,
      prevS: prevS ?? null,
      prevL: prevL ?? null,
      zLatest: histVals.length >= 2 ? zScore(latest, histVals) : null,
      usedNeutral: neutralLevel,
      nPoints: histVals.length,
      warnings
    }
  };
}

// --------------------------- example usage -----------------------------
// const input: ConfidenceInput = {
//   series: [
//     { date: "2023-01-31", value: 101.3 },
//     { date: "2023-02-28", value: 103.4 },
//     // ... (monthly points) ...
//     { date: "2024-12-31", value: 106.0 }
//   ],
//   latestActual: 107.2,
//   latestConsensus: 105.5,
//   neutralLevel: 100,
//   lookbackShort: 3,
//   lookbackLong: 12
// };
// const out = computeConsumerConfidenceAlpha(input);
// console.log(out);
