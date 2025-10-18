// riskarb/statarb.ts
// Pure TypeScript (no imports). Production-ready pairs/stat-arb utilities.
// Spread = log(A) − β·log(B); signals from z-score mean reversion.
// Includes: rolling beta, z-score signal, position rules, and backtest with TC & vol targeting.

// -------------------- Types --------------------
export type StatArbSignal = {
  z: number;                // z-score of spread
  beta: number;             // hedge ratio on log basis
  spread: number;           // log(A) - beta*log(B)
  mean: number;             // rolling mean of spread
  stdev: number;            // rolling stdev of spread
  side: "longA_shortB" | "shortA_longB" | "flat";
  size: number;             // |position| in [0,1] before leverage
};

export type RunConfig = {
  lookback?: number;        // z-score window (default 60)
  betaLookback?: number;    // beta regression window (default = lookback)
  entryZ?: number;          // enter when |z| >= entryZ (default 1.0)
  exitZ?: number;           // exit when |z| <= exitZ (default 0.2)
  hardStopZ?: number;       // flatten if |z| >= hardStopZ (default 3.5)
  maxPosition?: number;     // cap position size in [0,1] (default 1)
  positionSlope?: number;   // size = min(maxPosition, |z|/positionSlope) (default 2)
  tcBpsPerLeg?: number;     // transaction cost per leg per turnover in bps (default 1)
  volTarget?: number;       // annual vol target; if undefined → no targeting
  volLookback?: number;     // realized vol lookback for targeting (default 60)
  maxLeverage?: number;     // cap on leverage for vol targeting (default 5)
};

export type BacktestResult = {
  dailyRawRet: number[];      // un-levered daily returns (pair P&L as % of equity)
  dailyLevRet: number[];      // levered returns (after vol target)
  dailyLev: number[];         // leverage applied each day
  signalPath: StatArbSignal[];// signal snapshot each day
  posA: number[];             // exposure to A (notional fraction of equity)
  posB: number[];             // exposure to B
  cumReturn: number;
  annReturn: number;
  annVol: number;
  sharpe: number;
  winRate: number;            // fraction of >0 dailyLevRet
  avgTradeDays: number;       // mean holding period (days)
  trades: number;             // number of completed round trips
};

// -------------------- Utils --------------------
function isFiniteNumber(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
function safe(x: any, d = 0): number {
  return isFiniteNumber(x) ? x : d;
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
function mean(a: number[]): number {
  if (a.length === 0) return 0;
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}
function variance(a: number[]): number {
  if (a.length <= 1) return 0;
  const m = mean(a);
  let v = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - m; v += d * d; }
  return v / (a.length - 1);
}
function cov(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n <= 1) return 0;
  const ma = mean(a.slice(-n)), mb = mean(b.slice(-n));
  let c = 0; for (let i = 0; i < n; i++) c += (a[i] - ma) * (b[i] - mb);
  return c / (n - 1);
}
function annVolFromDaily(d: number[]): number {
  const v = variance(d);
  return Math.sqrt(v) * Math.sqrt(252);
}
function annReturnFromDaily(d: number[]): number {
  if (d.length === 0) return 0;
  let c = 1; for (let i = 0; i < d.length; i++) c *= (1 + d[i]);
  const yrs = d.length / 252;
  return yrs > 0 ? Math.pow(c, 1 / yrs) - 1 : 0;
}
function sign(x: number): number { return x > 0 ? 1 : x < 0 ? -1 : 0; }

// -------------------- Core: rolling beta --------------------
/** OLS beta of logA on logB over last `w` points. If degenerate, fallback to 1. */
function rollingBeta(logA: number[], logB: number[], w: number): number {
  const n = Math.min(logA.length, logB.length, w);
  if (n <= 1) return 1;
  const a = logA.slice(-n);
  const b = logB.slice(-n);
  const vB = variance(b);
  if (vB <= 1e-12) return 1;
  return cov(a, b) / vB;
}

