// alpha15/inflationsurprise.ts
// Pure TypeScript (no imports).
// Inflation-surprise alpha: positive = disinflationary surprise / improving trend (risk-on).
// Components: level vs target, surprise (headline/core), momentum (YoY & MoM), regime, breadth, core spread.

export type InflPoint = {
  date: string;                 // YYYY-MM-DD (release month end)
  headlineYoY: number;          // % YoY CPI (e.g., 3.2)
  coreYoY?: number | null;      // % YoY core CPI
  headlineMoM?: number | null;  // % MoM SA
  coreMoM?: number | null;      // % MoM SA
  contributions?: Record<string, number>; // category contributions in percentage points to YoY
};

export type Surprise = {
  headlineConsensusYoY?: number | null;
  coreConsensusYoY?: number | null;
  headlineConsensusMoM?: number | null;
  coreConsensusMoM?: number | null;
};

export type Options = {
  targetYoY?: number;          // inflation target YoY (e.g., 2.0 US, 4.0 IN); default 2.0
  lookbackShort?: number;      // months for short momentum; default 3
  lookbackLong?: number;       // months for long momentum; default 12
  zWindow?: number;            // months for regime calc; default 24
  weightOverrides?: Partial<Weights>;
};

export type Components = {
  level: number;        // -1..+1 (above target negative, below positive)
  surprise: number;     // -1..+1 (above consensus negative, below positive)
  momentumYoY_S: number;// -1..+1 (YoY deceleration positive)
  momentumYoY_L: number;// -1..+1
  momentumMoM: number;  // -1..+1 (MoM deceleration positive, uses headline/core if available)
  regime: number;       // -1..+1 (position vs trailing YoY distribution; lower is positive)
  breadth: number;      // -1..+1 (share of neg contribs minus pos; more negatives → disinflation → positive)
  coreSpread: number;   // -1..+1 (headline - core; headline < core (negative spread) → persistent inflation less likely → positive)
};

export type Weights = {
  level: number;
  surprise: number;
  momentumYoY_S: number;
  momentumYoY_L: number;
  momentumMoM: number;
  regime: number;
  breadth: number;
  coreSpread: number;
};

export type InflAlpha = {
  score: number;          // composite -1..+1
  components: Components;
  meta: {
    latestHeadlineYoY: number;
    latestCoreYoY?: number | null;
    latestHeadlineMoM?: number | null;
    latestCoreMoM?: number | null;
    prevS_YoY?: number | null;
    prevL_YoY?: number | null;
    zWindow: number;
    targetUsed: number;
    nPoints: number;
    warnings: string[];
  };
};

// ---------------------------- utils -----------------------------------

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

function squash(x: number, scale = 3): number {
  const y = x / scale;
  const y3 = y * y * y;
  return clamp(y - y3 / 3);
}

// --------------------------- components --------------------------------

// Level vs target: below target → positive; above → negative. Scale by volatility.
function levelComponent(latestYoY: number, target: number, hist: number[]): number {
  const s = std(hist);
  const denom = s > 0 ? 2 * s : 2; // 2σ band or 2pp fallback
  return clamp((target - latestYoY) / denom);
}

// Surprise: actual - consensus (YoY and MoM). Below consensus → positive.
function surpriseComponent(
  latest: { hYoY: number; cYoY?: number | null; hMoM?: number | null; cMoM?: number | null },
  cons: Surprise
): number {
  const parts: number[] = [];
  if (cons.headlineConsensusYoY != null) {
    const d = cons.headlineConsensusYoY;
    const denom = Math.max(0.2, abs(d)); // avoid tiny denom
    parts.push(clamp((d - latest.hYoY) / denom)); // below consensus → positive
  }
  if (cons.coreConsensusYoY != null && latest.cYoY != null) {
    const d = cons.coreConsensusYoY;
    const denom = Math.max(0.2, abs(d));
    parts.push(clamp((d - latest.cYoY) / denom));
  }
  if (cons.headlineConsensusMoM != null && latest.hMoM != null) {
    const d = cons.headlineConsensusMoM;
    const denom = Math.max(0.05, abs(d)); // MoM tends to be small
    parts.push(clamp((d - latest.hMoM) / denom));
  }
  if (cons.coreConsensusMoM != null && latest.cMoM != null) {
    const d = cons.coreConsensusMoM;
    const denom = Math.max(0.05, abs(d));
    parts.push(clamp((d - latest.cMoM) / denom));
  }
  if (parts.length === 0) return 0;
  return clamp(mean(parts));
}

