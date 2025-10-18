// alpha15/joblessclaims.ts
// Pure TypeScript (no imports).
// Weekly jobless-claims alpha: better labor = risk-on (+), worse = risk-off (−).
// Uses initial claims (IC), continuing claims (CC), 4-wk average smoothing, surprise vs consensus,
// momentum (short/long), regime, and CC/IC ratio tightness.

// ------------------------------- Types ---------------------------------

export type ClaimPoint = {
  date: string;             // YYYY-MM-DD (week ending)
  initial: number;          // Initial jobless claims (persons)
  continuing?: number | null; // Continuing claims (optional)
};

export type Surprise = {
  initialConsensus?: number | null;    // persons
  continuingConsensus?: number | null; // persons
};

export type Options = {
  lookbackShort?: number;   // weeks for short momentum, default 4 (≈ 1 month)
  lookbackLong?: number;    // weeks for long momentum, default 13 (≈ quarter)
  zWindow?: number;         // trailing window for regime z, default 52 (1y)
  useFourWeekAvg?: boolean; // apply 4-wk avg to IC for core calc; default true
  weightOverrides?: Partial<Weights>;
};

export type Components = {
  surprise: number;     // -1..+1 (below consensus = positive)
  momentumS: number;    // -1..+1 (IC falling = positive)
  momentumL: number;    // -1..+1
  regime: number;       // -1..+1 (IC low vs history = positive)
  ratio: number;        // -1..+1 (CC/IC tightness; lower ratio = positive)
  breadth: number;      // -1..+1 (agreement between IC and CC signals)
};

export type Weights = {
  surprise: number;
  momentumS: number;
  momentumL: number;
  regime: number;
  ratio: number;
  breadth: number;
};

export type ClaimsAlpha = {
  score: number;          // composite -1..+1
  components: Components;
  meta: {
    latestIC: number;
    latestIC_4w?: number;
    latestCC?: number | null;
    prevS_IC?: number | null;
    prevL_IC?: number | null;
    ccIcRatio?: number | null;
    zWindow: number;
    nPoints: number;
    warnings: string[];
  };
};

// ------------------------------- Utils ---------------------------------

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
  for (let i = 0; i < xs.length; i++) { const d = xs[i] - m; v += d * d; }
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
function movingAvg(vals: number[], w: number): number[] {
  if (w <= 1 || vals.length === 0) return vals.slice();
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < vals.length; i++) {
    acc += vals[i];
    if (i >= w) acc -= vals[i - w];
    if (i >= w - 1) out.push(acc / w);
    else out.push(vals[i]); // warm-up: just copy raw
  }
  return out;
}

// Percent change with safe denom (people counts)
function pctChange(curr: number, past: number): number {
  const denom = Math.max(1, abs(past));
  return (curr - past) / denom;
}

// ----------------------------- Components ------------------------------

function surpriseComponent(
  latestIC: number, latestCC: number | null,
  s: Surprise
): number {
  const parts: number[] = [];
  if (s.initialConsensus != null) {
    const denom = Math.max(1_000, abs(s.initialConsensus));
    parts.push(clamp((s.initialConsensus - latestIC) / denom)); // below consensus → positive
  }
  if (s.continuingConsensus != null && latestCC != null) {
    const denom = Math.max(5_000, abs(s.continuingConsensus));
    parts.push(clamp((s.continuingConsensus - latestCC) / denom));
  }
  return parts.length ? clamp(mean(parts) * 8) : 0; // rescale to typical -1..+1 range
}

function momentumComponent(latest: number, back?: number | null): number {
  if (back == null) return 0;
  const ch = pctChange(latest, back);
  return clamp(-ch); // falling claims (negative ch) → positive score
}

function regimeComponent(latest: number, hist: number[], zWin: number): number {
  const tail = hist.slice(Math.max(0, hist.length - zWin));
  const z = zScore(latest, tail);
  return clamp(-z / 2); // lower than avg (z<0) → positive
}

function ratioComponent(cc?: number | null, ic?: number | null, histRatio?: (number | null | undefined)[]): number {
  if (cc == null || ic == null || ic === 0) return 0;
  const r = cc / ic;
  const clean = (histRatio ?? []).filter((x): x is number => typeof x === "number");
  const s = clean.length >= 26 ? std(clean) : 0.2;
  const denom = Math.max(0.1, s * 2);
  return clamp((mean(clean.length ? clean : [r]) - r) / denom); // lower ratio than usual → positive
}

// Agreement between IC and CC direction (breadth): both improving → positive; both worsening → negative
function breadthComponent(momIC: number, momCC: number): number {
  if (momIC === 0 && momCC === 0) return 0;
  // map both to signs and average
  const sIC = momIC > 0 ? 1 : momIC < 0 ? -1 : 0;
  const sCC = momCC > 0 ? 1 : momCC < 0 ? -1 : 0;
  return clamp((sIC + sCC) / 2);
}

// ------------------------------ Main API -------------------------------

