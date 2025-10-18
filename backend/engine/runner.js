// engine/runner.js
// Minimal, dependency-free strategy runner (CommonJS).
// Exports: runStrategy(strategy, feed, opts)

/* ============================ Utilities ============================ */

function mean(x) { if (!x.length) return 0; let s = 0; for (const v of x) s += v; return s / x.length; }
function stdev(x) {
  const n = x.length; if (n < 2) return 0;
  const m = mean(x); let v = 0; for (const a of x) v += (a - m) * (a - m);
  return Math.sqrt(v / (n - 1));
}
function maxDrawdown(equity) {
  let peak = -Infinity, mdd = 0, start = 0, end = 0, peakIdx = 0;
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] > peak) { peak = equity[i]; peakIdx = i; }
    const dd = (equity[i] - peak) / peak;
    if (dd < mdd) { mdd = dd; start = peakIdx; end = i; }
  }
  return { mdd: Math.abs(mdd), start, end };
}
function rel(a, b) { return b > 0 ? (a / b) - 1 : 0; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/* ======================== Strategy Contract ======================== */
/**
 * Strategy object contract (loose; runner checks presence):
 * {
 *   id: "strat-1",
 *   name: "My Strategy",
 *   // optional; called once at start
 *   init?: (ctx) => void,
 *   // required: per bar -> return target weights {SYM: weight} (sum ~ 1)
 *   onBar: (ctx, bar) => ({ AAPL: 0.3, MSFT: 0.7 }),
 *   // optional; rebalance rule: "daily" | "weekly" | "monthly"
 *   rebalance?: "daily" | "weekly" | "monthly"
 * }
 *
 * Feed: array of { date: "YYYY-MM-DD", prices: {SYM: price, ...} }
 */

/* ============================ Runner =============================== */

function runStrategy(strategy, feed, opts = {}) {
  if (!strategy || typeof strategy.onBar !== "function") {
    throw new Error("strategy.onBar(ctx, bar) must be provided");
  }
  const initialCash = Number.isFinite(opts.initialCash) ? opts.initialCash : 1_000_000;
  const slipBps = Number.isFinite(opts.slippageBps) ? opts.slippageBps : 0; // per-trade bps
  const feePerTrade = Number.isFinite(opts.feePerTrade) ? opts.feePerTrade : 0; // flat fee
  const maxLeverage = Number.isFinite(opts.maxLeverage) ? opts.maxLeverage : 1.0;

  const ctx = {
    id: opts.runId || `run-${Date.now()}`,
    startAt: feed.length ? feed[0].date : new Date().toISOString(),
    capital: initialCash,
    cash: initialCash,
    positions: {},        // symbol -> shares
    lastPrices: {},       // symbol -> last price seen
    barIndex: -1,
    log: (...a) => opts.verbose && console.log("[runner]", ...a),
    meta: opts.meta || {}
  };

  // Allow strategy init
  if (typeof strategy.init === "function") {
    try { strategy.init(ctx); } catch (e) { ctx.log("strategy.init error:", e); }
  }

  const trades = [];       // {date, symbol, qty, price, value, side, reason}
  const equityCurve = [];  // {date, equity}
  const returns = [];      // arithmetic returns per step
  const weightsHist = [];  // {date, weights}

  let prevEquity = ctx.capital;

  const shouldRebalance = makeRebalanceFn(strategy.rebalance || "daily");

  for (let i = 0; i < feed.length; i++) {
    const bar = feed[i];
    ctx.barIndex = i;

    // Mark to market (compute equity before potential rebalance)
    const mtmEquity = markToMarket(ctx, bar);
    // per-step return based on equity change
    const stepRet = i === 0 ? 0 : rel(mtmEquity, prevEquity);
    returns.push(stepRet);
    equityCurve.push({ date: bar.date, equity: mtmEquity });
    prevEquity = mtmEquity;
    ctx.capital = mtmEquity;

    // Record last prices for valuation
    for (const [sym, px] of Object.entries(bar.prices || {})) ctx.lastPrices[sym] = px;

    // Rebalance if schedule says so
    if (!shouldRebalance(i, bar.date)) continue;

    // Ask strategy for target weights
    let target = {};
    try { target = strategy.onBar(ctx, bar) || {}; }
    catch (e) { ctx.log("onBar error:", e); target = {}; }

    // Normalize weights, clamp leverage
    const norm = normalizeWeights(target, maxLeverage);
    weightsHist.push({ date: bar.date, weights: norm });

    // Execute rebalance trades
    const t = rebalanceTo(ctx, bar, norm, slipBps, feePerTrade);
    trades.push(...t);
  }

  // Final marks
  const lastEq = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : ctx.capital;
  const { mdd, start: ddStart, end: ddEnd } = maxDrawdown(equityCurve.map(p => p.equity));
  const annFactor = opts.annFactor || 252;
  const avg = mean(returns), vol = stdev(returns);
  const annRet = Math.pow(1 + avg, annFactor) - 1;
  const annVol = vol * Math.sqrt(annFactor);
  const sharpe = annVol > 0 ? (annRet / annVol) : 0;

  const metrics = {
    points: returns.length,
    totalReturn: rel(lastEq, initialCash),
    annReturn: annRet,
    annVol,
    sharpe,
    maxDrawdown: mdd,
    maxDDStart: ddStart,
    maxDDEnd: ddEnd
  };

  // Lightweight snapshot (no external schema import)
  const snapshot = {
    asOf: feed.length ? feed[feed.length - 1].date : new Date().toISOString(),
    nav: lastEq,
    cash: ctx.cash,
    gross: calcGross(ctx),
    net: calcNet(ctx),
    longExposure: calcSide(ctx, +1),
    shortExposure: calcSide(ctx, -1),
    leverage: calcLeverage(ctx),
    positions: Object.entries(ctx.positions).map(([symbol, qty]) => {
      const price = ctx.lastPrices[symbol] || 0;
      const value = qty * price;
      const side = qty >= 0 ? "long" : "short";
      return { symbol, qty, price, value, side, weight: lastEq ? value / lastEq : 0 };
    }),
    exposures: {
      bySector: [],
      byAssetClass: [],
      byCurrency: []
    },
    pnl: { day: returns.length ? returns[returns.length - 1] : 0 }
  };

  return {
    runId: ctx.id,
    strategyId: strategy.id || "strategy",
    name: strategy.name || "strategy",
    metrics,
    equityCurve,
    returns,
    trades,
    weights: weightsHist,
    snapshot
  };
}

/* ======================== Rebalance & MTM ======================== */

function makeRebalanceFn(kind) {
  if (kind === "weekly") {
    // rebalance on Monday (ISO weekday 1)
    return (_i, iso) => new Date(iso + "T00:00:00Z").getUTCDay() === 1;
  }
  if (kind === "monthly") {
    // last calendar day of month
    return (_i, iso) => {
      const d = new Date(iso + "T00:00:00Z");
      const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
      return next.getUTCMonth() !== d.getUTCMonth();
    };
  }
  // default daily
  return () => true;
}

function markToMarket(ctx, bar) {
  let posValue = 0;
  for (const [sym, qty] of Object.entries(ctx.positions)) {
    const px = bar.prices[sym];
    if (px && Number.isFinite(px)) posValue += qty * px;
  }
  return ctx.cash + posValue;
}

function normalizeWeights(w, maxLev) {
  const entries = Object.entries(w || {}).filter(([_, v]) => Number.isFinite(v) && Math.abs(v) > 0);
  if (!entries.length) return {};
  const sumAbs = entries.reduce((s, [, v]) => s + Math.abs(v), 0);
  if (sumAbs === 0) return {};
  // scale to max leverage
  const scale = clamp(maxLev / sumAbs, 0, 1);
  const out = {};
  for (const [k, v] of entries) out[k] = v * scale;
  return out;
}

function rebalanceTo(ctx, bar, targetW, slipBps, feeFlat) {
  const eq = markToMarket(ctx, bar);
  if (eq <= 0) return [];
  const prices = bar.prices || {};
  const trades = [];

  // Current weights
  const curW = {};
  for (const [sym, qty] of Object.entries(ctx.positions)) {
    const px = prices[sym]; if (!px) continue;
    curW[sym] = (qty * px) / eq;
  }

  // Targets across union of symbols
  const symbols = new Set([...Object.keys(curW), ...Object.keys(targetW)]);
  for (const sym of symbols) {
    const px = prices[sym]; if (!px) continue;
    const w0 = curW[sym] || 0;
    const w1 = targetW[sym] || 0;
    const deltaValue = (w1 - w0) * eq;
    if (Math.abs(deltaValue) < 1e-9) continue;

    const slipMult = 1 + Math.sign(deltaValue) * (slipBps / 10000);
    const tradePx = px * slipMult;
    const qty = deltaValue / tradePx;
    if (!Number.isFinite(qty) || Math.abs(qty) < 1e-9) continue;

    // Book trade
    ctx.positions[sym] = (ctx.positions[sym] || 0) + qty;
    const cashChange = -qty * tradePx - (feeFlat || 0);
    ctx.cash += cashChange;

    trades.push({
      date: bar.date,
      symbol: sym,
      qty,
      price: tradePx,
      value: qty * tradePx,
      side: qty >= 0 ? "buy" : "sell",
      reason: "rebalance"
    });
  }

  return trades;
}

/* ============================== Exposures ============================== */

function calcGross(ctx) {
  let g = 0;
  for (const [sym, qty] of Object.entries(ctx.positions)) {
    const px = ctx.lastPrices[sym] || 0;
    g += Math.abs(qty * px);
  }
  return g;
}
function calcNet(ctx) {
  let n = 0;
  for (const [sym, qty] of Object.entries(ctx.positions)) {
    const px = ctx.lastPrices[sym] || 0;
    n += qty * px;
  }
  return n;
}
function calcSide(ctx, sgn) {
  let v = 0;
  for (const [sym, qty] of Object.entries(ctx.positions)) {
    if (Math.sign(qty) !== Math.sign(sgn)) continue;
    const px = ctx.lastPrices[sym] || 0;
    v += Math.abs(qty * px);
  }
  return v;
}
function calcLeverage(ctx) {
  const nav = ctx.cash + Object.entries(ctx.positions)
    .reduce((s, [sym, qty]) => s + (ctx.lastPrices[sym] || 0) * qty, 0);
  if (nav <= 0) return 0;
  const gross = calcGross(ctx);
  return gross / nav;
}

/* ============================== Exports =============================== */

module.exports = {
  runStrategy
};