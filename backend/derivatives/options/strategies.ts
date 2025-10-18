// options/strategies.ts
// Pure TS (no imports). Strategy builders + quick analytics for listed options.
//
// What's inside
// - Minimal leg/strategy types (compatible with options/payoff.ts style)
// - Factory helpers: long/short C/P, stock, futures
// - Common strategies: covered call, protective put, collar, verticals, butterflies,
//   straddles/strangles, iron condor, iron fly, calendars/diagonals
// - Quick analytics: net premium, payoff/PnL grid, breakevens, bounds
// - Aggregate Greeks (BS) for a simple single-expiry environment
//
// Notes
// - Premiums are per 1 underlying unit; use multiplier (e.g., 100 for equities).
// - Greeks are aggregated linearly across legs. BS implementation included locally
//   so this file stands alone (S, K, T in years (ACT/365), r/q cont. rates).

/** ===== Types ===== */
export type Right = "C" | "P";
export type ISODate = string;

export type OptionLeg = {
  kind: "option";
  right: Right;
  strike: number;
  qty: number;          // signed: + long / - short
  premium: number;      // per 1 underlying unit
  multiplier?: number;  // default 100
  expiry?: ISODate;     // informational
  label?: string;
};

export type StockLeg = {
  kind: "stock";
  entry: number;
  qty: number;          // shares (signed)
  multiplier?: number;  // default 1
  label?: string;
};

export type FuturesLeg = {
  kind: "futures";
  entry: number;
  qty: number;          // contracts (signed)
  multiplier: number;   // $ per 1 point per contract
  label?: string;
};

export type Leg = OptionLeg | StockLeg | FuturesLeg;

export type Strategy = {
  legs: Leg[];
  name?: string;
  spotRef?: number;     // for grid convenience
};

export type Greeks = {
  price: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
};

export type Env = {
  S: number;   // spot (or futures if q=r)
  T: number;   // years
  r?: number;  // cont.
  q?: number;  // cont.
  vol: number; // BS vol (decimal)
};

export type Point = { S: number; payoff: number; pnl: number };

/** ===== Small utils ===== */
const DEF_MULT_OPT = 100;
const isNum = (x: any): x is number => typeof x === "number" && Number.isFinite(x);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** ===== Per-leg payoff & PnL at expiry (replicated so this file is standalone) ===== */
export function optionIntrinsic(right: Right, S: number, K: number): number {
  return Math.max(0, right === "C" ? (S - K) : (K - S));
}
export function optionPayoff(leg: OptionLeg, S: number): number {
  const m = leg.multiplier ?? DEF_MULT_OPT;
  return optionIntrinsic(leg.right, S, leg.strike) * m * leg.qty;
}
export function optionPnL(leg: OptionLeg, S: number): number {
  const m = leg.multiplier ?? DEF_MULT_OPT;
  return optionPayoff(leg, S) - leg.premium * m * leg.qty; // premium paid if long (+qty)
}
export function stockPnL(leg: StockLeg, S: number): number {
  return (S - leg.entry) * (leg.multiplier ?? 1) * leg.qty;
}
export function futuresPnL(leg: FuturesLeg, S: number): number {
  return (S - leg.entry) * leg.multiplier * leg.qty;
}
export function legPnL(leg: Leg, S: number): number {
  if (leg.kind === "option") return optionPnL(leg, S);
  if (leg.kind === "stock")  return stockPnL(leg, S);
  return futuresPnL(leg, S);
}
export function legPayoff(leg: Leg, S: number): number {
  if (leg.kind === "option") return optionPayoff(leg, S);
  // linear instruments payoff == PnL
  return legPnL(leg, S);
}

/** Aggregate PnL/payoff for a strategy at a price */
export function pnlAt(strategy: Strategy, S: number): number {
  let t = 0; for (const leg of strategy.legs) t += legPnL(leg, S); return t;
}
export function payoffAt(strategy: Strategy, S: number): number {
  let t = 0; for (const leg of strategy.legs) t += legPayoff(leg, S); return t;
}

