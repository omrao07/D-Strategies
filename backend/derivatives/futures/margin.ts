// futures/margin.ts
// Pure TS (no imports). Utilities for futures margin: contract specs, portfolio margin,
// SPAN-lite scanning, stress testing, risk checks, and liquidation sizing.

export type ISODate = string; // "YYYY-MM-DD"

export type MarginSpec = {
  /** Per-contract initial and maintenance margins in account currency. */
  initial: number;
  maintenance: number;
};

export type ContractSpec = {
  /** Symbol, e.g., ESZ25. */
  symbol: string;
  /** PnL $ per 1 price point per contract. */
  multiplier: number;
  /** Margin requirement per contract. */
  margin: MarginSpec;
  /** Optional reference price for notional; if absent, pass prices to APIs below. */
  refPrice?: number;
  /** Optional risk group (e.g., "Equity", "Rates", "Energy") for concentration caps. */
  group?: string;
};

export type Position = {
  symbol: string;
  qty: number;      // signed: >0 long, <0 short
  avgPx?: number;   // informational
};

export type Price = { symbol: string; price: number };

export type Portfolio = {
  /** Current cash/equity snapshot (optional but useful for checks). */
  cash?: number;
  equity?: number;
  /** Open positions keyed by symbol. */
  positions: Record<string, Position>;
  /** Contract specs keyed by symbol. */
  specs: Record<string, ContractSpec>;
};

export type ScanParams = {
  /** Absolute shock in percent of price (e.g., 0.08 = 8%) for primary up/down scan. */
  scanPct: number;
  /** Intra-commodity spread add-on as percent of notional (0..). */
  intraPct?: number;
  /** Inter-commodity / concentration add-on percent (cap applied by group). */
  concentrationPct?: number;
  /** Additional user scenarios as percentage shocks (e.g., [-0.12, +0.12]). */
  extraScenarios?: number[];
  /** Floor per-contract margin override (≥ maintenance). */
  perContractFloor?: number;
};

export type MarginBreakdown = {
  bySymbol: Record<string, {
    qty: number;
    initialPer: number;
    maintPer: number;
    initial: number;
    maintenance: number;
    notional: number;
  }>;
  totals: {
    initial: number;
    maintenance: number;
    notional: number;
  };
};

export type SpanLikeResult = {
  worstLoss: number;          // worst-case portfolio PnL across scenarios
  scenarioPnL: { shock: number; pnl: number }[];
  addOns: {
    intra: number;
    concentration: number;
  };
  required: {
    span: number;             // base SPAN requirement = max(worstLoss, floor)
    total: number;            // span + add-ons
  };
};

export type MarginCheck = {
  equity: number;
  maintenance: number;
  initial: number;
  marginUsed: number;       // chosen requirement for "used" (usually maintenance or span total)
  marginExcess: number;
  deficit: number;          // max(0, maintenance - equity) if using maintenance
  utilization: number;      // marginUsed / max(equity, 1)
  effectiveLeverage: number; // notional / max(equity,1)
};

export type LiquidationPlan = {
  /** If deficit > 0, suggested closes by symbol (contracts to reduce), greedy by risk. */
  closes: { symbol: string; qtyToClose: number }[];
  /** Estimated margin improvement (maintenance reduction) after suggested closes. */
  estMaintAfter: number;
};

/** ===== Utilities ===== */

function abs(x: number): number { return x < 0 ? -x : x; }
function max(a: number, b: number): number { return a > b ? a : b; }
function min(a: number, b: number): number { return a < b ? a : b; }
function round2(x: number): number { return Math.round((x + 1e-12) * 100) / 100; }

function getPrice(sym: string, prices?: Price[], specs?: Record<string, ContractSpec>): number {
  const p = prices?.find(z => z.symbol === sym)?.price;
  if (p && p > 0) return p;
  const s = specs?.[sym]?.refPrice;
  return s && s > 0 ? s : 0;
}

function notionalPerContract(spec: ContractSpec, px: number): number {
  return px * (spec.multiplier || 1);
}

