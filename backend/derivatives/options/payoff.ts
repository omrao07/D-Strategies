// options/payoff.ts
// Pure TS (no imports). Build option/underlying payoff & PnL diagrams at expiry,
// compute breakevens, max profit/loss, and simple strategy builders.
//
// Conventions
// - Premium is per 1 unit of underlying; use `multiplier` (e.g., 100 for equity options).
// - Signed qty: + for long, - for short.
// - PnL = payoff_at_expiry - premium_paid_received (× multiplier × qty).
// - Underlying leg uses linear PnL: (S_T - entryPx) * qty * multiplier.
//
// What’s inside
// - Types for legs & strategies
// - Payoff math for calls/puts/stock/futures
// - Strategy aggregation (PnL at a price or across a grid)
// - Breakeven finder, bounds (max profit/loss), and summary
// - Helpers to build common structures (verticals, straddles/strangles, iron condors)
// - Optional discrete expected value / prob. of profit under lognormal (approx)

export type Right = "C" | "P";
export type ISODate = string;

export type OptionLeg = {
  kind: "option";
  right: Right;
  strike: number;
  qty: number;         // signed: + long / - short contracts
  premium: number;     // per 1 underlying unit
  multiplier?: number; // default 100
  // Informational:
  expiry?: ISODate;
  label?: string;
};

export type StockLeg = {
  kind: "stock";
  entry: number;       // entry price of stock
  qty: number;         // shares (signed)
  multiplier?: number; // default 1
  label?: string;
};

export type FuturesLeg = {
  kind: "futures";
  entry: number;       // entry price
  qty: number;         // contracts (signed)
  multiplier: number;  // $ per 1 price point per contract
  label?: string;
};

export type Leg = OptionLeg | StockLeg | FuturesLeg;

export type Strategy = {
  spotRef?: number;     // current spot for nice default grids
  legs: Leg[];
  name?: string;
};

export type Point = { S: number; payoff: number; pnl: number };

const DEF_MULT_OPT = 100;

// ===== Core per-leg payoff/PnL at expiry =====

export function optionIntrinsic(right: Right, S: number, K: number): number {
  return Math.max(0, right === "C" ? (S - K) : (K - S));
}

export function optionPayoffAtExpiry(leg: OptionLeg, S: number): number {
  const m = leg.multiplier ?? DEF_MULT_OPT;
  const intrinsic = optionIntrinsic(leg.right, S, leg.strike);
  // positive if long option ends in-the-money
  return intrinsic * m * leg.qty;
}

export function optionPnLAtExpiry(leg: OptionLeg, S: number): number {
  const m = leg.multiplier ?? DEF_MULT_OPT;
  const payoff = optionPayoffAtExpiry(leg, S);
  const premiumCash = -leg.premium * m * leg.qty; // long pays premium (negative), short receives (positive)
  return payoff + premiumCash;
}

export function stockPnLAtExpiry(leg: StockLeg, S: number): number {
  const m = leg.multiplier ?? 1;
  return (S - leg.entry) * leg.qty * m;
}

export function futuresPnLAtExpiry(leg: FuturesLeg, S: number): number {
  return (S - leg.entry) * leg.qty * leg.multiplier;
}

export function legPnLAtExpiry(leg: Leg, S: number): number {
  if (leg.kind === "option") return optionPnLAtExpiry(leg, S);
  if (leg.kind === "stock")  return stockPnLAtExpiry(leg, S);
  return futuresPnLAtExpiry(leg, S);
}

export function legPayoffAtExpiry(leg: Leg, S: number): number {
  if (leg.kind === "option") return optionPayoffAtExpiry(leg, S);
  // linear instruments’ payoff == PnL (no upfront premium notion)
  if (leg.kind === "stock")  return stockPnLAtExpiry(leg, S);
  return futuresPnLAtExpiry(leg, S);
}

// ===== Strategy aggregation =====

export function pnlAt(strategy: Strategy, S: number): number {
  let t = 0;
  for (const leg of strategy.legs) t += legPnLAtExpiry(leg, S);
  return t;
}
export function payoffAt(strategy: Strategy, S: number): number {
  let t = 0;
  for (const leg of strategy.legs) t += legPayoffAtExpiry(leg, S);
  return t;
}

/** Generate a price grid around spot or an inferred mid (min/max strikes) */
export function priceGrid(
  strategy: Strategy,
  opts?: { from?: number; to?: number; steps?: number; pctFrom?: number; pctTo?: number }
): number[] {
  const steps = Math.max(2, Math.floor(opts?.steps ?? 201));
  let lo = opts?.from, hi = opts?.to;

  const strikes = strategy.legs.filter((l): l is OptionLeg => l.kind === "option").map(l => l.strike);
  const ref = strategy.spotRef ?? (strikes.length ? avg(strikes) : 100);

  if (lo == null || hi == null) {
    const pFrom = opts?.pctFrom ?? -0.5;
    const pTo   = opts?.pctTo   ?? +0.5;
    lo = lo ?? Math.max(0, ref * (1 + pFrom));
    hi = hi ?? ref * (1 + pTo);
  }
  if (lo === hi) { hi = lo * 1.01 + 0.01; }

  const out: number[] = [];
  const dx = (hi - lo) / (steps - 1);
  for (let i = 0; i < steps; i++) out.push(lo + i * dx);
  return out;
}

