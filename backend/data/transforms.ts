// data/transforms.ts
// Pure TypeScript utilities for working with arrays, time series, and tabular rows.
// No imports. Deterministic, allocation-conscious, and side-effect free.
//
// Contents
// - Types
// - Basic transforms (map/filter/reduce, pick/pluck, distinct, sortBy)
// - Numeric utilities (sum, mean, median, stdev, zscore, normalizeMinMax)
// - Time-series transforms (SMA, EMA, WMA, RSI, MACD, rolling, expanding)
// - Returns (simple/log), cumulative, drawdown
// - Grouping & aggregation (groupBy, aggregate)
// - Join utilities (leftJoin, innerJoin) for arrays of objects keyed by field
// - Resampling helpers (bucket by time, OHLC/V aggregation)
// - Pipeline helper for chainable transforms (optional sugar)

export type Row = { [k: string]: any };
export type SeriesNumber = number[];
export type SeriesBool = boolean[];
export type SeriesString = string[];

export type TimeValue = number | string | Date;
export interface TSPoint {
  t: TimeValue; // timestamp
  v: number;    // value
}

export interface OHLCV {
  t: TimeValue;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

// ---------- Type guards ----------
function isNumber(x: any): x is number {
  return typeof x === "number" && !isNaN(x) && isFinite(x);
}
function asTime(x: TimeValue): number {
  if (typeof x === "number") return x;
  if (x instanceof Date) return x.getTime();
  // ISO string or date-like
  const n = Date.parse(String(x));
  return isNaN(n) ? 0 : n;
}

// ---------- Basic transforms ----------
export function map<T, U>(arr: T[], fn: (v: T, i: number, a: T[]) => U): U[] {
  const out: U[] = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = fn(arr[i], i, arr);
  return out;
}

export function filter<T>(arr: T[], fn: (v: T, i: number, a: T[]) => boolean): T[] {
  const out: T[] = [];
  for (let i = 0; i < arr.length; i++) if (fn(arr[i], i, arr)) out.push(arr[i]);
  return out;
}

export function reduce<T, U>(arr: T[], init: U, fn: (acc: U, v: T, i: number, a: T[]) => U): U {
  let acc = init;
  for (let i = 0; i < arr.length; i++) acc = fn(acc, arr[i], i, arr);
  return acc;
}

export function pluck<T extends Row, K extends keyof T>(rows: T[], key: K): T[K][] {
  const out: T[K][] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) out[i] = rows[i][key];
  return out;
}

export function pick<T extends Row, K extends keyof T>(row: T, keys: K[]): Pick<T, K> {
  const out: any = {};
  for (let i = 0; i < keys.length; i++) out[keys[i]] = row[keys[i]];
  return out;
}

export function distinct<T>(arr: T[]): T[] {
  const seen: any = Object.create(null);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i++) {
    const k = String((arr as any)[i]);
    if (!seen[k]) {
      seen[k] = 1;
      out.push(arr[i]);
    }
  }
  return out;
}

export function sortBy<T>(arr: T[], key: (v: T) => number | string, asc: boolean = true): T[] {
  const copy = arr.slice();
  copy.sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka === kb) return 0;
    const res = (ka < kb) ? -1 : 1;
    return asc ? res : -res;
  });
  return copy;
}

// ---------- Numeric stats ----------
export function sum(xs: SeriesNumber): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i] || 0;
  return s;
}

export function mean(xs: SeriesNumber): number {
  return xs.length ? sum(xs) / xs.length : 0;
}

export function variance(xs: SeriesNumber, sample: boolean = true): number {
  const n = xs.length;
  if (n <= (sample ? 1 : 0)) return 0;
  const m = mean(xs);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m;
    acc += d * d;
  }
  return acc / (sample ? (n - 1) : n);
}

export function stdev(xs: SeriesNumber, sample: boolean = true): number {
  const v = variance(xs, sample);
  return Math.sqrt(v);
}