// Momentum YoY: deceleration positive → (prev - latest)/scale
function momentumYoY(latest: number, back?: number | null, scaleRef?: number): number {
  if (back == null) return 0;
  const denom = Math.max(0.5, abs(scaleRef ?? back)); // scale by typical level
  return clamp((back - latest) / denom);
}

// Momentum MoM: deceleration positive
function momentumMoM(latest?: number | null, back?: number | null): number {
  if (latest == null || back == null) return 0;
  const denom = Math.max(0.05, abs(back));
  return clamp((back - latest) / denom);
}

// Regime on YoY: below trailing mean (z < 0) → positive.
function regimeComponent(latestYoY: number, histYoY: number[], zWin: number): number {
  const tail = histYoY.slice(Math.max(0, histYoY.length - zWin));
  const z = zScore(latestYoY, tail);
  return clamp(-z / 2);
}

// Breadth: share of negative YoY contributions minus positive (more negatives → disinflation → positive).
function breadthFromContribs(p?: InflPoint): number {
  if (!p || !p.contributions) return 0;
  const vals = Object.values(p.contributions);
  if (vals.length === 0) return 0;
  let pos = 0, neg = 0;
  for (const v of vals) {
    if (v > 0) pos++;
    else if (v < 0) neg++;
  }
  const total = pos + neg;
  if (total === 0) return 0;
  return clamp((neg - pos) / total); // more negatives → positive
}

// Core spread: headline - core; if headline < core (negative), disinflation broader → positive.
function coreSpreadComponent(hYoY: number, cYoY?: number | null, histSpread?: (number | null | undefined)[]): number {
  if (cYoY == null) return 0;
  const spread = hYoY - cYoY;
  const clean = (histSpread ?? []).filter((x): x is number => typeof x === "number");
  const s = clean.length >= 8 ? std(clean) : 0.5; // fallback scale
  const denom = Math.max(0.3, s * 2);
  return clamp((-spread) / denom); // negative spread → positive
}

// ------------------------------ main -----------------------------------

