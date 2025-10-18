// options/payoff.js
// Computes option strategy payoff and P&L across a grid of underlying prices.
// Supports multi-leg strategies with different rights, strikes, premiums, qty, multipliers.

/**
 * @typedef {"C"|"P"} Right
 * @typedef {{kind:"option", right:Right, strike:number, premium:number, qty:number, multiplier?:number}} Leg
 * @typedef {{name?:string, spotRef?:number, legs:Leg[]}} Strategy
 */

/** ensure number */
const num = (x, d=0) => (Number.isFinite(+x) ? +x : d);

/** compute payoff of one leg at price S */
function legPayoff(leg, S) {
  const mult = num(leg.multiplier, 1);
  const q = num(leg.qty);
  const prem = num(leg.premium);
  const K = num(leg.strike);

  let payoff = 0;
  if (leg.right === "C") payoff = Math.max(S - K, 0);
  else if (leg.right === "P") payoff = Math.max(K - S, 0);

  // Gross payoff
  const gross = payoff * q * mult;
  // Premium paid (long) or received (short)
  const premTotal = prem * q * mult * -1; // q>0 (long): cost; q<0 (short): credit

  return { gross, premTotal, net: gross + premTotal };
}

/** Compute total payoff/PnL for whole strategy */
function payoffAt(strategy, S) {
  let payoff = 0, premium = 0, pnl = 0;
  for (const leg of strategy.legs) {
    const { gross, premTotal, net } = legPayoff(leg, S);
    payoff += gross;
    premium += premTotal;
    pnl += net;
  }
  return { S, payoff, premium, pnl };
}

/**
 * Build grid of underlying prices for evaluation.
 * Options:
 *   - from,to,steps: absolute price grid
 *   - pctFrom,pctTo: relative to strategy.spotRef (default ±50%)
 */
export function priceGrid(strategy, opts = {}) {
  const spot = num(strategy.spotRef, 100);
  const steps = Math.max(2, num(opts.steps, 201));
  let from = opts.from !== undefined ? num(opts.from) : undefined;
  let to   = opts.to   !== undefined ? num(opts.to)   : undefined;

  if (from === undefined || to === undefined) {
    const pf = opts.pctFrom !== undefined ? +opts.pctFrom : -0.5;
    const pt = opts.pctTo   !== undefined ? +opts.pctTo   :  0.5;
    from = spot * (1 + pf);
    to   = spot * (1 + pt);
  }

  const out = [];
  const step = (to - from) / (steps - 1);
  for (let i = 0; i < steps; i++) out.push(from + i*step);
  return out;
}

/** Generate payoff/PnL curve across grid */
export function curve(strategy, grid) {
  return grid.map(S => payoffAt(strategy, S));
}

/** Summarize strategy textually */
export function summarize(strategy) {
  const lines = [];
  lines.push(`Strategy: ${strategy.name || "(unnamed)"}`);
  for (const leg of strategy.legs) {
    lines.push(`  ${leg.qty>0?"Long":"Short"} ${Math.abs(leg.qty)} ${leg.right} K=${leg.strike} prem=${leg.premium} mult=${leg.multiplier||1}`);
  }
  return lines.join("\n");
}

/** Default export */
export default {
  priceGrid,
  curve,
  summarize,
};
const { priceGrid, curve } = await load.payoff();
const { summarize } = await load.strategies();
const { priceGreeks } = await load.pricing();
const OptMargin = await load.margin();

const { StrategyRegistry } = await load.registry();
const { runStrategy }      = await load.runner();
const { makeContext }      = await load.context();
const { DemoFeed }         = await load.demoFeed();
const { PaperBroker }      = await load.paperBroker();
const { FSRepo }           = await load.fsRepo();