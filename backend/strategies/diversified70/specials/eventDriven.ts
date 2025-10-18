// specials/eventdriven.ts
// Pure TypeScript utilities for event-driven and special-situations workflows.
// One file, no imports. Numeric-stable enough for daily bars backtesting.
//
// What you get:
// - Event primitives (types/enums)
// - Simple OLS (market model) + abnormal returns & CAR
// - Generic event study engine (estimation window, event window)
// - Merger-arb helpers (spreads, annualized IRR-ish, Kelly sizing)
// - Earnings/buyback/dividend/split utilities
// - Gap/opening print analytics (gap-fade/drift heuristics)
//
// Notes:
// - Arrays are assumed oldest→newest. Returns are decimal (0.01 = +1%).
// - Time handling is string-agnostic; pass dates as ISO strings or numbers consistently.

export type Num = number;
export type Ticker = string;

export enum EventType {
  EARNINGS = "EARNINGS",
  DIVIDEND = "DIVIDEND",
  BUYBACK = "BUYBACK",
  SPLIT = "SPLIT",
  SPINOFF = "SPINOFF",
  MNA_ANNOUNCE = "MNA_ANNOUNCE",
  MNA_CLOSE = "MNA_CLOSE",
  GUIDANCE = "GUIDANCE",
  MANAGEMENT_CHANGE = "MANAGEMENT_CHANGE",
}

export type EventBase = {
  ticker: Ticker;
  type: EventType;
  // index of event in the provided time series (bars). If using dates, you map externally.
  index?: number;
  timestamp?: string | number | Date;
  meta?: { [k: string]: any };
};

// ---- Specific payloads (optional fields used by helpers) ----

export type EarningsEvent = EventBase & {
  type: EventType.EARNINGS;
  // surprises in decimals (0.05 = +5% beat), any you have:
  epsSurprise?: Num;
  salesSurprise?: Num;
  guideDelta?: Num; // guide up/down vs. street
};

export type DividendEvent = EventBase & {
  type: EventType.DIVIDEND;
  exDate?: string | number | Date;
  amount?: Num;       // per share
  yieldPct?: Num;     // 0.03 = 3%
  frequency?: "Q" | "S" | "A" | "IRREG";
};

export type BuybackEvent = EventBase & {
  type: EventType.BUYBACK;
  authUsd?: Num;
  pctFloat?: Num;     // 0.05 = 5% authorization
  tender?: boolean;   // if true, possibly one-time tender
};

export type SplitEvent = EventBase & {
  type: EventType.SPLIT;
  ratio?: string;     // e.g., "4:1"
};

export type MnaEvent = EventBase & {
  type: EventType.MNA_ANNOUNCE | EventType.MNA_CLOSE;
  target?: Ticker;
  acquirer?: Ticker;
  consideration?: "CASH" | "STOCK" | "MIX";
  offerPrice?: Num;          // for CASH or cash leg
  exchangeRatio?: Num;       // for STOCK/MIX: target gets ratio * acquirer_shares
  expectedCloseDays?: number;
  breakPx?: Num;             // user-estimate fallback price if deal breaks
};

// ---- Basic numeric helpers ----

function isFiniteNumber(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function clip(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function mean(xs: number[]): number {
  let s = 0, n = 0;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i];
    if (!isFiniteNumber(v)) continue;
    s += v; n++;
  }
  return n > 0 ? s / n : NaN;
}

function variance(xs: number[], sample: boolean = true): number {
  let m = 0, s2 = 0, n = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (!isFiniteNumber(x)) continue;
    n++;
    const d = x - m;
    m += d / n;
    s2 += d * (x - m);
  }
  if (n < 1) return NaN;
  return sample ? (n > 1 ? s2 / (n - 1) : 0) : s2 / n;
}

function stdev(xs: number[], sample: boolean = true): number {
  const v = variance(xs, sample);
  return isFiniteNumber(v) ? Math.sqrt(Math.max(0, v)) : NaN;
}