export function computeInflationSurpriseAlpha(
  series: InflPoint[],
  surprise: Surprise = {},
  opts: Options = {}
): InflAlpha {
  const warnings: string[] = [];
  if (!series || series.length === 0) {
    return {
      score: 0,
      components: {
        level: 0, surprise: 0, momentumYoY_S: 0, momentumYoY_L: 0,
        momentumMoM: 0, regime: 0, breadth: 0, coreSpread: 0
      },
      meta: {
        latestHeadlineYoY: NaN,
        latestCoreYoY: null,
        latestHeadlineMoM: null,
        latestCoreMoM: null,
        zWindow: 0,
        targetUsed: opts.targetYoY ?? 2.0,
        nPoints: 0,
        warnings: ["Empty series"]
      }
    };
  }

  const target = opts.targetYoY ?? 2.0;
  const lookS = Math.max(1, opts.lookbackShort ?? 3);
  const lookL = Math.max(lookS + 1, opts.lookbackLong ?? 12);
  const zWin  = Math.max(8, opts.zWindow ?? 24);

  // Build histories
  const histH = series.map(p => p.headlineYoY);
  const histC = series.map(p => (p.coreYoY == null ? null : p.coreYoY));
  const histSpread = series.map(p => (p.coreYoY == null ? null : (p.headlineYoY - (p.coreYoY ?? 0))));
  const histHM = series.map(p => p.headlineMoM ?? null);
  const histCM = series.map(p => p.coreMoM ?? null);

  const latest = series[series.length - 1];
  const hYoY = latest.headlineYoY;
  const cYoY = latest.coreYoY ?? null;
  const hMoM = latest.headlineMoM ?? null;
  const cMoM = latest.coreMoM ?? null;

  const prevS_YoY = get(histH, lookS);
  const prevL_YoY = get(histH, lookL);
  const prevS_MoM = get(histHM.filter((x): x is number => typeof x === "number"), 1); // nearest prior available MoM
  const prevS_MoM_core = get(histCM.filter((x): x is number => typeof x === "number"), 1);

  if (histH.length < lookL + 1) warnings.push(`Short history: have ${histH.length}, suggested ≥ ${lookL + 1}.`);

  // Components
  const compLevel   = levelComponent(hYoY, target, histH);
  const compSurp    = surpriseComponent(
    { hYoY, cYoY, hMoM, cMoM },
    surprise
  );
  const scaleYoY    = Math.max(1, abs(mean(histH)));
  const compMomYS   = momentumYoY(hYoY, prevS_YoY ?? null, scaleYoY);
  const compMomYL   = momentumYoY(hYoY, prevL_YoY ?? null, scaleYoY);

  // MoM momentum combines headline & core if both exist; otherwise whichever exists
  const moParts: number[] = [];
  const mH = momentumMoM(hMoM ?? null, prevS_MoM ?? null);
  const mC = momentumMoM(cMoM ?? null, prevS_MoM_core ?? null);
  if (mH !== 0) moParts.push(mH);
  if (mC !== 0) moParts.push(mC);
  const compMomM = moParts.length ? clamp(mean(moParts)) : 0;

  const compReg   = regimeComponent(hYoY, histH, zWin);
  const compBr    = breadthFromContribs(latest);
  const compCoreS = coreSpreadComponent(hYoY, cYoY, histSpread);

  // Weights
  const W: Weights = {
    level: 0.22,
    surprise: 0.30,
    momentumYoY_S: 0.15,
    momentumYoY_L: 0.10,
    momentumMoM: 0.10,
    regime: 0.08,
    breadth: 0.03,
    coreSpread: 0.02
  };
  if (opts.weightOverrides) {
    const o = opts.weightOverrides;
    (W.level         = o.level         ?? W.level);
    (W.surprise      = o.surprise      ?? W.surprise);
    (W.momentumYoY_S = o.momentumYoY_S ?? W.momentumYoY_S);
    (W.momentumYoY_L = o.momentumYoY_L ?? W.momentumYoY_L);
    (W.momentumMoM   = o.momentumMoM   ?? W.momentumMoM);
    (W.regime        = o.regime        ?? W.regime);
    (W.breadth       = o.breadth       ?? W.breadth);
    (W.coreSpread    = o.coreSpread    ?? W.coreSpread);
  }

  let raw =
      W.level         * compLevel +
      W.surprise      * compSurp +
      W.momentumYoY_S * compMomYS +
      W.momentumYoY_L * compMomYL +
      W.momentumMoM   * compMomM +
      W.regime        * compReg +
      W.breadth       * compBr +
      W.coreSpread    * compCoreS;

  // Confidence penalty if very few components available
  const present =
    1 + // level always present (uses target & headline YoY)
    (surprise.headlineConsensusYoY != null ? 1 : 0) +
    (prevS_YoY != null ? 1 : 0) +
    (prevL_YoY != null ? 1 : 0) +
    ((hMoM != null || cMoM != null) ? 1 : 0);

  if (present <= 2) raw *= 0.7;
  else if (present === 3) raw *= 0.85;

  const score = clamp(raw);

  return {
    score,
    components: {
      level: compLevel,
      surprise: compSurp,
      momentumYoY_S: compMomYS,
      momentumYoY_L: compMomYL,
      momentumMoM: compMomM,
      regime: compReg,
      breadth: compBr,
      coreSpread: compCoreS
    },
    meta: {
      latestHeadlineYoY: hYoY,
      latestCoreYoY: cYoY,
      latestHeadlineMoM: hMoM,
      latestCoreMoM: cMoM,
      prevS_YoY: prevS_YoY ?? null,
      prevL_YoY: prevL_YoY ?? null,
      zWindow: zWin,
      targetUsed: target,
      nPoints: series.length,
      warnings
    }
  };
}

// -------------------- cross-sectional helper ---------------------------

export function rankToUnit(scores: number[]): number[] {
  const n = scores.length;
  if (n === 0) return [];
  const idx = scores.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out: number[] = new Array(n);
  for (let r = 0; r < n; r++) {
    const pos = n === 1 ? 0.5 : r / (n - 1);
    out[idx[r].i] = pos * 2 - 1;
  }
  return out;
}

// ------------------------------ example --------------------------------
// const series: InflPoint[] = [
//   { date: "2024-01-31", headlineYoY: 3.1, coreYoY: 3.4, headlineMoM: 0.2, coreMoM: 0.3, contributions: { Food: 0.1, Energy: -0.2, Shelter: 0.3 } },
//   { date: "2024-02-29", headlineYoY: 3.0, coreYoY: 3.3, headlineMoM: 0.2, coreMoM: 0.3, contributions: { Food: 0.1, Energy: -0.1, Shelter: 0.2 } },
//   { date: "2024-03-31", headlineYoY: 2.8, coreYoY: 3.2, headlineMoM: 0.1, coreMoM: 0.2, contributions: { Food: 0.0, Energy: -0.2, Shelter: 0.1 } }
// ];
// const surprise: Surprise = { headlineConsensusYoY: 2.9, coreConsensusYoY: 3.2, headlineConsensusMoM: 0.2 };
// const out = computeInflationSurpriseAlpha(series, surprise, { targetYoY: 2.0 });
// console.log(out);
