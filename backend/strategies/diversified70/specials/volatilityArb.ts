// specials/volatilityarb.ts
// Pure TypeScript utilities for Volatility & Variance Arbitrage.
// No imports. Single-file drop-in. Numerically careful for daily/hourly use.
//
// Contents
// - Normal pdf/cdf, Black–Scholes (price & Greeks), forwards
// - Implied vol via Brent/Newton hybrid
// - Realized volatility estimators (close-close, Parkinson, Garman–Klass, Rogers–Satchell, Yang–Zhang-lite)
// - Variance/vol swap fair strikes (close-close proxy), convexity adjustments
// - Carry & PnL decompositions (theta–gamma–vega with realized var)
// - Simple delta-hedged PnL simulator
// - Skew/term-structure metrics & micro surface helpers (moneyness grid, linear interp)

export type Num = number;

export type OptionType = "C" | "P";

export type Greeks = {
  delta: number;
  gamma: number;
  vega: number;   // per 1 vol point = 0.01? (here per 1.00 = 100 vol pts). See note below.
  theta: number;  // per year
  rho: number;
};

export type BSResult = {
  price: number;
  greeks: Greeks;
  d1: number;
  d2: number;
};

const TWO_PI = 2 * Math.PI;
const INV_SQRT_2 = 1 / Math.sqrt(2);

