// options/margin.ts
// Pure TS (no imports). Margin utilities for OPTIONS portfolios.
//
// What’s inside
// - Types for specs, positions, prices/vols, greeks
// - Simplified Reg-T style margin for SHORT options (longs are paid-in-full)
// - SPAN-lite portfolio scan using either BS repricing or (Δ,Γ,ν) greeks
// - Margin check & a greedy liquidation planner
//
// Notes
// - This is a pragmatic approximation (good for backtests / risk guards).
// - Reg-T rules implemented are the common broker formulae (no complex offsets).
// - SPAN-lite scans absolute underlying % shocks and optional vol shocks.
// - Multiplier applies to premium/PNL per contract (e.g., 100 for equity options).

export type ISODate = string; // "YYYY-MM-DD"
export type Right = "C" | "P";

export type OptionSpec = {
  symbol: string;          // option symbol key (e.g., AAPL-2025-01-17-C-180)
  underlying: string;      // underlying symbol (e.g., AAPL)
  right: Right;
  strike: number;
  expiryISO: ISODate;
  multiplier: number;      // e.g., 100
};

export type Position = {
  symbol: string;          // option symbol
  qty: number;             // signed: >0 long, <0 short
  avgPx?: number;          // premium (not needed for margin but useful)
};

export type UnderlyingPx = { underlying: string; price: number };
export type UnderlyingState = { underlying: string; price: number; iv?: number; r?: number; q?: number; T?: number };

export type Portfolio = {
  cash?: number;
  equity?: number;
  positions: Record<string, Position>;
  specs: Record<string, OptionSpec>;
};

export type Greeks = { delta: number; gamma: number; vega: number }; // per 1.0 vol (not %), per 1 underlying unit

export type ChainState = {
  /** Current underlyings; iv is annualized (decimal), r/q cont. */
  underlyings: UnderlyingState[];
  /** Optional per-option greeks (if omitted, engine can Black–Scholes compute if T/iv/r/q present). */
  greeks?: Record<string, Greeks>;
};

export type RegTBreakdown = {
  bySymbol: Record<string, {
    qtyShort: number;
    priceRef: number;       // underlying ref (S)
    otm: number;            // out-of-the-money amount per share
    requirementPer: number; // currency per short contract
    requirement: number;    // total for that symbol
  }>;
  totals: {
    shortCount: number;
    requirement: number;
  };
};

export type ScanParams = {
  /** Absolute underlying price shocks (e.g., [-0.12, -0.08, 0.08, 0.12]). */
  pricePct: number[];
  /** Volatility shocks (additive in vol, e.g., [-0.1, +0.1]); optional. */
  volAbs?: number[];
  /** Use "bs" to reprice (needs iv, T, r, q) or "greeks" to use ΔΓν approximation. */
  method?: "bs" | "greeks";
  /** Per-contract floor requirement (>=0). Applied after scan as floor. */
  perContractFloor?: number;
};

export type SpanLikeResult = {
  worstLoss: number;                // worst portfolio PnL across scenarios (>=0)
  scenarioPnL: { dS: number; dVol: number; pnl: number }[];
  required: {
    span: number;                   // max(worstLoss, floor)
    total: number;                  // (span only here; add-ons could be added if you extend)
  };
};

export type MarginCheck = {
  equity: number;
  regT: number;
  span: number;
  used: number;          // max(regT, span)
  excess: number;
  deficit: number;
  utilization: number;   // used / max(equity,1)
};

/* ========== Mini Black–Scholes (C/P) for repricing ========== */

function Phi(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + p * z);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}
function phi(x: number): number { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

function d1d2(S: number, K: number, T: number, r: number, q: number, v: number): { d1: number; d2: number } {
  const vv = Math.max(1e-12, v), TT = Math.max(1e-12, T), sqrtT = Math.sqrt(TT);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * vv * vv) * TT) / (vv * sqrtT);
  return { d1, d2: d1 - vv * sqrtT };
}
function bsPrice(right: Right, S: number, K: number, T: number, r: number, q: number, v: number): number {
  const { d1, d2 } = d1d2(S, K, T, r, q, v);
  if (right === "C") return S * Math.exp(-q * T) * Phi(d1) - K * Math.exp(-r * T) * Phi(d2);
  return K * Math.exp(-r * T) * Phi(-d2) - S * Math.exp(-q * T) * Phi(-d1);
}
function bsGreeks(S: number, K: number, T: number, r: number, q: number, v: number, right: Right): Greeks {
  const { d1, d2 } = d1d2(S, K, T, r, q, v);
  const dfq = Math.exp(-q * Math.max(0, T));
  const sqrtT = Math.sqrt(Math.max(1e-12, T));
  const gamma = dfq * phi(d1) / (S * v * sqrtT);
  const vega  = S * dfq * phi(d1) * sqrtT; // per 1.0 vol
  const delta = right === "C" ? dfq * Phi(d1) : -dfq * Phi(-d1);
  return { delta, gamma, vega };
}

