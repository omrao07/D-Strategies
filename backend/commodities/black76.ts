// commodities/black76.ts
// Standalone Black (1976) option model for options on futures/forwards.
// - Prices (call/put)
// - Greeks (deltaF, gammaF, vega, theta, rho)
// - Implied volatility via robust Newton–Raphson with safeguards
// No imports. Strict-TS friendly.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type CP = "call" | "put";

export interface Params {
  F: number;      // forward/futures price
  K: number;      // strike
  r: number;      // continuously compounded risk-free rate
  sigma: number;  // volatility (annualized, e.g., 0.25)
  T: number;      // time to expiry in years
  cp: CP;         // call/put
}

export interface PriceResult {
  price: number;          // option price
  d1: number;
  d2: number;
  df: number;             // discount factor e^{-rT}
}

export interface Greeks {
  deltaF: number;         // derivative vs Forward (NOT spot)
  gammaF: number;         // second derivative vs F
  vega: number;           // per 1.00 vol (not per 1%)
  theta: number;          // ∂Price/∂T (per year)
  rho: number;            // ∂Price/∂r
}

/** Guarded log */
function ln(x: number): number { return Math.log(Math.max(x, 1e-300)); }
function sqrt(x: number): number { return Math.sqrt(Math.max(x, 0)); }
function isCall(cp: CP): boolean { return cp === "call"; }
function sgn(cp: CP): number { return cp === "call" ? +1 : -1; }
function exp(x: number): number { return Math.exp(Math.max(Math.min(x, 700), -700)); } // avoid overflow
function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }

/** Standard normal PDF and CDF (Acklam/erf-style approximation). */
function nPdf(x: number): number {
  const a = 0.3989422804014327; // 1/sqrt(2π)
  return a * exp(-0.5 * x * x);
}
function nCdf(x: number): number {
  // Abramowitz-Stegun approximation via erf
  const z = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * z);
  const a1 = 0.319381530, a2 = -0.356563782, a3 = 1.781477937, a4 = -1.821255978, a5 = 1.330274429;
  const m = 1 - nPdf(z) * ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
  return x >= 0 ? m : 1 - m;
}

/** Core d1/d2 for Black76. */
export function d1(F: number, K: number, sigma: number, T: number): number {
  if (sigma <= 0 || T <= 0) return (F > K) ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return (ln(F / K) + 0.5 * sigma * sigma * T) / (sigma * sqrt(T));
}
export function d2(F: number, K: number, sigma: number, T: number): number {
  if (sigma <= 0 || T <= 0) return (F > K) ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return d1(F, K, sigma, T) - sigma * sqrt(T);
}

/** Black76 option price (discounted by df = e^{-rT}). */
export function black76Price({ F, K, r, sigma, T, cp }: Params): PriceResult {
  const Tpos = Math.max(T, 0);
  const df = exp(-r * Tpos);

  // Handle T=0 or sigma=0 by intrinsic value on forward (discounted)
  if (Tpos === 0 || sigma === 0) {
    const intrinsic = Math.max(sgn(cp) * (F - K), 0);
    return { price: df * intrinsic, d1: NaN, d2: NaN, df };
  }

  const _d1 = d1(F, K, sigma, Tpos);
  const _d2 = _d1 - sigma * sqrt(Tpos);

  if (isCall(cp)) {
    const price = df * (F * nCdf(_d1) - K * nCdf(_d2));
    return { price, d1: _d1, d2: _d2, df };
  } else {
    const price = df * (K * nCdf(-_d2) - F * nCdf(-_d1));
    return { price, d1: _d1, d2: _d2, df };
  }
}

