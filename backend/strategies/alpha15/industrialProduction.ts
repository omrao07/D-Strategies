// alpha15/industrialproduction.ts
// Pure TypeScript (no imports).
// Industrial Production (IP) alpha: stronger production → risk-on (+); weaker → risk-off (−).

export type Basis = "YoY" | "MoM" | "SAAR"; // SAAR applies to MoM converted to annualized
export type Periodicity = "monthly" | "quarterly";

export type IpPoint = {
  date: string;          // YYYY-MM-DD period end
  value: number;         // growth rate (%), according to `basis`
  basis: Basis;          // YoY preferred for stability; MoM allowed
  annualized?: boolean;  // true if already SAAR when basis=MoM/SAAR
  // Optional breadth details: sector contributions in percentage points
  contributions?: Record<string, number>;
  // Optional inventory → sales ratio (level), same period
  invToSales?: number | null;
};

export type Options = {
  periodicity?: Periodicity;       // default "monthly"
  preferSAAR?: boolean;            // if MoM and not annualized, convert to SAAR; default true
  neutralYoY?: number | null;      // potential IP YoY (e.g., 2–4% depending on country); null disables level component
  neutralSAAR?: number | null;     // potential for SAAR basis if using MoM→SAAR; null disables level
  lookbackShort?: number;          // periods for short momentum (default 3 months / 2 quarters)
  lookbackLong?: number;           // periods for long momentum (default 12 months / 8 quarters)
  zWindow?: number;                // trailing window for regime z (default 24m / 12q)
  invSalesNeutral?: number | null; // neutral inventory/sales; lower than neutral → positive
  weightOverrides?: Partial<Weights>;
};

export type Surprise = {
  consensus?: number | null; // same basis as normalized series
};

export type Components = {
  level: number;       // vs neutral growth
  surprise: number;    // latest vs consensus
  momentumS: number;   // short acceleration
  momentumL: number;   // long acceleration
  regime: number;      // z-position
  breadth: number;     // sectoral diffusion
  inventory: number;   // inventory/sales signal (lower = positive)
};

export type Weights = {
  level: number;
  surprise: number;
  momentumS: number;
  momentumL: number;
  regime: number;
  breadth: number;
  inventory: number;
};