// ---- OLS (market model y = alpha + beta * x) ----

export type OLS = { alpha: number; beta: number; rsq: number; n: number };

export function olsMarketModel(y: number[], x: number[]): OLS {
  const n = Math.min(y.length, x.length);
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, m = 0;
  for (let i = 0; i < n; i++) {
    const yi = y[i], xi = x[i];
    if (!isFiniteNumber(yi) || !isFiniteNumber(xi)) continue;
    sx += xi; sy += yi; sxx += xi * xi; syy += yi * yi; sxy += xi * yi; m++;
  }
  if (m < 2) return { alpha: 0, beta: 0, rsq: 0, n: m };
  const xm = sx / m, ym = sy / m;
  const cov = sxy / m - xm * ym;
  const varx = sxx / m - xm * xm;
  const vary = syy / m - ym * ym;
  const beta = varx > 0 ? cov / varx : 0;
  const alpha = ym - beta * xm;
  const rsq = vary > 0 ? clip((cov * cov) / (varx * vary), 0, 1) : 0;
  return { alpha, beta, rsq, n: m };
}

// ---- Abnormal return & CAR around an event ----

export type CARResult = {
  eventIndex: number;
  window: [number, number];     // inclusive offsets, e.g., [-1, +3]
  alpha: number;
  beta: number;
  rsq: number;
  AR: number[];                 // abnormal returns per day in event window
  CAR: number;                  // sum of ARs in window
  nEst: number;                 // estimation sample size
};

/**
 * Compute AR & CAR via market model:
 *  - secRet[] and mktRet[] are daily returns arrays, oldest→newest
 *  - eventIndex is the bar index of the event
 *  - estLookback is number of bars ending BEFORE the event (e.g., 120)
 *  - evtWin = [l, r] window offsets around event (inclusive)
 */
export function carAroundEvent(
  secRet: number[],
  mktRet: number[],
  eventIndex: number,
  estLookback: number = 120,
  evtWin: [number, number] = [-1, 3]
): CARResult {
  const estStart = Math.max(0, eventIndex - estLookback - 1);
  const estEnd = Math.max(0, eventIndex - 1);
  const y: number[] = [], x: number[] = [];
  for (let i = estStart; i <= estEnd && i < secRet.length && i < mktRet.length; i++) {
    const sr = secRet[i], mr = mktRet[i];
    if (isFiniteNumber(sr) && isFiniteNumber(mr)) { y.push(sr); x.push(mr); }
  }
  const ols = olsMarketModel(y, x);
  const [L, R] = evtWin;
  const AR: number[] = [];
  for (let d = L; d <= R; d++) {
    const idx = eventIndex + d;
    if (idx < 0 || idx >= secRet.length || idx >= mktRet.length) { AR.push(NaN); continue; }
    const exp = ols.alpha + ols.beta * mktRet[idx];
    AR.push(isFiniteNumber(secRet[idx]) ? secRet[idx] - exp : NaN);
  }
  let car = 0;
  for (let i = 0; i < AR.length; i++) car += isFiniteNumber(AR[i]) ? AR[i] : 0;
  return {
    eventIndex,
    window: [L, R],
    alpha: ols.alpha,
    beta: ols.beta,
    rsq: ols.rsq,
    AR,
    CAR: car,
    nEst: ols.n,
  };
}

// ---- Generic event study across many events ----

export type EventStudyResult = {
  avgAR: number[];      // average abnormal return per offset
  avgCAR: number[];     // cumulative average abnormal return (CAAR)
  countPerOffset: number[];
  window: [number, number];
  eventsUsed: number;
};