/** Produce PnL/payoff curve across S-grid */
export function curve(
  strategy: Strategy,
  grid?: number[]
): Point[] {
  const xs = grid ?? priceGrid(strategy);
  const out: Point[] = [];
  for (const S of xs) out.push({ S, payoff: payoffAt(strategy, S), pnl: pnlAt(strategy, S) });
  return out;
}

// ===== Breakevens, bounds, and summary =====

/** Find breakeven prices by scanning for sign changes in PnL across a grid. */
export function breakevens(strategy: Strategy, grid?: number[]): number[] {
  const pts = curve(strategy, grid);
  const bes: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const y0 = pts[i - 1].pnl, y1 = pts[i].pnl;
    if (y0 === 0) { bes.push(pts[i - 1].S); continue; }
    if ((y0 < 0 && y1 > 0) || (y0 > 0 && y1 < 0)) {
      // linear interpolation
      const x0 = pts[i - 1].S, x1 = pts[i].S;
      const t = y0 / (y0 - y1);
      const x = x0 + t * (x1 - x0);
      bes.push(x);
    }
  }
  // Deduplicate near-equals
  const uniq = dedupeNear(bes, 1e-8);
  return uniq;
}

/** Max profit/loss estimation from a (wide) grid. Use generous pctFrom/pctTo for more accurate bounds. */
export function bounds(strategy: Strategy, grid?: number[]): { maxProfit?: number; maxLoss?: number } {
  const pts = curve(strategy, grid);
  let maxP: number | undefined, minP: number | undefined;
  for (const p of pts) {
    if (maxP == null || p.pnl > maxP) maxP = p.pnl;
    if (minP == null || p.pnl < minP) minP = p.pnl;
  }
  return { maxProfit: maxP, maxLoss: minP };
}

/** Quick textual summary with inferred breakevens and extremums over a default grid. */
export function summarize(strategy: Strategy): string {
  const xs = priceGrid(strategy, { pctFrom: -0.7, pctTo: 0.7, steps: 401 });
  const bes = breakevens(strategy, xs);
  const b = bounds(strategy, xs);
  const beStr = bes.length ? bes.map(x => x.toFixed(2)).join(", ") : "—";
  const pStr = b.maxProfit != null ? b.maxProfit.toFixed(2) : "∞";
  const lStr = b.maxLoss   != null ? b.maxLoss.toFixed(2)   : "∞";
  const nm = strategy.name || "Strategy";
  return `${nm} | BE: ${beStr} | Max Profit: ${pStr} | Max Loss: ${lStr}`;
}

// ===== Strategy builders (helpers) =====

export function longCall(K: number, premium: number, qty = 1, multiplier = DEF_MULT_OPT): OptionLeg {
  return { kind: "option", right: "C", strike: K, premium, qty, multiplier };
}
export function shortCall(K: number, premium: number, qty = 1, multiplier = DEF_MULT_OPT): OptionLeg {
  return { kind: "option", right: "C", strike: K, premium, qty: -Math.abs(qty), multiplier };
}
export function longPut(K: number, premium: number, qty = 1, multiplier = DEF_MULT_OPT): OptionLeg {
  return { kind: "option", right: "P", strike: K, premium, qty, multiplier };
}
export function shortPut(K: number, premium: number, qty = 1, multiplier = DEF_MULT_OPT): OptionLeg {
  return { kind: "option", right: "P", strike: K, premium, qty: -Math.abs(qty), multiplier };
}

export function stock(qty: number, entry: number, multiplier = 1): StockLeg {
  return { kind: "stock", qty, entry, multiplier };
}
export function futures(qty: number, entry: number, multiplier: number): FuturesLeg {
  return { kind: "futures", qty, entry, multiplier };
}

/** Vertical spread (call or put). If qty>0 => debit vertical; qty<0 => credit vertical. */
export function vertical(
  right: Right,
  Klong: number,
  plong: number,
  Kshort: number,
  pshort: number,
  qty = 1,
  multiplier = DEF_MULT_OPT
): Strategy {
  const legs: Leg[] = [];
  if (qty >= 0) {
    legs.push({ kind: "option", right, strike: Klong, premium: plong, qty: Math.abs(qty), multiplier });
    legs.push({ kind: "option", right, strike: Kshort, premium: pshort, qty: -Math.abs(qty), multiplier });
  } else {
    legs.push({ kind: "option", right, strike: Klong, premium: plong, qty: -Math.abs(qty), multiplier });
    legs.push({ kind: "option", right, strike: Kshort, premium: pshort, qty: +Math.abs(qty), multiplier });
  }
  return { legs, name: `${right} Vertical (${Klong}/${Kshort})` };
}