/** Greeks for Black76 (with respect to forward F). */
export function black76Greeks(p: Params): Greeks {
  const { F, K, r, sigma, T, cp } = p;
  const res = black76Price(p);
  const df = res.df;

  if (T <= 0 || sigma === 0) {
    // Derivatives degenerate at expiry / zero vol
    const deltaIntrinsic = (isCall(cp) ? (F > K ? df : 0) : (F < K ? -df : 0));
    return { deltaF: deltaIntrinsic, gammaF: 0, vega: 0, theta: 0, rho: -T * res.price };
  }

  const srt = sigma * sqrt(T);
  const _d1 = res.d1;
  const _d2 = res.d2;
  const phi = nPdf(_d1);

  // Delta w.r.t. Forward (NOT spot):
  const deltaF = isCall(cp) ? df * nCdf(_d1) : -df * nCdf(-_d1);

  // Gamma w.r.t. Forward:
  const gammaF = df * phi / (F * srt);

  // Vega (per 1.00 vol):
  const vega = df * F * phi * sqrt(T);

  // Rho: since Price = df * A(F, K, sigma, T), holding F fixed ⇒ dP/dr = -T * Price
  const rho = -T * res.price;

  // Theta: ∂P/∂T at constant F (annualized). Use analytic expression.
  // For calls: θ = ∂df/∂T*(F N(d1) - K N(d2)) + df*[ F φ(d1) * ∂d1/∂T - K φ(d2) * ∂d2/∂T ]
  // where ∂df/∂T = -r df, and ∂d1/∂T = - (ln(F/K)/(2 T^(3/2) σ)) + (σ / (2√T))
  // A compact stable form uses: ∂d1/∂T = ( - (d2) / (2T) ) ; ∂d2/∂T = ∂d1/∂T - σ/(2√T)
  // Derivation yields:
  const term = isCall(cp)
    ? (F * nCdf(_d1) - K * nCdf(_d2))
    : (K * nCdf(-_d2) - F * nCdf(-_d1));
  const d1dT = -_d2 / (2 * T);
  const d2dT = d1dT - sigma / (2 * sqrt(T));
  const theta =
    (-r * df) * term +
    df * (F * phi * d1dT - K * nPdf(_d2) * d2dT);

  return { deltaF, gammaF, vega, theta, rho };
}

/** Implied volatility for a given option price using guarded Newton with fallbacks. */
export function black76ImpliedVol(
  targetPrice: number,
  F: number,
  K: number,
  r: number,
  T: number,
  cp: CP,
  guess = 0.3
): number {
  const df = exp(-r * Math.max(T, 0));
  const intrinsic = df * Math.max(sgn(cp) * (F - K), 0);
  const upperBound = df * F; // loose cap
  const P = clamp(targetPrice, intrinsic, upperBound);

  if (T <= 0) return 0;
  if (P <= intrinsic + 1e-12) return 0;

  let sigma = clamp(guess, 1e-6, 5.0);

  // Newton iterations
  for (let i = 0; i < 20; i++) {
    const { price } = black76Price({ F, K, r, sigma, T, cp });
    const diff = price - P;
    if (Math.abs(diff) < 1e-10) return sigma;

    const v = black76Greeks({ F, K, r, sigma, T, cp }).vega;
    if (v <= 1e-12) break;

    let step = diff / v;
    // clamp step for stability
    step = clamp(step, -0.5, 0.5);
    sigma = clamp(sigma - step, 1e-8, 5.0);
  }

  // Fallback: simple bisection
  let lo = 1e-8, hi = 5.0;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    const { price } = black76Price({ F, K, r, sigma: mid, T, cp });
    if (price > P) hi = mid; else lo = mid;
  }
  return 0.5 * (lo + hi);
}

// ---------- Convenience wrappers ----------

export function callPrice(F: number, K: number, r: number, sigma: number, T: number): number {
  return black76Price({ F, K, r, sigma, T, cp: "call" }).price;
}
export function putPrice(F: number, K: number, r: number, sigma: number, T: number): number {
  return black76Price({ F, K, r, sigma, T, cp: "put" }).price;
}
export function callGreeks(F: number, K: number, r: number, sigma: number, T: number): Greeks {
  return black76Greeks({ F, K, r, sigma, T, cp: "call" });
}
export function putGreeks(F: number, K: number, r: number, sigma: number, T: number): Greeks {
  return black76Greeks({ F, K, r, sigma, T, cp: "put" });
}

// ---------- Sanity check helper (optional) ----------
export function parityError(F: number, K: number, r: number, sigma: number, T: number): number {
  // For Black76, discounted parity: C - P = df * (F - K)
  const df = exp(-r * Math.max(T, 0));
  const c = callPrice(F, K, r, sigma, T);
  const p = putPrice(F, K, r, sigma, T);
  return (c - p) - df * (F - K);
}