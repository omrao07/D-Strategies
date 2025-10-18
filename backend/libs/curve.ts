// libs/curve.ts
// Utilities for equity curves & returns (no deps).
// Import with:  import * as Curve from "../libs/curve.js";

export type CurvePt = { date: string; equity: number };
export type DDPoint = { date: string; equity: number; peak: number; dd: number };
export type Stats = {
  start?: string;
  end?: string;
  nDays: number;
  startEquity?: number;
  endEquity?: number;
  totalReturn: number;     // (end/start - 1)
  CAGR: number;
  volAnn: number;          // annualized stdev of daily returns
  Sharpe: number;          // using rf
  Sortino: number;         // using rf
  maxDD: number;           // min drawdown (negative)
  maxDDLen: number;        // longest drawdown length in days
  Calmar: number;          // CAGR / |maxDD|
  avgDailyRet: number;
  skew?: number;
  kurt?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/* ========================= Basics ========================= */

export function toISO(d: string | Date): string {
  if (typeof d === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    const dt = new Date(d);
    return dt.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

export function normalizeCurve(curve: Array<Partial<CurvePt>>): CurvePt[] {
  return (curve || [])
    .filter(p => p && p.date != null && p.equity != null)
    .map(p => ({ date: toISO(String(p.date!)), equity: Number(p.equity!) }))
    .filter(p => Number.isFinite(p.equity))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Fill missing days by forward-filling equity (optional). */
export function fillDaily(curve: CurvePt[]): CurvePt[] {
  const c = normalizeCurve(curve);
  if (c.length <= 1) return c;
  const out: CurvePt[] = [c[0]];
  for (let i = 1; i < c.length; i++) {
    const prev = out[out.length - 1];
    const cur = c[i];
    let t = new Date(prev.date).getTime() + DAY_MS;
    const end = new Date(cur.date).getTime();
    while (t < end) {
      out.push({ date: new Date(t).toISOString().slice(0, 10), equity: prev.equity });
      t += DAY_MS;
    }
    out.push(cur);
  }
  return out;
}

/* ===================== Returns & Math ===================== */

export function equityToReturns(curve: CurvePt[]): number[] {
  const c = normalizeCurve(curve);
  const r: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const ret = (c[i].equity - c[i - 1].equity) / c[i - 1].equity;
    if (Number.isFinite(ret)) r.push(ret);
  }
  return r;
}

export function returnsToEquity(returns: number[], startEquity = 1): CurvePt[] {
  const out: CurvePt[] = [];
  let eq = startEquity;
  const t0 = new Date().getTime();
  for (let i = 0; i < returns.length; i++) {
    eq *= (1 + (Number.isFinite(returns[i]) ? returns[i] : 0));
    out.push({ date: new Date(t0 + i * DAY_MS).toISOString().slice(0, 10), equity: eq });
  }
  return out;
}

export function mean(arr: number[]): number {
  const a = arr.filter(Number.isFinite);
  if (!a.length) return 0;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

export function stdev(arr: number[]): number {
  const a = arr.filter(Number.isFinite);
  if (a.length < 2) return 0;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1);
  return Math.sqrt(Math.max(0, v));
}

export function downsideDev(arr: number[], mar = 0): number {
  const d = arr.filter(Number.isFinite).map(x => Math.min(0, x - mar));
  if (!d.length) return 0;
  const v = d.reduce((s, x) => s + x * x, 0) / d.length;
  return Math.sqrt(v);
}

export function annualizeRet(dailyRet: number): number {
  return Math.pow(1 + dailyRet, 252) - 1;
}

export function annualizeVol(dailyVol: number): number {
  return dailyVol * Math.sqrt(252);
}

/* ===================== Drawdowns ===================== */

export function drawdownSeries(curve: CurvePt[]): DDPoint[] {
  const c = normalizeCurve(curve);
  if (!c.length) return [];
  let peak = c[0].equity;
  const out: DDPoint[] = [];
  for (const p of c) {
    peak = Math.max(peak, p.equity);
    const dd = peak ? p.equity / peak - 1 : 0;
    out.push({ date: p.date, equity: p.equity, peak, dd });
  }
  return out;
}

export function maxDrawdown(curve: CurvePt[]): { maxDD: number; start?: string; trough?: string; recovery?: string; lengthDays: number } {
  const dd = drawdownSeries(curve);
  if (!dd.length) return { maxDD: 0, lengthDays: 0 };
  let worst = 0, idx = 0;
  for (let i = 0; i < dd.length; i++) {
    if (dd[i].dd < worst) { worst = dd[i].dd; idx = i; }
  }
  // find peak start
  let startIdx = idx;
  let peakVal = dd[idx].peak;
  for (let i = idx; i >= 0; i--) {
    if (dd[i].equity === dd[i].peak) { startIdx = i; peakVal = dd[i].peak; break; }
  }
  // recovery (first time equity >= peak after trough)
  let recIdx: number | undefined;
  for (let i = idx + 1; i < dd.length; i++) {
    if (dd[i].equity >= peakVal) { recIdx = i; break; }
  }
  const lengthDays = startIdx != null && recIdx != null
    ? Math.round((new Date(dd[recIdx].date).getTime() - new Date(dd[startIdx].date).getTime()) / DAY_MS)
    : (dd.length ? dd.length - startIdx - 1 : 0);

  return {
    maxDD: worst, // negative
    start: dd[startIdx]?.date,
    trough: dd[idx]?.date,
    recovery: recIdx != null ? dd[recIdx].date : undefined,
    lengthDays,
  };
}

/* ===================== Stats ===================== */

export function stats(curve: CurvePt[], rf = 0): Stats {
  const c = normalizeCurve(curve);
  if (c.length < 2) {
    const eq = c[0]?.equity ?? 0;
    return { nDays: c.length, start: c[0]?.date, end: c[0]?.date, startEquity: eq, endEquity: eq, totalReturn: 0, CAGR: 0, volAnn: 0, Sharpe: 0, Sortino: 0, maxDD: 0, maxDDLen: 0, Calmar: 0, avgDailyRet: 0 };
  }

  const r = equityToReturns(c);
  const n = r.length;
  const startEq = c[0].equity;
  const endEq = c[c.length - 1].equity;
  const totalRet = startEq ? endEq / startEq - 1 : 0;

  const avg = mean(r);
  const vol = stdev(r);
  const ddev = downsideDev(r, rf / 252);
  const volAnn = annualizeVol(vol);
  const CAGR = Math.pow(1 + totalRet, 252 / n) - 1;

  const sharpe = volAnn ? (annualizeRet(avg) - rf) / volAnn : 0;
  const sortino = ddev ? (annualizeRet(avg) - rf) / (ddev * Math.sqrt(252)) : 0;

  const dd = maxDrawdown(c);
  const calmar = dd.maxDD !== 0 ? CAGR / Math.abs(dd.maxDD) : 0;

  // simple skew/kurt (sample)
  const m = avg;
  const s = vol || 1;
  const skew = r.length ? r.reduce((a, x) => a + Math.pow((x - m) / s, 3), 0) / r.length : 0;
  const kurt = r.length ? r.reduce((a, x) => a + Math.pow((x - m) / s, 4), 0) / r.length - 3 : 0;

  return {
    start: c[0].date,
    end: c[c.length - 1].date,
    nDays: n,
    startEquity: startEq,
    endEquity: endEq,
    totalReturn: totalRet,
    CAGR,
    volAnn,
    Sharpe: sharpe,
    Sortino: sortino,
    maxDD: dd.maxDD,
    maxDDLen: dd.lengthDays,
    Calmar: calmar,
    avgDailyRet: avg,
    skew, kurt,
  };
}

/* ===================== Rolling metrics ===================== */

export function rolling<T>(arr: T[], win: number, f: (slice: T[], i: number) => number): number[] {
  const out: number[] = [];
  if (win <= 0) return out;
  for (let i = 0; i < arr.length; i++) {
    const start = Math.max(0, i - win + 1);
    out.push(f(arr.slice(start, i + 1), i));
  }
  return out;
}

export function rollingSharpe(curve: CurvePt[], winDays = 63, rf = 0): number[] {
  const r = equityToReturns(curve);
  return rolling(r, winDays, (slice) => {
    const a = mean(slice);
    const v = stdev(slice);
    const sa = annualizeRet(a) - rf;
    const va = annualizeVol(v);
    return va ? sa / va : 0;
  });
}

export function rollingMaxDD(curve: CurvePt[], winDays = 252): number[] {
  const c = normalizeCurve(curve);
  return rolling(c, winDays, (slice) => maxDrawdown(slice as CurvePt[]).maxDD);
}

/* ===================== Resampling & Align ===================== */

/** Downsample to ~N points (keeping endpoints). */
export function downsampleCurve(curve: CurvePt[], nPoints = 300): CurvePt[] {
  const c = normalizeCurve(curve);
  if (c.length <= nPoints) return c;
  const step = c.length / nPoints;
  const out: CurvePt[] = [];
  for (let i = 0; i < c.length; i += step) out.push(c[Math.floor(i)]);
  if (out[out.length - 1]?.date !== c[c.length - 1]?.date) out.push(c[c.length - 1]);
  return out;
}

/** Resample daily → weekly/monthly by last value of period. */
export function resample(curve: CurvePt[], period: "W" | "M"): CurvePt[] {
  const c = normalizeCurve(curve);
  const out: CurvePt[] = [];
  let bucket = "";
  for (const p of c) {
    const d = new Date(p.date);
    const key = period === "W"
      ? `${d.getUTCFullYear()}-W${String(weekOfYear(d)).padStart(2, "0")}`
      : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (key !== bucket) {
      out.push({ date: p.date, equity: p.equity }); // provisional
      bucket = key;
    } else {
      out[out.length - 1] = { date: p.date, equity: p.equity }; // last in bucket
    }
  }
  return out;
}

function weekOfYear(d: Date): number {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil(((dt.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
}

/** Align two curves on common dates; forward-fill equities. */
export function align(curveA: CurvePt[], curveB: CurvePt[]): { A: CurvePt[]; B: CurvePt[] } {
  const a = fillDaily(curveA), b = fillDaily(curveB);
  const dates = Array.from(new Set([...a.map(p => p.date), ...b.map(p => p.date)])).sort();
  const mapA = new Map(a.map(p => [p.date, p.equity]));
  const mapB = new Map(b.map(p => [p.date, p.equity]));
  const outA: CurvePt[] = [], outB: CurvePt[] = [];
  let lastA = a[0]?.equity ?? 0, lastB = b[0]?.equity ?? 0;
  for (const d of dates) {
    const eqA = mapA.has(d) ? (lastA = mapA.get(d)!) : lastA;
    const eqB = mapB.has(d) ? (lastB = mapB.get(d)!) : lastB;
    outA.push({ date: d, equity: eqA });
    outB.push({ date: d, equity: eqB });
  }
  return { A: outA, B: outB };
}

/** Combine multiple curves by weighted sum of equities (weights sum to 1). */
export function combineWeighted(curves: CurvePt[][], weights?: number[]): CurvePt[] {
  if (!curves.length) return [];
  const filled = curves.map(fillDaily);
  const allDates = Array.from(new Set(filled.flatMap(c => c.map(p => p.date)))).sort();
  const maps = filled.map(c => new Map(c.map(p => [p.date, p.equity])));
  const w = weights && weights.length === curves.length
    ? weights
    : Array.from({ length: curves.length }, () => 1 / curves.length);
  const out: CurvePt[] = [];
  let last: number[] = filled.map(c => c[0]?.equity ?? 0);
  for (const d of allDates) {
    const eqs = maps.map((m, i) => (m.has(d) ? (last[i] = m.get(d)!) : last[i]));
    const total = eqs.reduce((s, v, i) => s + v * w[i], 0);
    out.push({ date: d, equity: total });
  }
  return out;
}

/* ===================== Exposure helpers ===================== */

/** Turn a curve into percent returns per day (for aggregation). */
export function pctReturns(curve: CurvePt[]): { date: string; ret: number }[] {
  const c = normalizeCurve(curve);
  const out: { date: string; ret: number }[] = [];
  for (let i = 1; i < c.length; i++) {
    const r = c[i - 1].equity ? c[i].equity / c[i - 1].equity - 1 : 0;
    out.push({ date: c[i].date, ret: r });
  }
  return out;
}

/** Apply target exposure (e.g., 0.5 for 50%) to a return stream, rebuild equity. */
export function applyExposure(curve: CurvePt[], exposure = 1, startEquity = curve[0]?.equity ?? 1): CurvePt[] {
  const rets = pctReturns(curve).map(x => ({ date: x.date, ret: x.ret * exposure }));
  let eq = startEquity;
  const out: CurvePt[] = [{ date: normalizeCurve(curve)[0]?.date ?? toISO(new Date()), equity: startEquity }];
  for (const r of rets) {
    eq *= (1 + r.ret);
    out.push({ date: r.date, equity: eq });
  }
  return out;
}

/* ===================== Export default ===================== */

export default {
  normalizeCurve,
  fillDaily,
  equityToReturns,
  returnsToEquity,
  mean,
  stdev,
  downsideDev,
  annualizeRet,
  annualizeVol,
  drawdownSeries,
  maxDrawdown,
  stats,
  rolling,
  rollingSharpe,
  rollingMaxDD,
  downsampleCurve,
  resample,
  align,
  combineWeighted,
  pctReturns,
  applyExposure,
};