export function median(xs: SeriesNumber): number {
  if (xs.length === 0) return 0;
  const arr = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

export function zscores(xs: SeriesNumber): SeriesNumber {
  const m = mean(xs);
  const sd = stdev(xs, true) || 1;
  const out = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = (xs[i] - m) / sd;
  return out;
}

export function normalizeMinMax(xs: SeriesNumber, minVal: number = 0, maxVal: number = 1): SeriesNumber {
  if (xs.length === 0) return [];
  let lo = xs[0], hi = xs[0];
  for (let i = 1; i < xs.length; i++) { if (xs[i] < lo) lo = xs[i]; if (xs[i] > hi) hi = xs[i]; }
  const range = (hi - lo) || 1;
  const out = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = minVal + (maxVal - minVal) * (xs[i] - lo) / range;
  return out;
}

// ---------- Rolling / Expanding ----------
export function rolling<T>(xs: T[], window: number, agg: (slice: T[], i0: number, i1: number) => number): SeriesNumber {
  if (window <= 0) return [];
  const out: number[] = new Array(xs.length);
  const buf: T[] = [];
  for (let i = 0; i < xs.length; i++) {
    buf.push(xs[i]);
    if (buf.length > window) buf.shift();
    const start = Math.max(0, i - window + 1);
    out[i] = agg(xs, start, i + 1);
  }
  return out;
}

export function rollingMean(xs: SeriesNumber, window: number): SeriesNumber {
  const n = xs.length;
  const out: number[] = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += xs[i];
    if (i >= window) acc -= xs[i - window];
    out[i] = i + 1 >= window ? acc / window : acc / (i + 1);
  }
  return out;
}

export function ema(xs: SeriesNumber, span: number): SeriesNumber {
  if (span <= 1) return xs.slice();
  const k = 2 / (span + 1);
  const out: number[] = new Array(xs.length);
  let prev = xs.length ? xs[0] : 0;
  for (let i = 0; i < xs.length; i++) {
    const cur = isNumber(prev) ? prev : xs[i];
    const val = cur + k * (xs[i] - cur);
    out[i] = val;
    prev = val;
  }
  return out;
}

export function wma(xs: SeriesNumber, window: number): SeriesNumber {
  const n = xs.length;
  const out = new Array(n);
  const denom = window * (window + 1) / 2 || 1;
  for (let i = 0; i < n; i++) {
    let acc = 0, w = 0;
    for (let j = 0; j < window; j++) {
      const idx = i - j;
      if (idx < 0) break;
      const weight = window - j;
      acc += xs[idx] * weight;
      w += weight;
    }
    out[i] = w ? acc / w : xs[i];
  }
  return out;
}

// ---------- Indicators ----------
export function rsi(prices: SeriesNumber, period: number = 14): SeriesNumber {
  const n = prices.length;
  if (n === 0) return [];
  const gains = new Array(n).fill(0);
  const losses = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const d = prices[i] - prices[i - 1];
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }
  const avgG = ema(gains, period);
  const avgL = ema(losses, period);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const g = avgG[i], l = avgL[i];
    const rs = l === 0 ? (g === 0 ? 0 : 1e9) : g / l;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

export interface MACDOutput {
  macd: SeriesNumber;
  signal: SeriesNumber;
  hist: SeriesNumber;
}
export function macd(prices: SeriesNumber, fast: number = 12, slow: number = 26, signalSpan: number = 9): MACDOutput {
  const fastE = ema(prices, fast);
  const slowE = ema(prices, slow);
  const macdLine = new Array(prices.length);
  for (let i = 0; i < prices.length; i++) macdLine[i] = fastE[i] - slowE[i];
  const signal = ema(macdLine, signalSpan);
  const hist = new Array(prices.length);
  for (let i = 0; i < prices.length; i++) hist[i] = macdLine[i] - signal[i];
  return { macd: macdLine, signal, hist };
}

// ---------- Returns & Cumulative ----------
export function simpleReturns(prices: SeriesNumber): SeriesNumber {
  const n = prices.length;
  const out = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const p0 = prices[i - 1];
    out[i] = p0 ? (prices[i] - p0) / p0 : 0;
  }
  return out;
}

export function logReturns(prices: SeriesNumber): SeriesNumber {
  const n = prices.length;
  const out = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const p0 = prices[i - 1];
    out[i] = (p0 && prices[i]) ? Math.log(prices[i] / p0) : 0;
  }
  return out;
}

export function cumulative(xs: SeriesNumber, start: number = 0): SeriesNumber {
  const out = new Array(xs.length);
  let acc = start;
  for (let i = 0; i < xs.length; i++) { acc += xs[i]; out[i] = acc; }
  return out;
}