export function eventStudy(
  secRet: number[],
  mktRet: number[],
  eventIndices: number[],
  estLookback: number = 120,
  evtWin: [number, number] = [-1, 3]
): EventStudyResult {
  const [L, R] = evtWin;
  const span = R - L + 1;
  const sumAR: number[] = new Array(span).fill(0);
  const cnt: number[] = new Array(span).fill(0);
  let used = 0;
  for (let i = 0; i < eventIndices.length; i++) {
    const idx = eventIndices[i];
    const r = carAroundEvent(secRet, mktRet, idx, estLookback, evtWin);
    // If estimation insufficient, still include if we got ARs
    let ok = false;
    for (let j = 0; j < r.AR.length; j++) {
      const a = r.AR[j];
      if (isFiniteNumber(a)) { sumAR[j] += a; cnt[j]++; ok = true; }
    }
    if (ok) used++;
  }
  const avgAR: number[] = [];
  for (let k = 0; k < sumAR.length; k++) avgAR.push(cnt[k] > 0 ? sumAR[k] / cnt[k] : NaN);
  const avgCAR: number[] = [];
  let acc = 0;
  for (let k = 0; k < avgAR.length; k++) { acc += isFiniteNumber(avgAR[k]) ? avgAR[k] : 0; avgCAR.push(acc); }
  return { avgAR, avgCAR, countPerOffset: cnt, window: [L, R], eventsUsed: used };
}

// ---- Earnings heuristics ----

export type EarningsSignal = {
  score: number;           // -1..+1 (drift/continuation bias)
  magnitude: number;       // absolute surprise proxy
  rationale: string;
};

export function earningsDriftSignal(e: EarningsEvent): EarningsSignal {
  const s1 = isFiniteNumber(e.epsSurprise) ? e.epsSurprise! : 0;
  const s2 = isFiniteNumber(e.salesSurprise) ? e.salesSurprise! : 0;
  const g = isFiniteNumber(e.guideDelta) ? e.guideDelta! : 0;
  // Simple blend; cap extremes.
  const mag = Math.abs(0.6 * s1 + 0.3 * s2 + 0.5 * g);
  let raw = 0.6 * s1 + 0.3 * s2 + 0.8 * g;
  raw = clip(raw, -0.2, 0.2); // tame outsized numbers (20% surprise is massive)
  const score = raw / 0.2;    // map to -1..+1
  const rationale = `EPS ${fmtPct(s1)}, Sales ${fmtPct(s2)}, Guide ${fmtPct(g)}`;
  return { score, magnitude: mag, rationale };
}

function fmtPct(x: number): string {
  const v = x * 100;
  return `${Math.round(v * 10) / 10}%`;
}

// ---- Buyback heuristics ----

export type BuybackSignal = {
  score: number;        // 0..1 (0 weak, 1 strong)
  rationale: string;
};

export function buybackSignal(b: BuybackEvent): BuybackSignal {
  const p = isFiniteNumber(b.pctFloat) ? b.pctFloat! : 0;
  // Very basic: >10% = strong, 5–10% = medium, 1–5% = light
  const score = p >= 0.10 ? 1 : p >= 0.05 ? 0.65 : p >= 0.01 ? 0.35 : 0.1;
  const tenderBoost = b.tender ? 0.15 : 0;
  const s = clip(score + tenderBoost, 0, 1);
  return { score: s, rationale: `Authorization ~${fmtPct(p)} of float${b.tender ? " (tender)" : ""}` };
}

// ---- Dividend capture helper ----

export type DivCapturePlan = {
  buyOnCloseDMinus?: number;  // e.g., 1 → buy on close day before ex-date
  sellOnOpenDPlus?: number;   // e.g., 1 → sell on open the day after ex-date
  holdDays?: number;
};

export function planDividendCapture(_div: DividendEvent, plan?: Partial<DivCapturePlan>): DivCapturePlan {
  return {
    buyOnCloseDMinus: plan?.buyOnCloseDMinus ?? 1,
    sellOnOpenDPlus: plan?.sellOnOpenDPlus ?? 1,
    holdDays: plan?.holdDays ?? 2,
  };
}

// ---- Splits (cosmetic drift heuristic) ----

