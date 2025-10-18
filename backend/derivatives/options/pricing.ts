// options/pricing.ts
// Pure TS (no imports). Pricing helpers for listed options.
//
// What’s inside
// - Time fractions (ACT/365), forwards & carry helpers
// - Black–Scholes (lognormal) & Bachelier (normal) models: price + greeks
// - Implied volatility solvers (bisection/Newton hybrid) for both models
// - Parity, futures-style convenience (set q=r), and bulk pricers for simple “rows”
// - Utility guards (safe math, clamps)
//
// Notes
// - All vols are in decimals (e.g., 0.20 = 20%); Bachelier uses absolute vol (price units).
// - Greeks are per 1 underlying unit (scale by multiplier outside).
// - T is in years (ACT/365F). Use `forwardFromSpot` for futures options (q=r).

/** ===== Types ===== */
export type ISODate = string;
export type Right = "C" | "P";
export type Model = "bs" | "bachelier";

export type BSInputs = { S: number; K: number; T: number; r?: number; q?: number; vol: number; right: Right };
export type BNInputs = { S: number; K: number; T: number; r?: number; q?: number; vol: number; right: Right }; // vol in price units

export type PriceGreeks = {
  price: number;
  delta: number;
  gamma: number;
  vega: number;     // per 1.0 vol (BS); for Bachelier, per 1.0 absolute vol
  theta: number;    // per year
  rho: number;
};

export type Row = { right: Right; strike: number; /** price reference */ ref?: number; vol?: number };

/** ===== Small math utils ===== */
const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const isNum = (x: any): x is number => typeof x === "number" && Number.isFinite(x);
const eps = 1e-12;

/** Normal PDF/CDF */
function nPdf(x: number): number { return INV_SQRT_2PI * Math.exp(-0.5 * x * x); }
function nCdf(x: number): number {
  // Abramowitz-Stegun approx via erf
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * z);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}

/** ===== Time & carry ===== */
export function yearFracACT365(anchorISO: ISODate, expiryISO: ISODate): number {
  const a = Date.UTC(+anchorISO.slice(0,4), +anchorISO.slice(5,7)-1, +anchorISO.slice(8,10));
  const e = Date.UTC(+expiryISO.slice(0,4), +expiryISO.slice(5,7)-1, +expiryISO.slice(8,10));
  return (e - a) / 86_400_000 / 365;
}
export function forwardFromSpot(S: number, r = 0, q = 0, T = 0): number {
  return S * Math.exp((r - q) * Math.max(0, T));
}
export function spotFromForward(F: number, r = 0, q = 0, T = 0): number {
  return F * Math.exp(-(r - q) * Math.max(0, T));
}
/** Put–call parity (European, continuous carry). C - P = S e^{-qT} - K e^{-rT} */
export function parity(S: number, K: number, T: number, r = 0, q = 0): number {
  return S * Math.exp(-q * T) - K * Math.exp(-r * T);
}

/** ===== Black–Scholes (lognormal) ===== */
export function bs_d1d2(S: number, K: number, T: number, r=0, q=0, vol=0.2): { d1: number; d2: number } {
  const v = Math.max(1e-12, vol), TT = Math.max(1e-12, T), sT = Math.sqrt(TT);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * v * v) * TT) / (v * sT);
  return { d1, d2: d1 - v * sT };
}
export function bsPrice(inp: BSInputs): number {
  const { S, K, T } = inp; const r = inp.r ?? 0, q = inp.q ?? 0, v = Math.max(1e-12, inp.vol);
  const { d1, d2 } = bs_d1d2(S, K, T, r, q, v);
  const dfq = Math.exp(-q * T), dfr = Math.exp(-r * T);
  return inp.right === "C"
    ? S * dfq * nCdf(d1) - K * dfr * nCdf(d2)
    : K * dfr * nCdf(-d2) - S * dfq * nCdf(-d1);
}
export function bsAll(inp: BSInputs): PriceGreeks {
  const { S, K, T } = inp; const r = inp.r ?? 0, q = inp.q ?? 0, v = Math.max(1e-12, inp.vol);
  const { d1, d2 } = bs_d1d2(S, K, T, r, q, v);
  const dfq = Math.exp(-q * T), dfr = Math.exp(-r * T), sT = Math.sqrt(Math.max(1e-12, T));
  const price = bsPrice(inp);
  if (inp.right === "C") {
    const delta = dfq * nCdf(d1);
    const gamma = dfq * nPdf(d1) / (S * v * sT);
    const vega  = S * dfq * nPdf(d1) * sT;
    const theta = -(S * dfq * nPdf(d1) * v) / (2 * sT) - r * K * dfr * nCdf(d2) + q * S * dfq * nCdf(d1);
    const rho   = K * T * dfr * nCdf(d2);
    return { price, delta, gamma, vega, theta, rho };
  } else {
    const delta = -dfq * nCdf(-d1);
    const gamma = dfq * nPdf(d1) / (S * v * sT);
    const vega  = S * dfq * nPdf(d1) * sT;
    const theta = -(S * dfq * nPdf(d1) * v) / (2 * sT) + r * K * dfr * nCdf(-d2) - q * S * dfq * nCdf(-d1);
    const rho   = -K * T * dfr * nCdf(-d2);
    return { price, delta, gamma, vega, theta, rho };
  }
}

