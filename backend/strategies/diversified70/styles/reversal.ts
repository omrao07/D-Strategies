// styles/reversal.ts
// Pure TypeScript. No imports.
// Compact toolkit for price-reversal (mean-reversion) signals & backtests.
//
// What you get:
// - Basic stats helpers (returns, rolling mean/stdev, z-score, ATR).
// - Classic reversal indicators: RSI, RSI(2), Williams %R, distance-to-MA.
// - Gap/overnight/intraday reversal heuristics and composite score.
// - Vol-scaled sizing and a tiny threshold backtester with stops/take-profits.
//
// Conventions:
// - Arrays are oldest → newest.
// - Prices > 0 where required. Returns are decimals (0.01 = +1%).
// - All signals are numeric in [-1, +1] when applicable (sign indicates direction).

// ----------------------------- Types -----------------------------

export type Num = number;

export type OHLC = {
  o: number; h: number; l: number; c: number;
  prevClose?: number; // optional for gap calc; if missing, we infer from prior bar
};

export type ReversalParams = {
  lookback?: number;           // for z/MA/etc. default 20
  rsiLen?: number;             // default 14 (classic)
  useRSI2?: boolean;           // if true, blends RSI(2) with default RSI
  williamsLen?: number;        // default 14
  maKind?: "SMA" | "EMA";      // default "SMA"
  zEntry?: number;             // |z| >= zEntry to enter (default 1.0)
  zExit?: number;              // |z| <= zExit to exit (default 0.2)
  holdMax?: number;            // hard cap on holding days (default 10)
  atrLen?: number;             // ATR window for stops (default 14)
  stopAtr?: number;            // e.g., 2.5 ATR stop (optional)
  takeAtr?: number;            // e.g., 2.0 ATR take profit (optional)
  volTarget?: number;          // target vol per position (annualized or per-step proxy)
  useCloseToClose?: boolean;   // true: use c2c returns for z; else price-to-MA z
};

export type Trade = {
  entryIdx: number;
  exitIdx: number;
  side: "long" | "short";
  pnl: number;                  // in price points (close-to-close sum)
  barsHeld: number;
};

export type BacktestResult = {
  trades: Trade[];
  totalPnL: number;
  hitRate: number;
  avgHold: number;
  sharpe: number;
  maxDD: number;
};

// ----------------------------- Guards & basics -----------------------------

function isFiniteNumber(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export function simpleReturns(prices: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1], p1 = prices[i];
    out.push(isFiniteNumber(p0) && isFiniteNumber(p1) && p0 > 0 ? (p1 / p0 - 1) : NaN);
  }
  return out;
}

export function rollingMean(xs: number[], win: number): number[] {
  const out: number[] = [];
  let s = 0, q: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    q.push(x); if (isFiniteNumber(x)) s += x;
    if (q.length > win) {
      const old = q.shift()!;
      if (isFiniteNumber(old)) s -= old;
    }
    const valid = q.filter(isFiniteNumber);
    out.push(valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : NaN);
  }
  return out;
}

export function rollingEMA(xs: number[], win: number): number[] {
  const out: number[] = [];
  const a = 2 / (win + 1);
  let ema = NaN;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (!isFiniteNumber(x)) { out.push(NaN); continue; }
    ema = isFiniteNumber(ema) ? (a * x + (1 - a) * ema) : x;
    out.push(ema);
  }
  return out;
}

export function rollingStdev(xs: number[], win: number): number[] {
  const out: number[] = [];
  const q: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    q.push(xs[i]); if (q.length > win) q.shift();
    const v = variance(q.filter(isFiniteNumber), true);
    out.push(isFiniteNumber(v) ? Math.sqrt(Math.max(0, v)) : NaN);
  }
  return out;
}

export function variance(xs: number[], sample: boolean = true): number {
  let m = 0, s2 = 0, n = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]; if (!isFiniteNumber(x)) continue;
    n++; const d = x - m; m += d / n; s2 += d * (x - m);
  }
  if (n < 1) return NaN;
  return sample ? (n > 1 ? s2 / (n - 1) : 0) : s2 / n;
}