// -------------------- Signal --------------------
export function statArbSignalAt(
  logA: number[],
  logB: number[],
  cfg: RunConfig = {}
): StatArbSignal {
  const L = Math.max(2, Math.floor(safe(cfg.lookback, 60)));
  const LB = Math.max(2, Math.floor(safe(cfg.betaLookback, L)));

  const beta = rollingBeta(logA, logB, LB);
  const spreadSeries = [];
  const n = Math.min(logA.length, logB.length);
  const start = Math.max(0, n - L);
  for (let i = start; i < n; i++) {
   
  }
  const spr = spreadSeries.length > 0 ? spreadSeries[spreadSeries.length - 1] : 0;
  const m = mean(spreadSeries);
  const sd = Math.sqrt(Math.max(variance(spreadSeries), 1e-12));

  const z = (spr - m) / sd;

  const entry = safe(cfg.entryZ, 1.0);
  const stop = safe(cfg.hardStopZ, 3.5);
  const posSlope = Math.max(0.1, safe(cfg.positionSlope, 2));
  const maxPos = clamp(safe(cfg.maxPosition, 1), 0, 1);

  let side: StatArbSignal["side"] = "flat";
  let size = 0;

  if (Math.abs(z) >= entry && Math.abs(z) < stop) {
    // mean-revert: if spread is high (+z), short A long B; if low, long A short B
    side = z > 0 ? "shortA_longB" : "longA_shortB";
    size = clamp(Math.abs(z) / posSlope, 0, maxPos);
  } else if (Math.abs(z) >= stop) {
    side = "flat";
    size = 0;
  }

  return { z, beta, spread: spr, mean: m, stdev: sd, side, size };
}

// -------------------- Backtest --------------------
export type StatArbInputs = {
  priceA: number[];      // price series of asset A
  priceB: number[];      // price series of asset B
  cfg?: RunConfig;
};

/**
 * P&L model:
 * - Notional per leg = size (fraction of equity); pair is market-neutral via hedge ratio β.
 * - Daily raw return ≈ size * [ rA - β rB ] with sign depending on side.
 * - Transaction costs: 2 legs * tcBpsPerLeg applied on turnover (|ΔposA| + |ΔposB|).
 * - Vol targeting optionally rescales daily returns by leverage L_t.
 */