export function cumulativeProduct(xs: SeriesNumber, start: number = 1): SeriesNumber {
  const out = new Array(xs.length);
  let acc = start;
  for (let i = 0; i < xs.length; i++) { acc *= xs[i]; out[i] = acc; }
  return out;
}

export function equityCurve(returns: SeriesNumber, start: number = 1): SeriesNumber {
  // turn returns into growth factors 1+r
  const factors = new Array(returns.length);
  for (let i = 0; i < returns.length; i++) factors[i] = 1 + (returns[i] || 0);
  return cumulativeProduct(factors, start);
}

export interface DrawdownOutput {
  peak: SeriesNumber;
  dd: SeriesNumber;      // drawdown as negative values (0 to -1)
  ddPct: SeriesNumber;   // same as dd
  maxDD: number;         // scalar min of dd
}
export function drawdown(equity: SeriesNumber): DrawdownOutput {
  const n = equity.length;
  const peak = new Array(n);
  const dd = new Array(n);
  let p = -Infinity;
  let minDD = 0;
  for (let i = 0; i < n; i++) {
    p = Math.max(p, equity[i]);
    peak[i] = isFinite(p) ? p : equity[i];
    const d = p ? (equity[i] - p) / p : 0;
    dd[i] = d;
    if (d < minDD) minDD = d;
  }
  return { peak, dd, ddPct: dd, maxDD: minDD };
}

// ---------- Grouping & Aggregation ----------
export function groupBy<T extends Row>(rows: T[], key: (r: T) => string | number): { [k: string]: T[] } {
  const out: { [k: string]: T[] } = Object.create(null);
  for (let i = 0; i < rows.length; i++) {
    const k = String(key(rows[i]));
    if (!out[k]) out[k] = [];
    out[k].push(rows[i]);
  }
  return out;
}

export interface Aggregations {
  count?: true;
  sum?: string[];
  mean?: string[];
  min?: string[];
  max?: string[];
}
export function aggregate(groups: { [k: string]: Row[] }, aggs: Aggregations): Row[] {
  const keys = Object.keys(groups);
  const out: Row[] = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const rows = groups[k];
    const r: Row = { _key: k };
    if (aggs.count) r.count = rows.length;

    const doCols = (cols: string[] | undefined, fn: (vals: number[]) => number, label: string) => {
      if (!cols) return;
      for (let ci = 0; ci < cols.length; ci++) {
        const c = cols[ci];
        const vals: number[] = [];
        for (let j = 0; j < rows.length; j++) {
          const v = rows[j][c];
          if (isNumber(v)) vals.push(v);
        }
        r[label + "_" + c] = vals.length ? fn(vals) : undefined;
      }
    };

    doCols(aggs.sum, sum, "sum");
    doCols(aggs.mean, mean, "mean");
    doCols(aggs.min, (xs) => { let m = xs[0]; for (let z = 1; z < xs.length; z++) if (xs[z] < m) m = xs[z]; return m; }, "min");
    doCols(aggs.max, (xs) => { let m = xs[0]; for (let z = 1; z < xs.length; z++) if (xs[z] > m) m = xs[z]; return m; }, "max");

    out[i] = r;
  }
  return out;
}

// ---------- Join utilities ----------
export function leftJoin<L extends Row, R extends Row>(
  left: L[],
  right: R[],
  keyL: (l: L) => string | number,
  keyR: (r: R) => string | number,
  merge: (l: L, r: R | null) => Row
): Row[] {
  const index: { [k: string]: R[] } = Object.create(null);
  for (let i = 0; i < right.length; i++) {
    const k = String(keyR(right[i]));
    if (!index[k]) index[k] = [];
    index[k].push(right[i]);
  }
  const out: Row[] = [];
  for (let i = 0; i < left.length; i++) {
    const k = String(keyL(left[i]));
    const list = index[k];
    if (!list || list.length === 0) {
      out.push(merge(left[i], null));
    } else {
      for (let j = 0; j < list.length; j++) out.push(merge(left[i], list[j]));
    }
  }
  return out;
}

