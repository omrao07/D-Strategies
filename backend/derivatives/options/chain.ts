// options/chain.ts
// Pure TS utilities (no imports) for working with option chains:
// - Types for options, quotes, greeks
// - Black–Scholes (european) pricing + greeks
// - Time-to-expiry (ACT/365)
// - Build/merge/clean a chain
// - Helpers: mid, spread, moneyness, intrinsic/extrinsic
// - Filters: by expiry, moneyness, delta, OTM/ATM
// - Simple IV surface sampling + smile slices

/** ===== Types ===== */

export type ISODate = string; // "YYYY-MM-DD"
export type OptionRight = "C" | "P";

export type OptionKey = {
  underlying: string;   // e.g., "ES"
  expiry: ISODate;      // ISO date (UTC) option expiry
  strike: number;       // strike
  right: OptionRight;   // "C" | "P"
};

export type OptionQuote = {
  bid?: number;
  ask?: number;
  last?: number;
  iv?: number;          // implied vol (decimal, e.g., 0.20)
  volume?: number;
  openInterest?: number;
  updated?: string;     // ISO datetime
};

export type OptionRow = OptionKey & OptionQuote & {
  mid?: number;         // (bid+ask)/2 if available
  spread?: number;      // ask-bid
  intrinsic?: number;
  extrinsic?: number;
  moneyness?: number;   // S/K for calls (or K/S for puts? we standardize to S/K)
  delta?: number;
  gamma?: number;
  vega?: number;
  theta?: number;
  rho?: number;
};

export type Chain = {
  underlying: string;
  asOf: ISODate;
  underlyingPrice: number;  // spot or futures ref
  riskFree?: number;        // r (ccy) annualized (e.g., 0.04)
  dividendYield?: number;   // q (annualized)
  rows: OptionRow[];        // unsorted or sorted; helpers can sort
};

/** ===== Time & math helpers ===== */

function toDate(iso: ISODate): Date {
  const [y, m, d] = iso.split("-").map(n => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d));
}
function toISO(d: Date): ISODate {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ACT/365F year fraction between anchor (inclusive) and expiry (exclusive). */
export function yearFracACT365(anchorISO: ISODate, expiryISO: ISODate): number {
  const a = toDate(anchorISO).getTime();
  const e = toDate(expiryISO).getTime();
  return (e - a) / 86_400_000 / 365;
}

function isNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }
function max(a: number, b: number): number { return a > b ? a : b; }
function min(a: number, b: number): number { return a < b ? a : b; }

/** ===== Black–Scholes (european) =====
 * Risk-neutral with continuous dividend yield q.
 * All vols are decimal (e.g., 0.20), T in years, r and q continuous.
 */

function normCdf(x: number): number {
  // Abramowitz-Stegun approximation for Φ(x)
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * z);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}
function normPdf(x: number): number {
  const invsqrt2pi = 1 / Math.sqrt(2 * Math.PI);
  return invsqrt2pi * Math.exp(-0.5 * x * x);
}

export type BSInputs = { S: number; K: number; T: number; r?: number; q?: number; vol: number; right: OptionRight };
export type BSOutput = { price: number; delta: number; gamma: number; vega: number; theta: number; rho: number };

export function blackScholes(inp: BSInputs): BSOutput {
  const S = inp.S, K = inp.K, T = max(1e-6, inp.T);
  const r = inp.r ?? 0, q = inp.q ?? 0, v = max(1e-6, inp.vol);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * v * v) * T) / (v * sqrtT);
  const d2 = d1 - v * sqrtT;

  if (inp.right === "C") {
    const price = S * Math.exp(-q * T) * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
    const delta = Math.exp(-q * T) * normCdf(d1);
    const gamma = Math.exp(-q * T) * normPdf(d1) / (S * v * sqrtT);
    const vega = S * Math.exp(-q * T) * normPdf(d1) * sqrtT; // per 1.0 vol
    const theta = - (S * normPdf(d1) * v * Math.exp(-q * T)) / (2 * sqrtT) - r * K * Math.exp(-r * T) * normCdf(d2) + q * S * Math.exp(-q * T) * normCdf(d1);
    const rho   = K * T * Math.exp(-r * T) * normCdf(d2);
    return { price, delta, gamma, vega, theta, rho };
  } else {
    const price = K * Math.exp(-r * T) * normCdf(-d2) - S * Math.exp(-q * T) * normCdf(-d1);
    const delta = -Math.exp(-q * T) * normCdf(-d1);
    const gamma = Math.exp(-q * T) * normPdf(d1) / (S * v * sqrtT);
    const vega  = S * Math.exp(-q * T) * normPdf(d1) * sqrtT;
    const theta = - (S * normPdf(d1) * v * Math.exp(-q * T)) / (2 * sqrtT) + r * K * Math.exp(-r * T) * normCdf(-d2) - q * S * Math.exp(-q * T) * normCdf(-d1);
    const rho   = -K * T * Math.exp(-r * T) * normCdf(-d2);
    return { price, delta, gamma, vega, theta, rho };
  }
}

