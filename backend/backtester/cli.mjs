#!/usr/bin/env node
// backtester/cli.mjs
// Zero-dependency (only Node built-ins) backtesting CLI.
// Supports: CSV OHLCV input, simple long-only engine, pluggable strategies,
// equity curve & trades export, and basic performance metrics.
// Usage examples:
//   node backtester/cli.mjs list
//   node backtester/cli.mjs run --data data/spy.csv --strategy sma --cash 100000 --fee-bps 1 --slippage-bps 1 --out equity.csv
//   node backtester/cli.mjs run --data prices.csv --strategyModule ./myStrategy.mjs --from 2020-01-01 --to 2024-12-31

// ------------------------------ Arg Parsing ------------------------------
function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { _: [] };
  let k = null;
  for (const a of args) {
    if (a.startsWith("--")) {
      const [key, val] = a.split("=", 2);
      if (val !== undefined) out[key.slice(2)] = coerce(val);
      else k = key.slice(2);
    } else if (a.startsWith("-") && a.length > 2) {
      // short cluster -abc -> -a -b -c (flags true)
      for (let i = 1; i < a.length; i++) out[a[i]] = true;
      k = null;
    } else if (a.startsWith("-")) {
      k = a.slice(1);
    } else {
      if (k) { out[k] = coerce(a); k = null; }
      else out._.push(a);
    }
  }
  return out;
}
function coerce(x) {
  if (x === "true") return true;
  if (x === "false") return false;
  if (!Number.isNaN(Number(x)) && x.trim() !== "") return Number(x);
  return x;
}
function usage() {
  console.log(`Backtester CLI
Commands:
  list                            List built-in strategies
  run [options]                   Run a backtest

Options (run):
  --data <path>                   CSV file with columns: timestamp,open,high,low,close,volume
  --from <YYYY-MM-DD>             Start date filter (inclusive)
  --to <YYYY-MM-DD>               End date filter (inclusive)
  --strategy <name>               Built-in: sma | breakout | buyhold
  --strategyModule <path>         Path to ESM module exporting default strategy { name, init, onBar, onEnd? }
  --cash <number>                 Starting cash (default 100000)
  --fee-bps <number>              Fee per notional in basis points (default 0)
  --slippage-bps <number>         Slippage per side in bps (default 0)
  --size <fraction>               Fraction of equity to allocate on each entry (0..1, default 1)
  --out <path>                    Write equity curve CSV
  --trades <path>                 Write trades CSV
  --tz <IANA>                     Timezone label for output (no conversion, label only)
  --quiet                         Less console output

Examples:
  node backtester/cli.mjs run --data ./ohlc.csv --strategy sma --cash 50000 --fee-bps 1 --slippage-bps 1
`);
}