/** Price grid helper */
export function priceGrid(
  strategy: Strategy,
  opts?: { from?: number; to?: number; steps?: number; pctFrom?: number; pctTo?: number }
): number[] {
  const steps = Math.max(2, Math.floor(opts?.steps ?? 201));
  const strikes = strategy.legs.filter((l): l is OptionLeg => l.kind === "option").map(l => l.strike);
  const ref = strategy.spotRef ?? (strikes.length ? strikes.reduce((a, b) => a + b, 0) / strikes.length : 100);
  const lo = opts?.from ?? Math.max(0, ref * (1 + (opts?.pctFrom ?? -0.5)));
  const hi = opts?.to ?? (ref * (1 + (opts?.pctTo ?? +0.5)));
  const out: number[] = []; const dx = (hi - lo) / (steps - 1);
  for (let i = 0; i < steps; i++) out.push(lo + i * dx);
  return out;
}

/** Curve of payoff/PnL */
export function curve(strategy: Strategy, grid?: number[]): Point[] {
  const xs = grid ?? priceGrid(strategy);
  return xs.map(S => ({ S, payoff: payoffAt(strategy, S), pnl: pnlAt(strategy, S) }));
}

/** Breakevens (scan sign changes in PnL) */
export function breakevens(strategy: Strategy, grid?: number[]): number[] {
  const xs = grid ?? priceGrid(strategy, { pctFrom: -0.8, pctTo: 0.8, steps: 801 });
  const pts = xs.map(S => ({ S, pnl: pnlAt(strategy, S) }));
  const bes: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const y0 = pts[i - 1].pnl, y1 = pts[i].pnl;
    if (y0 === 0) { bes.push(pts[i - 1].S); continue; }
    if ((y0 < 0 && y1 > 0) || (y0 > 0 && y1 < 0)) {
      const x0 = pts[i - 1].S, x1 = pts[i].S;
      const t = y0 / (y0 - y1);
      bes.push(x0 + t * (x1 - x0));
    }
  }
  // dedupe
  const out: number[] = [];
  for (const x of bes.sort((a, b) => a - b)) if (!out.length || Math.abs(out[out.length - 1] - x) > 1e-8) out.push(x);
  return out;
}

/** Bounds over a grid */
export function bounds(strategy: Strategy, grid?: number[]): { maxProfit?: number; maxLoss?: number } {
  const pts = curve(strategy, grid);
  let maxP: number | undefined, minP: number | undefined;
  for (const p of pts) {
    if (maxP == null || p.pnl > maxP) maxP = p.pnl;
    if (minP == null || p.pnl < minP) minP = p.pnl;
  }
  return { maxProfit: maxP, maxLoss: minP };
}

/** Net premium (credit>0 / debit<0) in currency */
export function netPremium(strategy: Strategy): number {
  let t = 0;
  for (const leg of strategy.legs) {
    if (leg.kind === "option") {
      const m = leg.multiplier ?? DEF_MULT_OPT;
      t += -leg.premium * m * leg.qty; // long pays -> negative; short receives -> positive
    }
  }
  return t;
}

/** ===== Strategy builders (factories) ===== */
export function longCall(K: number, prem: number, qty = 1, mult = DEF_MULT_OPT): OptionLeg {
  return { kind: "option", right: "C", strike: K, premium: prem, qty, multiplier: mult, label: `+C${K}` };
}
export function shortCall(K: number, prem: number, qty = 1, mult = DEF_MULT_OPT): OptionLeg {
  return { kind: "option", right: "C", strike: K, premium: prem, qty: -Math.abs(qty), multiplier: mult, label: `-C${K}` };
}
export function longPut(K: number, prem: number, qty = 1, mult = DEF_MULT_OPT): OptionLeg {
  return { kind: "option", right: "P", strike: K, premium: prem, qty, multiplier: mult, label: `+P${K}` };
}
export function shortPut(K: number, prem: number, qty = 1, mult = DEF_MULT_OPT): OptionLeg {
  return { kind: "option", right: "P", strike: K, premium: prem, qty: -Math.abs(qty), multiplier: mult, label: `-P${K}` };
}
export function stock(qty: number, entry: number, mult = 1): StockLeg {
  return { kind: "stock", qty, entry, multiplier: mult, label: `${qty >= 0 ? "+" : ""}${qty} stk` };
}
export function futures(qty: number, entry: number, multiplier: number): FuturesLeg {
  return { kind: "futures", qty, entry, multiplier, label: `${qty >= 0 ? "+" : ""}${qty} fut` };
}