/** ===== Simple per-contract margin aggregation (exchange posted margins) ===== */
export function marginByContracts(
  portfolio: Portfolio,
  prices?: Price[]
): MarginBreakdown {
  const bySymbol: MarginBreakdown["bySymbol"] = {};
  let tInit = 0, tMaint = 0, tNot = 0;

  for (const sym of Object.keys(portfolio.positions)) {
    const pos = portfolio.positions[sym];
    if (!pos || pos.qty === 0) continue;
    const spec = portfolio.specs[sym];
    if (!spec) continue;

    const px = getPrice(sym, prices, portfolio.specs);
    const perNot = notionalPerContract(spec, px || (spec.refPrice || 0));
    const qAbs = abs(pos.qty);

    const initPer = spec.margin.initial;
    const maintPer = spec.margin.maintenance;

    const init = qAbs * initPer;
    const maint = qAbs * maintPer;
    const notional = qAbs * perNot;

    bySymbol[sym] = {
      qty: pos.qty,
      initialPer: initPer,
      maintPer: maintPer,
      initial: round2(init),
      maintenance: round2(maint),
      notional: round2(notional),
    };

    tInit += init;
    tMaint += maint;
    tNot += notional;
  }

  return {
    bySymbol,
    totals: {
      initial: round2(tInit),
      maintenance: round2(tMaint),
      notional: round2(tNot),
    },
  };
}

/** ===== SPAN-lite portfolio margin =====
 * We approximate SPAN: evaluate portfolio PnL under price shocks ±scanPct and extras,
 * then require base margin >= worst loss (floored), plus add-ons.
 */
export function spanLikeMargin(
  portfolio: Portfolio,
  prices: Price[],
  params: ScanParams
): SpanLikeResult {
  const shocks: number[] = [];
  const s = max(0, params.scanPct);
  shocks.push(-s, +s);
  if (params.extraScenarios) {
    for (const x of params.extraScenarios) if (Number.isFinite(x)) shocks.push(x as number);
  }
  // Deduplicate & sort
  const uniq: number[] = [];
  for (const x of shocks.sort((a, b) => a - b)) {
    if (!uniq.length || Math.abs(uniq[uniq.length - 1] - x) > 1e-12) uniq.push(x);
  }

  const scenarioPnL: { shock: number; pnl: number }[] = [];
  for (const sh of uniq) {
    let pnl = 0;
    for (const sym of Object.keys(portfolio.positions)) {
      const pos = portfolio.positions[sym];
      if (!pos || pos.qty === 0) continue;
      const spec = portfolio.specs[sym];
      if (!spec) continue;
      const p0 = getPrice(sym, prices, portfolio.specs);
      if (!(p0 > 0)) continue;
      const p1 = p0 * (1 + sh);
      const dP = p1 - p0;
      pnl += dP * spec.multiplier * pos.qty; // signed qty
    }
    scenarioPnL.push({ shock: sh, pnl: round2(pnl) });
  }

  // Worst-case loss is min PnL across scenarios (negative most)
  const worst = scenarioPnL.reduce((m, r) => min(m, r.pnl), +Infinity);
  const worstLoss = worst === +Infinity ? 0 : -min(0, worst);

  // Add-ons
  const intra = spanIntraAddOn(portfolio, prices, params.intraPct || 0);
  const concentration = spanConcentrationAddOn(portfolio, prices, params.concentrationPct || 0);

  // Floor: per-contract maintenance or explicit floor
  const floor = max(contractMaintenanceTotal(portfolio), params.perContractFloor || 0);

  const spanReq = round2(max(worstLoss, floor));
  const totalReq = round2(spanReq + intra + concentration);

  return {
    worstLoss: round2(worstLoss),
    scenarioPnL,
    addOns: { intra: round2(intra), concentration: round2(concentration) },
    required: { span: spanReq, total: totalReq },
  };
}