/** Simple IV solve via Brent-like bisection on price. */
export function impliedVolFromPrice(
  right: OptionRight, S: number, K: number, T: number, r: number, q: number, price: number
): number | undefined {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(price >= 0)) return undefined;
  let lo = 1e-4, hi = 5.0; // 1 bps vol to 500%
  const target = price;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    const val = blackScholes({ S, K, T, r, q, vol: mid, right }).price;
    if (Math.abs(val - target) < 1e-8) return mid;
    if (val > target) hi = mid; else lo = mid;
  }
  return 0.5 * (lo + hi);
}

/** ===== Chain build/clean ===== */

export function makeKey(underlying: string, expiry: ISODate, strike: number, right: OptionRight): string {
  return `${underlying}_${expiry}_${right}_${String(strike)}`;
}

/** Create an empty chain scaffold. */
export function emptyChain(underlying: string, asOf: ISODate, S: number, r = 0, q = 0): Chain {
  return { underlying, asOf, underlyingPrice: S, riskFree: r, dividendYield: q, rows: [] };
}

/** Add or upsert a row into a chain. */
export function upsertRow(chain: Chain, row: OptionRow): void {
  const id = makeKey(row.underlying, row.expiry, row.strike, row.right);
  const map: Record<string, number> = {};
  for (let i = 0; i < chain.rows.length; i++) {
    const r = chain.rows[i];
    map[makeKey(r.underlying, r.expiry, r.strike, r.right)] = i;
  }
  if (id in map) chain.rows[map[id]] = row; else chain.rows.push(row);
}

/** Compute mid/spread/moneyness/intrinsic/extrinsic and greeks/IV if missing. */
export function enrichRow(
  chain: Chain,
  row: OptionRow,
  opts?: { preferMid?: boolean; fillGreeks?: boolean; recomputeIV?: boolean }
): OptionRow {
  const S = chain.underlyingPrice;
  const r = chain.riskFree ?? 0;
  const q = chain.dividendYield ?? 0;
  const T = max(0, yearFracACT365(chain.asOf, row.expiry));

  const bid = isNum(row.bid) ? row.bid! : undefined;
  const ask = isNum(row.ask) ? row.ask! : undefined;
  const last = isNum(row.last) ? row.last! : undefined;

  const mid = (isNum(bid) && isNum(ask)) ? 0.5 * (bid! + ask!) : (opts?.preferMid ? last : undefined);
  const spread = (isNum(bid) && isNum(ask)) ? max(0, ask! - bid!) : undefined;

  // intrinsic = max(0, +/- (S-K)) with dividends ignored (spot-based)
  const intrinsic = row.right === "C" ? max(0, S - row.strike) : max(0, row.strike - S);
  const refPx = isNum(mid) ? mid! : (isNum(last) ? last! : undefined);
  const extrinsic = isNum(refPx) ? max(0, refPx - intrinsic) : undefined;
  const moneyness = S / row.strike;

  let iv = row.iv;
  if ((!isNum(iv) || opts?.recomputeIV) && isNum(refPx) && T > 0) {
    iv = impliedVolFromPrice(row.right, S, row.strike, T, r, q, refPx as number);
  }

  let delta: number | undefined, gamma: number | undefined, vega: number | undefined, theta: number | undefined, rho: number | undefined;
  if ((opts?.fillGreeks ?? true) && isNum(iv)) {
    const g = blackScholes({ S, K: row.strike, T: max(T, 1e-6), r, q, vol: iv as number, right: row.right });
    delta = g.delta; gamma = g.gamma; vega = g.vega; theta = g.theta; rho = g.rho;
  }

  return {
    ...row,
    bid, ask, last, iv,
    mid, spread,
    intrinsic, extrinsic, moneyness,
    delta, gamma, vega, theta, rho,
  };
}