export function runStatArbPairs(inputs: StatArbInputs): BacktestResult {
  const P1 = inputs.priceA || [];
  const P2 = inputs.priceB || [];
  const n = Math.min(P1.length, P2.length);
  const cfg = inputs.cfg || {};

  const L = Math.max(2, Math.floor(safe(cfg.lookback, 60)));
  const LB = Math.max(2, Math.floor(safe(cfg.betaLookback, L)));
  const exitZ = safe(cfg.exitZ, 0.2);
  const tcPerLeg = Math.abs(safe(cfg.tcBpsPerLeg, 1)) / 10000; // in decimal
  const volTarget = cfg.volTarget;
  const volLb = Math.max(2, Math.floor(safe(cfg.volLookback, 60)));
  const maxLev = safe(cfg.maxLeverage, 5);

  const logA: number[] = [];
  const logB: number[] = [];
  for (let i = 0; i < n; i++) {
    logA.push(Math.log(Math.max(P1[i], 1e-12)));
    logB.push(Math.log(Math.max(P2[i], 1e-12)));
  }

  const raw: number[] = [];
  const lev: number[] = [];
  const levRet: number[] = [];
  const sigs: StatArbSignal[] = [];
  const posA: number[] = [];
  const posB: number[] = [];

  let curSide: StatArbSignal["side"] = "flat";
  let curSize = 0;
  let curBeta = 1;

  let trades = 0;
  let curHold = 0;
  const holdDurations: number[] = [];

  // helper to flatten and record trade duration
  function flatten() {
    if (curSide !== "flat") {
      trades += 1;
      holdDurations.push(curHold);
      curHold = 0;
    }
    curSide = "flat";
    curSize = 0;
  }

  // iterate from second point to compute returns
  for (let t = 1; t < n; t++) {
    // compute signal using data up to t (inclusive)
    const sig = statArbSignalAt(logA.slice(0, t + 1), logB.slice(0, t + 1), cfg);
    sigs.push(sig);

    // exit/entry logic with hysteresis
    if (curSide === "flat") {
      if (sig.side !== "flat") { curSide = sig.side; curSize = sig.size; curBeta = sig.beta; curHold = 0; }
    } else {
      // if hit hard stop -> flatten
      if (Math.abs(sig.z) >= safe(cfg.hardStopZ, 3.5)) {
        flatten();
      } else if (Math.abs(sig.z) <= exitZ) {
        flatten();
      } else {
        // keep side, adjust size softly toward signal size
        curSize = clamp(0.5 * curSize + 0.5 * sig.size, 0, safe(cfg.maxPosition, 1));
        curBeta = sig.beta;
        curHold += 1;
      }
    }

    // daily log returns
    const rA = logA[t] - logA[t - 1];
    const rB = logB[t] - logB[t - 1];

    let pair = 0;
    if (curSide === "longA_shortB") pair = curSize * (rA - curBeta * rB);
    else if (curSide === "shortA_longB") pair = curSize * (-rA + curBeta * rB);
    else pair = 0;

    // transaction costs on turnover (both legs)
    const prevA = posA.length ? posA[posA.length - 1] : 0;
    const prevB = posB.length ? posB[posB.length - 1] : 0;

    const targetA = curSide === "longA_shortB" ? +curSize : curSide === "shortA_longB" ? -curSize : 0;
    const targetB = curSide === "longA_shortB" ? -curSize * curBeta : curSide === "shortA_longB" ? +curSize * curBeta : 0;

    const turnA = Math.abs(targetA - prevA);
    const turnB = Math.abs(targetB - prevB);
    const tc = (Math.abs(targetA) + Math.abs(targetB)) > 0 ? (turnA + turnB) * tcPerLeg : 0;

    const rUnlev = pair - tc;
    raw.push(rUnlev);
    posA.push(targetA);
    posB.push(targetB);

    // vol targeting
    let Lmult = 1;
    if (isFiniteNumber(volTarget)) {
      const win = raw.slice(Math.max(0, raw.length - volLb));
      const realized = annVolFromDaily(win);
      Lmult = realized > 0 ? clamp(volTarget! / realized, 0, maxLev) : 0;
    }
    lev.push(Lmult);
    levRet.push(rUnlev * Lmult);
  }

  const wins = levRet.filter(x => x > 0).length;
  const cum = levRet.reduce((c, x) => c * (1 + x), 1) - 1;
  const aR = annReturnFromDaily(levRet);
  const aV = annVolFromDaily(levRet);
  const shp = aV > 0 ? aR / aV : 0;
  const avgHold = holdDurations.length ? mean(holdDurations) : 0;

  return {
    dailyRawRet: raw,
    dailyLevRet: levRet,
    dailyLev: lev,
    signalPath: sigs,
    posA,
    posB,
    cumReturn: cum,
    annReturn: aR,
    annVol: aV,
    sharpe: shp,
    winRate: levRet.length ? wins / levRet.length : 0,
    avgTradeDays: avgHold,
    trades,
  };
}

// -------------------- Convenience summary --------------------
export function statArbSummary(
  priceA: number[],
  priceB: number[],
  cfg: RunConfig = {}
) {
  if (priceA.length < 2 || priceB.length < 2) {
    return { ok: false, message: "Need at least 2 prices for each series." };
  }
  const res = runStatArbPairs({ priceA, priceB, cfg });
  const lastSig = res.signalPath.length ? res.signalPath[res.signalPath.length - 1] : undefined;

  const template =
    lastSig && lastSig.side === "longA_shortB"
      ? ["Long A", `Short ${lastSig.beta.toFixed(3)} × B`]
      : lastSig && lastSig.side === "shortA_longB"
      ? ["Short A", `Long ${lastSig.beta.toFixed(3)} × B`]
      : ["Flat"];

  return {
    ok: true,
    latestSignal: lastSig,
    tradeTemplate: template,
    annReturn: res.annReturn,
    annVol: res.annVol,
    sharpe: res.sharpe,
    notes: [
      "Spread defined on logs to stabilize variance; β is rolling OLS of log(A) on log(B).",
      "Signals use z-score with entry/exit bands; hard-stop flattens extreme divergence.",
      "Returns are after transaction costs on turnover and optional volatility targeting.",
    ],
  };
}