export function computeJoblessClaimsAlpha(
  series: ClaimPoint[],
  surprise: Surprise = {},
  opts: Options = {}
): ClaimsAlpha {
  const warnings: string[] = [];
  if (!series || series.length === 0) {
    return {
      score: 0,
      components: { surprise: 0, momentumS: 0, momentumL: 0, regime: 0, ratio: 0, breadth: 0 },
      meta: { latestIC: NaN, zWindow: 0, nPoints: 0, warnings: ["Empty series"] }
    };
  }

  const lookS = Math.max(1, opts.lookbackShort ?? 4);
  const lookL = Math.max(lookS + 1, opts.lookbackLong ?? 13);
  const zWin  = Math.max(13, opts.zWindow ?? 52);
  const use4w = opts.useFourWeekAvg ?? true;

  // Histories (ascending)
  const icHistRaw = series.map(p => p.initial);
  const icHist = use4w ? movingAvg(icHistRaw, 4) : icHistRaw.slice();
  const ccHist = series.map(p => (p.continuing == null ? null : p.continuing));
  const ratioHist = series.map(p => (p.continuing != null && p.initial ? p.continuing / p.initial : null));

  const latestIC = icHist[icHist.length - 1];
  const latestIC_4w = use4w ? latestIC : movingAvg(icHistRaw, 4)[icHistRaw.length - 1];
  const latestCC = ccHist[ccHist.length - 1] ?? null;

  const prevS_IC = get(icHist, lookS);
  const prevL_IC = get(icHist, lookL);

  if (icHist.length < lookL + 1) {
    warnings.push(`Short history: have ${icHist.length}, suggested ≥ ${lookL + 1}.`);
  }

  // Components
  const compSurp = surpriseComponent(latestIC, latestCC, surprise);
  const compMomS = momentumComponent(latestIC, prevS_IC ?? null);
  const compMomL = momentumComponent(latestIC, prevL_IC ?? null);
  const compReg  = regimeComponent(latestIC, icHist, zWin);
  const compRatio= ratioComponent(latestCC ?? null, icHistRaw[icHistRaw.length - 1] ?? null, ratioHist);
  // CC momentum for breadth (use raw CC series)
  const prevS_CC = get(ccHist.filter((x): x is number => typeof x === "number"), lookS);
  const compMomCC_S = momentumComponent(latestCC ?? NaN, prevS_CC ?? null);
  const compBreadth = breadthComponent(compMomS, compMomCC_S);

  // Weights
  const W: Weights = {
    surprise: 0.30,
    momentumS: 0.25,
    momentumL: 0.15,
    regime:   0.15,
    ratio:    0.10,
    breadth:  0.05
  };
  if (opts.weightOverrides) {
    const o = opts.weightOverrides;
    (W.surprise = o.surprise ?? W.surprise);
    (W.momentumS= o.momentumS?? W.momentumS);
    (W.momentumL= o.momentumL?? W.momentumL);
    (W.regime   = o.regime   ?? W.regime);
    (W.ratio    = o.ratio    ?? W.ratio);
    (W.breadth  = o.breadth  ?? W.breadth);
  }

  let raw =
      W.surprise * compSurp +
      W.momentumS* compMomS +
      W.momentumL* compMomL +
      W.regime   * compReg  +
      W.ratio    * compRatio+
      W.breadth  * compBreadth;

  // Confidence penalty if only one component available
  const present =
    (surprise.initialConsensus != null || surprise.continuingConsensus != null ? 1 : 0) +
    (prevS_IC != null ? 1 : 0) +
    (prevL_IC != null ? 1 : 0) +
    1; // regime always present

  if (present <= 2) raw *= 0.75;
  else if (present === 3) raw *= 0.9;

  const score = clamp(raw);

  return {
    score,
    components: {
      surprise: compSurp,
      momentumS: compMomS,
      momentumL: compMomL,
      regime: compReg,
      ratio: compRatio,
      breadth: compBreadth
    },
    meta: {
      latestIC,
      latestIC_4w,
      latestCC,
      prevS_IC: prevS_IC ?? null,
      prevL_IC: prevL_IC ?? null,
      ccIcRatio: (latestCC != null && icHistRaw[icHistRaw.length - 1] ? latestCC / icHistRaw[icHistRaw.length - 1] : null),
      zWindow: zWin,
      nPoints: series.length,
      warnings
    }
  };
}

// -------------------- Cross-sectional helper ---------------------------

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

// ------------------------------ Example --------------------------------
// const data: ClaimPoint[] = [
//   { date: "2024-06-01", initial: 230000, continuing: 1780000 },
//   { date: "2024-06-08", initial: 226000, continuing: 1765000 },
//   // ...
//   { date: "2024-08-31", initial: 210000, continuing: 1700000 }
// ];
// const s: Surprise = { initialConsensus: 220000 };
// const out = computeJoblessClaimsAlpha(data, s, { useFourWeekAvg: true });
// console.log(out);
