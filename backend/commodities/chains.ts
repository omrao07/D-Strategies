// commodities/chains.ts
// Self-contained utilities to build simple option chains for futures using Black (1976).
// No imports. Strict-TS friendly.
//
// What you get:
// - Build strikes around-the-money
// - Price calls/puts (Black76), greeks, and (optionally) implied vols from mid prices
// - Create single-maturity or multi-maturity chains
// - Tiny CSV exporter
//
// Usage:
//   const chain = makeChain({
//     F: 82.35, r: 0.02, T: 0.25,
//     strikes: strikesATM(82.35, 1, 11), // step=1, 11 strikes centered on F
//     sigma: 0.28,
//     spreadBps: 30, // optional synthetic bid/ask spread in bps of premium
//   });
//
//   const term = makeTermStructure({
//     F: 82.35, r: 0.02,
//     maturities: [0.1, 0.2, 0.35],
//     strikes: strikesATM(82.35, 1, 9),
//     sigma: 0.28,
//   });

/* eslint-disable @typescript-eslint/no-explicit-any */

export type CP = "call" | "put";

export interface ChainInput {
  F: number;            // forward/futures
  r: number;            // cont. risk-free
  T: number;            // time to expiry (years)
  strikes: number[];    // strikes to price
  sigma?: number;       // if provided, price → premium
  // If you pass mid prices instead of sigma, fill `mids[ K ][cp ]`
  mids?: Record<number, Partial<Record<CP, number>>>;
  // Synthetic spread model for creating bid/ask from mid (bps of premium), default 0
  spreadBps?: number;
}

export interface TermInput extends Omit<ChainInput, "T"> {
  maturities: number[];        // list of T values
}

export interface Quote {
  cp: CP;
  K: number;
  T: number;
  mid: number;
  bid?: number;
  ask?: number;
  iv?: number;                 // implied vol (if mids provided)
  sigma?: number;              // model vol (if sigma provided)
  deltaF?: number;
  gammaF?: number;
  vega?: number;
  theta?: number;
  rho?: number;
  d1?: number;
  d2?: number;
  df?: number;                 // discount factor e^{-rT}
  itm?: boolean;
}

export interface Chain {
  F: number;
  r: number;
  T: number;
  rows: Quote[];               // calls+puts for all strikes
}

export interface TermStructure {
  F: number;
  r: number;
  rows: Quote[];               // union of all maturities
}

// ------------------------------ Strike helpers ------------------------------