/** Enrich every row (non-mutating). */
export function enrichChain(chain: Chain, opts?: Parameters<typeof enrichRow>[2]): Chain {
  const rows = chain.rows.map(r => enrichRow(chain, r, opts));
  return { ...chain, rows };
}

/** Merge two chains (same underlying/asOf preferred). Second chain overrides overlapping rows. */
export function mergeChains(base: Chain, add: Chain): Chain {
  const out: Chain = { ...base, rows: base.rows.slice() };
  if (isNum(add.underlyingPrice)) out.underlyingPrice = add.underlyingPrice;
  if (isNum(add.riskFree)) out.riskFree = add.riskFree;
  if (isNum(add.dividendYield)) out.dividendYield = add.dividendYield;
  const map: Record<string, number> = {};
  for (let i = 0; i < out.rows.length; i++) map[makeKey(out.rows[i].underlying, out.rows[i].expiry, out.rows[i].strike, out.rows[i].right)] = i;
  for (const r of add.rows) {
    const k = makeKey(r.underlying, r.expiry, r.strike, r.right);
    if (k in map) out.rows[map[k]] = r; else out.rows.push(r);
  }
  return out;
}

/** ===== Filters & selectors ===== */

/** All distinct expiries sorted ascending. */
export function expiries(chain: Chain): ISODate[] {
  const set: Record<string, 1> = {};
  for (const r of chain.rows) set[r.expiry] = 1;
  return Object.keys(set).sort();
}

/** All distinct strikes for an expiry (sorted ascending). */
export function strikes(chain: Chain, expiry: ISODate): number[] {
  const xs: number[] = [];
  const seen: Record<string, 1> = {};
  for (const r of chain.rows) if (r.expiry === expiry && !seen[String(r.strike)]) {
    seen[String(r.strike)] = 1; xs.push(r.strike);
  }
  return xs.sort((a, b) => a - b);
}

/** Slice rows by expiry and right. */
export function sliceBy(chain: Chain, expiry: ISODate, right?: OptionRight): OptionRow[] {
  return chain.rows.filter(r => r.expiry === expiry && (!right || r.right === right));
}

/** Return ATM strike for an expiry (min |K - S|). */
export function atmStrike(chain: Chain, expiry: ISODate): number | undefined {
  const S = chain.underlyingPrice;
  let bestK: number | undefined, bestDiff = Infinity;
  for (const k of strikes(chain, expiry)) {
    const d = Math.abs(k - S);
    if (d < bestDiff) { bestDiff = d; bestK = k; }
  }
  return bestK;
}

/** Keep only OTM options for an expiry. */
export function otmOnly(chain: Chain, expiry: ISODate): OptionRow[] {
  const S = chain.underlyingPrice;
  return sliceBy(chain, expiry).filter(r => (r.right === "C" ? r.strike >= S : r.strike <= S));
}

/** Select N strikes around ATM symmetrically (both calls and puts). */
export function aroundATM(chain: Chain, expiry: ISODate, nEachSide = 3): OptionRow[] {
  const ks = strikes(chain, expiry);
  const S = chain.underlyingPrice;
  const sorted = ks.sort((a, b) => Math.abs(a - S) - Math.abs(b - S));
  const pick = new Set(sorted.slice(0, Math.max(1, nEachSide * 2 + 1)));
  return sliceBy(chain, expiry).filter(r => pick.has(r.strike));
}

/** Filter by delta band (absolute). */
export function byDelta(chain: Chain, expiry: ISODate, lo = 0, hi = 1): OptionRow[] {
  const enriched = enrichChain({ ...chain, rows: sliceBy(chain, expiry) });
  return enriched.rows.filter(r => isNum(r.delta) && Math.abs((r.delta as number)) >= lo && Math.abs((r.delta as number)) <= hi);
}

/** ===== IV Surface / Smiles ===== */