/** ===== Bachelier (normal) =====
 * Price with absolute vol (σ_N), useful for low-priced underlyings/rates.
 */
export function bach_d(S: number, K: number, T: number, volN: number): number {
  const s = Math.max(1e-12, volN) * Math.sqrt(Math.max(1e-12, T));
  return (S - K) / s;
}
export function bachelierPrice(inp: BNInputs): number {
  const { S, K, T } = inp; const r = inp.r ?? 0, q = inp.q ?? 0, vN = Math.max(1e-12, inp.vol);
  const dfq = Math.exp(-q * T), dfr = Math.exp(-r * T);
  const s = vN * Math.sqrt(Math.max(1e-12, T));
  const d = (S - K) / s;
  const discFwd = S * dfq - K * dfr;
  const phi = nPdf(d), Phi = nCdf(d);
  if (inp.right === "C") return discFwd * nCdf(d) + s * phi;
  return -discFwd * nCdf(-d) + s * phi;
}
export function bachelierAll(inp: BNInputs): PriceGreeks {
  const { S, K, T } = inp; const r = inp.r ?? 0, q = inp.q ?? 0, vN = Math.max(1e-12, inp.vol);
  const dfq = Math.exp(-q * T), dfr = Math.exp(-r * T);
  const s = vN * Math.sqrt(Math.max(1e-12, T)), d = (S - K) / s;
  const phi = nPdf(d), Phi = nCdf(d), price = bachelierPrice(inp);
  // Greeks w.r.t. spot (carry-aware)
  const delta = dfq * Phi;
  const gamma = dfq * phi / s;
  const vega  = Math.sqrt(Math.max(1e-12, T)) * phi; // per 1.0 abs vol
  // Theta using carry on forward + vol term
  const theta_carry = -r * (-K) * dfr - q * S * dfq; // d/dt of (S e^{-qT} - K e^{-rT})
  const theta_vol   = 0.5 * vN * phi / Math.sqrt(Math.max(1e-12, T));
  const theta = theta_carry * (inp.right === "C" ? 1 : -1) + theta_vol;
  // Rho approximate sensitivity (to r on discount leg)
  const rho = -K * T * dfr * (inp.right === "C" ? Phi : -nCdf(-d));
  return { price, delta, gamma, vega, theta, rho };
}

