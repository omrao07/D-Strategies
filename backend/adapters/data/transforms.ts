// data/transform.ts
// Lightweight transforms for rows & time series. Zero deps. NodeNext/ESM ready.

/* =========================
   Basic types
   ========================= */

export type Row = Record<string, any>;

export type SeriesPoint = { ts: string | number; value: number };
export type XY = { x: string | number; y: number };

export type OHLCV = {
  ts: string | number;
  o: number; h: number; l: number; c: number;
  v?: number; symbol?: string;
};

export type AggSpec =
  | { op: "count" }
  | { op: "sum" | "avg" | "min" | "max" | "std"; field: string }
  | { op: "first" | "last"; field: string };

/* =========================
   Utilities
   ========================= */

const isFiniteNum = (n: any) => typeof n === "number" && Number.isFinite(n);
const toISO = (t: string | number) =>
  typeof t === "number" ? new Date(t).toISOString() : new Date(t).toISOString();

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/* =========================
   Row & table transforms
   ========================= */

export function select(rows: Row[], columns: string[]): Row[] {
  return rows.map(r => {
    const out: Row = {};
    for (const c of columns) out[c] = r[c];
    return out;
  });
}

export function rename(rows: Row[], ren: Record<string, string>): Row[] {
  return rows.map(r => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) out[ren[k] ?? k] = v;
    return out;
  });
}

export function cast(
  rows: Row[],
  hints: Record<string, "string" | "number" | "boolean" | "date" | "json">
): Row[] {
  const castOne = (v: any, hint: string) => {
    if (v == null || v === "") return undefined;
    switch (hint) {
      case "number": {
        const n = Number(v); return Number.isFinite(n) ? n : undefined;
      }
      case "boolean": {
        const s = String(v).trim().toLowerCase();
        return s === "true" || s === "1" || s === "yes"
          ? true : s === "false" || s === "0" || s === "no" ? false : undefined;
      }
      case "date": {
        const t = Date.parse(String(v)); return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
      }
      case "json": {
        try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return undefined; }
      }
      default: return String(v);
    }
  };
  return rows.map(r => {
    const out: Row = { ...r };
    for (const [k, hint] of Object.entries(hints)) out[k] = castOne(r[k], hint);
    return out;
  });
}

export function filterRows(rows: Row[], pred: (r: Row, i: number) => boolean): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < rows.length; i++) if (pred(rows[i], i)) out.push(rows[i]);
  return out;
}

export function mapRows<T = Row>(rows: Row[], fn: (r: Row, i: number) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < rows.length; i++) out.push(fn(rows[i], i));
  return out;
}

export function groupBy(rows: Row[], key: string): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const r of rows) {
    const k = String(r[key]);
    (out[k] ||= []).push(r);
  }
  return out;
}

function aggSeries(vals: number[], op: AggSpec["op"]) {
  if (!vals.length) return undefined;
  if (op === "count") return vals.length;
  if (op === "sum") return vals.reduce((a, b) => a + b, 0);
  if (op === "avg") return vals.reduce((a, b) => a + b, 0) / vals.length;
  if (op === "min") return Math.min(...vals);
  if (op === "max") return Math.max(...vals);
  if (op === "std") {
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / (vals.length - 1 || 1);
    return Math.sqrt(v);
  }
}

export function aggregate(
  rows: Row[],
  by: string,
  specs: Record<string, AggSpec>
): Row[] {
  const groups = groupBy(rows, by);
  const out: Row[] = [];
  for (const [k, arr] of Object.entries(groups)) {
    const row: Row = { [by]: k };
    for (const [name, spec] of Object.entries(specs)) {
      if (spec.op === "count") {
        row[name] = arr.length;
      } else if (spec.op === "first" || spec.op === "last") {
        const idx = spec.op === "first" ? 0 : arr.length - 1;
        row[name] = arr[idx]?.[spec.field];
      } else {
        const vals = arr.map(r => Number(r[spec.field])).filter(isFiniteNum);
        row[name] = aggSeries(vals, spec.op as any);
      }
    }
    out.push(row);
  }
  return out;
}

/* =========================
   Joins (inner / left)
   ========================= */

export function innerJoin(a: Row[], b: Row[], on: [string, string]): Row[] {
  const [ka, kb] = on;
  const idx = new Map<string, Row[]>();
  for (const r of b) (idx.get(String(r[kb])) ?? idx.set(String(r[kb]), []).get(String(r[kb]))!) .push(r);
  const out: Row[] = [];
  for (const ra of a) {
    const matches = idx.get(String(ra[ka]));
    if (matches) for (const rb of matches) out.push({ ...ra, ...rb });
  }
  return out;
}

export function leftJoin(a: Row[], b: Row[], on: [string, string]): Row[] {
  const [ka, kb] = on;
  const idx = new Map<string, Row[]>();
  for (const r of b) (idx.get(String(r[kb])) ?? idx.set(String(r[kb]), []).get(String(r[kb]))!) .push(r);
  const out: Row[] = [];
  for (const ra of a) {
    const matches = idx.get(String(ra[ka]));
    if (matches && matches.length) for (const rb of matches) out.push({ ...ra, ...rb });
    else out.push({ ...ra });
  }
  return out;
}