/** Covered call: long stock + short OTM call */
export function coveredCall(entry: number, qtyShares: number, Kc: number, callPrem: number, optMult = DEF_MULT_OPT): Strategy {
  const sharesPerOpt = optMult; // typical equity options
  const qtyOpts = Math.floor(Math.abs(qtyShares) / sharesPerOpt) * (qtyShares >= 0 ? 1 : -1);
  return {
    name: "Covered Call",
    legs: [
      stock(qtyShares, entry, 1),
      shortCall(Kc, callPrem, Math.abs(qtyOpts), optMult),
    ],
  };
}

/** Protective put: long stock + long put */
export function protectivePut(entry: number, qtyShares: number, Kp: number, putPrem: number, optMult = DEF_MULT_OPT): Strategy {
  const qtyOpts = Math.floor(Math.abs(qtyShares) / optMult);
  return { name: "Protective Put", legs: [stock(qtyShares, entry, 1), longPut(Kp, putPrem, qtyOpts, optMult)] };
}

/** Collar: long stock + long put - short call */
export function collar(
  entry: number, qtyShares: number, Kp: number, pp: number, Kc: number, pc: number, optMult = DEF_MULT_OPT
): Strategy {
  const n = Math.floor(Math.abs(qtyShares) / optMult);
  return { name: "Collar", legs: [stock(qtyShares, entry, 1), longPut(Kp, pp, n, optMult), shortCall(Kc, pc, n, optMult)] };
}

/** Verticals (same expiry) */
export function bullCall(Kbuy: number, pBuy: number, Ksell: number, pSell: number, qty = 1, mult = DEF_MULT_OPT): Strategy {
  return { name: "Bull Call Spread", legs: [longCall(Kbuy, pBuy, qty, mult), shortCall(Ksell, pSell, qty, mult)] };
}
export function bearCall(Ksell: number, pSell: number, Kbuy: number, pBuy: number, qty = 1, mult = DEF_MULT_OPT): Strategy {
  return { name: "Bear Call Spread", legs: [shortCall(Ksell, pSell, qty, mult), longCall(Kbuy, pBuy, qty, mult)] };
}
export function bullPut(Ksell: number, pSell: number, Kbuy: number, pBuy: number, qty = 1, mult = DEF_MULT_OPT): Strategy {
  return { name: "Bull Put Spread", legs: [shortPut(Ksell, pSell, qty, mult), longPut(Kbuy, pBuy, qty, mult)] };
}
export function bearPut(Kbuy: number, pBuy: number, Ksell: number, pSell: number, qty = 1, mult = DEF_MULT_OPT): Strategy {
  return { name: "Bear Put Spread", legs: [longPut(Kbuy, pBuy, qty, mult), shortPut(Ksell, pSell, qty, mult)] };
}

/** Butterflies (same expiry) */
export function callButterfly(K1: number, p1: number, K2: number, p2: number, K3: number, p3: number, qty = 1, mult = DEF_MULT_OPT): Strategy {
  return { name: "Call Butterfly", legs: [longCall(K1, p1, qty, mult), shortCall(K2, p2, 2 * qty, mult), longCall(K3, p3, qty, mult)] };
}
export function putButterfly(K1: number, p1: number, K2: number, p2: number, K3: number, p3: number, qty = 1, mult = DEF_MULT_OPT): Strategy {
  return { name: "Put Butterfly", legs: [longPut(K1, p1, qty, mult), shortPut(K2, p2, 2 * qty, mult), longPut(K3, p3, qty, mult)] };
}

