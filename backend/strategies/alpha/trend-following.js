// alpha/trend following.js
// Multi-asset trend-following toolkit + turnkey portfolio builder.
// ESM/NodeNext, zero external deps.

// =============== tiny utils ===============
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const sum = (a) => a.reduce((s, v) => s + v, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);

function toTs(x) { return typeof x === "string" ? new Date(x).getTime() : +x; }
function byTs(a, b) { return a.ts - b.ts; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// =============== OHLC helpers ===============
/**
 * Normalize to OHLC series: [{ts, o,h,l,c, v?, symbol?}]
 * Accepts rows with at least {ts, c} (others optional).
 */
export function toOHLC(rows) {
  const out = [];
  for (const r of rows || []) {
    const ts = toTs(r.ts);
    const c = +r.c;
    if (!isNum(ts) || !isNum(c)) continue;
    out.push({
      ts,
      o: isNum(r.o) ? +r.o : c,
      h: isNum(r.h) ? +r.h : c,
      l: isNum(r.l) ? +r.l : c,
      c,
      v: isNum(r.v) ? +r.v : undefined,
      symbol: r.symbol,
    });
  }
  return out.sort(byTs);
}

export function closeSeries(ohlc) {
  return (ohlc || []).map(b => ({ ts: b.ts, value: b.c })).sort(byTs);
}

// =============== indicators ===============
export function sma(series, n) {
  const out = [];
  const q = []; let s = 0;
  for (let i = 0; i < series.length; i++) {
    const v = +series[i].value; q.push(v); s += v;
    if (q.length > n) s -= q.shift();
    if (q.length === n) out.push({ ts: series[i].ts, value: s / n });
  }
  return out;
}

export function ema(series, n) {
  if (!series.length) return [];
  const k = 2 / (n + 1);
  let prev = series[0].value;
  const out = [{ ts: series[0].ts, value: prev }];
  for (let i = 1; i < series.length; i++) {
    const v = prev + k * (series[i].value - prev);
    out.push({ ts: series[i].ts, value: v }); prev = v;
  }
  return out;
}

export function atr(ohlc, n = 14) {
  const out = [];
  const trArr = [];
  let prevClose = ohlc?.[0]?.c;
  for (let i = 0; i < ohlc.length; i++) {
    const b = ohlc[i];
    const tr = Math.max(
      b.h - b.l,
      isNum(prevClose) ? Math.abs(b.h - prevClose) : 0,
      isNum(prevClose) ? Math.abs(b.l - prevClose) : 0
    );
    trArr.push(tr);
    if (trArr.length > n) trArr.shift();
    if (trArr.length === n) out.push({ ts: b.ts, value: mean(trArr) });
    prevClose = b.c;
  }
  return out;
}

export function macd(series, fast = 12, slow = 26, signal = 9) {
  const eFast = ema(series, fast), eSlow = ema(series, slow);
  const mapSlow = new Map(eSlow.map(x => [x.ts, x.value]));
  const line = [];
  for (const e of eFast) {
    const s = mapSlow.get(e.ts);
    if (isNum(s)) line.push({ ts: e.ts, value: e.value - s });
  }
  const sig = ema(line, signal);
  const mapSig = new Map(sig.map(x => [x.ts, x.value]));
  const hist = line.map(x => ({ ts: x.ts, value: x.value - (mapSig.get(x.ts) ?? 0) }));
  return { line, signal: sig, hist };
}

/** Wilder’s DX/ADX-lite based on ATR proxy (simple variant). */
export function adxLite(ohlc, n = 14) {
  if (ohlc.length < n + 1) return [];
  const plusDM = []; const minusDM = []; const trs = [];
  for (let i = 1; i < ohlc.length; i++) {
    const upMove = ohlc[i].h - ohlc[i - 1].h;
    const downMove = ohlc[i - 1].l - ohlc[i].l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(
      ohlc[i].h - ohlc[i].l,
      Math.abs(ohlc[i].h - ohlc[i - 1].c),
      Math.abs(ohlc[i].l - ohlc[i - 1].c)
    ));
  }
  const roll = (a) => {
    const out = []; const q = []; let s = 0;
    for (let i = 0; i < a.length; i++) {
      q.push(a[i]); s += a[i];
      if (q.length > n) s -= q.shift();
      if (q.length === n) out.push(s / n);
    }
    return out;
  };
  const pdm = roll(plusDM), mdm = roll(minusDM), atrS = roll(trs);
  const out = [];
  for (let i = 0; i < Math.min(pdm.length, mdm.length, atrS.length); i++) {
    const idx = i + (ohlc.length - atrS.length);
    const plusDI = atrS[i] ? 100 * (pdm[i] / atrS[i]) : 0;
    const minusDI = atrS[i] ? 100 * (mdm[i] / atrS[i]) : 0;
    const dx = (plusDI + minusDI) ? (100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI)) : 0;
    out.push({ ts: ohlc[idx].ts, value: dx }); // DX; ADX would be EMA of DX—this is “lite”
  }
  // return EMA of DX for smoother ADX
  const dxSeries = out.map(x => ({ ts: x.ts, value: x.value }));
  return ema(dxSeries, n);
}

// =============== entry/exit signals ===============
/** Moving-average crossover (+1 long, -1 short, 0 flat) */
export function maCrossover(ohlc, fastN = 50, slowN = 200, useEMA = true) {
  const closes = closeSeries(ohlc);
  const fast = (useEMA ? ema : sma)(closes, fastN);
  const slow = (useEMA ? ema : sma)(closes, slowN);
  const M = new Map(slow.map(x => [x.ts, x.value]));
  const out = [];
  for (const f of fast) {
    const s = M.get(f.ts);
    if (!isNum(s)) continue;
    out.push({ ts: f.ts, value: f.value > s ? 1 : f.value < s ? -1 : 0 });
  }
  return out;
}

/** Donchian breakout: +1 if close >= highest(high, n), -1 if close <= lowest(low, n) */
export function donchian(ohlc, n = 55) {
  const out = [];
  const winH = []; const winL = [];
  for (let i = 0; i < ohlc.length; i++) {
    const b = ohlc[i];
    winH.push(b.h); winL.push(b.l);
    if (winH.length > n) { winH.shift(); winL.shift(); }
    if (winH.length === n) {
      const hi = Math.max(...winH), lo = Math.min(...winL);
      const sig = b.c >= hi ? 1 : b.c <= lo ? -1 : 0;
      out.push({ ts: b.ts, value: sig });
    }
  }
  return out;
}

/** MACD sign: +1 if line>signal, -1 if line<signal */
export function macdSignal(ohlc, fast = 12, slow = 26, signal = 9) {
  const closes = closeSeries(ohlc);
  const { line, signal: sig } = macd(closes, fast, slow, signal);
  const mapSig = new Map(sig.map(x => [x.ts, x.value]));
  const out = [];
  for (const l of line) {
    const s = mapSig.get(l.ts);
    if (!isNum(s)) continue;
    out.push({ ts: l.ts, value: l.value > s ? 1 : l.value < s ? -1 : 0 });
  }
  return out;
}

/** Combine multiple signals by majority vote. */
export function voteSignals(signals /* array of [{ts, value}] */) {
  const map = new Map();
  for (const s of signals) for (const x of s) {
    const v = map.get(x.ts) ?? 0;
    map.set(x.ts, v + (x.value > 0 ? 1 : x.value < 0 ? -1 : 0));
  }
  const out = [];
  for (const ts of Array.from(map.keys()).sort((a, b) => a - b)) {
    const v = map.get(ts);
    out.push({ ts, value: v > 0 ? 1 : v < 0 ? -1 : 0 });
  }
  return out;
}

