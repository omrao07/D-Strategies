// alpha/momentum.js
// Momentum utilities + a plug-and-play strategy helper.
// ESM/NodeNext, zero external deps.

// =============== Small utils ===============
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sum = (a) => a.reduce((s, v) => s + v, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);
const variance = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1);
};
const std = (a) => Math.sqrt(variance(a));

// =============== Core series helpers ===============

/**
 * Build a price series from bars/quotes.
 * @param {Array<{ts:number|string, c?:number, price?:number}>} rows
 * @param {"c"|"price"} [field="c"]
 * @returns {Array<{ts:number, price:number}>}
 */
export function toPriceSeries(rows, field = "c") {
  const out = [];
  for (const r of rows) {
    const ts = typeof r.ts === "string" ? new Date(r.ts).getTime() : +r.ts;
    const px = isNum(r[field]) ? +r[field] : isNum(r.price) ? +r.price : undefined;
    if (isNum(ts) && isNum(px)) out.push({ ts, price: px });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * Rate of change (ROC) over lookback n (in points, not %).
 * value_t = price_t / price_{t-n} - 1
 */
export function roc(series, n) {
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const j = i - n;
    if (j >= 0) {
      const p0 = series[j].price;
      const p1 = series[i].price;
      if (isNum(p0) && p0 > 0 && isNum(p1)) {
        out.push({ ts: series[i].ts, value: p1 / p0 - 1 });
      }
    }
  }
  return out;
}

/** Simple returns (close-to-close). */
export function simpleReturns(series) {
  const out = [];
  for (let i = 1; i < series.length; i++) {
    const p0 = series[i - 1].price, p1 = series[i].price;
    if (p0 > 0 && isNum(p0) && isNum(p1)) out.push({ ts: series[i].ts, value: p1 / p0 - 1 });
  }
  return out;
}

/** SMA of numeric series (array of {ts,value}). */
export function sma(series, n) {
  const out = [];
  const q = [];
  let s = 0;
  for (let i = 0; i < series.length; i++) {
    const v = series[i].value;
    q.push(v); s += v;
    if (q.length > n) s -= q.shift();
    if (q.length === n) out.push({ ts: series[i].ts, value: s / n });
  }
  return out;
}

/** EMA of numeric series (array of {ts,value}). */
export function ema(series, n) {
  if (!series.length) return [];
  const k = 2 / (n + 1);
  let prev = series[0].value;
  const out = [{ ts: series[0].ts, value: prev }];
  for (let i = 1; i < series.length; i++) {
    const v = prev + k * (series[i].value - prev);
    out.push({ ts: series[i].ts, value: v });
    prev = v;
  }
  return out;
}

/** Z-score of momentum over rolling window m (applied to ROC values). */
export function zscore(series, m) {
  const out = [];
  const q = [];
  for (let i = 0; i < series.length; i++) {
    q.push(series[i].value);
    if (q.length > m) q.shift();
    if (q.length === m) {
      const z = (series[i].value - mean(q)) / (std(q) || 1);
      out.push({ ts: series[i].ts, value: z });
    }
  }
  return out;
}

/** Crossover signal: +1 when fast > slow, -1 when fast < slow (flat on tie). */
export function crossoverSignal(priceSeries, fastN = 20, slowN = 50) {
  // Use SMA of prices
  const ps = priceSeries.map(p => ({ ts: p.ts, value: p.price }));
  const fast = sma(ps, fastN);
  const slow = sma(ps, slowN);
  // align by ts
  const mapSlow = new Map(slow.map(x => [x.ts, x.value]));
  const out = [];
  for (const f of fast) {
    const s = mapSlow.get(f.ts);
    if (!isNum(s)) continue;
    const val = f.value > s ? 1 : f.value < s ? -1 : 0;
    out.push({ ts: f.ts, value: val });
  }
  return out;
}

// =============== Momentum scoring ===============

/**
 * Compute a composite momentum score: average of ROC over multiple lookbacks.
 * @param {Array<{ts:number, price:number}>} series
 * @param {number[]} lookbacks e.g., [20,60,120,252]
 * @param {"mean"|"sum"} [mode="mean"]
 * @returns {Array<{ts:number, score:number}>}
 */
export function momentumScore(series, lookbacks = [60, 120, 252], mode = "mean") {
  const rocs = lookbacks.map(n => roc(series, n));
  // index by ts
  const tsSet = new Set();
  rocs.forEach(a => a.forEach(x => tsSet.add(x.ts)));
  const out = [];
  for (const ts of Array.from(tsSet).sort((a, b) => a - b)) {
    const vals = rocs.map(a => (a.find(x => x.ts === ts)?.value));
    if (vals.every(isNum)) {
      const agg = mode === "sum" ? sum(vals) : mean(vals);
      out.push({ ts, score: agg });
    }
  }
  return out;
}

/** Turn a momentum score series into discrete positions via thresholds. */
export function thresholdSignal(scoreSeries, up = 0, down = 0, neutral = 0) {
  // up >  down for long-only, up>0, down<0 for L/S
  return scoreSeries.map(s => ({
    ts: s.ts,
    value: s.score > up ? 1 : s.score < down ? -1 : neutral,
  }));
}

// =============== Portfolio construction ===============

/**
 * Build portfolio weights from a momentum scoreboard.
 * @param {Record<string, Array<{ts:number, score:number}>>} panel map symbol->score series
 * @param {{ ts:number }[]} rebalances array of timestamps to (re)compute weights
 * @param {object} opts
 *   - topK: pick top K by score (absolute for L/S)
 *   - longShort: if true, split longs/shorts equally; else long-only
 *   - equalWeight: if true, equal-weight the chosen names; else rank-weight
 *   - gross: target gross exposure (e.g., 1.0)
 *   - capPerName: max abs weight per symbol
 * @returns {Array<{ts:number, weights: Record<string, number>}>}
 */
export function buildMomentumPortfolio(panel, rebalances, opts = {}) {
  const {
    topK = 10,
    longShort = false,
    equalWeight = true,
    gross = 1.0,
    capPerName = 0.1,
  } = opts;

  const out = [];
  for (const ts of rebalances.map((x) => (typeof x.ts === "string" ? new Date(x.ts).getTime() : x.ts))) {
    const snap = [];
    for (const [sym, ser] of Object.entries(panel)) {
      // pick last score <= ts
      const s = lastLE(ser, ts);
      if (s) snap.push({ symbol: sym, score: s.score });
    }
    if (!snap.length) continue;

    let longs = [], shorts = [];
    if (longShort) {
      const pos = snap.filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
      const neg = snap.filter(x => x.score < 0).sort((a, b) => a.score - b.score).slice(0, topK);
      longs = pos; shorts = neg;
    } else {
      longs = snap.sort((a, b) => b.score - a.score).slice(0, topK);
    }

    const weights = {};
    if (equalWeight) {
      if (longShort) {
        const wL = longs.length ? (gross / 2) / longs.length : 0;
        const wS = shorts.length ? (gross / 2) / shorts.length : 0;
        for (const x of longs) weights[x.symbol] = clamp(wL, -capPerName, capPerName);
        for (const x of shorts) weights[x.symbol] = clamp(-wS, -capPerName, capPerName);
      } else {
        const w = longs.length ? gross / longs.length : 0;
        for (const x of longs) weights[x.symbol] = clamp(w, -capPerName, capPerName);
      }
    } else {
      // rank-weighted (linearly scaled to gross)
      const scale = (arr) => {
        const ranks = arr.map((x, i) => ({ ...x, rank: arr.length - i })); // 1..N
        const rsum = sum(ranks.map(r => r.rank));
        return ranks.map(r => ({ symbol: r.symbol, w: r.rank / rsum }));
      };
      if (longShort) {
        const L = scale(longs), S = scale(shorts);
        for (const r of L) weights[r.symbol] = clamp((gross / 2) * r.w, -capPerName, capPerName);
        for (const r of S) weights[r.symbol] = clamp(-(gross / 2) * r.w, -capPerName, capPerName);
      } else {
        const L = scale(longs);
        for (const r of L) weights[r.symbol] = clamp(gross * r.w, -capPerName, capPerName);
      }
    }

    out.push({ ts, weights });
  }
  return out;
}

function lastLE(series, ts) {
  // binary search if you want; linear is fine for small arrays
  let best = null;
  for (let i = 0; i < series.length; i++) {
    if (series[i].ts <= ts) best = series[i];
    else break;
  }
  return best;
}

// =============== Turnkey strategy helper ===============

/**
 * Create a ready-to-use momentum strategy that produces portfolio targets.
 * You provide a function to fetch prices per symbol.
 *
 * @param {object} cfg
 *  - universe: string[] of symbols
 *  - lookbacks: number[] for composite momentum (e.g., [60,120,252])
 *  - rebalanceEveryDays: number (e.g., 21)
 *  - topK: number
 *  - longShort: boolean
 *  - equalWeight: boolean
 *  - capPerName: number
 *  - gross: number
 *  - fetchPrices: async (symbol) => Array<{ts:number|string, c:number}>
 * @returns {object} { run(): Promise<Array<{ts,weights}>>, scorePanel, settings }
 */
export function createMomentumStrategy(cfg) {
  const settings = {
    universe: cfg.universe || [],
    lookbacks: cfg.lookbacks || [60, 120, 252],
    rebalanceEveryDays: cfg.rebalanceEveryDays ?? 21,
    topK: cfg.topK ?? 10,
    longShort: !!cfg.longShort,
    equalWeight: cfg.equalWeight !== false,
    capPerName: cfg.capPerName ?? 0.1,
    gross: cfg.gross ?? 1.0,
    fetchPrices: cfg.fetchPrices, // required
  };

  async function run() {
    const panel = {};
    // 1) build score series per symbol
    for (const sym of settings.universe) {
      const bars = await settings.fetchPrices(sym);
      const prices = toPriceSeries(bars, "c");
      const scores = momentumScore(prices, settings.lookbacks, "mean");
      panel[sym] = scores;
    }

    // 2) make rebalance dates (from intersection of available dates or last symbol)
    const anySym = settings.universe[0];
    const base = toPriceSeries(await settings.fetchPrices(anySym), "c");
    const stepMs = settings.rebalanceEveryDays * 86_400_000;
    const rebalances = [];
    if (base.length) {
      let t = base[0].ts;
      const end = base[base.length - 1].ts;
      while (t <= end) { rebalances.push({ ts: t }); t += stepMs; }
    }

    // 3) portfolio weights on each rebalance
    const weights = buildMomentumPortfolio(panel, rebalances, {
      topK: settings.topK,
      longShort: settings.longShort,
      equalWeight: settings.equalWeight,
      gross: settings.gross,
      capPerName: settings.capPerName,
    });

    return weights;
  }

  return {
    run,
    settings,
  };
}

// =============== Quick demo (optional) ===============
if (import.meta.url === `file://${process.argv[1]}`) {
  // Tiny synthetic demo: two symbols trending differently
  const mk = (s0, drift, n = 300) => {
    let s = s0; const out = [];
    const start = Date.now() - n * 86_400_000;
    for (let i = 0; i < n; i++) {
      s *= 1 + drift + (Math.random() - 0.5) * 0.01;
      out.push({ ts: start + i * 86_400_000, c: s });
    }
    return out;
  };

  const fetchPrices = async (sym) => {
    if (sym === "MOMO") return mk(100, 0.0015);
    if (sym === "SLOW") return mk(100, 0.0002);
    return mk(100, 0.0008);
  };

  const strat = createMomentumStrategy({
    universe: ["MOMO", "SLOW", "FLAT"],
    lookbacks: [60, 120, 252],
    rebalanceEveryDays: 21,
    topK: 2,
    longShort: false,
    equalWeight: true,
    fetchPrices,
  });

  strat.run().then((w) => {
    console.log("Rebalances:", w.length);
    console.log("Last weights:", w.at(-1));
  });
}