// --- Guards ---
function isFiniteNumber(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// --- Normal pdf / cdf (Acklam-ish approx for Phi) ---
export function nPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export function nCdf(x: number): number {
  // Abramowitz–Stegun approx for Phi
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const a1 = 0.319381530,
    a2 = -0.356563782,
    a3 = 1.781477937,
    a4 = -1.821255978,
    a5 = 1.330274429;
  const poly = ((((a5 * k + a4) * k + a3) * k + a2) * k + a1) * k;
  const phi = 1 - nPdf(x) * poly;
  return x >= 0 ? phi : 1 - phi;
}

// --- Forwards & discounting ---
/**
 * Forward price under continuous rates:
 *  F = S * exp((r - q) * T)
 *  r : risk-free cont. rate, q : dividend yield (or carry)
 *  T : years
 */
export function forwardFromSpot(S: number, T: number, r: number = 0, q: number = 0): number {
  return S * Math.exp((r - q) * T);
}

// --- Black–Scholes (European) ---
/**
 * Returns price and greeks. Assumes:
 *  S : spot
 *  K : strike
 *  T : time in years
 *  r : cont. risk-free
 *  q : cont. dividend/borrow
 *  vol : annualized implied volatility (decimal, e.g., 0.25)
 *
 * Notes:
 *  - vega here is per +1.00 in vol (i.e., 100 vol points). For per 1 vol point (0.01), divide by 100.
 */
export function blackScholes(opt: OptionType, S: number, K: number, T: number, r: number, q: number, vol: number): BSResult {
  if (!(isFiniteNumber(S) && isFiniteNumber(K) && isFiniteNumber(T) && isFiniteNumber(vol)) || S <= 0 || K <= 0 || T <= 0 || vol <= 0) {
    return { price: NaN, greeks: { delta: NaN, gamma: NaN, vega: NaN, theta: NaN, rho: NaN }, d1: NaN, d2: NaN };
  }
  const sqrtT = Math.sqrt(T);
  const F = forwardFromSpot(S, T, r, q); // S*e^{(r-q)T}
  const df = Math.exp(-r * T);
  const dq = Math.exp(-q * T);

  const d1 = (Math.log(F / K) + 0.5 * vol * vol * T) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;

  const Nd1 = nCdf(opt === "C" ? d1 : -d1);
  const Nd2 = nCdf(opt === "C" ? d2 : -d2);

  const priceForward = (opt === "C" ? (F * nCdf(d1) - K * nCdf(d2)) : (K * nCdf(-d2) - F * nCdf(-d1)));
  const price = df * priceForward;

  // Greeks (spot/forward form; convert where needed)
  const pdfd1 = nPdf(d1);
  const gamma = (dq * pdfd1) / (S * vol * sqrtT);
  const vega = S * dq * pdfd1 * sqrtT; // per 1.00 vol
  const delta = (opt === "C" ? dq * nCdf(d1) : -dq * nCdf(-d1));
  const theta =
    -0.5 * S * dq * pdfd1 * vol / sqrtT // time decay
    + (opt === "C" ? (q * S * dq * nCdf(d1) - r * K * df * nCdf(d2))
                   : (-q * S * dq * nCdf(-d1) + r * K * df * nCdf(-d2)));
  const rho = (opt === "C" ? (K * T * df * nCdf(d2)) : (-K * T * df * nCdf(-d2)));

  return { price, greeks: { delta, gamma, vega, theta, rho }, d1, d2 };
}

// --- Implied volatility (Brent/Newton hybrid) ---
export type IVOptions = {
  tol?: number;          // price tolerance
  maxIter?: number;
  volLower?: number;     // absolute bounds (e.g., 1e-4)
  volUpper?: number;     // e.g., 5.0 (500% vol)
};

export function impliedVol(opt: OptionType, S: number, K: number, T: number, r: number, q: number, targetPx: number, opts?: IVOptions): number {
  const tol = opts?.tol ?? 1e-8;
  const maxIter = opts?.maxIter ?? 100;
  let lo = Math.max(1e-6, opts?.volLower ?? 1e-6);
  let hi = Math.max(lo * 2, opts?.volUpper ?? 5.0);

  // Ensure target is within price at bounds; expand hi if needed
  for (let i = 0; i < 30; i++) {
    const plo = blackScholes(opt, S, K, T, r, q, lo).price;
    const phi = blackScholes(opt, S, K, T, r, q, hi).price;
    if (!isFiniteNumber(plo) || !isFiniteNumber(phi)) break;
    if ((targetPx - plo) * (targetPx - phi) <= 0) break;
    hi *= 2;
    if (hi > 10) break;
  }

  let v = Math.sqrt(2 * Math.abs(Math.log(S / K)) / Math.max(1e-12, T)); // rough seed
  v = clamp(v, lo, hi);

  let pv = 0;
  for (let iter = 0; iter < maxIter; iter++) {
    const res = blackScholes(opt, S, K, T, r, q, v);
    const diff = res.price - targetPx;
    if (Math.abs(diff) < tol) return v;

    // Newton step if vega reasonable; else bisection
    const vega = res.greeks.vega; // per 1.00 vol
    if (isFiniteNumber(vega) && Math.abs(vega) > 1e-10) {
      pv = v;
      v = v - diff / vega;
      if (!isFiniteNumber(v) || v <= lo || v >= hi) {
        // fallback to bisection using sign of diff
        if (diff > 0) hi = Math.min(hi, pv);
        else lo = Math.max(lo, pv);
        v = 0.5 * (lo + hi);
      }
    } else {
      // bisection
      const plo = blackScholes(opt, S, K, T, r, q, lo).price - targetPx;
      if (plo * diff < 0) { hi = v; } else { lo = v; }
      v = 0.5 * (lo + hi);
    }
    if (hi - lo < 1e-6) return v;
  }
  return v; // best effort
}

// --- Realized volatility estimators ---
// Inputs are arrays from oldest -> newest.
// All vol outputs are ANNUALIZED (trading year = 252) unless specified.

export type OHLC = { o: number; h: number; l: number; c: number; prevClose?: number };

export function closeCloseRV(returns: number[], tradingDays: number = 252): number {
  // simple realized variance: sum(r^2) * (tradingDays / N)
  let s2 = 0, n = 0;
  for (let i = 0; i < returns.length; i++) {
    const r = returns[i];
    if (!isFiniteNumber(r)) continue;
    s2 += r * r; n++;
  }
  if (n === 0) return NaN;
  return (s2 / n) * tradingDays;
}

export function parkinsonRV(highs: number[], lows: number[], tradingDays: number = 252): number {
  // σ^2 ≈ (1/(4 ln 2)) * mean( ln(H/L)^2 ) * tradingDays
  const k = 1 / (4 * Math.log(2));
  let s = 0, n = 0;
  for (let i = 0; i < Math.min(highs.length, lows.length); i++) {
    const H = highs[i], L = lows[i];
    if (!isFiniteNumber(H) || !isFiniteNumber(L) || H <= 0 || L <= 0) continue;
    const x = Math.log(H / L);
    s += x * x; n++;
  }
  if (n === 0) return NaN;
  return k * (s / n) * tradingDays;
}

export function garmanKlassRV(ohlc: OHLC[], tradingDays: number = 252): number {
  // GK: 0.5*(ln(H/L))^2 - (2ln2 -1)*(ln(C/O))^2
  const a = 0.5, b = (2 * Math.log(2) - 1);
  let s = 0, n = 0;
  for (let i = 0; i < ohlc.length; i++) {
    const { o, h, l, c } = ohlc[i];
    if (!isFiniteNumber(o) || !isFiniteNumber(h) || !isFiniteNumber(l) || !isFiniteNumber(c) || o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
    const u = Math.log(h / l);
    const v = Math.log(c / o);
    s += a * u * u - b * v * v;
    n++;
  }
  if (n === 0) return NaN;
  return (s / n) * tradingDays;
}

export function rogersSatchellRV(ohlc: OHLC[], tradingDays: number = 252): number {
  // RS: mean[ ln(H/C)*ln(H/O) + ln(L/C)*ln(L/O) ]
  let s = 0, n = 0;
  for (let i = 0; i < ohlc.length; i++) {
    const { o, h, l, c } = ohlc[i];
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
    const term = Math.log(h / c) * Math.log(h / o) + Math.log(l / c) * Math.log(l / o);
    s += term; n++;
  }
  if (n === 0) return NaN;
  return (s / n) * tradingDays;
}

export function realizedVolFromVariance(rv: number): number {
  // rv is annualized variance; return annualized volatility
  return rv > 0 ? Math.sqrt(rv) : NaN;
}

// --- Variance/Vol swap fair strikes ---
// Basic proxy using close-close realized; for intraday-aware, prefer RS/GK blends.
// K_var ≈ E[RV]; K_vol ≈ sqrt(E[RV]) + convexity adj (Jensen).
export function fairVarianceSwapStrike(returns: number[], tradingDays: number = 252): number {
  return closeCloseRV(returns, tradingDays);
}

export function fairVolSwapStrike(returns: number[], tradingDays: number = 252): number {
  const rv = fairVarianceSwapStrike(returns, tradingDays);
  // Jensen/convexity: E[σ] ≈ sqrt(E[σ^2]) - (Var(σ^2))/(8 (E[σ^2])^{3/2}) ~ ignore w/o higher moments.
  return realizedVolFromVariance(rv);
}

// --- Carry & theta–gamma approximation ---
// For a single European option over a short horizon Δt:
// dV ≈ theta*Δt + 0.5*gamma*S^2*(dX^2 - vol^2*Δt) + vega*(dIV)
// If delta-hedged: drop delta*dS term.
export type CarryDecomp = {
  expectedCarry: number;    // theta * dt  (risk-neutral expectation)
  gammaConvexity: number;   // 0.5*gamma*S^2*(realizedVar - impVar)*dt
  vegaImpact: number;       // vega * dIV (user-supplied)
  total: number;
};

export function carryApprox(
  S: number, opt: OptionType, K: number, T: number, r: number, q: number, impVol: number,
  dtYears: number,
  realizedVarAnn: number,                  // realized variance annualized over dt horizon
  dIV: number = 0                          // change in implied vol (absolute, e.g., -0.01)
): CarryDecomp {
  const bs = blackScholes(opt, S, K, T, r, q, impVol);
  if (!isFiniteNumber(bs.price)) return { expectedCarry: NaN, gammaConvexity: NaN, vegaImpact: NaN, total: NaN };
  const { theta, gamma, vega } = bs.greeks;
  const expCarry = theta * dtYears;
  const impVar = impVol * impVol; // annualized
  const gammaTerm = 0.5 * gamma * S * S * (realizedVarAnn - impVar) * dtYears;
  const vegaTerm = vega * dIV;
  const total = expCarry + gammaTerm + vegaTerm;
  return { expectedCarry: expCarry, gammaConvexity: gammaTerm, vegaImpact: vegaTerm, total };
}

// --- Delta-hedged PnL simulation ---
// Simulate discrete delta hedging of one option over price path S_t and (option) IV_t.
// Returns PnL (in currency) and per-step components.
export type HedgedStep = {
  t: number;                 // index
  S: number;
  iv: number;
  optPrice: number;
  delta: number;
  dStockPnl: number;
  dOptionPnl: number;
  dHedgeRebalance: number;   // cost to rebalance delta (cashflow)
  pnlCum: number;
};

export type HedgeSimResult = {
  steps: HedgedStep[];
  totalPnl: number;
};

export function simulateDeltaHedge(
  opt: OptionType,
  K: number,
  r: number,
  q: number,
  T0: number,                 // initial years to expiry
  S: number[],
  iv: number[],               // per step IV (same length as S)
  dtYears: number             // step size in years
): HedgeSimResult {
  const n = Math.min(S.length, iv.length);
  const steps: HedgedStep[] = [];
  if (n < 2) return { steps, totalPnl: 0 };

  // start
  let T = T0;
  let prevS = S[0];
  let prevIV = iv[0];
  let bs0 = blackScholes(opt, prevS, K, T, r, q, prevIV);
  let optPos = 1; // long one option
  let delta = bs0.greeks.delta * optPos;
  let hedge = -delta; // shares
  let cash = -bs0.price * optPos; // pay for option
  let pnlCum = 0;

  steps.push({
    t: 0, S: prevS, iv: prevIV, optPrice: bs0.price, delta,
    dStockPnl: 0, dOptionPnl: 0, dHedgeRebalance: 0, pnlCum
  });

  for (let i = 1; i < n; i++) {
    const Si = S[i];
    const ivi = iv[i];
    const Tnext = Math.max(0, T - dtYears);

    // Revalue option
    const bsi = blackScholes(opt, Si, K, Tnext, r, q, ivi);
    const optValue = bsi.price * optPos;
    const dOpt = optValue - steps[i - 1].optPrice * optPos;

    // Stock hedge PnL
    const dS = Si - prevS;
    const stockPnl = hedge * dS;

    // Rebalance hedge to new delta
    const newDelta = bsi.greeks.delta * optPos;
    const dHedge = -(newDelta - hedge) * Si; // cash cost to add shares (negative = outflow)
    cash += dHedge;

    // Cash accrual at r-q on net cash? For simplicity, ignore or add r * cash * dt
    const carryCash = r * cash * dtYears;
    cash += carryCash;

    pnlCum += dOpt + stockPnl + dHedge + carryCash;

    steps.push({
      t: i,
      S: Si,
      iv: ivi,
      optPrice: bsi.price,
      delta: newDelta,
      dStockPnl: stockPnl,
      dOptionPnl: dOpt,
      dHedgeRebalance: dHedge + carryCash,
      pnlCum
    });

    // advance
    prevS = Si; prevIV = ivi; hedge = newDelta; T = Tnext;
  }
  return { steps, totalPnl: pnlCum };
}

// --- Skew & Term-Structure helpers ---

export function moneyness(S: number, K: number, T: number, r: number = 0, q: number = 0): number {
  // log-moneyness under forward measure
  const F = forwardFromSpot(S, T, r, q);
  return Math.log(K / F);
}

// Simple 1D linear interpolation
export function linInterp1D(xs: number[], ys: number[], xq: number): number {
  if (xs.length !== ys.length || xs.length === 0) return NaN;
  const n = xs.length;
  if (xq <= xs[0]) return ys[0];
  if (xq >= xs[n - 1]) return ys[n - 1];
  for (let i = 1; i < n; i++) {
    if (xq <= xs[i]) {
      const w = (xq - xs[i - 1]) / (xs[i] - xs[i - 1]);
      return ys[i - 1] * (1 - w) + ys[i] * w;
    }
  }
  return ys[n - 1];
}

export type SmilePoint = { K: number; iv: number };
export type Smile = { T: number; points: SmilePoint[] };

/**
 * Interpolate IV for arbitrary (K, T) given a sparse surface.
 * 1) For each T-bracket, linearly interp across strikes in log-moneyness.
 * 2) Then linearly interp across T.
 */
export function interpIVSurface(S: number, r: number, q: number, smiles: Smile[], K: number, T: number): number {
  if (smiles.length === 0) return NaN;
  // sort by T
  const sm = smiles.slice().sort((a, b) => a.T - b.T);
  const Ts = sm.map(s => s.T);

  // Helper to get IV at a given T via strike interpolation
  function ivAt(Tx: number): number {
    // choose nearest smile or bracket interpolate by strike grid
    const smile = sm.find(s => Math.abs(s.T - Tx) < 1e-12) ?? sm.reduce((prev, curr) => Math.abs(curr.T - Tx) < Math.abs(prev.T - Tx) ? curr : prev);
    const pts = smile.points.slice().sort((a, b) => a.K - b.K);
    const xs: number[] = []; const ys: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const LM = moneyness(S, pts[i].K, Tx, r, q);
      xs.push(LM); ys.push(pts[i].iv);
    }
    const xq = moneyness(S, K, Tx, r, q);
    return linInterp1D(xs, ys, xq);
  }

  if (T <= Ts[0]) return ivAt(Ts[0]);
  if (T >= Ts[Ts.length - 1]) return ivAt(Ts[Ts.length - 1]);

  // bracket in time
  let tLo = Ts[0], tHi = Ts[Ts.length - 1];
  for (let i = 1; i < Ts.length; i++) {
    if (T <= Ts[i]) { tLo = Ts[i - 1]; tHi = Ts[i]; break; }
  }
  const ivLo = ivAt(tLo);
  const ivHi = ivAt(tHi);
  const w = (T - tLo) / (tHi - tLo);
  return (1 - w) * ivLo + w * ivHi;
}

// Skew slope: ∂IV/∂(log-moneyness) approx using two strikes
export function skewSlope(S: number, r: number, q: number, smile: Smile, K1: number, K2: number): number {
  const iv1 = linInterp1D(smile.points.map(p => moneyness(S, p.K, smile.T, r, q)),
                          smile.points.map(p => p.iv),
                          moneyness(S, K1, smile.T, r, q));
  const iv2 = linInterp1D(smile.points.map(p => moneyness(S, p.K, smile.T, r, q)),
                          smile.points.map(p => p.iv),
                          moneyness(S, K2, smile.T, r, q));
  const x1 = moneyness(S, K1, smile.T, r, q);
  const x2 = moneyness(S, K2, smile.T, r, q);
  if (!(isFiniteNumber(iv1) && isFiniteNumber(iv2) && x1 !== x2)) return NaN;
  return (iv2 - iv1) / (x2 - x1);
}

// Term-structure slope: ∂IV/∂T approx with two tenors at ATM K≈F
export function termStructureSlopeATM(S: number, r: number, q: number, smiles: Smile[], T1: number, T2: number): number {
  const F1 = forwardFromSpot(S, T1, r, q), F2 = forwardFromSpot(S, T2, r, q);
  const iv1 = interpIVSurface(S, r, q, smiles, F1, T1);
  const iv2 = interpIVSurface(S, r, q, smiles, F2, T2);
  if (!(isFiniteNumber(iv1) && isFiniteNumber(iv2) && T2 !== T1)) return NaN;
  return (iv2 - iv1) / (T2 - T1);
}

// --- Small helpers ---

/** Convert annualized vol to per-step variance for step size dtYears. */
export function stepVarianceFromVol(annVol: number, dtYears: number): number {
  return (annVol * annVol) * dtYears;
}

/** Convert array of prices to simple returns r_t = P_t / P_{t-1} - 1 */
export function simpleReturns(prices: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1], p1 = prices[i];
    out.push(isFiniteNumber(p0) && isFiniteNumber(p1) && p0 > 0 ? (p1 / p0 - 1) : NaN);
  }
  return out;
}

/** Log returns ln(P_t / P_{t-1}) */
export function logReturns(prices: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1], p1 = prices[i];
    out.push(isFiniteNumber(p0) && isFiniteNumber(p1) && p0 > 0 && p1 > 0 ? Math.log(p1 / p0) : NaN);
  }
  return out;
}

/** Quick VIX-like vol proxy from close-close returns over last N days. */
export function vixStyleProxy(returns: number[], lookback: number = 30, tradingDays: number = 252): number {
  const n = returns.length;
  const L = Math.max(0, n - lookback);
  const rv = closeCloseRV(returns.slice(L), tradingDays);
  return realizedVolFromVariance(rv);
}