export function zscore(xs: number[], win: number): number[] {
  const mu = rollingMean(xs, win);
  const sd = rollingStdev(xs, win);
  const out: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    out.push(isFiniteNumber(x) && isFiniteNumber(mu[i]) && isFiniteNumber(sd[i]) && sd[i] > 0 ? (x - mu[i]) / sd[i] : NaN);
  }
  return out;
}

// ----------------------------- Vol & ATR -----------------------------

export function trueRange(o: number, h: number, l: number, cPrev: number): number {
  if (!(h > 0 && l > 0)) return NaN;
  const r1 = h - l;
  const r2 = Math.abs(h - cPrev);
  const r3 = Math.abs(l - cPrev);
  return Math.max(r1, r2, r3);
}

export function ATR(ohlc: OHLC[], len: number = 14): number[] {
  const out: number[] = [];
  let ema = NaN;
  const a = 2 / (len + 1);
  for (let i = 0; i < ohlc.length; i++) {
    const cPrev = i > 0 ? ohlc[i - 1].c : (ohlc[i].prevClose ?? ohlc[i].c);
    const tr = trueRange(ohlc[i].o, ohlc[i].h, ohlc[i].l, cPrev);
    if (!isFiniteNumber(tr)) { out.push(NaN); continue; }
    ema = isFiniteNumber(ema) ? (a * tr + (1 - a) * ema) : tr;
    out.push(ema);
  }
  return out;
}

// ----------------------------- Indicators -----------------------------

export function RSI(prices: number[], len: number = 14): number[] {
  const out: number[] = [];
  let avgU = NaN, avgD = NaN;
  for (let i = 0; i < prices.length; i++) {
    if (i === 0) { out.push(NaN); continue; }
    const ch = prices[i] - prices[i - 1];
    const u = Math.max(0, ch), d = Math.max(0, -ch);
    if (i < len) { out.push(NaN); continue; }
    if (i === len) {
      // seed with simple averages over first len periods
      let su = 0, sd = 0;
      for (let k = 1; k <= len; k++) {
        const ch2 = prices[k] - prices[k - 1];
        su += Math.max(0, ch2);
        sd += Math.max(0, -ch2);
      }
      avgU = su / len; avgD = sd / len;
    } else {
      avgU = (avgU as number) * (len - 1) / len + u / len;
      avgD = (avgD as number) * (len - 1) / len + d / len;
    }
    const rs = (avgD as number) > 0 ? (avgU as number) / (avgD as number) : Infinity;
    const rsi = 100 - (100 / (1 + rs));
    out.push(rsi);
  }
  return out;
}

export function WilliamsR(pricesHigh: number[], pricesLow: number[], pricesClose: number[], len: number = 14): number[] {
  const out: number[] = [];
  for (let i = 0; i < pricesClose.length; i++) {
    const L = Math.max(0, i - len + 1);
    const hi = Math.max(...pricesHigh.slice(L, i + 1));
    const lo = Math.min(...pricesLow.slice(L, i + 1));
    const c = pricesClose[i];
    if (!(hi > lo && isFiniteNumber(c))) { out.push(NaN); continue; }
    const wr = -100 * (hi - c) / (hi - lo);
    out.push(wr);
  }
  return out;
}

export function distanceFromMA(prices: number[], len: number = 20, kind: "SMA" | "EMA" = "SMA"): number[] {
  const ma = kind === "EMA" ? rollingEMA(prices, len) : rollingMean(prices, len);
  const out: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i], m = ma[i];
    out.push(isFiniteNumber(p) && isFiniteNumber(m) && m !== 0 ? (p / m - 1) : NaN);
  }
  return out;
}

// ----------------------------- Reversal heuristics -----------------------------

export function overnightReturn(prevClose: number[], open: number[]): number[] {
  const n = Math.min(prevClose.length, open.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const pc = prevClose[i], o = open[i];
    out.push(pc > 0 && isFiniteNumber(o) ? (o / pc - 1) : NaN);
  }
  return out;
}

export function intradayReturn(open: number[], close: number[]): number[] {
  const n = Math.min(open.length, close.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = open[i], c = close[i];
    out.push(o > 0 && isFiniteNumber(c) ? (c / o - 1) : NaN);
  }
  return out;
}