/** ===== Implied volatility solvers ===== */
export function ivFromPriceBS(right: Right, S: number, K: number, T: number, r: number, q: number, target: number): number | undefined {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(target >= 0)) return undefined;
  // Bracket with bisection; refine with a few Newton steps
  let lo = 1e-4, hi = 5.0;
  for (let i = 0; i < 70; i++) {
    const mid = 0.5 * (lo + hi);
    const p = bsPrice({ S, K, T, r, q, vol: mid, right });
    if (Math.abs(p - target) < 1e-10) return mid;
    if (p > target) hi = mid; else lo = mid;
  }
  let v = 0.5 * (lo + hi);
  for (let i = 0; i < 6; i++) {
    const g = bsAll({ S, K, T, r, q, vol: v, right });
    const diff = g.price - target;
    if (Math.abs(diff) < 1e-10 || g.vega <= eps) break;
    v = clamp(v - diff / g.vega, 1e-4, 5.0);
  }
  return v;
}
export function ivFromPriceBachelier(right: Right, S: number, K: number, T: number, r: number, q: number, target: number): number | undefined {
  if (!(T > 0)) return undefined;
  // Use Newton on abs vol with safeguard bisection
  let lo = 1e-6, hi = Math.max(1e-6, Math.abs(S) + Math.abs(K) + 1); // generous
  let v = 0.5 * (lo + hi);
  for (let i = 0; i < 50; i++) {
    const g = bachelierAll({ S, K, T, r, q, vol: v, right });
    const diff = g.price - target;
    if (Math.abs(diff) < 1e-10) return v;
    const dv = g.vega > eps ? diff / g.vega : 0;
    v = clamp(v - dv, lo, hi);
    // tighten bracket
    const p = bachelierPrice({ S, K, T, r, q, vol: v, right });
    if (p > target) hi = v; else lo = v;
  }
  return v;
}

/** ===== Unified dispatch helpers ===== */
export function price(model: Model, right: Right, S: number, K: number, T: number, r: number, q: number, vol: number): number {
  return model === "bs"
    ? bsPrice({ S, K, T, r, q, vol, right })
    : bachelierPrice({ S, K, T, r, q, vol, right });
}
export function priceGreeks(model: Model, right: Right, S: number, K: number, T: number, r: number, q: number, vol: number): PriceGreeks {
  return model === "bs"
    ? bsAll({ S, K, T, r, q, vol, right })
    : bachelierAll({ S, K, T, r, q, vol, right });
}
export function impliedVol(
  model: Model, right: Right, S: number, K: number, T: number, r: number, q: number, priceTarget: number
): number | undefined {
  return model === "bs"
    ? ivFromPriceBS(right, S, K, T, r, q, priceTarget)
    : ivFromPriceBachelier(right, S, K, T, r, q, priceTarget);
}

/** ===== Futures-style convenience =====
 * For options on futures: set q = r (so DF on S cancels), or pass F as S and use r=0,q=0.
 */
export function bsFuturesOptionPrice(right: Right, F: number, K: number, T: number, df: number, vol: number): number {
  // df = exp(-rT); price = df * BS(F, K, T, r=0, q=0)
  return df * bsPrice({ S: F, K, T, r: 0, q: 0, vol, right });
}
export function ivFromPriceBSFutures(right: Right, F: number, K: number, T: number, df: number, target: number): number | undefined {
  // Solve on undiscounted then adjust: target/df
  if (!(df > 0)) return undefined;
  return ivFromPriceBS(right, F, K, T, 0, 0, target / df);
}

/** ===== Bulk pricers for simple rows =====
 * Useful to price many strikes given a single (S,T,r,q,vol) environment.
 */
export function priceRows(
  model: Model,
  rows: Row[],
  env: { S: number; T: number; r?: number; q?: number; vol: number }
): Array<Row & { price: number; delta: number; gamma: number; vega: number; theta: number; rho: number }> {
  const r = env.r ?? 0, q = env.q ?? 0;
  const out: Array<Row & PriceGreeks> = [];
  for (const row of rows) {
    const g = priceGreeks(model, row.right, env.S, row.strike, env.T, r, q, row.vol ?? env.vol);
    out.push({ ...row, ...g });
  }
  return out;
}

/** ===== Sanity helpers ===== */
export function intrinsic(right: Right, S: number, K: number): number {
  return Math.max(0, right === "C" ? (S - K) : (K - S));
}
export function moneyness_log(S: number, K: number): number { return Math.log(Math.max(eps, S / Math.max(eps, K))); }

/* ===== Mini examples (comment or remove)
const S=100, K=105, T=0.5, r=0.04, q=0.01, vol=0.2;
console.log(bsAll({S,K,T,r,q,vol,right:"C"}));
console.log(bachelierAll({S,K,T,r,q,vol:5,right:"P"}));
console.log(ivFromPriceBS("C", S, K, T, r, q, 3.5));
*/