// options/margin.js
// Lightweight margin engine: SPAN-lite (scenario stress) + a simple Reg-T proxy.
// ESM compatible. Designed to match the CLI expectations in backtester/cli.ts.
//
// Exports:
//   - checkMargin(portfolio, underlyings, chain, params, premiumPerContract?)
//   - summarizeCheck(result)
//
// Notes
// - Default method is "greeks": scenario PnL ≈ Δ*dS + 0.5*Γ*dS^2 + Vega*dVol, scaled by qty*multiplier.
// - If greeks for a symbol are missing, we treat them as 0 (neutral) for SPAN-lite.
// - Reg-T proxy here is intentionally simple (conservative-ish) and should be replaced
//   with your house/broker formula when available.

/** @typedef {{symbol:string, qty:number}} Pos
 *  @typedef {{symbol:string, underlying:string, right?:"C"|"P", strike?:number, expiryISO?:string, multiplier?:number}} Spec
 *  @typedef {{cash?:number, positions:Record<string, Pos>, specs:Record<string, Spec>}} Portfolio
 *  @typedef {{underlying:string, price:number, iv?:number, r?:number, q?:number, T?:number}} UnderlyingPx
 *  @typedef {{underlyings: Record<string, {price:number, iv?:number}>, greeks?: Record<string, {delta:number, gamma:number, vega:number}>}} ChainState
 *  @typedef {{pricePct:number[], volAbs:number[], method:"greeks"|"bs", perContractFloor?:number}} ScanParams
 */

/** Utility: safe number */
const num = (x, d = 0) => (Number.isFinite(+x) ? +x : d);

/** Build map: underlying -> price */
function mapUnderlyings(arr) {
  const m = {};
  for (const u of arr || []) m[u.underlying] = { price: num(u.price), iv: num(u.iv) || undefined };
  return m;
}

/** Count short contracts to apply per-contract floors */
function countShorts(portfolio, specs) {
  let shorts = 0, total = 0;
  for (const k of Object.keys(portfolio.positions || {})) {
    const p = portfolio.positions[k];
    const qty = num(p?.qty);
    total += Math.abs(qty);
    if (qty < 0) shorts += Math.abs(qty);
  }
  // If multiplier exists, contracts are still counted as 1 unit per position lot.
  return { shorts, total };
}

/** One-leg scenario PnL via greeks (approx) */
function legPnLGreeks(sym, qty, mult, dS, dVol, greeks) {
  const g = greeks?.[sym] || { delta: 0, gamma: 0, vega: 0 };
  // Value change per 1 underlying unit (delta/gamma) and per 1.00 vol (vega)
  const dV = g.delta * dS + 0.5 * g.gamma * dS * dS + g.vega * dVol;
  return dV * qty * (mult || 1);
}

/** Scenario sweep: returns array of { dS, dVol, pnl } at the portfolio level */
function sweepScenarios(portfolio, specs, underMap, greeks, pricePct, volAbs) {
  const positions = portfolio.positions || {};
  const out = [];
  // If portfolio holds multiple underlyings, we currently apply the same dS (% of *each* underlyings' spot)
  // and same dVol (absolute) to all. For finer control, expand this grid per underlying.
  for (const pp of pricePct) {
    for (const vv of (volAbs.length ? volAbs : [0])) {
      let pnl = 0;
      for (const sym of Object.keys(positions)) {
        const pos = positions[sym];
        const spec = specs[sym] || {};
        const u = underMap[spec.underlying || spec.symbol || ""] || { price: 0 };
        const S0 = num(u.price);
        const dSabs = S0 * pp; // absolute underlying move
        const mult = num(spec.multiplier, 1);

        pnl += legPnLGreeks(sym, num(pos.qty), mult, dSabs, vv, greeks);
      }
      out.push({ dS: pp, dVol: vv, pnl });
    }
  }
  return out;
}

/** Worst loss across scenarios (negative pnl) */
function pickWorst(scenarios) {
  if (!scenarios.length) return { dS: 0, dVol: 0, pnl: 0 };
  let worst = scenarios[0];
  for (const s of scenarios) if (s.pnl < worst.pnl) worst = s;
  return worst;
}

/** Very simplified Reg-T proxy for options portfolios.
 *  Intuition: take 15% of spot * per-share exposure for *short* options only (conservative),
 *  plus add a minimum per-contract floor if present.
 *  Replace with your broker/house rules when available.
 */