export function straddle(K: number, pc: { callPrem: number; putPrem: number }, qty = 1, multiplier = DEF_MULT_OPT): Strategy {
  return {
    legs: [
      longCall(K, pc.callPrem, qty, multiplier),
      longPut(K, pc.putPrem, qty, multiplier),
    ],
    name: `Long Straddle @${K}`,
  };
}

export function shortStraddle(K: number, prem: { callPrem: number; putPrem: number }, qty = 1, multiplier = DEF_MULT_OPT): Strategy {
  return {
    legs: [
      shortCall(K, prem.callPrem, qty, multiplier),
      shortPut(K, prem.putPrem, qty, multiplier),
    ],
    name: `Short Straddle @${K}`,
  };
}

export function strangle(Kp: number, Kc: number, pp: number, pc: number, qty = 1, multiplier = DEF_MULT_OPT): Strategy {
  return {
    legs: [
      longPut(Kp, pp, qty, multiplier),
      longCall(Kc, pc, qty, multiplier),
    ],
    name: `Long Strangle P${Kp}/C${Kc}`,
  };
}

export function ironCondor(
  KpLong: number, KpShort: number,
  KcShort: number, KcLong: number,
  prem: { pLong: number; pShort: number; cShort: number; cLong: number },
  qty = 1,
  multiplier = DEF_MULT_OPT
): Strategy {
  return {
    legs: [
      longPut(KpLong, prem.pLong, qty, multiplier),
      shortPut(KpShort, prem.pShort, qty, multiplier),
      shortCall(KcShort, prem.cShort, qty, multiplier),
      longCall(KcLong, prem.cLong, qty, multiplier),
    ],
    name: `Iron Condor P${KpLong}/${KpShort} C${KcShort}/${KcLong}`,
  };
}

// ===== Probability & EV (discrete lognormal approximation; optional) =====

export type LNDist = { S0: number; mu?: number; sigma: number; T?: number };
/**
 * Approximate expected PnL and probability of profit by integrating over
 * a lognormal grid. sigma is annualized vol (decimal); mu is drift of log S (risk-neutral ≈ r-q).
 */
export function expectedPnL(
  strategy: Strategy,
  dist: LNDist,
  grid?: number[]
): { ev: number; probProfit: number } {
  const S0 = dist.S0;
  const T = Math.max(1e-12, dist.T ?? 1);
  const mu = dist.mu ?? 0;               // risk-neutral use r-q
  const vol = Math.max(1e-12, dist.sigma);

  // If no grid provided, use a wide range around S0
  const xs = grid ?? priceGrid({ ...strategy, spotRef: S0 }, { pctFrom: -0.9, pctTo: 1.1, steps: 1201 });

  let ev = 0;
  let probProfit = 0;
  let wsum = 0;
  for (const S of xs) {
    // Lognormal PDF of S_T
    const m = Math.log(S0) + (mu - 0.5 * vol * vol) * T;
    const pdf = (S > 0) ? (1 / (S * vol * Math.sqrt(2 * Math.PI * T))) * Math.exp(-Math.pow(Math.log(S) - m, 2) / (2 * vol * vol * T)) : 0;

    const pnl = pnlAt(strategy, S);
    const dS = differential(xs, S);
    const weight = pdf * dS;

    ev += pnl * weight;
    if (pnl >= 0) probProfit += weight;

    wsum += weight;
  }
  // normalize slight numeric drift
  if (wsum > 0) {
    ev /= wsum;
    probProfit /= wsum;
  }
  return { ev, probProfit };
}

// ===== Small utilities =====
function avg(xs: number[]): number { if (!xs.length) return 0; let s = 0; for (const x of xs) s += x; return s / xs.length; }
function dedupeNear(xs: number[], eps: number): number[] {
  const out: number[] = [];
  const sorted = xs.slice().sort((a, b) => a - b);
  for (const x of sorted) {
    if (!out.length || Math.abs(out[out.length - 1] - x) > eps) out.push(x);
  }
  return out;
}
/** Small numeric differential for grid integration */
function differential(xs: number[], x: number): number {
  const n = xs.length;
  if (n < 2) return 1;
  const i = nearestIndex(xs, x);
  if (i <= 0) return xs[1] - xs[0];
  if (i >= n - 1) return xs[n - 1] - xs[n - 2];
  return 0.5 * (xs[i + 1] - xs[i - 1]);
}
function nearestIndex(xs: number[], x: number): number {
  let lo = 0, hi = xs.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid;
  }
  return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
}

/* ===== Example usage (remove if not needed) =====
const strat: Strategy = {
  spotRef: 100,
  legs: [
    longCall(105, 2.0, 1, 100),
    shortCall(110, 0.9, 1, 100),
    stock(100, 0, 1), // (example: if you want a covered call, use stock leg instead)
  ],
  name: "Call Spread + Stock"
};

console.log(summarize(strat));
const pts = curve(strat);
const bes = breakevens(strat);
const ev = expectedPnL(strat, { S0: 100, sigma: 0.2, mu: 0, T: 0.25 });
*/