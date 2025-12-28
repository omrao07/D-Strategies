/* =========================================================
   Returns & PnL Utilities
   Self-contained, strict-safe, no imports
   ========================================================= */

/* ===================== Types ===================== */

export type ReturnSeries = number[];
export type PriceSeries = number[];
export type EquitySeries = number[];

/* ===================== Basic Returns ===================== */

/**
 * Simple returns: (P_t / P_{t-1}) - 1
 */
export function simpleReturns(prices: PriceSeries): ReturnSeries {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1]!;
    const cur = prices[i]!;
    out.push(prev !== 0 ? cur / prev - 1 : 0);
  }
  return out;
}

/**
 * Log returns: ln(P_t / P_{t-1})
 */
export function logReturns(prices: PriceSeries): ReturnSeries {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1]!;
    const cur = prices[i]!;
    out.push(prev > 0 && cur > 0 ? Math.log(cur / prev) : 0);
  }
  return out;
}

/* ===================== Aggregation ===================== */

/**
 * Convert returns to equity curve (start = 1)
 */
export function returnsToEquity(returns: ReturnSeries): EquitySeries {
  const out: number[] = [];
  let acc = 1;

  for (let i = 0; i < returns.length; i++) {
    acc *= 1 + returns[i]!;
    out.push(acc);
  }
  return out;
}

/**
 * Convert equity curve to returns
 */
export function equityToReturns(equity: EquitySeries): ReturnSeries {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]!;
    const cur = equity[i]!;
    out.push(prev !== 0 ? cur / prev - 1 : 0);
  }
  return out;
}

/* ===================== Cumulative & Annualized ===================== */

export function cumulativeReturn(returns: ReturnSeries): number {
  let acc = 1;
  for (let i = 0; i < returns.length; i++) {
    acc *= 1 + returns[i]!;
  }
  return acc - 1;
}

export function cumulativeReturns(returns: ReturnSeries): ReturnSeries {
  const out: number[] = [];
  let acc = 1;
  for (let i = 0; i < returns.length; i++) {
    acc *= 1 + returns[i]!;
    out.push(acc - 1);
  }
  return out;
}

export function annualizedReturn(
  returns: ReturnSeries,
  periodsPerYear = 252
): number {
  if (returns.length === 0) return 0;
  const total = cumulativeReturn(returns);
  return Math.pow(1 + total, periodsPerYear / returns.length) - 1;
}

/* ===================== Volatility ===================== */

export function volatility(
  returns: ReturnSeries,
  periodsPerYear = 252
): number {
  const n = returns.length;
  if (n < 2) return 0;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += returns[i]!;
  mean /= n;

  let v = 0;
  for (let i = 0; i < n; i++) {
    const d = returns[i]! - mean;
    v += d * d;
  }

  return Math.sqrt(v / (n - 1)) * Math.sqrt(periodsPerYear);
}

/* ===================== Drawdowns ===================== */

export function drawdownSeries(equity: EquitySeries): number[] {
  const out: number[] = [];
  let peak = -Infinity;

  for (let i = 0; i < equity.length; i++) {
    peak = Math.max(peak, equity[i]!);
    out.push(peak > 0 ? equity[i]! / peak - 1 : 0);
  }
  return out;
}

export function maxDrawdown(equity: EquitySeries): number {
  let peak = -Infinity;
  let maxDD = 0;

  for (let i = 0; i < equity.length; i++) {
    peak = Math.max(peak, equity[i]!);
    if (peak > 0) {
      const dd = 1 - equity[i]! / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }
  return maxDD;
}

/* ===================== PnL ===================== */

/**
 * Apply position weights to returns
 */
export function strategyReturns(
  returns: ReturnSeries,
  weights: number[]
): ReturnSeries {
  const n = Math.min(returns.length, weights.length);
  const out: number[] = [];

  for (let i = 0; i < n; i++) {
    out.push(returns[i]! * weights[i]!);
  }
  return out;
}