function regTProxy(portfolio, specs, underMap, perContractFloor = 0) {
  let req = 0;
  let shortContracts = 0;
  for (const sym of Object.keys(portfolio.positions || {})) {
    const pos = portfolio.positions[sym];
    const q = num(pos.qty);
    const spec = specs[sym] || {};
    const u = underMap[spec.underlying || spec.symbol || ""] || { price: 0 };
    const S0 = num(u.price);
    const mult = num(spec.multiplier, 1);

    if (q < 0) {
      shortContracts += Math.abs(q);
      // 15% * spot * multiplier * |qty|
      req += 0.15 * S0 * mult * Math.abs(q);
    }
  }
  req = Math.max(req, shortContracts * perContractFloor);
  return { regT: req, shortContracts };
}

/** Sum of premiums (use quoted map if provided), positive if received (short premium) */
function netPremiumCredit(portfolio, specs, premiumPerContract) {
  if (!premiumPerContract) return 0;
  let credit = 0;
  for (const sym of Object.keys(portfolio.positions || {})) {
    const pos = portfolio.positions[sym];
    const spec = specs[sym] || {};
    const mult = num(spec.multiplier, 1);
    const px = num(premiumPerContract[sym], 0);
    // Premium * qty * multiplier; qty<0 (short) adds positive credit if px>0
    credit += px * num(pos.qty) * mult;
  }
  return credit;
}

/**
 * Main entry: compute SPAN-lite + Reg-T proxy + summary.
 * @param {Portfolio} portfolio
 * @param {UnderlyingPx[]} underlyings
 * @param {ChainState} chain
 * @param {ScanParams} params
 * @param {Record<string, number>=} premiumPerContract  // option mid prices per contract (per symbol)
 */
export function checkMargin(portfolio, underlyings, chain, params, premiumPerContract) {
  const specs = portfolio.specs || {};
  const underMap = chain?.underlyings || mapUnderlyings(underlyings || []);
  const greeks = chain?.greeks || {};
  const pricePct = (params?.pricePct && params.pricePct.length ? params.pricePct : [-0.08, 0.08]).map(Number);
  const volAbs = (params?.volAbs && params.volAbs.length ? params.volAbs : [0]).map(Number);
  const perContractFloor = num(params?.perContractFloor, 0);
  const method = params?.method || "greeks";

  // Build scenario grid (greeks method only implemented here)
  const scenarios = method === "greeks"
    ? sweepScenarios(portfolio, specs, underMap, greeks, pricePct, volAbs)
    : sweepScenarios(portfolio, specs, underMap, greeks, pricePct, volAbs); // placeholder for BS

  const worst = pickWorst(scenarios);
  const spanRequirement = Math.max(-worst.pnl, 0);

  const { regT, shortContracts } = regTProxy(portfolio, specs, underMap, perContractFloor);
  const netPrem = netPremiumCredit(portfolio, specs, premiumPerContract);

  const { shorts, total } = countShorts(portfolio, specs);

  return {
    method,
    grid: { pricePct, volAbs },
    scenarios,             // { dS, dVol, pnl }[]
    worst,                 // scenario with min pnl
    spanRequirement,       // positive number (capital required to cover worst loss)
    regT,                  // simple proxy
    perContractFloor,
    shortContracts,
    netPremium: netPrem,
    portfolioStats: { shorts, total },
  };
}

/** Text summary for humans/CLI printing */
export function summarizeCheck(r) {
  const lines = [];
  lines.push("=== Margin Check (SPAN-lite) ===");
  lines.push(`Method           : ${r.method}`);
  lines.push(`Grid dS (% move): [${(r.grid.pricePct || []).map(x => (x*100).toFixed(1)+"%").join(", ")}]`);
  lines.push(`Grid dVol (abs) : [${(r.grid.volAbs || []).map(x => x.toFixed(2)).join(", ")}]`);
  lines.push(`Worst Scenario   : dS=${(r.worst.dS*100).toFixed(1)}%, dVol=${num(r.worst.dVol).toFixed(2)} -> PnL=${num(r.worst.pnl).toFixed(2)}`);
  lines.push(`SPAN Requirement : ${num(r.spanRequirement).toFixed(2)}`);
  lines.push(`Reg-T Proxy      : ${num(r.regT).toFixed(2)}  (floor/contract=${num(r.perContractFloor).toFixed(2)}, shorts=${num(r.shortContracts)})`);
  lines.push(`Net Premium      : ${num(r.netPremium).toFixed(2)}`);
  lines.push(`Positions        : total=${num(r.portfolioStats?.total)}, shorts=${num(r.portfolioStats?.shorts)}`);
  return lines.join("\n");
}

// Default export for NodeNext/ESM interop if someone uses "import OptMargin from ...".
export default {
  checkMargin,
  summarizeCheck,
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