/** Build a centered ATM strike grid: `count` odd, centered on F, step size `step`. */
export function strikesATM(F: number, step: number, count: number): number[] {
  const n = Math.max(1, Math.floor(count));
  const s = Math.max(1e-8, step);
  const out: number[] = [];
  const mid = Math.floor(n / 2);
  for (let i = 0; i < n; i++) out.push(round2(F + (i - mid) * s));
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

/** Build strikes from min..max with uniform `step`. */
export function strikesRange(minK: number, maxK: number, step: number): number[] {
  const lo = Math.min(minK, maxK), hi = Math.max(minK, maxK);
  const s = Math.max(1e-8, step);
  const out: number[] = [];
  for (let k = Math.ceil(lo / s) * s; k <= hi + 1e-12; k += s) out.push(round2(k));
  return out;
}

// ------------------------------ Chain builders ------------------------------

export function makeChain(input: ChainInput): Chain {
  const F = num(input.F), r = num(input.r), T = Math.max(0, num(input.T));
  const strikes = (input.strikes || []).map(num).filter(isFiniteNum).sort((a,b)=>a-b);
  const sigma = input.sigma != null ? Math.max(0, Number(input.sigma)) : undefined;
  const mids = input.mids || {};
  const spreadBps = Math.max(0, Math.floor(input.spreadBps ?? 0));

  const rows: Quote[] = [];

  for (const Kraw of strikes) {
    const K = Number(Kraw);
    for (const cp of (["call","put"] as CP[])) {
      let mid: number;
      let iv: number | undefined;
      let usedSigma: number | undefined = sigma;

      if (sigma == null) {
        const guess = mids[K]?.[cp];
        if (!isFiniteNum(guess)) continue; // skip if no mid
        mid = Number(guess);
        // back out IV
        iv = clamp(black76ImpliedVol(mid, F, K, r, T, cp, 0.3), 0, 5);
        usedSigma = iv;
      } else {
        // price model mid
        mid = black76Price({ F, K, r, sigma, T, cp }).price;
      }

      // greeks
      const g = usedSigma! > 0 && T > 0
        ? black76Greeks({ F, K, r, sigma: usedSigma!, T, cp })
        : { deltaF: intrinsicDelta(cp, F, K, r), gammaF: 0, vega: 0, theta: 0, rho: -T * mid };

      const res = black76Price({ F, K, r, sigma: usedSigma ?? 0, T, cp });

      // synthetic bid/ask around mid
      let bid: number | undefined, ask: number | undefined;
      if (spreadBps > 0) {
        const half = Math.max(0.0001, (spreadBps / 10000) * Math.max(mid, 0.01)) / 2;
        bid = Math.max(0, round4(mid - half));
        ask = round4(mid + half);
      }

      rows.push({
        cp, K, T, mid: round4(mid),
        bid, ask,
        iv: iv != null ? round6(iv) : undefined,
        sigma: sigma != null ? round6(sigma) : undefined,
        deltaF: round6(g.deltaF), gammaF: round6(g.gammaF), vega: round6(g.vega),
        theta: round6(g.theta), rho: round6(g.rho),
        d1: res.d1, d2: res.d2, df: res.df,
        itm: cp === "call" ? F > K : F < K,
      });
    }
  }

  // Sort: K asc, puts first then calls at same K (or vice-versa if you prefer)
  rows.sort((a,b) => (a.K - b.K) || (a.cp === "put" ? -1 : 1));
  return { F, r, T, rows };
}

export function makeTermStructure(input: TermInput): TermStructure {
  const rows: Quote[] = [];
  for (const T of (input.maturities || [])) {
    const chain = makeChain({ ...input, T });
    rows.push(...chain.rows);
  }
  rows.sort((a,b) => (a.T - b.T) || (a.K - b.K) || (a.cp === "put" ? -1 : 1));
  return { F: num(input.F), r: num(input.r), rows };
}

// ------------------------------ Filters & views ------------------------------

export function filterByMoneyness(rows: Quote[], F: number, minM = 0.8, maxM = 1.2): Quote[] {
  const lo = Math.min(minM, maxM), hi = Math.max(minM, maxM);
  return rows.filter(q => {
    const m = q.K / F;
    return m >= lo && m <= hi;
  });
}

export function toCSV(chain: Chain | TermStructure): string {
  const rows = "rows" in chain ? chain.rows : [];
  const header = [
    "F","r","T","cp","K","mid","bid","ask","iv","sigma","deltaF","gammaF","vega","theta","rho","d1","d2","df","itm"
  ];
  const lines = [header.join(",")];
  for (const q of rows) {
    lines.push([
      "F" in chain ? round6((chain as any).F) : "",
      "r" in chain ? round6((chain as any).r) : "",
      round6(q.T), q.cp, round6(q.K), round6(q.mid),
      q.bid != null ? round6(q.bid) : "", q.ask != null ? round6(q.ask) : "",
      q.iv != null ? round6(q.iv) : "", q.sigma != null ? round6(q.sigma) : "",
      round6(q.deltaF ?? 0), round6(q.gammaF ?? 0), round6(q.vega ?? 0), round6(q.theta ?? 0), round6(q.rho ?? 0),
      round6(q.d1 ?? 0), round6(q.d2 ?? 0), round6(q.df ?? 0), q.itm ? "1" : "0",
    ].join(","));
  }
  return lines.join("\n");
}

// ------------------------------ Embedded Black76 ------------------------------
// (duplicated here on purpose to keep this file import-free)

type B76Params = { F: number; K: number; r: number; sigma: number; T: number; cp: CP; };
function ln(x: number): number { return Math.log(Math.max(x, 1e-300)); }
function exp(x: number): number { return Math.exp(Math.max(Math.min(x, 700), -700)); }
function sqrt(x: number): number { return Math.sqrt(Math.max(x, 0)); }
function nPdf(x: number): number { return 0.3989422804014327 * exp(-0.5 * x * x); }
function nCdf(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * z);
  const a1 = 0.319381530, a2 = -0.356563782, a3 = 1.781477937, a4 = -1.821255978, a5 = 1.330274429;
  const m = 1 - nPdf(z) * ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
  return x >= 0 ? m : 1 - m;
}
function isCall(cp: CP): boolean { return cp === "call"; }
function sgn(cp: CP): number { return cp === "call" ? +1 : -1; }

