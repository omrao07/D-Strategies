// backtester/metrics.ts
// Lightweight performance metrics for backtests (no deps).

export type MetricsOptions = {
  /** Observations per year (trading days=252, hours=24*365, etc.). Default 252 */
  periodsPerYear?: number;
  /** Risk-free rate (annualized). Default 0 */
  riskFree?: number;
  /** Use log returns for CAGR/Sharpe (default: false => simple returns) */
  logReturns?: boolean;
};

export type ReturnStats = {
  n: number;
  mean: number;         // arithmetic mean of periodic returns
  stdev: number;        // sample std-dev of returns
  downsideStdev: number;// sample std-dev of negative returns
  skew?: number;
  kurtosis?: number;
  winRate: number;      // fraction > 0
  avgWin: number;
  avgLoss: number;      // negative (or 0 if none)
  expectancy: number;   // avgWin*winRate + avgLoss*(1-winRate)
};

export type DrawdownPoint = {
  idx: number;          // index into series
  equity: number;
  peak: number;
  dd: number;           // drawdown amount (equity - peak) <= 0
  ddPct: number;        // drawdown as % of peak (<= 0)
};

export type DrawdownStats = {
  maxDD: number;        // most negative drawdown (amount)
  maxDDPct: number;     // most negative drawdown (%)
  maxDDStart: number;
  maxDDEnd: number;
  avgDDPct?: number;
  ddSeries: DrawdownPoint[];
};

export type PerfMetrics = {
  // Return-based (annualized where applicable)
  cagr?: number;
  sharpe?: number;
  sortino?: number;
  vol?: number;         // annualized volatility
  calmar?: number;
  mar?: number;         // CAGR / |MaxDD%|
  // Rebalance/edge
  hitRate?: number;
  avgWin?: number;
  avgLoss?: number;
  expectancy?: number;
  // Equity/Drawdown
  maxDD?: number;       // amount
  maxDDPct?: number;    // %
  // Count
  periods?: number;
};

/* ----------------------------- Public API ----------------------------- */

/** Compute metrics from an equity/NAV series. */
export function metricsFromEquity(
  equity: number[],
  opts: MetricsOptions = {}
): PerfMetrics {
  if (!equity || equity.length < 2) return { periods: equity?.length ?? 0 };

  const returns = toReturns(equity, opts.logReturns === true);
  const retStats = metricsFromReturns(returns, opts);

  const dd = drawdownStats(equity);
  const cagr = CAGR(equity[0], equity[equity.length - 1], returns.length, opts.periodsPerYear ?? 252);

  const maxDDPctAbs = Math.abs(dd.maxDDPct || 0);
  const calmar = maxDDPctAbs > 0 ? (retStats.cagrAnnual ?? cagr ?? 0) / maxDDPctAbs : undefined;
  const mar = maxDDPctAbs > 0 ? (cagr ?? 0) / maxDDPctAbs : undefined;

  return {
    cagr,
    sharpe: retStats.sharpe,
    sortino: retStats.sortino,
    vol: retStats.vol,
    calmar,
    mar,
    hitRate: retStats.winRate,
    avgWin: retStats.avgWin,
    avgLoss: retStats.avgLoss,
    expectancy: retStats.expectancy,
    maxDD: dd.maxDD,
    maxDDPct: dd.maxDDPct,
    periods: returns.length,
  };
}

/** Compute metrics directly from a returns series (periodic returns). */
export function metricsFromReturns(
  returns: number[],
  opts: MetricsOptions = {}
): PerfMetrics & ReturnStats & { cagrAnnual?: number } {
  const ppy = opts.periodsPerYear ?? 252;
  const rf = opts.riskFree ?? 0;

  const n = returns.length;
  const mean = avg(returns);
  const stdev = std(returns);
  const downside = std(returns.filter((r) => r < 0));

  const sharpe = stdev > 0 ? ((mean - rf / ppy) * Math.sqrt(ppy)) / stdev : undefined;
  const sortino = downside > 0 ? ((mean - rf / ppy) * Math.sqrt(ppy)) / downside : undefined;

  const vol = stdev * Math.sqrt(ppy);

  const { winRate, avgWin, avgLoss, expectancy } = edgeStats(returns);

  // Convert to annual CAGR proxy from mean periodic return
  const cagrAnnual = opts.logReturns
    ? Math.exp(mean * ppy) - 1
    : (1 + mean) ** ppy - 1;

  return {
    n,
    mean,
    stdev,
    downsideStdev: downside,
    skew: skewness(returns),
    kurtosis: excessKurtosis(returns),
    winRate,
    avgWin,
    avgLoss,
    expectancy,
    sharpe,
    sortino,
    vol,
    cagrAnnual,
    periods: n,
  };
}