/* ========== Helpers ========== */

function round2(x: number): number { return Math.round((x + 1e-12) * 100) / 100; }
function abs(x: number): number { return x < 0 ? -x : x; }
function max(a: number, b: number): number { return a > b ? a : b; }
function isNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }

function mapUnderlyings(us: UnderlyingState[]): Record<string, UnderlyingState> {
  const m: Record<string, UnderlyingState> = {};
  for (const u of us) m[u.underlying] = u;
  return m;
}

/* ========== Reg-T style requirement for SHORT options ========== */
/**
 * Approximate broker rule:
 *  Short CALL: premium + max( 20% * S  - OTM,  10% * S ) * multiplier
 *  Short PUT:  premium + max( 20% * S  - OTM,  10% * K ) * multiplier
 *  Long options are paid in full (no additional margin beyond premium).
 *  OTM for call = max(0, K - S), for put = max(0, S - K). S = underlying price per share.
 *
 * Returns 0 for longs. S and premium are not looked up here — this function uses only S for OTM term;
 * you’ll typically overlay with cash/equity from the ledger for the paid premium effects.
 */
export function regTRequirement(
  portfolio: Portfolio,
  underlyings: UnderlyingPx[],
  premiumPerContract?: Record<string, number> // optional: current mid premium to include in requirement term; if omitted we ignore premium add-on
): RegTBreakdown {
  const bySymbol: RegTBreakdown["bySymbol"] = {};
  const um = mapUnderlyings(underlyings);
  let total = 0, shorts = 0;

  for (const sym of Object.keys(portfolio.positions)) {
    const pos = portfolio.positions[sym];
    if (!pos || pos.qty >= 0) continue; // only shorts need Reg-T margin here
    const spec = portfolio.specs[sym];
    if (!spec) continue;
    const S = um[spec.underlying]?.price || 0;
    if (!(S > 0)) continue;

    const qAbs = abs(pos.qty);
    const mult = spec.multiplier || 1;
    const otm = spec.right === "C" ? max(0, spec.strike - S) : max(0, S - spec.strike);
    const prem = isNum(premiumPerContract?.[sym]) ? premiumPerContract![sym]! : 0;

    const base = 0.2 * S - otm; // per share
    const alt  = spec.right === "C" ? 0.1 * S : 0.1 * spec.strike;
    const addPerShare = max(base, alt);
    const perContract = prem * mult + max(0, addPerShare) * mult;

    const requirement = round2(qAbs * perContract);
    bySymbol[sym] = {
      qtyShort: -pos.qty,
      priceRef: S,
      otm,
      requirementPer: round2(perContract),
      requirement,
    };
    total += requirement;
    shorts += qAbs;
  }

  return {
    bySymbol,
    totals: { shortCount: shorts, requirement: round2(total) },
  };
}

/* ========== SPAN-lite scan using either BS or greeks ========== */