function d1(F: number, K: number, sigma: number, T: number): number {
  if (sigma <= 0 || T <= 0) return (F > K) ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return (ln(F / K) + 0.5 * sigma * sigma * T) / (sigma * sqrt(T));
}
function d2(F: number, K: number, sigma: number, T: number): number {
  if (sigma <= 0 || T <= 0) return (F > K) ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return d1(F, K, sigma, T) - sigma * sqrt(T);
}
function black76Price(p: B76Params): { price: number; d1: number; d2: number; df: number } {
  const { F, K, r, sigma, T, cp } = p;
  const Tpos = Math.max(T, 0);
  const df = exp(-r * Tpos);
  if (Tpos === 0 || sigma === 0) {
    const intrinsic = Math.max(sgn(cp) * (F - K), 0);
    return { price: df * intrinsic, d1: NaN, d2: NaN, df };
  }
  const _d1 = d1(F, K, sigma, Tpos);
  const _d2 = _d1 - sigma * sqrt(Tpos);
  const price = isCall(cp)
    ? df * (F * nCdf(_d1) - K * nCdf(_d2))
    : df * (K * nCdf(-_d2) - F * nCdf(-_d1));
  return { price, d1: _d1, d2: _d2, df };
}
function black76Greeks(p: B76Params) {
  const { F, K, r, sigma, T, cp } = p;
  const res = black76Price(p);
  const df = res.df;
  if (T <= 0 || sigma === 0) {
    const deltaIntrinsic = (isCall(cp) ? (F > K ? df : 0) : (F < K ? -df : 0));
    return { deltaF: deltaIntrinsic, gammaF: 0, vega: 0, theta: 0, rho: -T * res.price };
  }
  const _d1 = res.d1, _d2 = res.d2;
  const phi = nPdf(_d1);
  const srt = sigma * sqrt(T);
  const deltaF = isCall(cp) ? df * nCdf(_d1) : -df * nCdf(-_d1);
  const gammaF = df * phi / (F * srt);
  const vega = df * F * phi * sqrt(T);
  const rho = -T * res.price;
  const term = isCall(cp) ? (F * nCdf(_d1) - K * nCdf(_d2)) : (K * nCdf(-_d2) - F * nCdf(-_d1));
  const d1dT = -_d2 / (2 * T);
  const d2dT = d1dT - sigma / (2 * sqrt(T));
  const theta = (-r * df) * term + df * (F * phi * d1dT - K * nPdf(_d2) * d2dT);
  return { deltaF, gammaF, vega, theta, rho };
}
function black76ImpliedVol(targetPrice: number, F: number, K: number, r: number, T: number, cp: CP, guess = 0.3): number {
  const df = exp(-r * Math.max(T, 0));
  const intrinsic = df * Math.max(sgn(cp) * (F - K), 0);
  const upperBound = df * F;
  const P = clamp(targetPrice, intrinsic, upperBound);
  if (T <= 0) return 0;
  if (P <= intrinsic + 1e-12) return 0;
  let sigma = clamp(guess, 1e-6, 5.0);
  for (let i = 0; i < 20; i++) {
    const { price } = black76Price({ F, K, r, sigma, T, cp });
    const diff = price - P;
    if (Math.abs(diff) < 1e-10) return sigma;
    const v = black76Greeks({ F, K, r, sigma, T, cp }).vega;
    if (v <= 1e-12) break;
    let step = diff / v;
    step = clamp(step, -0.5, 0.5);
    sigma = clamp(sigma - step, 1e-8, 5.0);
  }
  let lo = 1e-8, hi = 5.0;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    const { price } = black76Price({ F, K, r, sigma: mid, T, cp });
    if (price > P) hi = mid; else lo = mid;
  }
  return 0.5 * (lo + hi);
}

// ------------------------------ Tiny helpers ------------------------------

function intrinsicDelta(cp: CP, F: number, K: number, r: number): number {
  const df = exp(-r * 0); // at T≈0, df≈1
  if (cp === "call") return F > K ? df : 0;
  return F < K ? -df : 0;
}

function num(x: any): number { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function isFiniteNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }
function round2(x: number): number { return Math.round(x * 100) / 100; }
function round4(x: number): number { return Math.round(x * 1e4) / 1e4; }
function round6(x: number): number { return Math.round(x * 1e6) / 1e6; }
function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }