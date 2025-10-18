// options/strategies.js
// Helpers for option strategies: summarization, break-evens, max profit/loss.

/**
 * @typedef {"C"|"P"} Right
 * @typedef {{kind:"option", right:Right, strike:number, premium:number, qty:number, multiplier?:number}} Leg
 * @typedef {{name?:string, spotRef?:number, legs:Leg[]}} Strategy
 */

const num = (x, d=0) => (Number.isFinite(+x) ? +x : d);

/** Simple payoff calc for one leg */
function legPayoff(leg, S) {
  const mult = num(leg.multiplier, 1);
  const q = num(leg.qty);
  const prem = num(leg.premium);
  const K = num(leg.strike);

  let payoff = 0;
  if (leg.right === "C") payoff = Math.max(S - K, 0);
  else payoff = Math.max(K - S, 0);

  const gross = payoff * q * mult;
  const premTotal = prem * q * mult * -1;
  return gross + premTotal;
}

/** Summarize text */
export function summarize(strategy) {
  const lines = [];
  lines.push(`Strategy: ${strategy.name || "(unnamed)"}`);
  if (strategy.spotRef) lines.push(`SpotRef: ${strategy.spotRef}`);
  for (const leg of strategy.legs) {
    lines.push(`  ${leg.qty>0?"Long":"Short"} ${Math.abs(leg.qty)} ${leg.right} K=${leg.strike} prem=${leg.premium} mult=${leg.multiplier||1}`);
  }
  const info = analyze(strategy);
  lines.push(`Break-evens : ${info.breakEvens.length? info.breakEvens.map(x=>x.toFixed(2)).join(", ") : "(none)"}`);
  lines.push(`Max Profit  : ${info.maxProfit === Infinity ? "∞" : info.maxProfit.toFixed(2)}`);
  lines.push(`Max Loss    : ${info.maxLoss === -Infinity ? "∞" : info.maxLoss.toFixed(2)}`);
  return lines.join("\n");
}

/** Analyze a strategy: break-evens, max profit/loss */
export function analyze(strategy) {
  const spot = num(strategy.spotRef, 100);
  // Candidate prices: strikes, spotRef ± wide range
  const strikes = strategy.legs.map(l => num(l.strike));
  const grid = [];
  const minS = Math.max(1, Math.min(...strikes, spot*0.5));
  const maxS = Math.max(...strikes, spot*1.5);
  const steps = 500;
  const step = (maxS - minS)/steps;
  for (let i=0;i<=steps;i++) grid.push(minS + i*step);

  const values = grid.map(S => ({ S, pnl: strategy.legs.reduce((a,l)=>a+legPayoff(l,S),0) }));

  let maxProfit = Math.max(...values.map(v=>v.pnl));
  let maxLoss   = Math.min(...values.map(v=>v.pnl));

  // break-evens: sign change in PnL across grid
  const breakEvens = [];
  for (let i=1;i<values.length;i++) {
    const prev = values[i-1], cur = values[i];
    if (prev.pnl===0) breakEvens.push(prev.S);
    else if (prev.pnl*cur.pnl < 0) {
      // linear interpolation
      const t = prev.S + (cur.S-prev.S)* (0-prev.pnl)/(cur.pnl-prev.pnl);
      breakEvens.push(t);
    }
  }

  return { breakEvens, maxProfit, maxLoss };
}

export default {
  summarize,
  analyze,
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