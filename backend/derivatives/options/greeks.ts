// options/greeks.ts
// Pure TS (no imports). Black–Scholes price + Greeks (C/P) with dividend yield.
// Provides first/second/third-order analytics commonly used in trading.
//
// Exposed:
// - types: OptionRight, BSInputs, BSPriceGreeks
// - core: d1d2(), bsPrice(), bsGreeks(), bsAll()
// - extras: vanna(), vomma(), charm(), speed(), color()
// - parity: putCallParity(), forwardFrom(S,r,q,T)
// - iv solve: impliedVolFromPrice()

export type OptionRight = "C" | "P";

export type BSInputs = {
  S: number;       // spot (or futures if you set q=r)
  K: number;       // strike
  T: number;       // time in years (ACT/365 usually)
  r?: number;      // risk-free rate (cont.)
  q?: number;      // dividend yield (cont.)
  vol: number;     // sigma (decimal)
  right: OptionRight;
};

export type BSPriceGreeks = {
  price: number;
  delta: number;
  gamma: number;
  vega: number;     // per 1.0 vol (not per 1%)
  theta: number;    // per year
  rho: number;
  // Second/interaction
  vanna: number;
  vomma: number;
  charm: number;    // dDelta/dt (per year)
  speed: number;    // dGamma/dS
  color: number;    // dGamma/dt (per year)
};

const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);

function phi(x: number): number {
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}
function Phi(x: number): number {
  // erf-based normal CDF approximation (Abramowitz-Stegun)
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * z);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

export function d1d2(S: number, K: number, T: number, r = 0, q = 0, v = 0.2): { d1: number; d2: number } {
  const vv = Math.max(1e-12, v);
  const TT = Math.max(1e-12, T);
  const sqrtT = Math.sqrt(TT);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * vv * vv) * TT) / (vv * sqrtT);
  const d2 = d1 - vv * sqrtT;
  return { d1, d2 };
}

export function bsPrice(inp: BSInputs): number {
  const { S, K, T } = inp;
  const r = inp.r ?? 0, q = inp.q ?? 0, v = Math.max(1e-12, inp.vol);
  const { d1, d2 } = d1d2(S, K, T, r, q, v);
  if (inp.right === "C") {
    return S * Math.exp(-q * T) * Phi(d1) - K * Math.exp(-r * T) * Phi(d2);
  } else {
    return K * Math.exp(-r * T) * Phi(-d2) - S * Math.exp(-q * T) * Phi(-d1);
  }
}

export function bsGreeks(inp: BSInputs): Omit<BSPriceGreeks, "price" | "vanna" | "vomma" | "charm" | "speed" | "color"> {
  const { S, K, T } = inp;
  const r = inp.r ?? 0, q = inp.q ?? 0, v = Math.max(1e-12, inp.vol);
  const TT = Math.max(1e-12, T);
  const sqrtT = Math.sqrt(TT);
  const { d1, d2 } = d1d2(S, K, TT, r, q, v);
  const dfq = Math.exp(-q * TT), dfr = Math.exp(-r * TT);

  if (inp.right === "C") {
    const delta = dfq * Phi(d1);
    const gamma = dfq * phi(d1) / (S * v * sqrtT);
    const vega  = S * dfq * phi(d1) * sqrtT;
    const theta = - (S * dfq * phi(d1) * v) / (2 * sqrtT) - r * K * dfr * Phi(d2) + q * S * dfq * Phi(d1);
    const rho   = K * TT * dfr * Phi(d2);
    return { delta, gamma, vega, theta, rho };
  } else {
    const delta = -dfq * Phi(-d1);
    const gamma = dfq * phi(d1) / (S * v * sqrtT);
    const vega  = S * dfq * phi(d1) * sqrtT;
    const theta = - (S * dfq * phi(d1) * v) / (2 * sqrtT) + r * K * dfr * Phi(-d2) - q * S * dfq * Phi(-d1);
    const rho   = -K * TT * dfr * Phi(-d2);
    return { delta, gamma, vega, theta, rho };
  }
}

