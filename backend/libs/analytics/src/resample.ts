/* =========================================================
   Time Series Resampling Utilities
   Strict-safe, self-contained, no imports
   ========================================================= */

/* ===================== Types ===================== */

export type TimePoint<T = number> = {
  t: number; // timestamp (ms or monotonic)
  v: T;
};

export type OHLC = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type Bar = {
  t: number; // bucket start time
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
};

/* ===================== Helpers ===================== */

function bucketStart(t: number, intervalMs: number): number {
  return Math.floor(t / intervalMs) * intervalMs;
}

/* ===================== Numeric Resample ===================== */

/**
 * Resample numeric time series using last-value carry
 */
export function resampleNumeric(
  x: TimePoint<number>[],
  intervalMs: number
): TimePoint<number>[] {
  if (x.length === 0) return [];

  const out: TimePoint<number>[] = [];
  let curBucket = bucketStart(x[0]!.t, intervalMs);
  let last = x[0]!.v;

  for (let i = 0; i < x.length; i++) {
    const p = x[i]!;
    const b = bucketStart(p.t, intervalMs);

    if (b !== curBucket) {
      out.push({ t: curBucket, v: last });
      curBucket = b;
    }
    last = p.v;
  }

  out.push({ t: curBucket, v: last });
  return out;
}

/* ===================== OHLC Resample ===================== */

/**
 * Convert ticks or lower-timeframe bars into OHLC bars
 */
export function resampleOHLC(
  x: Array<{ t: number; price: number; volume?: number }>,
  intervalMs: number
): Bar[] {
  if (x.length === 0) return [];

  const out: Bar[] = [];

  let curBucket = bucketStart(x[0]!.t, intervalMs);
  let o = x[0]!.price;
  let h = o;
  let l = o;
  let c = o;
  let v = x[0]!.volume ?? 0;

  for (let i = 1; i < x.length; i++) {
    const p = x[i]!;
    const b = bucketStart(p.t, intervalMs);

    if (b !== curBucket) {
      out.push({ t: curBucket, o, h, l, c, v });
      curBucket = b;
      o = p.price;
      h = p.price;
      l = p.price;
      c = p.price;
      v = p.volume ?? 0;
    } else {
      h = Math.max(h, p.price);
      l = Math.min(l, p.price);
      c = p.price;
      if (p.volume !== undefined) v += p.volume;
    }
  }

  out.push({ t: curBucket, o, h, l, c, v });
  return out;
}

/* ===================== Bar → Higher TF ===================== */

/**
 * Resample existing OHLC bars to higher timeframe
 */
export function resampleBars(
  bars: Bar[],
  intervalMs: number
): Bar[] {
  if (bars.length === 0) return [];

  const out: Bar[] = [];

  let curBucket = bucketStart(bars[0]!.t, intervalMs);
  let o = bars[0]!.o;
  let h = bars[0]!.h;
  let l = bars[0]!.l;
  let c = bars[0]!.c;
  let v = bars[0]!.v ?? 0;

  for (let i = 1; i < bars.length; i++) {
    const b0 = bars[i]!;
    const b = bucketStart(b0.t, intervalMs);

    if (b !== curBucket) {
      out.push({ t: curBucket, o, h, l, c, v });
      curBucket = b;
      o = b0.o;
      h = b0.h;
      l = b0.l;
      c = b0.c;
      v = b0.v ?? 0;
    } else {
      h = Math.max(h, b0.h);
      l = Math.min(l, b0.l);
      c = b0.c;
      if (b0.v !== undefined) v += b0.v;
    }
  }

  out.push({ t: curBucket, o, h, l, c, v });
  return out;
}

/* ===================== Time Filters ===================== */

export function filterByTime<T>(
  x: TimePoint<T>[],
  start: number,
  end: number
): TimePoint<T>[] {
  const out: TimePoint<T>[] = [];
  for (let i = 0; i < x.length; i++) {
    const p = x[i]!;
    if (p.t >= start && p.t <= end) out.push(p);
  }
  return out;
}

/* ===================== Validation ===================== */

export function isMonotonic(x: TimePoint[]): boolean {
  for (let i = 1; i < x.length; i++) {
    if (x[i]!.t < x[i - 1]!.t) return false;
  }
  return true;
}