export function innerJoin<L extends Row, R extends Row>(
  left: L[],
  right: R[],
  keyL: (l: L) => string | number,
  keyR: (r: R) => string | number,
  merge: (l: L, r: R) => Row
): Row[] {
  const out: Row[] = [];
  const index: { [k: string]: R[] } = Object.create(null);
  for (let i = 0; i < right.length; i++) {
    const k = String(keyR(right[i]));
    if (!index[k]) index[k] = [];
    index[k].push(right[i]);
  }
  for (let i = 0; i < left.length; i++) {
    const k = String(keyL(left[i]));
    const list = index[k];
    if (list) for (let j = 0; j < list.length; j++) out.push(merge(left[i], list[j]));
  }
  return out;
}

// ---------- Resampling / Bucketing ----------
export type BucketFn<T> = (row: T) => number; // returns epoch millis bucket key

export function bucketByTime<T>(rows: T[], toMillis: (r: T) => TimeValue, bucketMs: number): { [bucket: number]: T[] } {
  const out: { [bucket: number]: T[] } = Object.create(null);
  for (let i = 0; i < rows.length; i++) {
    const t = asTime(toMillis(rows[i]));
    const b = Math.floor(t / bucketMs) * bucketMs;
    if (!out[b]) out[b] = [];
    out[b].push(rows[i]);
  }
  return out;
}

export function aggregateOHLCV(points: { t: TimeValue; p: number; v?: number }[]): OHLCV | null {
  if (points.length === 0) return null;
  const sorted = points.slice().sort((a, b) => asTime(a.t) - asTime(b.t));
  const o = sorted[0].p;
  let h = o, l = o, c = o, vv = 0;
  for (let i = 0; i < sorted.length; i++) {
    const px = sorted[i].p;
    if (px > h) h = px;
    if (px < l) l = px;
    if (i === sorted.length - 1) c = px;
    vv += sorted[i].v || 0;
  }
  return { t: sorted[sorted.length - 1].t, o, h, l, c, v: vv };
}

export function resampleToOHLCV<T>(
  ticks: T[],
  time: (r: T) => TimeValue,
  price: (r: T) => number,
  volume?: (r: T) => number,
  bucketMs: number = 60_000
): OHLCV[] {
  const groups = bucketByTime(ticks, time, bucketMs);
  const keys = Object.keys(groups).map(k => Number(k)).sort((a, b) => a - b);
  const out: OHLCV[] = [];
  for (let i = 0; i < keys.length; i++) {
    const bucket = groups[keys[i]];
    const pts = new Array(bucket.length);
    for (let j = 0; j < bucket.length; j++) {
      pts[j] = { t: time(bucket[j]), p: price(bucket[j]), v: volume ? (volume(bucket[j]) || 0) : 0 };
    }
    const ohlc = aggregateOHLCV(pts);
    if (ohlc) out.push(ohlc);
  }
  return out;
}

// ---------- VWAP ----------
export function vwap(prices: SeriesNumber, volumes: SeriesNumber): SeriesNumber {
  const n = Math.min(prices.length, volumes.length);
  const out = new Array(n);
  let pv = 0, v = 0;
  for (let i = 0; i < n; i++) {
    const vi = Math.max(0, volumes[i] || 0);
    pv += (prices[i] || 0) * vi;
    v += vi;
    out[i] = v ? pv / v : 0;
  }
  return out;
}

// ---------- Pipeline (chainable sugar) ----------
export class Series {
  private xs: SeriesNumber;
  constructor(xs: SeriesNumber) { this.xs = xs.slice(); }
  sma(n: number): Series { this.xs = rollingMean(this.xs, n); return this; }
  ema(n: number): Series { this.xs = ema(this.xs, n); return this; }
  wma(n: number): Series { this.xs = wma(this.xs, n); return this; }
  z(): Series { this.xs = zscores(this.xs); return this; }
  minMax(a: number = 0, b: number = 1): Series { this.xs = normalizeMinMax(this.xs, a, b); return this; }
  diff(): Series {
    const n = this.xs.length;
    const out = new Array(n).fill(0);
    for (let i = 1; i < n; i++) out[i] = this.xs[i] - this.xs[i - 1];
    this.xs = out; return this;
  }
  returns(log: boolean = false): Series {
    this.xs = log ? logReturns(this.xs) : simpleReturns(this.xs);
    return this;
  }
  values(): SeriesNumber { return this.xs.slice(); }
}

// ---------- Small helpers ----------
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : (x > hi ? hi : x);
}

export function fillNa(xs: SeriesNumber, value: number = 0): SeriesNumber {
  const out = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = isNumber(xs[i]) ? xs[i] : value;
  return out;
}