/** Straddles/Strangles */
export function longStraddle(K: number, pc: { call: number; put: number }, qty = 1, mult = DEF_MULT_OPT): Strategy {
  return { name: "Long Straddle", legs: [longCall(K, pc.call, qty, mult), longPut(K, pc.put, qty, mult)] };
}
export function shortStraddle(K: number, pc: { call: number; put: number }, qty = 1, mult = DEF_MULT_OPT): Strategy {
  return { name: "Short Straddle", legs: [shortCall(K, pc.call, qty, mult), shortPut(K, pc.put, qty, mult)] };
}
export function longStrangle(Kp: number, Kc: number, pp: number, pc: number, qty = 1, mult = DEF_MULT_OPT): Strategy {
  return { name: "Long Strangle", legs: [longPut(Kp, pp, qty, mult), longCall(Kc, pc, qty, mult)] };
}
export function shortStrangle(Kp: number, Kc: number, pp: number, pc: number, qty = 1, mult = DEF_MULT_OPT): Strategy {
  return { name: "Short Strangle", legs: [shortPut(Kp, pp, qty, mult), shortCall(Kc, pc, qty, mult)] };
}

/** Iron structures */
export function ironCondor(
  KpLong: number, KpShort: number, KcShort: number, KcLong: number,
  prem: { pLong: number; pShort: number; cShort: number; cLong: number },
  qty = 1, mult = DEF_MULT_OPT
): Strategy {
  return {
    name: "Iron Condor",
    legs: [
      longPut(KpLong, prem.pLong, qty, mult),
      shortPut(KpShort, prem.pShort, qty, mult),
      shortCall(KcShort, prem.cShort, qty, mult),
      longCall(KcLong, prem.cLong, qty, mult),
    ],
  };
}
export function ironFly(K: number, wings: { Kp: number; Kc: number }, prem: { pWing: number; cWing: number; straddleC: number; straddleP: number }, qty = 1, mult = DEF_MULT_OPT): Strategy {
  return {
    name: "Iron Butterfly",
    legs: [
      longPut(wings.Kp, prem.pWing, qty, mult),
      shortPut(K, prem.straddleP, qty, mult),
      shortCall(K, prem.straddleC, qty, mult),
      longCall(wings.Kc, prem.cWing, qty, mult),
    ],
  };
}

/** Calendars & diagonals (note: payoff at a *single* expiry is piecewise; here we mainly structure the legs) */
export function longCalendar(
  K: number,
  prem: { near: number; far: number },
  qty = 1,
  mult = DEF_MULT_OPT,
  expiries?: { near: ISODate; far: ISODate }
): Strategy {
  return {
    name: "Long Calendar",
    legs: [
      shortCall(K, prem.near, qty, mult), // sell near
      longCall(K, prem.far, qty, mult),   // buy far
    ].map((l, i) => (l.kind === "option" ? { ...l, expiry: i === 0 ? expiries?.near : expiries?.far } : l)),
  };
}
export function diagonal(
  right: Right,
  near: { K: number; prem: number; expiry?: ISODate },
  far:  { K: number; prem: number; expiry?: ISODate },
  qty = 1,
  mult = DEF_MULT_OPT
): Strategy {
  const shortLeg = right === "C" ? shortCall(near.K, near.prem, qty, mult) : shortPut(near.K, near.prem, qty, mult);
  const longLeg  = right === "C" ? longCall(far.K, far.prem, qty, mult)   : longPut(far.K, far.prem, qty, mult);
  if (shortLeg.kind === "option") shortLeg.expiry = near.expiry;
  if (longLeg.kind === "option")  longLeg.expiry = far.expiry;
  return { name: `Diagonal ${right}`, legs: [shortLeg, longLeg] };
}