/** Build a simple smile for one expiry: [{strike, iv}] using mid or last. */
export function smile(chain: Chain, expiry: ISODate): { strike: number; iv?: number }[] {
  const S = chain.underlyingPrice;
  const rows = enrichChain({ ...chain, rows: sliceBy(chain, expiry) }, { preferMid: true, fillGreeks: false, recomputeIV: !true }).rows;
  const uniq: Record<string, { strike: number; iv?: number }> = {};
  for (const r of rows) {
    const key = String(r.strike);
    const refPx = isNum(r.mid) ? r.mid : (isNum(r.last) ? r.last : undefined);
    let iv = r.iv;
    if (!isNum(iv) && isNum(refPx)) {
      const T = yearFracACT365(chain.asOf, expiry);
      iv = impliedVolFromPrice(r.right, S, r.strike, T, chain.riskFree ?? 0, chain.dividendYield ?? 0, refPx as number);
    }
    // Prefer call IV for K>=S and put IV for K<S (just a convention)
    const prefer = (r.right === "C" && r.strike >= S) || (r.right === "P" && r.strike <= S);
    if (!uniq[key] || prefer) uniq[key] = { strike: r.strike, iv: iv };
  }
  return Object.values(uniq).sort((a, b) => a.strike - b.strike);
}

/** Coarse IV surface grid across expiries and strikes around ATM (±n steps). */
export function surface(
  chain: Chain,
  nStrikesEachSide = 5
): { expiry: ISODate; points: { strike: number; iv?: number }[] }[] {
  const outs: { expiry: ISODate; points: { strike: number; iv?: number }[] }[] = [];
  for (const exp of expiries(chain)) {
    const ks = strikes(chain, exp);
    const kATM = atmStrike(chain, exp);
    if (!isNum(kATM)) { outs.push({ expiry: exp, points: [] }); continue; }
    // choose indexes around ATM
    const idxATM = ks.indexOf(kATM as number);
    const lo = max(0, idxATM - nStrikesEachSide);
    const hi = min(ks.length - 1, idxATM + nStrikesEachSide);
    const subKs = ks.slice(lo, hi + 1);
    // Build smile on these K by recomputing IV best-effort
    const rows = sliceBy(chain, exp);
    const map: Record<string, OptionRow[]> = {};
    for (const r of rows) (map[String(r.strike)] ||= []).push(r);
    const pts: { strike: number; iv?: number }[] = [];
    for (const K of subKs) {
      const rr = map[String(K)] || [];
      // pick best quote (prefer call for K>=ATM else put)
      const prefRight: OptionRight = K >= (kATM as number) ? "C" : "P";
      const candidate = rr.find(x => x.right === prefRight) || rr[0];
      if (!candidate) { pts.push({ strike: K, iv: undefined }); continue; }

      const enriched = enrichRow(chain, candidate, { preferMid: true, fillGreeks: false, recomputeIV: true });
      pts.push({ strike: K, iv: enriched.iv });
    }
    outs.push({ expiry: exp, points: pts });
  }
  return outs;
}

/** ===== Convenience builders ===== */

/** Build a chain from raw arrays. Rights: "C" or "P". Missing ivs will be backsolved from mid/last if possible. */
export function buildChain(
  underlying: string,
  asOf: ISODate,
  S: number,
  rows: Array<{ expiry: ISODate; strike: number; right: OptionRight; bid?: number; ask?: number; last?: number; iv?: number; volume?: number; openInterest?: number; }>,
  r = 0,
  q = 0
): Chain {
  const chain: Chain = { underlying, asOf, underlyingPrice: S, riskFree: r, dividendYield: q, rows: [] };
  for (const r0 of rows) {
    const row: OptionRow = {
      underlying, expiry: r0.expiry, strike: r0.strike, right: r0.right,
      bid: r0.bid, ask: r0.ask, last: r0.last, iv: r0.iv,
      volume: r0.volume, openInterest: r0.openInterest,
    };
    chain.rows.push(enrichRow(chain, row, { preferMid: true, fillGreeks: true, recomputeIV: !isNum(r0.iv) }));
  }
  return chain;
}

/** Pretty summary for logs. */
export function summarize(chain: Chain): string {
  const exps = expiries(chain);
  const n = chain.rows.length;
  const atmPerExp = exps.map(e => atmStrike(chain, e)).filter(isNum).length;
  return `Chain ${chain.underlying} asOf=${chain.asOf} S=${chain.underlyingPrice.toFixed(4)} rows=${n} expiries=${exps.length} (ATM found ${atmPerExp}/${exps.length})`;
}