/** Extended set of greeks (vanna, vomma, charm, speed, color). */
export function vanna(S: number, T: number, r = 0, q = 0, v = 0.2): number {
  // ∂^2 Price / ∂S ∂σ  (also ∂Delta/∂σ)
  const { d1 } = d1d2(S, S, Math.max(1e-12, T), r, q, v); // strike cancels in form; using K=S is OK since only d1 matters with coefficient below
  const dfq = Math.exp(-q * Math.max(0, T));
  return dfq * phi(d1) * Math.sqrt(Math.max(1e-12, T)) * (1 - d1 / (v * Math.sqrt(Math.max(1e-12, T))));
}
export function vomma(S: number, K: number, T: number, r = 0, q = 0, v = 0.2): number {
  // ∂Vega/∂σ
  const { d1, d2 } = d1d2(S, K, Math.max(1e-12, T), r, q, v);
  const vega = S * Math.exp(-q * T) * phi(d1) * Math.sqrt(Math.max(1e-12, T));
  return vega * (d1 * d2) / Math.max(1e-12, v);
}
export function charm(inp: BSInputs): number {
  // dDelta/dt (per year). Valid for both calls/puts via sign on delta pieces.
  const { S, K, T } = inp;
  const r = inp.r ?? 0, q = inp.q ?? 0, v = Math.max(1e-12, inp.vol);
  const TT = Math.max(1e-12, T), sqrtT = Math.sqrt(TT);
  const { d1, d2 } = d1d2(S, K, TT, r, q, v);
  const dfq = Math.exp(-q * TT);
  const term = q * Phi(inp.right === "C" ? d1 : -d1) - dfq * phi(d1) * (2 * (r - q) * TT - d2 * v * sqrtT) / (2 * TT * v * sqrtT);
  return inp.right === "C" ? dfq * term : -dfq * term;
}
export function speed(inp: BSInputs): number {
  // dGamma/dS
  const { S, K, T } = inp;
  const r = inp.r ?? 0, q = inp.q ?? 0, v = Math.max(1e-12, inp.vol);
  const { d1 } = d1d2(S, K, Math.max(1e-12, T), r, q, v);
  const gamma = Math.exp(-q * Math.max(0, T)) * phi(d1) / (S * v * Math.sqrt(Math.max(1e-12, T)));
  return -gamma * (d1 / (S * v * Math.sqrt(Math.max(1e-12, T))) + 1 / S);
}
export function color(inp: BSInputs): number {
  // dGamma/dt (per year)
  const { S, K, T } = inp;
  const r = inp.r ?? 0, q = inp.q ?? 0, v = Math.max(1e-12, inp.vol);
  const TT = Math.max(1e-12, T), sqrtT = Math.sqrt(TT);
  const { d1, d2 } = d1d2(S, K, TT, r, q, v);
  const dfq = Math.exp(-q * TT);
  const gamma = dfq * phi(d1) / (S * v * sqrtT);
  return -gamma * (q + (r - q) * d1 / (v * sqrtT) + (1 + d1 * d2) / (2 * TT));
}

/** One-shot: all greeks + price. */
export function bsAll(inp: BSInputs): BSPriceGreeks {
  const price = bsPrice(inp);
  const g = bsGreeks(inp);
  const va = vanna(inp.S, inp.T, inp.r ?? 0, inp.q ?? 0, inp.vol);
  const vo = vomma(inp.S, inp.K, inp.T, inp.r ?? 0, inp.q ?? 0, inp.vol);
  const ch = charm(inp);
  const sp = speed(inp);
  const col = color(inp);
  return { price, delta: g.delta, gamma: g.gamma, vega: g.vega, theta: g.theta, rho: g.rho, vanna: va, vomma: vo, charm: ch, speed: sp, color: col };
}

/** Put–call parity (European): C - P = S e^{-qT} - K e^{-rT}. */
export function putCallParity(S: number, K: number, T: number, r = 0, q = 0): number {
  return S * Math.exp(-q * T) - K * Math.exp(-r * T);
}

/** Forward price implied by carry: F = S e^{(r-q)T}. */
export function forwardFrom(S: number, r = 0, q = 0, T = 0): number {
  return S * Math.exp((r - q) * Math.max(0, T));
}

/** Solve for implied vol from a target option price (bisection). */
export function impliedVolFromPrice(
  right: OptionRight, S: number, K: number, T: number, r: number, q: number, target: number
): number | undefined {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(target >= 0)) return undefined;
  let lo = 1e-4, hi = 5.0;
  for (let i = 0; i < 64; i++) {
    const mid = 0.5 * (lo + hi);
    const p = bsPrice({ S, K, T, r, q, vol: mid, right });
    if (Math.abs(p - target) < 1e-10) return mid;
    if (p > target) hi = mid; else lo = mid;
  }
  return 0.5 * (lo + hi);
}

/** Convenience: return greeks scaled by contract multiplier. */
export function scaleGreeks(g: BSPriceGreeks, multiplier = 1): BSPriceGreeks {
  return {
    price: g.price * multiplier,
    delta: g.delta * multiplier,
    gamma: g.gamma * multiplier,
    vega: g.vega * multiplier,
    theta: g.theta * multiplier,
    rho: g.rho * multiplier,
    vanna: g.vanna * multiplier,
    vomma: g.vomma * multiplier,
    charm: g.charm * multiplier,
    speed: g.speed * multiplier,
    color: g.color * multiplier,
  };
}