/** Gap fade score: large gap vs ATR → fade bias. Returns [-1..+1], +1 = long (fade down-gap). */
export function gapFadeScore(ohlc: OHLC[], atrLen: number = 14): number[] {
  const out: number[] = [];
  const atr = ATR(ohlc, atrLen);
  for (let i = 0; i < ohlc.length; i++) {
    const pc = i > 0 ? ohlc[i - 1].c : (ohlc[i].prevClose ?? NaN);
    const o = ohlc[i].o, a = atr[i];
    if (!(pc > 0 && o > 0 && isFiniteNumber(a) && a > 0)) { out.push(NaN); continue; }
    const gap = (o / pc - 1);
    const s = Math.max(-3, Math.min(3, gap / (a / Math.max(1, pc)))); // normalize by ATR as pct of price
    // Fade: if gap > 0 (up-gap), score negative (short); if gap < 0, score positive (long)
    out.push(-Math.max(-1, Math.min(1, s / 2)));
  }
  return out;
}

/** Composite reversal alpha: blend of (negative) z of returns, RSI(2)/RSI(14), and Williams %R. */
export function reversalAlpha(prices: number[], highs: number[], lows: number[], params?: ReversalParams): number[] {
  const L = params?.lookback ?? 20;
  const rsiLen = params?.rsiLen ?? 14;
  const willLen = params?.williamsLen ?? 14;

  const r = simpleReturns(prices);
  const zr = zscore(r.concat([NaN]), L); // align to price index
  const dist = distanceFromMA(prices, L, params?.maKind ?? "SMA");
  const zDist = zscore(dist.map(x => isFiniteNumber(x) ? x : NaN), L);

  const rsiMain = RSI(prices, rsiLen);
  const rsiTwo = RSI(prices, 2);
  const wr = WilliamsR(highs, lows, prices, willLen);

  const out: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    const s1 = isFiniteNumber(zr[i]) ? (-zr[i]) : 0;              // revert c2c
    const s2 = isFiniteNumber(zDist[i]) ? (-zDist[i]) : 0;        // revert to MA
    const s3 = isFiniteNumber(rsiMain[i]) ? ((50 - rsiMain[i]) / 50) : 0;  // <50 → positive
    const s4 = isFiniteNumber(rsiTwo[i]) ? ((50 - rsiTwo[i]) / 50) : 0;
    const s5 = isFiniteNumber(wr[i]) ? (-(wr[i] + 50) / 50) : 0;  // %R near -100 → +1; near 0 → -1

    // Blend with mild weights; emphasize short-term RSI(2) and zDist
    const alpha = 0.25 * s1 + 0.30 * s2 + 0.20 * s3 + 0.20 * s4 + 0.05 * s5;
    out.push(Math.max(-1, Math.min(1, alpha)));
  }
  return out;
}

// ----------------------------- Sizing & risk -----------------------------

export function volScaledWeight(targetVolPerStep: number, stepVol: number, cap: number = 1): number {
  if (!(isFiniteNumber(targetVolPerStep) && isFiniteNumber(stepVol)) || stepVol <= 0) return 0;
  return Math.max(0, Math.min(cap, targetVolPerStep / stepVol));
}

export function equityCurve(pnls: number[]): number[] {
  const out: number[] = []; let c = 0;
  for (let i = 0; i < pnls.length; i++) { const p = pnls[i]; c += isFiniteNumber(p) ? p : 0; out.push(c); }
  return out;
}

export function maxDrawdown(pnls: number[]): number {
  const eq = equityCurve(pnls);
  let peak = -Infinity, mdd = 0;
  for (let i = 0; i < eq.length; i++) { peak = Math.max(peak, eq[i]); mdd = Math.max(mdd, peak - eq[i]); }
  return mdd;
}

// ----------------------------- Tiny backtester -----------------------------

/**
 * Backtest a simple reversal rule using z of (return OR price-to-MA).
 * - Enter long if z <= -zEntry, short if z >= zEntry.
 * - Exit on |z| <= zExit or after holdMax bars or on stop/take (ATR-based).
 * - Position size = sign * volScaledWeight(volTarget, stepVol).
 */
