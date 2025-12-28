/* =========================================================
   Technical Indicators – Self Contained
   Strict-safe, noUncheckedIndexedAccess compatible
   ========================================================= */

/* ===================== Moving Averages ===================== */

export function sma(x: number[], window: number): number[] {
  const out: number[] = [];
  let sum = 0;

  for (let i = 0; i < x.length; i++) {
    sum += x[i]!;
    if (i >= window) sum -= x[i - window]!;
    out.push(i + 1 >= window ? sum / window : NaN);
  }
  return out;
}

export function ema(x: number[], window: number): number[] {
  const out: number[] = [];
  if (x.length === 0) return out;

  const alpha = 2 / (window + 1);
  let prev = x[0]!;

  out.push(prev);

  for (let i = 1; i < x.length; i++) {
    const v = alpha * x[i]! + (1 - alpha) * prev;
    out.push(v);
    prev = v;
  }
  return out;
}

/* ===================== Momentum ===================== */

export function roc(x: number[], window: number): number[] {
  const out: number[] = [];

  for (let i = 0; i < x.length; i++) {
    if (i < window || x[i - window]! === 0) {
      out.push(NaN);
    } else {
      out.push((x[i]! / x[i - window]!) - 1);
    }
  }
  return out;
}

export function momentum(x: number[], window: number): number[] {
  const out: number[] = [];

  for (let i = 0; i < x.length; i++) {
    if (i < window) out.push(NaN);
    else out.push(x[i]! - x[i - window]!);
  }
  return out;
}

/* ===================== RSI ===================== */

export function rsi(x: number[], period = 14): number[] {
  const out: number[] = new Array(x.length).fill(NaN);
  if (x.length < period + 1) return out;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const d = x[i]! - x[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }

  gain /= period;
  loss /= period;

  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);

  for (let i = period + 1; i < x.length; i++) {
    const d = x[i]! - x[i - 1]!;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;

    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;

    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }

  return out;
}

/* ===================== Volatility ===================== */

export function trueRange(
  high: number[],
  low: number[],
  close: number[]
): number[] {
  const n = Math.min(high.length, low.length, close.length);
  const out: number[] = new Array(n).fill(NaN);

  for (let i = 1; i < n; i++) {
    const h = high[i]!;
    const l = low[i]!;
    const pc = close[i - 1]!;
    out[i] = Math.max(
      h - l,
      Math.abs(h - pc),
      Math.abs(l - pc)
    );
  }
  return out;
}

export function atr(
  high: number[],
  low: number[],
  close: number[],
  period = 14
): number[] {
  const tr = trueRange(high, low, close);
  const out: number[] = [];
  let sum = 0;

  for (let i = 0; i < tr.length; i++) {
    sum += tr[i]!;
    if (i >= period) sum -= tr[i - period]!;
    out.push(i + 1 >= period ? sum / period : NaN);
  }
  return out;
}

/* ===================== Bands ===================== */

export function bollingerBands(
  x: number[],
  window = 20,
  k = 2
): { middle: number[]; upper: number[]; lower: number[] } {
  const middle = sma(x, window);
  const upper: number[] = [];
  const lower: number[] = [];

  for (let i = 0; i < x.length; i++) {
    if (i + 1 < window) {
      upper.push(NaN);
      lower.push(NaN);
      continue;
    }

    let s = 0;
    const m = middle[i]!;
    for (let j = i + 1 - window; j <= i; j++) {
      const d = x[j]! - m;
      s += d * d;
    }

    const sd = Math.sqrt(s / window);
    upper.push(m + k * sd);
    lower.push(m - k * sd);
  }

  return { middle, upper, lower };
}