/** Compute drawdown path + summary stats for an equity series. */
export function drawdownStats(equity: number[]): DrawdownStats {
  if (!equity.length) return { maxDD: 0, maxDDPct: 0, maxDDStart: 0, maxDDEnd: 0, ddSeries: [] };

  let peak = equity[0];
  let peakIdx = 0;
  let maxDD = 0, maxDDPct = 0, maxStart = 0, maxEnd = 0;
  const ddSeries: DrawdownPoint[] = [];

  for (let i = 0; i < equity.length; i++) {
    const v = equity[i];
    if (v > peak) { peak = v; peakIdx = i; }
    const dd = v - peak;
    const ddPct = peak !== 0 ? dd / peak : 0;
    ddSeries.push({ idx: i, equity: v, peak, dd, ddPct });

    if (dd < maxDD) { maxDD = dd; maxStart = peakIdx; maxEnd = i; }
    if (ddPct < maxDDPct) maxDDPct = ddPct;
  }

  const avgDDPct = ddSeries.length ? ddSeries.reduce((s, x) => s + x.ddPct, 0) / ddSeries.length : 0;

  return { maxDD, maxDDPct, maxDDStart: maxStart, maxDDEnd: maxEnd, avgDDPct, ddSeries };
}

/* ------------------------------ Utilities ------------------------------ */

/** Convert equity curve to periodic returns (simple or log). */
export function toReturns(equity: number[], log = false): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const a = equity[i - 1], b = equity[i];
    if (log) out.push(Math.log(Math.max(1e-12, b / Math.max(1e-12, a))));
    else out.push((b - a) / (Math.abs(a) > 1e-12 ? a : 1));
  }
  return out;
}

/** CAGR from start & end value and number of periods. */
export function CAGR(start: number, end: number, periods: number, periodsPerYear = 252): number | undefined {
  if (periods <= 0 || start <= 0 || end <= 0) return undefined;
  const years = periods / periodsPerYear;
  return years > 0 ? (end / start) ** (1 / years) - 1 : undefined;
}

/** Hit-rate/expectancy summary for a returns array. */
export function edgeStats(returns: number[]) {
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r < 0);
  const winRate = returns.length ? wins.length / returns.length : 0;
  const avgWin = wins.length ? avg(wins) : 0;
  const avgLoss = losses.length ? avg(losses) : 0; // negative
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;
  return { winRate, avgWin, avgLoss, expectancy };
}

/** Rolling Sharpe over a window (returns series). */
export function rollingSharpe(returns: number[], window: number, periodsPerYear = 252) {
  const out: number[] = Array(Math.max(0, returns.length - window + 1)).fill(0);
  for (let i = 0; i + window <= returns.length; i++) {
    const slice = returns.slice(i, i + window);
    const m = avg(slice), s = std(slice);
    out[i] = s > 0 ? (m * Math.sqrt(periodsPerYear)) / s : 0;
  }
  return out;
}

/* ------------------------------- Math bits ------------------------------ */

function avg(a: number[]) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
function std(a: number[]) {
  if (a.length <= 1) return 0;
  const m = avg(a);
  let s2 = 0;
  for (const x of a) s2 += (x - m) ** 2;
  return Math.sqrt(s2 / (a.length - 1));
}
function skewness(a: number[]) {
  if (a.length < 3) return undefined;
  const m = avg(a), s = std(a);
  if (s === 0) return 0;
  const n = a.length;
  const num = a.reduce((acc, x) => acc + ((x - m) / s) ** 3, 0) * (n / ((n - 1) * (n - 2)));
  return num;
}
function excessKurtosis(a: number[]) {
  if (a.length < 4) return undefined;
  const m = avg(a), s = std(a);
  if (s === 0) return 0;
  const n = a.length;
  const sum4 = a.reduce((acc, x) => acc + ((x - m) / s) ** 4, 0);
  // Fisher’s definition (excess kurtosis)
  const g2 =
    ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * sum4 -
    (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  return g2;
}