export type IpAlpha = {
  score: number;          // -1..+1
  components: Components;
  meta: {
    latest: number;
    basis: Basis;
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

function squash(x: number, scale = 3): number {
  const y = x / scale;
  const y3 = y * y * y;
  return clamp(y - y3 / 3);
}

// Convert MoM (%) → SAAR (%) if desired
function momToSAAR(momPct: number): number {
  const m = momPct / 100;
  const saar = (Math.pow(1 + m, 12) - 1) * 100;
  return saar;
}

// Normalize series to a coherent basis:
// Prefer YoY if present. Otherwise use MoM; annualize to SAAR if requested.
function normalizeSeries(points: IpPoint[], preferSAAR: boolean): { values: number[]; basis: Basis; annualized: boolean } {
  const anyYoY = points.some(p => p.basis === "YoY");
  if (anyYoY) {
    const vals = points.filter(p => p.basis === "YoY").map(p => p.value);
    return { values: vals, basis: "YoY", annualized: false };
  }
  // Use MoM/SAAR path
  const vals = points.map(p => {
    if (p.basis === "SAAR") return p.value;
    if (p.basis === "MoM") {
      if (preferSAAR && !p.annualized) return momToSAAR(p.value);
      return p.value;
    }
    return p.value;
  });
  const ann = preferSAAR || points.every(p => p.annualized === true || p.basis === "SAAR");
  return { values: vals, basis: ann ? "SAAR" : "MoM", annualized: ann };
}

// Breadth: share of positive contributions minus negative, clipped to [-1,1]
function breadthFromContribs(p?: IpPoint): number {
  if (!p || !p.contributions) return 0;
  const vals = Object.values(p.contributions);
  let pos = 0, neg = 0;
  for (const v of vals) {
    if (v > 0) pos++;
    else if (v < 0) neg++;
  }
  const total = pos + neg;
  if (total === 0) return 0;
  return clamp((pos - neg) / total);
}

// ------------------------------- components ---------------------------

function levelComponent(latest: number, neutral: number | null, hist: number[]): number {
  if (neutral == null) return 0;
  const s = std(hist);
  const denom = s > 0 ? 2 * s : 4; // fallback 4pp band
  return clamp((latest - neutral) / denom);
}

function surpriseComponent(latest: number, consensus?: number | null): number {
  if (consensus == null) return 0;
  const denom = Math.max(1, abs(consensus));
  return clamp((latest - consensus) / denom);
}

function momentumComponent(latest: number, back?: number | null, scaleRef?: number): number {
  if (back == null) return 0;
  const denom = Math.max(1, abs(scaleRef ?? back));
  return clamp((latest - back) / denom);
}

function regimeComponent(latest: number, hist: number[], zWin: number): number {
  const tail = hist.slice(Math.max(0, hist.length - zWin));
  const z = zScore(latest, tail);
  return squash(z / 2);
}

function inventoryComponent(invToSales?: number | null, neutral?: number | null, hist?: (number | null | undefined)[]): number {
  if (invToSales == null) return 0;
  if (neutral != null) {
    const dev = (invToSales - neutral) / Math.max(0.1, neutral);
    return clamp(-dev); // lower than neutral → positive
  }
  const clean = (hist ?? []).filter((x): x is number => typeof x === "number");
  if (clean.length < 2) return 0;
  const z = zScore(invToSales, clean);
  return clamp(-z / 2); // below average inventories → positive
}

// ------------------------------ main API ------------------------------

export function computeIndustrialProductionAlpha(
  series: IpPoint[],
  surprise: Surprise = {},
  opts: Options = {}
): IpAlpha {
  const warnings: string[] = [];
  if (!series || series.length === 0) {
    return {
      score: 0,
      components: { level: 0, surprise: 0, momentumS: 0, momentumL: 0, regime: 0, breadth: 0, inventory: 0 },
      meta: { latest: NaN, basis: "YoY", annualized: false, zWindow: 0, nPoints: 0, warnings: ["Empty series"] }
    };
  }

  const periodicity: Periodicity = opts.periodicity ?? "monthly";
  const preferSAAR = opts.preferSAAR ?? true;
  const lookS = Math.max(1, opts.lookbackShort ?? (periodicity === "monthly" ? 3 : 2));
  const lookL = Math.max(lookS + 1, opts.lookbackLong ?? (periodicity === "monthly" ? 12 : 8));
  const zWin = Math.max(8, opts.zWindow ?? (periodicity === "monthly" ? 24 : 12));

  // Normalize main growth series
  const norm = normalizeSeries(series, preferSAAR);
  const hist = norm.values;
  const latest = hist[hist.length - 1];

  if (hist.length < lookL + 1) {
    warnings.push(`Short history: have ${hist.length}, suggested ≥ ${lookL + 1}.`);
  }

  // Choose neutral
  let neutral: number | null = null;
  if (norm.basis === "YoY") neutral = opts.neutralYoY ?? null;
  else if (norm.basis === "SAAR") neutral = opts.neutralSAAR ?? null;
  else neutral = null; // MoM non-annualized: disable level unless user provides a specific neutral

  // Components
  const prevS = get(hist, lookS);
  const prevL = get(hist, lookL);
  const scaleRef = Math.max(1, abs(mean(hist)));

  const compLevel    = levelComponent(latest, neutral, hist);
  const compSurprise = surpriseComponent(latest, surprise.consensus ?? null);
  const compMomS     = momentumComponent(latest, prevS ?? null, scaleRef);
  const compMomL     = momentumComponent(latest, prevL ?? null, scaleRef);
  const compRegime   = regimeComponent(latest, hist, zWin);
  const compBreadth  = breadthFromContribs(series[series.length - 1]);

  // Inventory signal (use last available inv/sales)
  const invHist = series.map(p => p.invToSales ?? null);
  const lastInv = series[series.length - 1].invToSales ?? null;
  const compInv = inventoryComponent(lastInv, opts.invSalesNeutral ?? null, invHist);

  // Weights
  const W: Weights = {
    level: 0.20,
    surprise: 0.20,
    momentumS: 0.20,
    momentumL: 0.15,
    regime: 0.10,
    breadth: 0.10,
    inventory: 0.05
  };
  if (opts.weightOverrides) {
    const o = opts.weightOverrides;
    (W.level     = o.level     ?? W.level);
    (W.surprise  = o.surprise  ?? W.surprise);
    (W.momentumS = o.momentumS ?? W.momentumS);
    (W.momentumL = o.momentumL ?? W.momentumL);
    (W.regime    = o.regime    ?? W.regime);
    (W.breadth   = o.breadth   ?? W.breadth);
    (W.inventory = o.inventory ?? W.inventory);
  }

  let raw =
      W.level     * compLevel +
      W.surprise  * compSurprise +
      W.momentumS * compMomS +
      W.momentumL * compMomL +
      W.regime    * compRegime +
      W.breadth   * compBreadth +
      W.inventory * compInv;

  // Confidence penalties
  const present =
    (neutral != null ? 1 : 0) +
    (surprise.consensus != null ? 1 : 0) +
    (prevS != null ? 1 : 0) +
    (prevL != null ? 1 : 0);

  if (present <= 1) raw *= 0.75;
  else if (present === 2) raw *= 0.9;

  const score = clamp(raw);

  return {
    score,
    components: {
      level: compLevel,
      surprise: compSurprise,
      momentumS: compMomS,
      momentumL: compMomL,
      regime: compRegime,
      breadth: compBreadth,
      inventory: compInv
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

// ------------------------------- example -------------------------------
// const series: IpPoint[] = [
//   { date: "2024-01-31", value: 1.8, basis: "YoY", contributions: { Manufacturing: 0.9, Mining: 0.4, Utilities: 0.5 }, invToSales: 1.35 },
//   { date: "2024-02-29", value: 2.1, basis: "YoY", contributions: { Manufacturing: 1.2, Mining: 0.3, Utilities: 0.6 }, invToSales: 1.33 },
//   { date: "2024-03-31", value: 2.4, basis: "YoY", contributions: { Manufacturing: 1.5, Mining: 0.4, Utilities: 0.5 }, invToSales: 1.31 }
// ];
// const alpha = computeIndustrialProductionAlpha(series, { consensus: 2.2 }, { neutralYoY: 2.0, invSalesNeutral: 1.4 });
// console.log(alpha);