/* =========================
   Basic time-series helpers
   ========================= */

export function sortByTs<T extends { ts: string | number }>(arr: T[]): T[] {
  return arr.slice().sort((a, b) => (new Date(a.ts).getTime() - new Date(b.ts).getTime()));
}

export function toSeries(rows: Row[], field: string, tsCol = "ts"): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (const r of rows) {
    const v = Number(r[field]);
    if (isFiniteNum(v)) out.push({ ts: r[tsCol], value: v });
  }
  return sortByTs(out);
}

export function sma(series: SeriesPoint[], window = 20): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  let sum = 0;
  const q: number[] = [];
  for (let i = 0; i < series.length; i++) {
    const v = series[i].value;
    q.push(v); sum += v;
    if (q.length > window) sum -= q.shift()!;
    if (q.length === window) out.push({ ts: series[i].ts, value: sum / window });
  }
  return out;
}

export function ema(series: SeriesPoint[], window = 20): SeriesPoint[] {
  if (!series.length) return [];
  const k = 2 / (window + 1);
  let prev = series[0].value;
  const out: SeriesPoint[] = [{ ts: series[0].ts, value: prev }];
  for (let i = 1; i < series.length; i++) {
    const v = prev + k * (series[i].value - prev);
    out.push({ ts: series[i].ts, value: v });
    prev = v;
  }
  return out;
}

export function rollingStd(series: SeriesPoint[], window = 20): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  const q: number[] = [];
  for (let i = 0; i < series.length; i++) {
    q.push(series[i].value);
    if (q.length > window) q.shift();
    if (q.length === window) {
      const mean = q.reduce((a, b) => a + b, 0) / window;
      const v = q.reduce((a, b) => a + (b - mean) ** 2, 0) / (window - 1);
      out.push({ ts: series[i].ts, value: Math.sqrt(v) });
    }
  }
  return out;
}

export function minMaxNorm(series: SeriesPoint[]): SeriesPoint[] {
  if (!series.length) return [];
  const min = Math.min(...series.map(s => s.value));
  const max = Math.max(...series.map(s => s.value));
  const span = max - min || 1;
  return series.map(s => ({ ts: s.ts, value: (s.value - min) / span }));
}

export function zScore(series: SeriesPoint[]): SeriesPoint[] {
  if (!series.length) return [];
  const mean = series.reduce((a, b) => a + b.value, 0) / series.length;
  const v = series.reduce((a, b) => a + (b.value - mean) ** 2, 0) / (series.length - 1 || 1);
  const sd = Math.sqrt(v || 1);
  return series.map(s => ({ ts: s.ts, value: (s.value - mean) / sd }));
}

/* =========================
   Returns, equity, drawdowns
   ========================= */

export function simpleReturnsFromClose(bars: OHLCV[]): SeriesPoint[] {
  const s = sortByTs(bars.map(b => ({ ts: b.ts, value: b.c })));
  const out: SeriesPoint[] = [];
  for (let i = 1; i < s.length; i++) {
    const prev = s[i - 1].value, next = s[i].value;
    if (prev > 0 && isFiniteNum(prev) && isFiniteNum(next)) {
      out.push({ ts: s[i].ts, value: next / prev - 1 });
    }
  }
  return out;
}

export function equityFromReturns(rets: SeriesPoint[], start = 1): SeriesPoint[] {
  let eq = start;
  const out: SeriesPoint[] = [];
  for (const r of sortByTs(rets)) {
    eq *= (1 + r.value);
    out.push({ ts: r.ts, value: eq });
  }
  return out;
}

export function drawdownCurve(equity: SeriesPoint[]): SeriesPoint[] {
  let peak = -Infinity;
  return sortByTs(equity).map(p => {
    peak = Math.max(peak, p.value);
    const dd = peak === 0 ? 0 : (p.value - peak) / peak;
    return { ts: p.ts, value: dd };
  });
}

export function maxDrawdown(equity: SeriesPoint[]): number {
  return Math.min(...drawdownCurve(equity).map(p => p.value).concat([0]));
}

/* =========================
   Resampling & gap filling
   ========================= */

export type Interval = "1m" | "5m" | "15m" | "1h" | "1d";

function stepMs(iv: Interval): number {
  switch (iv) {
    case "1m": return 60_000;
    case "5m": return 300_000;
    case "15m": return 900_000;
    case "1h": return 3_600_000;
    case "1d": return 86_400_000;
  }
}