// =============== risk & exits ===============
/** ATR trailing stop: returns a stop series (price level) for a long (+) or short (-) trend. */
export function atrStop(ohlc, atrN = 20, k = 3) {
  const A = atr(ohlc, atrN);
  const mapA = new Map(A.map(x => [x.ts, x.value]));
  const out = [];
  let trend = 0; // +1 long, -1 short, 0 unknown
  let stop = undefined;

  for (const b of ohlc) {
    const a = mapA.get(b.ts);
    if (!isNum(a)) continue;

    if (!isNum(stop)) { // initialize stop around first bar
      trend = 0;
      stop = b.c;
    }

    // update stop depending on trend
    if (trend >= 0) { // long or flat
      stop = Math.max(stop, b.c - k * a); // trailing up
      if (b.c < stop) { trend = -1; stop = b.c + k * a; }
    }
    if (trend <= 0) { // short or flat
      stop = Math.min(stop, b.c + k * a); // trailing down
      if (b.c > stop) { trend = 1; stop = b.c - k * a; }
    }

    out.push({ ts: b.ts, value: stop, trend });
  }
  return out;
}

/** Position sizing by volatility parity: w ∝ 1 / ATR */
export function volParityWeights(panelATR /* {sym: [{ts,value}]} */, ts, capPerName = 0.2) {
  const entries = [];
  for (const [sym, series] of Object.entries(panelATR)) {
    const last = lastLE(series, ts);
    if (last && isNum(last.value) && last.value > 0) {
      entries.push({ sym, inv: 1 / last.value });
    }
  }
  const total = sum(entries.map(e => e.inv)) || 1;
  const raw = entries.map(e => ({ sym: e.sym, w: e.inv / total }));
  const weights = {};
  for (const r of raw) weights[r.sym] = clamp(r.w, 0, capPerName);
  return weights;
}

function lastLE(series, ts) {
  let best = null;
  for (let i = 0; i < series.length; i++) {
    if (series[i].ts <= ts) best = series[i]; else break;
  }
  return best;
}

// =============== turnkey: multi-asset trend portfolio ===============
/**
 * Create a diversified trend-following portfolio builder.
 * Produces target weights at rebalance dates.
 *
 * cfg:
 *  - universe: string[]
 *  - fetchBars: async (symbol) => [{ts,o,h,l,c,v?}]
 *  - rebalanceEveryDays: number (e.g., 21)
 *  - entry: "donchian" | "mac" | "macd" | "vote"
 *  - params: object (per entry type):
 *      donchian: { n?: 55 }
 *      mac: { fast?:50, slow?:200, useEMA?:true }
 *      macd: { fast?:12, slow?:26, signal?:9 }
 *      vote: { fast?:50, slow?:200, donchian?:55, macdFast?:12, macdSlow?:26, macdSig?:9 }
 *  - risk:
 *      atrN?: number (default 20), atrK?: number (stop multiple, default 3)
 *      capPerName?: number (max weight per symbol, default 0.2)
 *      gross?: number (gross exposure, default 1.0)
 *  - longShort?: boolean (default false = long-only; if true, shorts when signal -1)
 *
 * returns: { run(): Promise<Array<{ts, weights}>> }
 */
