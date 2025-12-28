/* =========================================================
   Analytics Utilities – Self-Contained Barrel
   Strict-safe, noUncheckedIndexedAccess compatible
   ========================================================= */

/* ===================== Basic Stats ===================== */

export function mean(x: number[]): number {
  const n = x.length;
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i]!;
  return s / n;
}

export function median(x: number[]): number {
  const n = x.length;
  if (n === 0) return 0;

  const a = [...x].sort((p, q) => p - q);
  const m = Math.floor(n / 2);

  if (n % 2 === 1) return a[m]!;
  return (a[m - 1]! + a[m]!) / 2;
}

export function variance(x: number[]): number {
  const n = x.length;
  if (n < 2) return 0;

  const m = mean(x);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i]!;
    s += (v - m) ** 2;
  }
  return s / (n - 1);
}

export function stddev(x: number[]): number {
  return Math.sqrt(variance(x));
}

export function covariance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;

  const ma = mean(a);
  const mb = mean(b);
  let s = 0;

  for (let i = 0; i < n; i++) {
    s += (a[i]! - ma) * (b[i]! - mb);
  }
  return s / (n - 1);
}

/* ===================== Rolling Ops ===================== */

export function rollingSum(x: number[], w: number): number[] {
  const out: number[] = [];
  let s = 0;

  for (let i = 0; i < x.length; i++) {
    s += x[i]!;
    if (i >= w) s -= x[i - w]!;
    out.push(i + 1 >= w ? s : NaN);
  }
  return out;
}

export function rollingMean(x: number[], w: number): number[] {
  return rollingSum(x, w).map(v => isFinite(v) ? v / w : NaN);
}

export function rollingStd(x: number[], w: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < x.length; i++) {
    if (i + 1 < w) {
      out.push(NaN);
      continue;
    }
    const slice = x.slice(i + 1 - w, i + 1);
    out.push(stddev(slice));
  }
  return out;
}

export function rollingMin(x: number[], w: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < x.length; i++) {
    if (i + 1 < w) {
      out.push(NaN);
      continue;
    }
    let m = Infinity;
    for (let j = i + 1 - w; j <= i; j++) m = Math.min(m, x[j]!);
    out.push(m);
  }
  return out;
}

export function rollingMax(x: number[], w: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < x.length; i++) {
    if (i + 1 < w) {
      out.push(NaN);
      continue;
    }
    let m = -Infinity;
    for (let j = i + 1 - w; j <= i; j++) m = Math.max(m, x[j]!);
    out.push(m);
  }
  return out;
}

/* ===================== Performance ===================== */

export function cumulativeReturns(returns: number[]): number[] {
  const out: number[] = [];
  let acc = 1;

  for (let i = 0; i < returns.length; i++) {
    acc *= 1 + returns[i]!;
    out.push(acc - 1);
  }
  return out;
}

export function annualizedReturn(returns: number[], periodsPerYear = 252): number {
  if (returns.length === 0) return 0;
  const cr = cumulativeReturns(returns).at(-1)!;
  return Math.pow(1 + cr, periodsPerYear / returns.length) - 1;
}

export function drawdownCurve(equity: number[]): number[] {
  const out: number[] = [];
  let peak = -Infinity;

  for (let i = 0; i < equity.length; i++) {
    peak = Math.max(peak, equity[i]!);
    out.push(peak > 0 ? (equity[i]! / peak) - 1 : 0);
  }
  return out;
}

export function maxDrawdown(equity: number[]): number {
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