// ------------------------------ CSV Reader ------------------------------
async function readCSV(path, { from, to } = {}) {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(path, 'utf8');
  const lines = raw.replace(/\r/g, "").split("\n").filter(Boolean);
  const header = lines[0].split(",").map(s => s.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const need = ["timestamp","open","high","low","close","volume"];
  for (const n of need) if (idx(n) === -1) throw new Error(`CSV missing column "${n}"`);
  const out = [];
  const fromTs = from ? Date.parse(from + "T00:00:00Z") : -Infinity;
  const toTs = to ? Date.parse(to + "T23:59:59Z") : Infinity;
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    if (cols.length !== header.length) continue;
    const tsRaw = cols[idx("timestamp")];
    const ts = parseTimestamp(tsRaw);
    if (!Number.isFinite(ts)) continue;
    if (ts < fromTs || ts > toTs) continue;
    out.push({
      t: ts,
      o: +cols[idx("open")],
      h: +cols[idx("high")],
      l: +cols[idx("low")],
      c: +cols[idx("close")],
      v: +cols[idx("volume")],
    });
  }
  out.sort((a,b) => a.t - b.t);
  return out;
}
function parseTimestamp(s) {
  // supports ISO, "YYYY-MM-DD", or epoch ms
  if (!s) return NaN;
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s + "T00:00:00Z");
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
}
function splitCSVLine(line) {
  // minimal CSV splitter (no nested quotes); acceptable for clean OHLC files
  const out = [];
  let cur = "", inQ = false;
  for (let i=0;i<line.length;i++) {
    const ch = line[i];
    if (ch === '"' ) {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// ------------------------------ Engine ------------------------------
function createEngine({ cash=100000, feeBps=0, slippageBps=0, size=1 }={}) {
  const state = {
    cash: +cash,
    equity: +cash,
    pos: 0,                // units
    avgPrice: 0,
    equityCurve: [],
    trades: [],
    feeBps: +feeBps,
    slipBps: +slippageBps,
    size: Math.max(0, Math.min(1, +size || 1)),
    highWater: +cash,
    maxDD: 0,
    lastClose: 0,
  };
  function markToMarket(ts, close) {
    state.lastClose = close;
    const positionValue = state.pos * close;
    state.equity = state.cash + positionValue;
    state.highWater = Math.max(state.highWater, state.equity);
    const dd = state.highWater > 0 ? 1 - (state.equity / state.highWater) : 0;
    state.maxDD = Math.max(state.maxDD, dd);
    state.equityCurve.push({ t: ts, equity: round2(state.equity) });
  }
  function notionalToUnits(notional, price) { return notional / price; }
  function cost(notional) {
    const fee = Math.abs(notional) * (state.feeBps/10000);
    const slip = Math.abs(notional) * (state.slipBps/10000);
    return fee + slip;
  }
  function buy(ts, price, fraction=state.size, meta={}) {
    // allocate fraction of CURRENT equity
    const alloc = Math.max(0, Math.min(1, fraction)) * state.equity;
    if (alloc <= 0) return;
    const units = notionalToUnits(alloc, price);
    const notion = units * price;
    const fees = cost(notion);
    if (state.cash < notion + fees) return;
    state.cash -= (notion + fees);
    state.avgPrice = (state.pos * state.avgPrice + units * price) / (state.pos + units);
    state.pos += units;
    state.trades.push({ ts, side: "BUY", price, units, fees: round2(fees), meta });
  }
  function sell(ts, price, fraction=1, meta={}) {
    const units = state.pos * Math.max(0, Math.min(1, fraction));
    if (units <= 0) return;
    const notion = units * price;
    const fees = cost(notion);
    const pnl = (price - state.avgPrice) * units - fees;
    state.cash += (notion - fees);
    state.pos -= units;
    if (state.pos === 0) state.avgPrice = 0;
    state.trades.push({ ts, side: "SELL", price, units, fees: round2(fees), pnl: round2(pnl), meta });
  }
  function flat(ts, price, meta={}) {
    if (state.pos > 0) sell(ts, price, 1, meta);
  }
  return { state, markToMarket, buy, sell, flat };
}

// ------------------------------ Built-in Strategies ------------------------------
const Builtins = {
  buyhold: {
    name: "buyhold",
    description: "Buy on first bar, hold to end.",
    init(engine) { /* no state */ },
    onBar(bar, engine) {
      const { state, buy } = engine;
      if (state.pos === 0) buy(bar.t, bar.c, 1, { reason: "init" });
    },
    onEnd(_engine) { /* noop */ },
  },
  sma: (periodFast = 10, periodSlow = 50) => ({
    name: "sma",
    description: `SMA crossover (${periodFast}/${periodSlow})`,
    _buf: [],
    _fast: 0,
    _slow: 0,
    init(_engine) { /* buffers reset */ },
    onBar(bar, engine) {
      this._buf.push(bar.c);
      if (this._buf.length > periodSlow) this._buf.shift();
      if (this._buf.length >= periodSlow) {
        this._fast = avg(this._buf.slice(-periodFast));
        this._slow = avg(this._buf.slice(-periodSlow));
        const { state, buy, flat } = engine;
        const prev = this._prevCross;
        const crossUp = this._fast > this._slow;
        if (prev === undefined) this._prevCross = crossUp;
        else if (crossUp && prev === false && state.pos === 0) {
          buy(bar.t, bar.c, 1, { reason: "golden" });
          this._prevCross = true;
        } else if (!crossUp && prev === true && state.pos > 0) {
          flat(bar.t, bar.c, { reason: "death" });
          this._prevCross = false;
        }
      }
      engine.markToMarket(bar.t, bar.c);
    },
    onEnd(engine) { engine.markToMarket(engine.state.equityCurve.at(-1)?.t ?? 0, engine.state.lastClose); },
  }),
  breakout: (lookback = 50) => ({
    name: "breakout",
    description: `Donchian breakout (${lookback})`,
    _h: [], _l: [],
    init() {},
    onBar(bar, engine) {
      this._h.push(bar.h); if (this._h.length > lookback) this._h.shift();
      this._l.push(bar.l); if (this._l.length > lookback) this._l.shift();
      const maxH = Math.max(...this._h), minL = Math.min(...this._l);
      const { state, buy, flat } = engine;
      if (this._h.length === lookback) {
        if (bar.c >= maxH && state.pos === 0) buy(bar.t, bar.c, 1, { reason: "breakout-up" });
        else if (bar.c <= minL && state.pos > 0) flat(bar.t, bar.c, { reason: "breakout-down" });
      }
      engine.markToMarket(bar.t, bar.c);
    },
    onEnd(engine) { engine.markToMarket(engine.state.equityCurve.at(-1)?.t ?? 0, engine.state.lastClose); },
  }),
};

// ------------------------------ Metrics ------------------------------
function metrics(curve, trades, startCash) {
  if (!curve.length) return {};
  const start = curve[0].equity ?? startCash;
  const end = curve[curve.length - 1].equity;
  const ret = (end - start) / start;

  // daily returns (assumes 1 bar = 1 day if input is daily)
  const rets = [];
  for (let i = 1; i < curve.length; i++) {
    const r = (curve[i].equity - curve[i-1].equity) / curve[i-1].equity;
    if (Number.isFinite(r)) rets.push(r);
  }
  const avgR = rets.length ? avg(rets) : 0;
  const stdR = rets.length ? std(rets) : 0;
  const sharpe = stdR > 0 ? (avgR / stdR) * Math.sqrt(252) : 0;

  const { maxDD, ddSeries } = drawdownSeries(curve.map(x => x.equity));
  const tradePnls = trades.filter(t => t.side === "SELL").map(t => t.pnl ?? 0);
  const wins = tradePnls.filter(x => x > 0).length;
  const winRate = tradePnls.length ? wins / tradePnls.length : 0;

  // CAGR using years between first/last timestamps
  const years = Math.max(1/252, (curve[curve.length - 1].t - curve[0].t) / (365.25*24*3600*1000));
  const cagr = Math.pow(end / start, 1/years) - 1;

  return {
    start: round2(start),
    end: round2(end),
    return: round4(ret),
    cagr: round4(cagr),
    sharpe: round4(sharpe),
    maxDrawdown: round4(maxDD),
    bars: curve.length,
    trades: tradePnls.length,
    winRate: round4(winRate),
    ddSeries, // raw if needed
  };
}
function drawdownSeries(equity) {
  let peak = equity[0], maxDD = 0;
  const out = [];
  for (const e of equity) {
    peak = Math.max(peak, e);
    const dd = peak > 0 ? 1 - (e/peak) : 0;
    maxDD = Math.max(maxDD, dd);
    out.push(dd);
  }
  return { maxDD, ddSeries: out };
}
const avg = (a) => a.reduce((s,x)=>s+x,0)/a.length;
function std(a) { const m = avg(a); const v = a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length>1?a.length-1:1); return Math.sqrt(v); }
const round2 = (x) => Math.round(x*100)/100;
const round4 = (x) => Math.round(x*10000)/10000;

// ------------------------------ Strategy Loader ------------------------------
async function loadStrategy({ strategy, strategyModule, params }) {
  if (strategyModule) {
    const mod = await import(pathToFileURLSafe(strategyModule));
    const s = mod.default ?? mod.strategy ?? mod;
    if (!s || typeof s.init !== "function" || typeof s.onBar !== "function") {
      throw new Error("strategyModule must export default { name, init(engine), onBar(bar, engine), onEnd? }");
    }
    return s;
  }
  switch ((strategy ?? "sma").toLowerCase()) {
    case "sma": {
      const f = Number(params?.fast ?? 10);
      const s = Number(params?.slow ?? 50);
      return Builtins.sma(f, s);
    }
    case "breakout": {
      const lb = Number(params?.lookback ?? 50);
      return Builtins.breakout(lb);
    }
    case "buyhold":
      return Builtins.buyhold;
    default:
      throw new Error(`Unknown built-in strategy "${strategy}". Try: sma, breakout, buyhold`);
  }
}
function pathToFileURLSafe(p) {
  if (/^file:\/\//.test(p)) return p;
  const { pathToFileURL } = requireNodeURL();
  return pathToFileURL(resolvePath(p)).href;
}
function resolvePath(p) {
  const { resolve } = requireNodePath();
  return resolve(process.cwd(), p);
}
function requireNodePath(){ return requireLazy('node:path'); }
function requireNodeURL(){ return requireLazy('node:url'); }
function requireLazy(spec){ return (globalThis.___cache ??= {}), (globalThis.___cache[spec] ??= (new Function('s', 'return import(s)'))(spec)); }

// ------------------------------ Writers ------------------------------
async function writeCSV(path, rows, header) {
  if (!path || !rows?.length) return;
  const { writeFile } = await import('node:fs/promises');
  const lines = [];
  if (header) lines.push(header.join(","));
  for (const r of rows) lines.push(header.map(h => escapeCSV(String(r[h] ?? ""))).join(","));
  await writeFile(path, lines.join("\n"), "utf8");
}
function escapeCSV(s) {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g,'""')}"`;
  return s;
}

// ------------------------------ Orchestrator ------------------------------
async function run() {
  const args = parseArgs(process.argv);
  const cmd = args._[0];

  if (!cmd || cmd === "help" || args.h) {
    usage();
    return;
  }

  if (cmd === "list") {
    console.log("Built-in strategies:");
    console.log(`- buyhold       : Buy once and hold`);
    console.log(`- sma           : SMA crossover (args: --fast=10 --slow=50)`);
    console.log(`- breakout      : Donchian breakout (args: --lookback=50)`);
    return;
  }

  if (cmd === "run") {
    const dataPath = args.data;
    if (!dataPath) {
      console.error("Error: --data <path> required");
      process.exit(1);
    }
    const from = args.from ? String(args.from) : undefined;
    const to = args.to ? String(args.to) : undefined;
    const feeBps = +args["fee-bps"] || 0;
    const slippageBps = +args["slippage-bps"] || 0;
    const startCash = Number.isFinite(+args.cash) ? +args.cash : 100000;
    const size = Number.isFinite(+args.size) ? +args.size : 1;
    const tz = args.tz ? String(args.tz) : "UTC";

    const quiet = !!args.quiet;

    const bars = await readCSV(dataPath, { from, to });
    if (!bars.length) {
      console.error("No bars after filtering. Check --from/--to or CSV.");
      process.exit(1);
    }
    const strat = await loadStrategy({
      strategy: args.strategy,
      strategyModule: args.strategyModule,
      params: { fast: args.fast, slow: args.slow, lookback: args.lookback }
    });

    const engine = createEngine({ cash: startCash, feeBps, slippageBps, size });
    strat.init?.(engine);

    for (const b of bars) {
      strat.onBar(b, engine);
      // If strategy didn't call markToMarket, ensure equity is tracked:
      if (engine.state.equityCurve.length === 0 || engine.state.equityCurve.at(-1).t !== b.t) {
        engine.markToMarket(b.t, b.c);
      }
    }
    strat.onEnd?.(engine);

    const m = metrics(engine.state.equityCurve, engine.state.trades, startCash);

    if (!quiet) {
      console.log(`\nStrategy: ${strat.name}${strat.description ? " — " + strat.description : ""}`);
      console.log(`Bars: ${m.bars}, Trades: ${m.trades}, WinRate: ${(m.winRate*100).toFixed(1)}%`);
      console.log(`Return: ${(m.return*100).toFixed(2)}%  CAGR: ${(m.cagr*100).toFixed(2)}%  Sharpe: ${m.sharpe}`);
      console.log(`MaxDD: ${(m.maxDrawdown*100).toFixed(2)}%  End Equity: ${m.end}\n`);
    }

    if (args.out) {
      const eqRows = engine.state.equityCurve.map(r => ({
        timestamp: new Date(r.t).toISOString(),
        equity: r.equity
      }));
      await writeCSV(String(args.out), eqRows, ["timestamp","equity"]);
      if (!quiet) console.log(`Equity curve -> ${args.out}`);
    }

    if (args.trades) {
      const tRows = engine.state.trades.map(t => ({
        timestamp: new Date(t.ts).toISOString(),
        side: t.side,
        price: t.price,
        units: t.units,
        fees: t.fees ?? 0,
        pnl: t.pnl ?? "",
        note: stringifyMeta(t.meta)
      }));
      await writeCSV(String(args.trades), tRows, ["timestamp","side","price","units","fees","pnl","note"]);
      if (!quiet) console.log(`Trades -> ${args.trades}`);
    }

    // Print last few equity points if quiet
    if (quiet) {
      const last = engine.state.equityCurve.at(-1);
      console.log(JSON.stringify({ end_equity: last?.equity, return: m.return, cagr: m.cagr, sharpe: m.sharpe, maxDD: m.maxDrawdown }));
    }
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  usage();
}

function stringifyMeta(m) {
  if (!m) return "";
  try { return JSON.stringify(m); } catch { return String(m); }
}

// Node ESM helpers for dynamic import of built-ins
// (avoid top-level imports to keep file self-contained)
run().catch(e => { console.error(e?.stack || String(e)); process.exit(1); });