/** ===== Black–Scholes greeks for a single environment (no imports) ===== */
function nPdf(x: number): number { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
function nCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + p * z);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}
function bs_d1d2(S: number, K: number, T: number, r: number, q: number, v: number): { d1: number; d2: number } {
  const V = Math.max(1e-12, v), TT = Math.max(1e-12, T), sT = Math.sqrt(TT);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * V * V) * TT) / (V * sT);
  return { d1, d2: d1 - V * sT };
}
function bsGreeks(right: Right, S: number, K: number, T: number, r = 0, q = 0, vol = 0.2): Greeks {
  const { d1, d2 } = bs_d1d2(S, K, T, r, q, vol);
  const dfq = Math.exp(-q * T), dfr = Math.exp(-r * T), sT = Math.sqrt(Math.max(1e-12, T));
  const price = right === "C"
    ? S * dfq * nCdf(d1) - K * dfr * nCdf(d2)
    : K * dfr * nCdf(-d2) - S * dfq * nCdf(-d1);
  if (right === "C") {
    const delta = dfq * nCdf(d1);
    const gamma = dfq * nPdf(d1) / (S * Math.max(1e-12, vol) * sT);
    const vega  = S * dfq * nPdf(d1) * sT;
    const theta = -(S * dfq * nPdf(d1) * vol) / (2 * sT) - r * K * dfr * nCdf(d2) + q * S * dfq * nCdf(d1);
    const rho   = K * T * dfr * nCdf(d2);
    return { price, delta, gamma, vega, theta, rho };
  } else {
    const delta = -dfq * nCdf(-d1);
    const gamma = dfq * nPdf(d1) / (S * Math.max(1e-12, vol) * sT);
    const vega  = S * dfq * nPdf(d1) * sT;
    const theta = -(S * dfq * nPdf(d1) * vol) / (2 * sT) + r * K * dfr * nCdf(-d2) - q * S * dfq * nCdf(-d1);
    const rho   = -K * T * dfr * nCdf(-d2);
    return { price, delta, gamma, vega, theta, rho };
  }
}

/** Aggregate Greeks for the whole strategy (scaled by multipliers & qty).
 * For stock and futures legs:
 *  - Stock: delta = qty*multiplier, theta=gamma=vega=rho=0
 *  - Futures: delta = qty*multiplier (per 1 price unit), others 0
 */
export function aggregateGreeks(strategy: Strategy, env: Env): Greeks {
  const r = env.r ?? 0, q = env.q ?? 0;
  const acc: Greeks = { price: 0, delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0 };

  for (const leg of strategy.legs) {
    if (leg.kind === "option") {
      const g = bsGreeks(leg.right, env.S, leg.strike, env.T, r, q, env.vol);
      const mult = leg.multiplier ?? DEF_MULT_OPT;
      const qty = leg.qty;
      // Premium price here is option theoretical price; total premium effect could be g.price * mult * qty
      acc.price += g.price * mult * qty;
      acc.delta += g.delta * mult * qty;
      acc.gamma += g.gamma * mult * qty;
      acc.vega  += g.vega  * mult * qty;
      acc.theta += g.theta * mult * qty;
      acc.rho   += g.rho   * mult * qty;
    } else if (leg.kind === "stock") {
      const mult = leg.multiplier ?? 1;
      acc.delta += 1 * mult * leg.qty;
      // No price/theta/vega/rho; price term for stock position value isn't very meaningful here, leave 0
    } else {
      // futures
      acc.delta += 1 * leg.multiplier * leg.qty;
    }
  }

  return acc;
}

/** Concise summary */
export function summarize(strategy: Strategy): string {
  const credit = netPremium(strategy);
  const xs = priceGrid(strategy, { pctFrom: -0.7, pctTo: 0.7, steps: 401 });
  const be = breakevens(strategy, xs).map(x => x.toFixed(2)).join(", ") || "—";
  const b = bounds(strategy, xs);
  const nm = strategy.name || "Strategy";
  const maxP = b.maxProfit != null ? b.maxProfit.toFixed(2) : "∞";
  const maxL = b.maxLoss   != null ? b.maxLoss.toFixed(2)   : "∞";
  return `${nm} | Net Premium: ${credit >= 0 ? "+" : ""}${credit.toFixed(2)} | BE: ${be} | Max P: ${maxP} | Max L: ${maxL}`;
}