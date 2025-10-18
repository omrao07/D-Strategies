// specials/mergerarb.ts
// Pure TypeScript utilities for merger-arbitrage math.
// No imports. Handles cash/stock/mix deals, collars, spreads, hedge sizing,
// carry (borrow & dividends), break/close probabilities, and simple PnL.

/** Basic number guard */
function isFiniteNumber(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export type Ticker = string;

export enum Consideration {
  CASH = "CASH",
  STOCK = "STOCK",
  MIX = "MIX",
}

export type RatioCollar =
  | { kind: "none" }
  | { kind: "ratio"; rMin: number; rMax: number }                       // ratio floats but clamped to [rMin, rMax]
  | { kind: "fixed_value"; value: number; pMin: number; pMax: number }; // delivers fixed value within band by floating ratio

export type MixBreakdown = {
  cashPerShare?: number;     // cash leg per target share (if any)
  stockRatio?: number;       // baseline exchange ratio (shares of acquirer per target)
  stockWeight?: number;      // optional weight (0..1) if deal proration-like (approx)
  cashWeight?: number;       // optional weight (0..1), default = 1 - stockWeight
  collar?: RatioCollar;      // optional collar on stock leg
};

export type Deal = {
  target: Ticker;
  acquirer?: Ticker;               // required for STOCK/MIX
  consideration: Consideration;
  cashPerShare?: number;           // for CASH
  exchangeRatio?: number;          // for STOCK (shares of acquirer per target)
  collar?: RatioCollar;            // for STOCK
  mix?: MixBreakdown;              // for MIX
  expectedCloseDays?: number;      // E[days to close]
  breakPrice?: number;             // user’s estimate of break value for target
};

export type CarryInputs = {
  daysToClose?: number;          // defaults to deal.expectedCloseDays
  borrowRateTarget?: number;     // annualized short borrow (decimal). If you SHORT target, cost is +rate
  borrowRateAcquirer?: number;   // if you LONG target/SHORT acquirer, this is the acquirer borrow
  divYieldTarget?: number;       // forward annual dividend yield (decimal)
  divYieldAcquirer?: number;     // forward annual dividend yield (decimal)
  longTarget?: boolean;          // position side; default true (long target/short acquirer hedge)
};

export type LiveState = {
  targetPx: number;
  acquirerPx?: number;           // required for STOCK/MIX pricing
};

// --------------------------- Core pricing ---------------------------

/** Effective stock ratio after collar rules */
export function effectiveRatio(
  baseRatio: number | undefined,
  acqPx: number,
  collar?: RatioCollar
): number {
  const r0 = isFiniteNumber(baseRatio) ? (baseRatio as number) : 0;
  if (!collar || collar.kind === "none") return r0;

  if (collar.kind === "ratio") {
    return clamp(r0, Math.max(0, collar.rMin), Math.max(r0, collar.rMax));
  }

  // Fixed-value collar: ratio floats to deliver 'value' in [pMin, pMax], then fixes at edges.
  // Inside band: ratio = value / acqPx. Below band: ratio = value / pMin. Above band: value / pMax.
  if (collar.kind === "fixed_value") {
    const { value, pMin, pMax } = collar;
    if (acqPx <= pMin) return value / pMin;
    if (acqPx >= pMax) return value / pMax;
    return value / acqPx;
  }

  return r0;
}

/** Implied value to a target share given current acquirer price */
export function impliedTakeoutValue(deal: Deal, acqPx?: number): number {
  if (deal.consideration === Consideration.CASH) {
    return isFiniteNumber(deal.cashPerShare) ? (deal.cashPerShare as number) : NaN;
  }
  if (deal.consideration === Consideration.STOCK) {
    if (!isFiniteNumber(acqPx)) return NaN;
    const rEff = effectiveRatio(deal.exchangeRatio, acqPx as number, deal.collar);
    return rEff * (acqPx as number);
  }
  // MIX
  if (!deal.mix) return NaN;
  const cashLeg = isFiniteNumber(deal.mix.cashPerShare) ? (deal.mix.cashPerShare as number) : 0;
  if (!isFiniteNumber(acqPx)) return NaN;
  const rEff = effectiveRatio(deal.mix.stockRatio, acqPx as number, deal.mix.collar);
  const sWeight = isFiniteNumber(deal.mix.stockWeight) ? (deal.mix.stockWeight as number) : 0.5;
  const cWeight = isFiniteNumber(deal.mix.cashWeight) ? (deal.mix.cashWeight as number) : (1 - sWeight);
  // Approx proration: weighted average of stock and cash components
  const stockValue = rEff * (acqPx as number);
  return cWeight * cashLeg + sWeight * stockValue;
}

/** Spread vs. market price of target: (implied - market) / market */
export function simpleSpread(targetPx: number, impliedValue: number): number {
  if (!isFiniteNumber(targetPx) || targetPx <= 0 || !isFiniteNumber(impliedValue)) return NaN;
  return (impliedValue - targetPx) / targetPx;
}

/** Gross to-close return (no carry): implied/market - 1 */
export function grossReturnToClose(targetPx: number, impliedValue: number): number {
  if (!isFiniteNumber(targetPx) || targetPx <= 0 || !isFiniteNumber(impliedValue)) return NaN;
  return impliedValue / targetPx - 1;
}

/** Annualize a holding return over given days */
export function annualize(ret: number, days: number): number {
  if (!isFiniteNumber(ret) || !isFiniteNumber(days) || days <= 0) return NaN;
  return Math.pow(1 + ret, 365 / days) - 1;
}

// --------------------------- Carry / drag ---------------------------

/**
 * Very simple carry model:
 * - If you're LONG target, the dividend yield is a positive carry.
 * - If you're SHORT acquirer (for hedge), dividend yield on acquirer is a negative carry.
 * - Borrow rates: if LONG target, ignore borrow; if SHORT target (reverse trade), pay borrowRateTarget.
 * - Same logic for acquirer borrow when SHORT acquirer.
 * All annualized inputs converted linearly to the holding period. (Good enough for deal math.)
 */
export function carryAdjustment(
  targetNotional: number,
  acquirerHedgeNotional: number,
  carry: CarryInputs
): number {
  const days = carry.daysToClose ?? 180;
  const t = Math.max(1, days) / 365;
  const longTarget = carry.longTarget !== false; // default true

  // Dividends
  const divT = (carry.divYieldTarget ?? 0) * (longTarget ? +1 : -1);
  const divA = (carry.divYieldAcquirer ?? 0) * (-1); // we assume SHORT A for standard long-target trade

  // Borrow
  const borrowT = (carry.borrowRateTarget ?? 0) * (longTarget ? 0 : +1); // pay only when short target
  const borrowA = (carry.borrowRateAcquirer ?? 0) * (+1);                // pay when short acquirer

  const pnlDiv = targetNotional * divT * t + acquirerHedgeNotional * divA * t;
  const pnlBorrow = targetNotional * (-borrowT) * t + acquirerHedgeNotional * (-borrowA) * t;
  return pnlDiv + pnlBorrow; // absolute PnL (same units as notionals)
}

/** Hedge ratio (# acquirer shares per 1 target share) implied by the deal (stock component only). */
export function hedgeRatio(deal: Deal, acqPx: number): number {
  if (deal.consideration === Consideration.CASH) return 0;
  if (deal.consideration === Consideration.STOCK) {
    return effectiveRatio(deal.exchangeRatio, acqPx, deal.collar);
  }
  // MIX
  if (!deal.mix) return 0;
  const sWeight = isFiniteNumber(deal.mix.stockWeight) ? (deal.mix.stockWeight as number) : 0.5;
  const rEff = effectiveRatio(deal.mix.stockRatio, acqPx, deal.mix.collar);
  return sWeight * rEff; // proration-weighted hedge
}

/** Net annualized (very approximate): includes borrow/div carry and gross spread. */
export function netAnnualizedReturn(
  deal: Deal,
  live: LiveState,
  carry: CarryInputs = {}
): number {
  const days = carry.daysToClose ?? deal.expectedCloseDays ?? 180;
  const implied = impliedTakeoutValue(deal, live.acquirerPx);
  if (!isFiniteNumber(implied)) return NaN;
  const gross = grossReturnToClose(live.targetPx, implied);
  const h = isFiniteNumber(live.acquirerPx) ? hedgeRatio(deal, live.acquirerPx as number) : 0;

  // notionals per 1 target share position
  const targetNotional = live.targetPx;                    // LONG 1 * price
  const acqNotional = (live.acquirerPx ?? 0) * h * -1;     // SHORT hedge is negative notional; for carry we pass absolute magnitude
  const carryPnl = carryAdjustment(targetNotional, Math.abs(acqNotional), { ...carry, daysToClose: days });

  // Convert carry PnL to a return on target cost basis (per share)
  const carryRet = carryPnl / Math.max(1e-9, targetNotional);
  return annualize(gross + carryRet, days);
}

// --------------------------- Probability math ---------------------------

/** Given market target price, implied close value, and assumed break price, solve close probability p. */
export function impliedCloseProbability(
  marketTargetPx: number,
  impliedCloseValue: number,
  breakPx: number
): number {
  if (!isFiniteNumber(marketTargetPx) || !isFiniteNumber(impliedCloseValue) || !isFiniteNumber(breakPx)) return NaN;
  if (impliedCloseValue === breakPx) return NaN;
  const p = (marketTargetPx - breakPx) / (impliedCloseValue - breakPx);
  return clamp(p, 0, 1);
}

/** Invert for break price given market price and user-estimated close probability p. */
export function impliedBreakPrice(
  marketTargetPx: number,
  impliedCloseValue: number,
  pClose: number
): number {
  const p = clamp(pClose, 0, 1);
  const q = 1 - p;
  if (q === 0) return NaN;
  return (marketTargetPx - p * impliedCloseValue) / q;
}

/** Kelly fraction for binary outcome (long-only cap) */
export function kellyFraction(pClose: number, upRet: number, downRet: number): number {
  const p = clamp(pClose, 0, 1);
  const q = 1 - p;
  const b = upRet / Math.abs(downRet || -1);
  if (!isFiniteNumber(b) || b <= 0) return 0;
  const f = (p * b - q) / b;
  return clamp(f, 0, 1);
}

// --------------------------- Sensitivities ---------------------------

/** d(Target) / d(Acquirer) approximation under the deal terms (per target share). */
export function dealDeltaToAcquirer(deal: Deal, acqPx?: number): number {
  if (!isFiniteNumber(acqPx)) return 0;
  if (deal.consideration === Consideration.CASH) return 0;
  if (deal.consideration === Consideration.STOCK) {
    // Within a ratio collar, delta is ratio if not at a hard edge of fixed-value collar
    if (deal.collar && deal.collar.kind === "fixed_value") {
      const c = deal.collar;
      if (acqPx! < c.pMin || acqPx! > c.pMax) {
        // outside band ratio fixed at value/pEdge -> target value changes at rEff * d(acqPx)
        const rEff = effectiveRatio(deal.exchangeRatio, acqPx!, deal.collar);
        return rEff;
      }
      // inside band, target value is fixed value (cash-like), delta ~ 0
      return 0;
    }
    return effectiveRatio(deal.exchangeRatio, acqPx!, deal.collar);
  }
  // MIX: proration-weighted delta (cash leg has 0 delta)
  if (!deal.mix) return 0;
  const sWeight = isFiniteNumber(deal.mix.stockWeight) ? (deal.mix.stockWeight as number) : 0.5;
  if (deal.mix.collar && deal.mix.collar.kind === "fixed_value") {
    const c = deal.mix.collar;
    if (acqPx! >= c.pMin && acqPx! <= c.pMax) return 0 * sWeight;
  }
  const rEff = effectiveRatio(deal.mix.stockRatio, acqPx!, deal.mix.collar);
  return sWeight * rEff;
}

// --------------------------- PnL & scenarios ---------------------------

export type Position = {
  targetShares: number;             // >0 if long target
  acquirerShares: number;           // <0 if short acquirer
  entryTargetPx: number;
  entryAcquirerPx?: number;
  feesPerShare?: number;            // one-off costs (commission, borrow locate, etc.)
};

export function markToMarketPnL(pos: Position, live: LiveState): number {
  const tPnl = pos.targetShares * (live.targetPx - pos.entryTargetPx);
  const aPxNow = live.acquirerPx ?? 0;
  const aPxEnt = pos.entryAcquirerPx ?? 0;
  const aPnl = pos.acquirerShares * (aPxNow - aPxEnt);
  const fees = (pos.feesPerShare ?? 0) * Math.abs(pos.targetShares);
  return tPnl + aPnl - fees;
}

export type Scenario = {
  name: string;
  acquirerPx?: number;
  targetOutcomePx: number;
  prob?: number; // optional
};

export function basicScenarios(
  deal: Deal,
  live: LiveState,
  opts?: { breakPx?: number; acquirerMoves?: number[] }
): Scenario[] {
  const breakPx = opts?.breakPx ?? deal.breakPrice ?? Math.max(0, live.targetPx * 0.7);
  const moves = opts?.acquirerMoves ?? [-0.2, -0.1, 0, 0.1, 0.2];
  const out: Scenario[] = [];

  // Close scenarios with acquirer moves
  if (isFiniteNumber(live.acquirerPx)) {
    for (let i = 0; i < moves.length; i++) {
      const aPx = (live.acquirerPx as number) * (1 + moves[i]);
      const implied = impliedTakeoutValue(deal, aPx);
      out.push({ name: `Close @ A ${Math.round(moves[i] * 100)}%`, acquirerPx: aPx, targetOutcomePx: implied });
    }
  } else {
    const implied = impliedTakeoutValue(deal, undefined);
    out.push({ name: "Close", targetOutcomePx: implied });
  }

  // Break scenario
  out.push({ name: "Break", targetOutcomePx: breakPx });

  return out;
}

// --------------------------- Convenience wrapper ---------------------------

export function evaluateDeal(
  deal: Deal,
  live: LiveState,
  carry?: CarryInputs
): {
  impliedValue: number;
  spread: number;
  grossToClose: number;
  annGross: number;
  netAnn?: number;
  hedgeRatio: number;
  deltaToAcquirer: number;
  pCloseFromBreak?: number;
} {
  const implied = impliedTakeoutValue(deal, live.acquirerPx);
  const spread = simpleSpread(live.targetPx, implied);
  const gross = grossReturnToClose(live.targetPx, implied);
  const days = carry?.daysToClose ?? deal.expectedCloseDays ?? 180;
  const annGross = annualize(gross, days);
  const h = isFiniteNumber(live.acquirerPx) ? hedgeRatio(deal, live.acquirerPx as number) : 0;
  const dA = isFiniteNumber(live.acquirerPx) ? dealDeltaToAcquirer(deal, live.acquirerPx as number) : 0;

  const netAnn = carry ? netAnnualizedReturn(deal, live, carry) : undefined;

  // If user provided breakPrice, back out pClose
  let pCloseFromBreak: number | undefined = undefined;
  const br = deal.breakPrice;
  if (isFiniteNumber(br)) {
    const p = impliedCloseProbability(live.targetPx, implied, br as number);
    if (isFiniteNumber(p)) pCloseFromBreak = p;
  }

  return {
    impliedValue: implied,
    spread,
    grossToClose: gross,
    annGross,
    netAnn,
    hedgeRatio: h,
    deltaToAcquirer: dA,
    pCloseFromBreak,
  };
}