export function splitHeuristic(s: SplitEvent): { postSplitDriftBias: number; note: string } {
  // Many retail-favored names see a mild positive flow after forward splits.
  const isForward = s.ratio ? parseSplitRatio(s.ratio) > 1 : true;
  const bias = isForward ? 0.15 : -0.05; // tiny bias, unitless
  return { postSplitDriftBias: bias, note: `${s.ratio || "split"} inferred ${isForward ? "forward" : "reverse"}` };
}

function parseSplitRatio(ratio: string): number {
  const parts = ratio.split(":");
  if (parts.length !== 2) return 1;
  const a = parseFloat(parts[0]); const b = parseFloat(parts[1]);
  if (!isFiniteNumber(a) || !isFiniteNumber(b) || b === 0) return 1;
  return a / b;
}

// ---- M&A helpers ----

export type MergerSpread = {
  impliedTargetValue: number;
  spread: number;                 // (offer - market) / market
  simpleAnnualized: number;       // approx annualized return using expected days
};

export function mergerImpliedSpread(
  targetPx: number,
  acquirerPx: number,
  deal: MnaEvent
): MergerSpread {
  let implied = NaN;
  if (deal.consideration === "CASH") {
    implied = deal.offerPrice ?? NaN;
  } else if (deal.consideration === "STOCK" || deal.consideration === "MIX") {
    const r = deal.exchangeRatio ?? 0;
    const cash = deal.offerPrice ?? 0;
    implied = r * acquirerPx + cash;
  }
  const spread = isFiniteNumber(implied) && targetPx > 0 ? (implied - targetPx) / targetPx : NaN;
  const days = deal.expectedCloseDays ?? 180;
  const ann = isFiniteNumber(spread) ? Math.pow(1 + spread, 365 / Math.max(1, days)) - 1 : NaN;
  return { impliedTargetValue: implied, spread, simpleAnnualized: ann };
}

export function mergerKellySizing(
  pClose: number,        // probability the deal closes
  upReturn: number,      // +X if closes (decimal)
  downReturn: number     // -Y if breaks (decimal, negative)
): number {
  // Kelly fraction: f* = (p*b - q)/b for binary, where b = up / |down|
  const q = 1 - pClose;
  const b = upReturn / Math.abs(downReturn || -1);
  if (!isFiniteNumber(b) || b <= 0) return 0;
  const f = (pClose * b - q) / b;
  return clip(f, 0, 1); // long-only sizing cap
}

// ---- Opening gap / print analytics ----

export type GapSignal = {
  gapPct: number;          // (open - prevClose) / prevClose
  bias: "FADE" | "FOLLOW" | "NONE";
  score: number;           // 0..1 conviction
  note: string;
};

export function gapHeuristic(prevClose: number, open: number, intradayRet?: number): GapSignal {
  if (!isFiniteNumber(prevClose) || prevClose <= 0 || !isFiniteNumber(open)) {
    return { gapPct: NaN, bias: "NONE", score: 0, note: "Bad inputs" };
  }
  const gap = (open - prevClose) / prevClose;
  const g = Math.abs(gap);
  // Small gaps tend to mean-revert (fade); large newsy gaps can trend (follow).
  const k1 = g < 0.01 ? ("FADE") : g < 0.04 ? ("WEAK") : ("FOLLOW");
  let bias: "FADE" | "FOLLOW" | "NONE" = "NONE";
  let score = 0.3;
  if (k1 === "FADE") { bias = "FADE"; score = 0.55; }
  else if (k1 === "WEAK") { bias = "NONE"; score = 0.35; }
  else { bias = "FOLLOW"; score = 0.6; }

  // If early intraday direction agrees with gap sign, boost follow; else boost fade.
  if (isFiniteNumber(intradayRet)) {
    const sameSign = (intradayRet >= 0 && gap >= 0) || (intradayRet <= 0 && gap <= 0);
    if (sameSign && bias === "FOLLOW") score = clip(score + 0.2, 0, 1);
    if (!sameSign && bias === "FADE") score = clip(score + 0.15, 0, 1);
  }
  return { gapPct: gap, bias, score, note: `Gap ${fmtPct(gap)}; mode=${bias}` };
}