/** Intra-commodity add-on: sum over groups of intraPct * group notional. */
function spanIntraAddOn(portfolio: Portfolio, prices: Price[], pct: number): number {
  if (!(pct > 0)) return 0;
  const perGroup: Record<string, number> = {};
  for (const sym of Object.keys(portfolio.positions)) {
    const pos = portfolio.positions[sym];
    const spec = portfolio.specs[sym];
    if (!pos || !spec) continue;
    const px = getPrice(sym, prices, portfolio.specs);
    const notional = abs(pos.qty) * notionalPerContract(spec, px || spec.refPrice || 0);
    const g = spec.group || "UNGROUPED";
    perGroup[g] = (perGroup[g] || 0) + notional;
  }
  let add = 0;
  for (const g of Object.keys(perGroup)) add += perGroup[g] * pct;
  return round2(add);
}

/** Concentration add-on: for the largest group exposure, apply concentrationPct * notional. */
function spanConcentrationAddOn(portfolio: Portfolio, prices: Price[], pct: number): number {
  if (!(pct > 0)) return 0;
  const perGroup: Record<string, number> = {};
  for (const sym of Object.keys(portfolio.positions)) {
    const pos = portfolio.positions[sym];
    const spec = portfolio.specs[sym];
    if (!pos || !spec) continue;
    const px = getPrice(sym, prices, portfolio.specs);
    const notional = abs(pos.qty) * notionalPerContract(spec, px || spec.refPrice || 0);
    const g = spec.group || "UNGROUPED";
    perGroup[g] = (perGroup[g] || 0) + notional;
  }
  let maxNotional = 0;
  for (const g of Object.keys(perGroup)) maxNotional = max(maxNotional, perGroup[g]);
  return round2(maxNotional * pct);
}

/** Sum of exchange maintenance margins across open contracts. */
export function contractMaintenanceTotal(p: Portfolio): number {
  let t = 0;
  for (const sym of Object.keys(p.positions)) {
    const pos = p.positions[sym];
    const spec = p.specs[sym];
    if (!pos || !spec) continue;
    t += abs(pos.qty) * (spec.margin.maintenance || 0);
  }
  return round2(t);
}

/** Sum of exchange initial margins across open contracts. */
export function contractInitialTotal(p: Portfolio): number {
  let t = 0;
  for (const sym of Object.keys(p.positions)) {
    const pos = p.positions[sym];
    const spec = p.specs[sym];
    if (!pos || !spec) continue;
    t += abs(pos.qty) * (spec.margin.initial || 0);
  }
  return round2(t);
}

/** Portfolio notional exposure (sum |qty| * px * multiplier). */
export function portfolioNotional(p: Portfolio, prices?: Price[]): number {
  let t = 0;
  for (const sym of Object.keys(p.positions)) {
    const pos = p.positions[sym];
    const spec = p.specs[sym];
    if (!pos || !spec) continue;
    const px = getPrice(sym, prices, p.specs);
    t += abs(pos.qty) * notionalPerContract(spec, px || spec.refPrice || 0);
  }
  return round2(t);
}

/** Margin check using exchange maintenance & initial, plus optional SPAN-lite overlay. */
export function checkMargin(
  portfolio: Portfolio,
  prices?: Price[],
  spanOverlay?: SpanLikeResult
): MarginCheck {
  const equity = portfolio.equity ?? (portfolio.cash ?? 0);
  const maint = contractMaintenanceTotal(portfolio);
  const init = contractInitialTotal(portfolio);

  // If a SPAN overlay is provided, we can treat maintenance as max(maintenance, span.total)
  const used = spanOverlay ? max(maint, spanOverlay.required.total) : maint;

  const excess = round2(equity - used);
  const deficit = round2(max(0, used - equity));
  const notional = portfolioNotional(portfolio, prices);
  const util = used > 0 ? round2(used / max(equity, 1)) : 0;
  const effLev = round2(notional / max(equity, 1));

  return {
    equity: round2(equity),
    maintenance: maint,
    initial: init,
    marginUsed: round2(used),
    marginExcess: excess,
    deficit,
    utilization: util,
    effectiveLeverage: effLev,
  };
}