export function spanLikeOptions(
  portfolio: Portfolio,
  chain: ChainState,
  params: ScanParams
): SpanLikeResult {
  const method = params.method || "greeks";
  const um = mapUnderlyings(chain.underlyings);
  const shocksS = (params.pricePct || []).slice().sort((a, b) => a - b);
  const shocksV = (params.volAbs && params.volAbs.length ? params.volAbs : [0]);

  const scenarios: { dS: number; dVol: number; pnl: number }[] = [];

  for (const dS of shocksS) {
    for (const dVol of shocksV) {
      let pnl = 0;

      for (const sym of Object.keys(portfolio.positions)) {
        const pos = portfolio.positions[sym];
        if (!pos || pos.qty === 0) continue;
        const spec = portfolio.specs[sym];
        if (!spec) continue;

        const u = um[spec.underlying];
        if (!u || !(u.price > 0)) continue;

        const mult = spec.multiplier || 1;
        const qty = pos.qty;

        if (method === "bs") {
          // Need iv/T; fall back to greeks if missing
          const iv0 = isNum(u.iv) ? u.iv! : undefined;
          const T0  = isNum(u.T)  ? u.T!  : undefined;
          const r   = isNum(u.r)  ? u.r!  : 0;
          const q   = isNum(u.q)  ? u.q!  : 0;

          if (isNum(iv0) && isNum(T0)) {
            const S0 = u.price, S1 = S0 * (1 + dS);
            const v0 = iv0 as number, v1 = Math.max(1e-6, v0 + (dVol || 0));
            const p0 = bsPrice(spec.right, S0, spec.strike, T0, r, q, v0);
            const p1 = bsPrice(spec.right, S1, spec.strike, Math.max(0, T0), r, q, v1);
            pnl += (p1 - p0) * mult * qty;
          } else {
            // fallback to greeks approximation
            const g = chain.greeks?.[sym] || bsGreeks(u.price, spec.strike, u.T ?? 0.25, u.r ?? 0, u.q ?? 0, u.iv ?? 0.2, spec.right);
            const S = u.price, dSabs = dS * S, dV = dVol || 0;
            const dP = g.delta * dSabs + 0.5 * g.gamma * dSabs * dSabs + g.vega * dV;
            pnl += dP * mult * qty;
          }
        } else {
          // Greeks approximation
          const g = chain.greeks?.[sym] || bsGreeks(u.price, spec.strike, u.T ?? 0.25, u.r ?? 0, u.q ?? 0, u.iv ?? 0.2, spec.right);
          const S = u.price, dSabs = dS * S, dV = dVol || 0;
          const dP = g.delta * dSabs + 0.5 * g.gamma * dSabs * dSabs + g.vega * dV;
          pnl += dP * mult * qty;
        }
      }

      scenarios.push({ dS, dVol, pnl: round2(pnl) });
    }
  }

  // Worst-case LOSS (>=0)
  const worstPnl = scenarios.reduce((m, s) => Math.min(m, s.pnl), +Infinity);
  const worstLoss = worstPnl === +Infinity ? 0 : round2(-Math.min(0, worstPnl));

  // Floor based on per-contract minimum
  let contractsOpen = 0;
  for (const sym of Object.keys(portfolio.positions)) contractsOpen += abs(portfolio.positions[sym]?.qty || 0);
  const floor = round2(max(0, (params.perContractFloor || 0) * contractsOpen));

  const span = round2(max(worstLoss, floor));
  return {
    worstLoss,
    scenarioPnL: scenarios,
    required: { span, total: span },
  };
}

/* ========== Combined check (Reg-T vs SPAN-lite) ========== */

export function checkMargin(
  portfolio: Portfolio,
  underlyings: UnderlyingPx[],
  chain: ChainState,
  params: ScanParams,
  premiumPerContract?: Record<string, number>
): MarginCheck {
  const equity = round2(portfolio.equity ?? portfolio.cash ?? 0);

  const regT = regTRequirement(portfolio, underlyings, premiumPerContract).totals.requirement;
  const span = spanLikeOptions(portfolio, chain, params).required.total;

  const used = round2(max(regT, span));
  const excess = round2(equity - used);
  const deficit = round2(max(0, used - equity));
  const utilization = used > 0 ? round2(used / max(1, equity)) : 0;

  return { equity, regT, span, used, excess, deficit, utilization };
}

/* ========== Greedy liquidation planner (reduce margin fast) ========== */
/**
 * Close contracts that save the most Reg-T per lot first (simple + fast).
 * Returns suggested {symbol, qtyToClose}.
 */
export function planLiquidationRegT(
  portfolio: Portfolio,
  underlyings: UnderlyingPx[],
  targetReduction: number,
  premiumPerContract?: Record<string, number>
): { symbol: string; qtyToClose: number }[] {
  if (!(targetReduction > 0)) return [];
  type Cand = { symbol: string; qtyAvail: number; savePer: number };
  const rt = regTRequirement(portfolio, underlyings, premiumPerContract);
  const cands: Cand[] = [];

  for (const sym of Object.keys(rt.bySymbol)) {
    const b = rt.bySymbol[sym];
    const qtyAvail = b.qtyShort;
    const savePer = b.requirementPer; // per short contract
    if (qtyAvail > 0 && savePer > 0) cands.push({ symbol: sym, qtyAvail, savePer });
  }
  cands.sort((a, b) => b.savePer - a.savePer);

  const closes: { symbol: string; qtyToClose: number }[] = [];
  let reduced = 0;
  for (const c of cands) {
    if (reduced >= targetReduction) break;
    const need = Math.ceil((targetReduction - reduced) / c.savePer);
    const take = Math.min(need, c.qtyAvail);
    if (take > 0) {
      closes.push({ symbol: c.symbol, qtyToClose: take });
      reduced += take * c.savePer;
    }
  }
  return closes;
}

/* ========== Pretty summary ========== */

export function summarizeCheck(m: MarginCheck): string {
  return `Equity=${m.equity.toFixed(2)} Used=${m.used.toFixed(2)} (RegT=${m.regT.toFixed(2)} | SPAN=${m.span.toFixed(2)}) ` +
         `Excess=${m.excess.toFixed(2)} Def=${m.deficit.toFixed(2)} Util=${(m.utilization * 100).toFixed(1)}%`;
}