// ---- Convenience aggregates ----

export function scoreEarningsAndGap(e: EarningsEvent, prevClose: number, open: number): { drift: EarningsSignal; gap: GapSignal; combined: number } {
  const drift = earningsDriftSignal(e);
  const gap = gapHeuristic(prevClose, open);
  // Combine by sign agreement between gap and drift score
  const driftSign = Math.sign(drift.score);
  const gapSign = Math.sign(gap.gapPct);
  const aligned = driftSign === gapSign ? 1 : -1;
  const combined = clip(Math.abs(drift.score) * 0.6 + gap.score * 0.4, 0, 1) * aligned;
  return { drift, gap, combined };
}

// ---- Utilities for building inputs from prices ----

/**
 * Compute simple returns from prices: r_t = P_t / P_{t-1} - 1
 */
export function simpleReturns(prices: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1], p1 = prices[i];
    out.push(isFiniteNumber(p0) && isFiniteNumber(p1) && p0 > 0 ? p1 / p0 - 1 : NaN);
  }
  return out;
}

/**
 * Detect gaps given daily OHLC: returns array of (open - prevClose)/prevClose.
 */
export function gapSeries(prevCloses: number[], opens: number[]): number[] {
  const n = Math.min(prevCloses.length, opens.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const pc = prevCloses[i], o = opens[i];
    out.push(isFiniteNumber(pc) && pc > 0 && isFiniteNumber(o) ? (o - pc) / pc : NaN);
  }
  return out;
}

// ---- Grouping helper (sector-neutral alpha for events) ----

export type GroupMap = { [t: string]: string };

export function groupNeutralize(snapshot: { [t: string]: number }, groups: GroupMap): { [t: string]: number } {
  const buckets: { [g: string]: { v: number[]; names: string[] } } = {};
  for (const t in snapshot) {
    const g = groups[t] || "OTHER";
    const b = buckets[g] || { v: [], names: [] };
    b.v.push(snapshot[t]); b.names.push(t);
    buckets[g] = b;
  }
  const out: { [t: string]: number } = {};
  for (const g in buckets) {
    const m = mean(buckets[g].v);
    const names = buckets[g].names;
    for (let i = 0; i < names.length; i++) out[names[i]] = snapshot[names[i]] - m;
  }
  return out;
}

// ---- Tiny risk helpers ----

export function volScaledSize(targetVol: number, assetVol: number, cap?: number): number {
  if (!isFiniteNumber(targetVol) || !isFiniteNumber(assetVol) || assetVol <= 0) return 0;
  const w = targetVol / assetVol;
  return clip(w, 0, cap ?? 1);
}

export function stopFromCAR(car: number, beta?: number): number {
  // crude: tighter stops if negative CAR and high beta
  const b = isFiniteNumber(beta) ? Math.abs(beta!) : 1;
  return car < 0 ? -Math.min(0.03 * b, 0.08) : -0.04; // -3% to -8% if bad; else -4%
}

// ---- Module export convenience types ----

export type AnyEvent =
  | EarningsEvent
  | DividendEvent
  | BuybackEvent
  | SplitEvent
  | MnaEvent
  | EventBase;

// Example recipe (pseudo):
// 1) const secR = simpleReturns(secPrices); const mktR = simpleReturns(mktPrices);
// 2) const car = carAroundEvent(secR, mktR, eventIndex, 120, [-1, 3]);
// 3) const earnSig = earningsDriftSignal(earnEvent);
// 4) const gapSig = gapHeuristic(prevClose, open, intradayRet);
// 5) Size via volScaledSize(0.02, stdev(secR.slice(-20))).