/** Greedy liquidation planner: close contracts with highest "maintenance saved per 1 lot" first. */
export function planLiquidation(
  portfolio: Portfolio,
  targetReduction: number // required reduction in maintenance (or span total) currency units
): LiquidationPlan {
  if (!(targetReduction > 0)) return { closes: [], estMaintAfter: contractMaintenanceTotal(portfolio) };

  type Cand = { symbol: string; qtyAvail: number; maintPer: number };
  const cands: Cand[] = [];
  let currentMaint = 0;

  for (const sym of Object.keys(portfolio.positions)) {
    const pos = portfolio.positions[sym];
    const spec = portfolio.specs[sym];
    if (!pos || !spec || pos.qty === 0) continue;
    const qtyAvail = abs(pos.qty);
    const maintPer = spec.margin.maintenance || 0;
    currentMaint += qtyAvail * maintPer;
    if (qtyAvail > 0 && maintPer > 0) cands.push({ symbol: sym, qtyAvail, maintPer });
  }

  // Sort by maintenance saved per contract descending
  cands.sort((a, b) => b.maintPer - a.maintPer);

  const closes: { symbol: string; qtyToClose: number }[] = [];
  let reduced = 0;

  for (const c of cands) {
    if (reduced >= targetReduction) break;
    const needLots = Math.ceil((targetReduction - reduced) / c.maintPer);
    const take = min(needLots, c.qtyAvail);
    if (take > 0) {
      closes.push({ symbol: c.symbol, qtyToClose: take });
      reduced += take * c.maintPer;
    }
  }

  const estAfter = round2(max(0, currentMaint - reduced));
  return { closes, estMaintAfter: estAfter };
}

/** Stress test: return portfolio PnL for an array of absolute percentage shocks (e.g., [-0.1, 0.1]). */
export function stressPnL(
  portfolio: Portfolio,
  prices: Price[],
  shocksPct: number[]
): { shock: number; pnl: number }[] {
  const out: { shock: number; pnl: number }[] = [];
  for (const sh of shocksPct) {
    let pnl = 0;
    for (const sym of Object.keys(portfolio.positions)) {
      const pos = portfolio.positions[sym];
      const spec = portfolio.specs[sym];
      if (!pos || !spec) continue;
      const p0 = getPrice(sym, prices, portfolio.specs);
      if (!(p0 > 0)) continue;
      pnl += (p0 * (1 + sh) - p0) * spec.multiplier * pos.qty;
    }
    out.push({ shock: sh, pnl: round2(pnl) });
  }
  return out;
}

/** Convenience: compute SPAN-lite, then margin check including overlay. */
export function spanAndCheck(
  portfolio: Portfolio,
  prices: Price[],
  params: ScanParams
): { span: SpanLikeResult; check: MarginCheck } {
  const span = spanLikeMargin(portfolio, prices, params);
  const check = checkMargin(portfolio, prices, span);
  return { span, check };
}

/** Example helper: given a margin deficit, return a liquidation plan sized to cover it with a 10% buffer. */
export function planToCoverDeficit(
  portfolio: Portfolio,
  prices: Price[],
  params: ScanParams,
  equity?: number
): LiquidationPlan {
  const { span, check } = spanAndCheck(portfolio, prices, params);
  const used = max(contractMaintenanceTotal(portfolio), span.required.total);
  const eq = equity ?? check.equity;
  const deficit = max(0, used - eq);
  const target = deficit > 0 ? deficit * 1.1 : 0; // 10% buffer
  return planLiquidation(portfolio, target);
}

/** Pretty one-line summary for logs. */
export function summarizeCheck(chk: MarginCheck, span?: SpanLikeResult): string {
  const spanStr = span ? ` | SPAN=${span.required.total.toFixed(2)} worst=${span.worstLoss.toFixed(2)}` : "";
  return `Equity=${chk.equity.toFixed(2)} Used=${chk.marginUsed.toFixed(2)} Excess=${chk.marginExcess.toFixed(2)} Util=${(chk.utilization*100).toFixed(1)}% Lev=${chk.effectiveLeverage.toFixed(2)}${spanStr}`;
}