export function resampleOHLCV(bars: OHLCV[], interval: Interval): OHLCV[] {
  const s = sortByTs(bars);
  if (!s.length) return [];
  const step = stepMs(interval);
  const start = new Date(s[0].ts).getTime();
  const bucket = (t: number) => Math.floor((t - start) / step);

  const buckets = new Map<number, OHLCV>();
  for (const b of s) {
    const t = new Date(b.ts).getTime();
    const k = bucket(t);
    const cur = buckets.get(k);
    if (!cur) {
      buckets.set(k, { ts: new Date(start + k * step).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0, symbol: b.symbol });
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v = (cur.v ?? 0) + (b.v ?? 0);
    }
  }
  return sortByTs(Array.from(buckets.values()));
}

export function ffill(series: SeriesPoint[], step: number): SeriesPoint[] {
  if (!series.length) return [];
  const s = sortByTs(series);
  const out: SeriesPoint[] = [s[0]];
  let last = s[0].value;
  let tPrev = new Date(s[0].ts).getTime();
  for (let i = 1; i < s.length; i++) {
    const t = new Date(s[i].ts).getTime();
    for (let tt = tPrev + step; tt < t; tt += step) out.push({ ts: new Date(tt).toISOString(), value: last });
    out.push(s[i]);
    last = s[i].value;
    tPrev = t;
  }
  return out;
}

export function interpolateLinear(series: SeriesPoint[], step: number): SeriesPoint[] {
  if (!series.length) return [];
  const s = sortByTs(series);
  const out: SeriesPoint[] = [s[0]];
  let tPrev = new Date(s[0].ts).getTime();
  for (let i = 1; i < s.length; i++) {
    const t = new Date(s[i].ts).getTime();
    const v0 = s[i - 1].value, v1 = s[i].value;
    const span = (t - tPrev) || 1;
    for (let tt = tPrev + step; tt < t; tt += step) {
      const alpha = (tt - tPrev) / span;
      out.push({ ts: new Date(tt).toISOString(), value: v0 + alpha * (v1 - v0) });
    }
    out.push(s[i]);
    tPrev = t;
  }
  return out;
}

/* =========================
   Correlation & covariance
   ========================= */

export function covariance(a: SeriesPoint[], b: SeriesPoint[]): number | undefined {
  const A = sortByTs(a), B = sortByTs(b);
  const mapB = new Map<number, number>(B.map(p => [new Date(p.ts).getTime(), p.value]));
  const common: [number, number][] = [];
  for (const p of A) {
    const t = new Date(p.ts).getTime();
    const y = mapB.get(t);
    if (isFiniteNum(y)) common.push([p.value, y!]);
  }
  if (common.length < 2) return undefined;
  const ax = common.reduce((s, [x]) => s + x, 0) / common.length;
  const ay = common.reduce((s, [, y]) => s + y, 0) / common.length;
  const c = common.reduce((s, [x, y]) => s + (x - ax) * (y - ay), 0) / (common.length - 1);
  return c;
}

export function correlation(a: SeriesPoint[], b: SeriesPoint[]): number | undefined {
  const cov = covariance(a, b);
  if (cov === undefined) return undefined;
  const sd = (s: SeriesPoint[]) => {
    const S = sortByTs(s).map(p => p.value);
    const m = S.reduce((x, y) => x + y, 0) / S.length;
    const v = S.reduce((x, y) => x + (y - m) ** 2, 0) / (S.length - 1 || 1);
    return Math.sqrt(v || 1);
  };
  const sa = sd(a), sb = sd(b);
  return sa && sb ? cov / (sa * sb) : undefined;
}

/* =========================
   Pipeline helper
   ========================= */

export type Pipe<T> = (x: T) => T;

export function compose<T>(...fns: Pipe<T>[]): Pipe<T> {
  return (x: T) => fns.reduce((v, f) => f(v), x);
}

/* =========================
   Quick recipes
   ========================= */

// Build daily returns → equity → drawdowns from OHLCV
export function equityAndDrawdownFromBars(bars: OHLCV[]) {
  const rets = simpleReturnsFromClose(bars);
  const equity = equityFromReturns(rets, 1);
  const dd = drawdownCurve(equity);
  return { rets, equity, drawdowns: dd, maxDD: maxDrawdown(equity) };
}

// Normalize an arbitrary numeric column to [0,1] keeping ts
export function normalizeColumn(rows: Row[], col: string, tsCol = "ts"): SeriesPoint[] {
  return minMaxNorm(toSeries(rows, col, tsCol));
}

// Resample to daily & compute 20d SMA on close
export function resampleAndSMA(bars: OHLCV[], interval: Interval, window = 20) {
  const rb = resampleOHLCV(bars, interval);
  const series = toSeries(rb.map(b => ({ ts: b.ts, close: b.c })) as unknown as Row[], "close", "ts");
  return { bars: rb, sma: sma(series, window) };
}

/* =========================
   Demo (optional)
   ========================= */

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = [
    { ts: "2025-01-01", a: 1, b: 10 },
    { ts: "2025-01-02", a: 3, b: 14 },
    { ts: "2025-01-03", a: 2, b: 12 },
  ];
  const s = toSeries(rows, "a");
  console.log("SMA(2):", sma(s, 2));
  console.log("EMA(2):", ema(s, 2));
  console.log("z:", zScore(s));
}