export function backtestReversal(prices: number[], ohlc?: OHLC[], userParams?: ReversalParams): BacktestResult {
  const p = {
    lookback: 20,
    zEntry: 1.0,
    zExit: 0.2,
    holdMax: 10,
    atrLen: 14,
    stopAtr: undefined as number | undefined,
    takeAtr: undefined as number | undefined,
    volTarget: undefined as number | undefined,
    useCloseToClose: false,
    maKind: "SMA" as "SMA" | "EMA",
    ...userParams
  };

  const r = simpleReturns(prices);
  const seriesForZ = p.useCloseToClose
    ? r.concat([NaN]) // align
    : distanceFromMA(prices, p.lookback!, p.maKind!);
  const z = zscore(seriesForZ, p.lookback!);
  const stepVol = rollingStdev(r, p.lookback! + 1).concat([NaN]); // align to price index
  const atr = ohlc ? ATR(ohlc, p.atrLen) : undefined;

  const trades: Trade[] = [];
  let pos: { side: "long" | "short"; entryIdx: number; entryPx: number; bars: number; stop?: number; take?: number } | null = null;

  for (let i = 1; i < prices.length; i++) {
    const zi = z[i];
    if (!isFiniteNumber(zi)) continue;

    // Position sizing not used in trade list PnL (we report raw points); sizing is for external portfolio layer.
    // Stops/takes (if ATR provided)
    const px = prices[i];

    // Exit logic
    if (pos) {
      let exit = false;
      // z exit
      if (Math.abs(zi) <= (p.zExit as number)) exit = true;
      // hold cap
      if (pos.bars >= (p.holdMax as number)) exit = true;
      // stops/takes
      if (atr && (isFiniteNumber(p.stopAtr) || isFiniteNumber(p.takeAtr))) {
        const a = atr[i];
        if (isFiniteNumber(a)) {
          if (pos.side === "long") {
            const stop = pos.entryPx - (p.stopAtr ?? Infinity) * a;
            const take = pos.entryPx + (p.takeAtr ?? Infinity) * a;
            if (px <= stop || px >= take) exit = true;
          } else {
            const stop = pos.entryPx + (p.stopAtr ?? Infinity) * a;
            const take = pos.entryPx - (p.takeAtr ?? Infinity) * a;
            if (px >= stop || px <= take) exit = true;
          }
        }
      }

      if (exit) {
        const pnl = (pos.side === "long" ? (px - pos.entryPx) : (pos.entryPx - px));
        trades.push({ entryIdx: pos.entryIdx, exitIdx: i, side: pos.side, pnl, barsHeld: pos.bars });
        pos = null;
        continue;
      } else {
        pos.bars++;
      }
    }

    // Entry logic
    if (!pos) {
      if (zi <= -(p.zEntry as number)) {
        pos = { side: "long", entryIdx: i, entryPx: px, bars: 1 };
      } else if (zi >= (p.zEntry as number)) {
        pos = { side: "short", entryIdx: i, entryPx: px, bars: 1 };
      }
    }
  }

  // Force close at end
  if (pos) {
    const i = prices.length - 1, px = prices[i];
    const pnl = (pos.side === "long" ? (px - pos.entryPx) : (pos.entryPx - px));
    trades.push({ entryIdx: pos.entryIdx, exitIdx: i, side: pos.side, pnl, barsHeld: pos.bars });
    pos = null;
  }

  // Metrics
  const pnls = trades.map(t => t.pnl);
  const totalPnL = pnls.reduce((a, b) => a + b, 0);
  const v = variance(pnls, true);
  const sd = isFiniteNumber(v) ? Math.sqrt(Math.max(0, v)) : NaN;
  const sharpe = isFiniteNumber(sd) && sd > 0 ? (pnls.length > 0 ? (pnls.reduce((a, b) => a + b, 0) / pnls.length) / sd * Math.sqrt(Math.max(1, pnls.length)) : 0) : 0;
  const hitRate = trades.length > 0 ? trades.filter(t => t.pnl > 0).length / trades.length : 0;
  const avgHold = trades.length > 0 ? trades.reduce((a, t) => a + t.barsHeld, 0) / trades.length : 0;
  const maxDDval = maxDrawdown(pnls);

  return { trades, totalPnL, hitRate, avgHold, sharpe, maxDD: maxDDval };
}