export function createTrendPortfolio(cfg) {
  const settings = {
    universe: cfg.universe || [],
    fetchBars: cfg.fetchBars,
    rebalanceEveryDays: cfg.rebalanceEveryDays ?? 21,
    entry: cfg.entry ?? "donchian",
    params: cfg.params || {},
    risk: { atrN: 20, atrK: 3, capPerName: 0.2, gross: 1.0, ...(cfg.risk || {}) },
    longShort: !!cfg.longShort,
  };

  async function run() {
    // 1) load all bars
    const book = {}; // {sym: ohlc[]}
    for (const sym of settings.universe) book[sym] = toOHLC(await settings.fetchBars(sym));

    // 2) build indicator panels
    const panelSig = {}; // {sym: [{ts,value}] in {-1,0,1}}
    const panelATR = {}; // {sym: [{ts,value}]}
    for (const [sym, bars] of Object.entries(book)) {
      let sig;
      if (settings.entry === "donchian") {
        sig = donchian(bars, settings.params.n ?? 55);
      } else if (settings.entry === "mac") {
        sig = maCrossover(bars, settings.params.fast ?? 50, settings.params.slow ?? 200, settings.params.useEMA !== false);
      } else if (settings.entry === "macd") {
        sig = macdSignal(bars, settings.params.fast ?? 12, settings.params.slow ?? 26, settings.params.signal ?? 9);
      } else if (settings.entry === "vote") {
        const s1 = maCrossover(bars, settings.params.fast ?? 50, settings.params.slow ?? 200, settings.params.useEMA !== false);
        const s2 = donchian(bars, settings.params.donchian ?? 55);
        const s3 = macdSignal(bars, settings.params.macdFast ?? 12, settings.params.macdSlow ?? 26, settings.params.macdSig ?? 9);
        sig = voteSignals([s1, s2, s3]);
      } else {
        sig = donchian(bars, 55);
      }
      panelSig[sym] = sig;
      panelATR[sym] = atr(bars, settings.risk.atrN ?? 20);
    }

    // 3) build rebalance dates from a reference symbol (first with data)
    const refSym = settings.universe.find(s => (book[s] || []).length > 0);
    if (!refSym) return [];
    const ref = book[refSym];
    const stepMs = (settings.rebalanceEveryDays || 21) * 86_400_000;
    const rebalances = [];
    if (ref.length) {
      let t = ref[0].ts, end = ref[ref.length - 1].ts;
      while (t <= end) { rebalances.push({ ts: t }); t += stepMs; }
    }

    // 4) at each rebalance, compute target weights:
    const targets = [];
    for (const { ts } of rebalances) {
      // a) base weights by vol parity across *eligible* symbols (signal != 0)
      const elig = {};
      for (const sym of settings.universe) {
        const s = lastLE(panelSig[sym] || [], ts);
        if (!s || s.value === 0) continue;
        elig[sym] = true;
      }

      const atrSlice = {};
      for (const sym of Object.keys(elig)) atrSlice[sym] = panelATR[sym] || [];

      let w = volParityWeights(atrSlice, ts, settings.risk.capPerName);
      // b) apply direction (+/-) according to signal and longShort flag
      const directed = {};
      const longs = [], shorts = [];
      for (const [sym, baseW] of Object.entries(w)) {
        const s = lastLE(panelSig[sym], ts)?.value ?? 0;
        if (s > 0) { directed[sym] = baseW; longs.push(sym); }
        else if (s < 0 && settings.longShort) { directed[sym] = -baseW; shorts.push(sym); }
      }

      // c) scale to gross exposure
      const gross = sum(Object.values(directed).map(Math.abs));
      const scale = gross > 0 ? (settings.risk.gross / gross) : 0;
      for (const k of Object.keys(directed)) directed[k] *= scale;

      targets.push({ ts, weights: directed });
    }

    return targets;
  }

  return { run, settings };
}

// =============== quick demo (optional) ===============
if (import.meta.url === `file://${process.argv[1]}`) {
  // Synthetic two-asset demo
  const mk = (s0, drift, vol = 0.01, n = 600) => {
    let s = s0; const out = [];
    const start = Date.now() - n * 86_400_000;
    for (let i = 0; i < n; i++) {
      s *= 1 + drift + (Math.random() - 0.5) * vol;
      const o = s * (1 - 0.003), h = s * (1 + 0.005), l = s * (1 - 0.005), c = s;
      out.push({ ts: start + i * 86_400_000, o, h, l, c });
    }
    return out;
  };

  const fetchBars = async (sym) => {
    if (sym === "TREND") return mk(100, 0.0012);
    if (sym === "CHOP")  return mk(100, 0.0000, 0.02);
    return mk(100, 0.0005);
  };

  const strat = createTrendPortfolio({
    universe: ["TREND", "CHOP", "NEUTRAL"],
    fetchBars,
    entry: "vote", // combines MA xover + Donchian + MACD
    params: { fast: 50, slow: 200, donchian: 55 },
    longShort: true,
    risk: { atrN: 20, atrK: 3, capPerName: 0.25, gross: 1.0 },
    rebalanceEveryDays: 21,
  });

  strat.run().then(w => {
    console.log("rebalances:", w.length);
    console.log("last weights:", w.at(-1));
  });
}