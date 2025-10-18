// futures/spreads.ts
// Pure TS (no imports). Build linear spreads (calendar, inter-commodity, butterflies)
// from one or more contract time series. Supports difference/ratio spreads,
// arbitrary leg weights & multipliers, and annualized roll metrics for calendars.

export type ISODate = string; // "YYYY-MM-DD"

export type PriceBar = {
  date: ISODate;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  settle?: number;
  volume?: number;
  openInterest?: number;
};

export type ContractSeries = {
  symbol: string;           // e.g., ESZ25
  bars: PriceBar[];         // sorted by date ASC, unique dates
  expiryISO?: ISODate;      // optional (used for calendar roll metrics)
  multiplier?: number;      // $ per 1 point per contract (optional for notional parity)
};

export type Field = "settle" | "close" | "open";

export type SpreadBar = {
  date: ISODate;
  value: number;            // spread value after all transforms
};

export type SpreadSeries = {
  symbol: string;           // e.g., "ES[H-M] CAL" or generic name
  method: "diff" | "ratio" | "butterfly" | "linear";
  bars: SpreadBar[];
  legs: { symbol: string; weight: number; multiplier: number }[];
  meta?: Record<string, any>;
};

export type LinearLeg = {
  series: ContractSeries;
  weight: number;           // +1/-1 etc.
  /** Optional multiplier override (defaults to series.multiplier || 1). */
  multiplier?: number;
};

export type CalendarSpec = {
  near: ContractSeries;
  far: ContractSeries;
  /** Price field used; default 'settle'. */
  field?: Field;
  /** If true, scale legs by their multipliers to notional parity. Default true. */
  notionalParity?: boolean;
  /** Optional scaling factor applied to the result (e.g., ticks-to-$). Default 1. */
  scale?: number;
  /** Optional custom symbol label. */
  name?: string;
};

export type ButterflySpec = {
  near: ContractSeries;
  mid: ContractSeries;
  far: ContractSeries;
  /** Weights; default [1, -2, 1]. */
  weights?: [number, number, number];
  field?: Field;
  notionalParity?: boolean;
  scale?: number;
  name?: string;
};

/** ===== Utilities ===== */
function isNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }
function cmpISO(a: ISODate, b: ISODate): number { return a < b ? -1 : a > b ? 1 : 0; }

function idxByDate(bars: PriceBar[]): Record<ISODate, PriceBar> {
  const m: Record<ISODate, PriceBar> = {};
  for (const b of bars) m[b.date] = b;
  return m;
}
function uniqueSortedDates(series: ContractSeries[]): ISODate[] {
  const s: Record<ISODate, 1> = {};
  for (const S of series) for (const b of S.bars) s[b.date] = 1;
  return Object.keys(s).sort(cmpISO);
}
function getField(b: PriceBar, f: Field): number | undefined {
  if (f === "settle") return isNum(b.settle) ? b.settle : (isNum(b.close) ? b.close : undefined);
  if (f === "close")  return isNum(b.close)  ? b.close  : (isNum(b.settle) ? b.settle : undefined);
  return isNum(b.open) ? b.open : (isNum(b.settle) ? b.settle : (isNum(b.close) ? b.close : undefined));
}
function yearFracACT365(anchorISO: ISODate, expiryISO: ISODate): number {
  const a = Date.UTC(+anchorISO.slice(0,4), +anchorISO.slice(5,7)-1, +anchorISO.slice(8,10));
  const e = Date.UTC(+expiryISO.slice(0,4), +expiryISO.slice(5,7)-1, +expiryISO.slice(8,10));
  return (e - a) / 86_400_000 / 365;
}

/** Align a set of series on common dates (intersection) and return sorted ISO dates. */
export function commonDates(series: ContractSeries[]): ISODate[] {
  if (series.length === 0) return [];
  const maps = series.map(s => idxByDate(s.bars));
  const all = uniqueSortedDates(series);
  const out: ISODate[] = [];
  for (const d of all) {
    let ok = true;
    for (const m of maps) { if (!m[d]) { ok = false; break; } }
    if (ok) out.push(d);
  }
  return out;
}

/** Generic linear spread across N legs: sum_i (weight_i * multiplier_i * price_i) * scale. */
export function buildLinearSpread(
  legs: LinearLeg[],
  field: Field = "settle",
  opts?: { scale?: number; name?: string }
): SpreadSeries {
  const scale = opts?.scale ?? 1;
  const dates = commonDates(legs.map(l => l.series));
  const maps = legs.map(l => idxByDate(l.series.bars));
  const values: SpreadBar[] = [];

  for (const d of dates) {
    let v = 0;
    let valid = true;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const b = maps[i][d];
      const px = getField(b, field);
      if (!isNum(px)) { valid = false; break; }
      const mult = isNum(leg.multiplier) ? (leg.multiplier as number) : (isNum(leg.series.multiplier) ? (leg.series.multiplier as number) : 1);
      v += leg.weight * mult * px;
    }
    if (valid) values.push({ date: d, value: v * scale });
  }

  const label = opts?.name || `LIN_${field}_${legs.map(l => `${l.series.symbol}*${l.weight}`).join("+")}`;
  return {
    symbol: label,
    method: "linear",
    bars: values,
    legs: legs.map(l => ({ symbol: l.series.symbol, weight: l.weight, multiplier: isNum(l.multiplier) ? l.multiplier! : (l.series.multiplier || 1) })),
  };
}

/** Calendar spread: Far - Near (by default). If notionalParity=true, scales legs by their multipliers. */
export function buildCalendarSpread(spec: CalendarSpec): SpreadSeries {
  const field = spec.field ?? "settle";
  const scale = spec.scale ?? 1;
  const notional = spec.notionalParity !== false; // default true

  const mNear = isNum(spec.near.multiplier) ? spec.near.multiplier! : 1;
  const mFar  = isNum(spec.far.multiplier)  ? spec.far.multiplier!  : 1;

  const legs: LinearLeg[] = notional
    ? [
        { series: spec.far,  weight: +1, multiplier: mFar  },
        { series: spec.near, weight: -1, multiplier: mNear },
      ]
    : [
        { series: spec.far,  weight: +1, multiplier: 1 },
        { series: spec.near, weight: -1, multiplier: 1 },
      ];

  const ss = buildLinearSpread(legs, field, {
    scale,
    name: spec.name || `${spec.far.symbol}-${spec.near.symbol} CAL`,
  });
  ss.method = "diff";

  // Optional roll metrics if both expiries are present: ann. roll yield = (P_far - P_near)/(Δt * P_near)
  if (spec.near.expiryISO && spec.far.expiryISO && ss.bars.length) {
    const firstDate = ss.bars[0].date;
    const tNear = yearFracACT365(firstDate, spec.near.expiryISO);
    const tFar  = yearFracACT365(firstDate, spec.far.expiryISO);
    if (tFar > tNear) {
      const maps = [idxByDate(spec.near.bars), idxByDate(spec.far.bars)];
      const roll: { date: ISODate; ann: number }[] = [];
      for (const b of ss.bars) {
        const bn = maps[0][b.date], bf = maps[1][b.date];
        const pn = getField(bn, field), pf = getField(bf, field);
        if (isNum(pn) && pn !== 0 && isNum(pf)) {
          const ann = (pf - pn) / ((tFar - tNear) * pn);
          roll.push({ date: b.date, ann });
        }
      }
      (ss.meta ||= {}).rollNearFar = { tNear, tFar, annualized: roll };
    }
  }
  return ss;
}

/** Butterfly: w1*N + w2*M + w3*F. Defaults to [1, -2, 1]. Honors notional parity if requested. */
export function buildButterfly(spec: ButterflySpec): SpreadSeries {
  const field = spec.field ?? "settle";
  const scale = spec.scale ?? 1;
  const weights = spec.weights ?? [1, -2, 1];
  const notional = spec.notionalParity !== false; // default true

  const mN = isNum(spec.near.multiplier) ? spec.near.multiplier! : 1;
  const mM = isNum(spec.mid.multiplier)  ? spec.mid.multiplier!  : 1;
  const mF = isNum(spec.far.multiplier)  ? spec.far.multiplier!  : 1;

  const legs: LinearLeg[] = notional
    ? [
        { series: spec.near, weight: weights[0], multiplier: mN },
        { series: spec.mid,  weight: weights[1], multiplier: mM },
        { series: spec.far,  weight: weights[2], multiplier: mF },
      ]
    : [
        { series: spec.near, weight: weights[0], multiplier: 1 },
        { series: spec.mid,  weight: weights[1], multiplier: 1 },
        { series: spec.far,  weight: weights[2], multiplier: 1 },
      ];

  const ss = buildLinearSpread(legs, field, {
    scale,
    name: spec.name || `${spec.near.symbol}/${spec.mid.symbol}/${spec.far.symbol} FLY`,
  });
  ss.method = "butterfly";
  return ss;
}

/** Ratio spread: Far - k * Near (default k = Near.multiplier/Far.multiplier to notionalize). */
export function buildRatioSpread(
  near: ContractSeries,
  far: ContractSeries,
  opts?: { k?: number; field?: Field; scale?: number; name?: string }
): SpreadSeries {
  const field = opts?.field ?? "settle";
  const scale = opts?.scale ?? 1;
  const mNear = isNum(near.multiplier) ? near.multiplier! : 1;
  const mFar  = isNum(far.multiplier)  ? far.multiplier!  : 1;
  const k = isNum(opts?.k) ? (opts!.k as number) : (mFar === 0 ? 1 : mFar / mNear);

  const legs: LinearLeg[] = [
    { series: far,  weight: +1, multiplier: 1 },
    { series: near, weight: -k, multiplier: 1 },
  ];
  const ss = buildLinearSpread(legs, field, {
    scale,
    name: opts?.name || `${far.symbol} - ${k.toFixed(4)}*${near.symbol}`,
  });
  ss.method = "ratio";
  return ss;
}

/** Convert a spread series into simple returns (diff over previous), useful for backtests. */
export function spreadReturns(spread: SpreadSeries): { date: ISODate; ret: number }[] {
  const out: { date: ISODate; ret: number }[] = [];
  for (let i = 1; i < spread.bars.length; i++) {
    const p0 = spread.bars[i - 1].value;
    const p1 = spread.bars[i].value;
    const denom = p0 !== 0 ? p0 : 1; // safe guard
    out.push({ date: spread.bars[i].date, ret: (p1 - p0) / denom });
  }
  return out;
}

/** Convenience: calendar spread with annualized roll yield time series (if expiries provided). */
export function calendarWithRoll(
  spec: CalendarSpec
): { spread: SpreadSeries; annualizedRoll?: { date: ISODate; ann: number }[] } {
  const spread = buildCalendarSpread(spec);
  const roll = spread.meta?.rollNearFar?.annualized as { date: ISODate; ann: number }[] | undefined;
  return { spread, annualizedRoll: roll };
}

/** Create a spread between two already continuous series (e.g., front & next). */
export function spreadFromContinuous(
  near: { symbol: string; bars: SpreadBar[] },
  far: { symbol: string; bars: SpreadBar[] },
  name?: string
): SpreadSeries {
  // Align by common dates
  const mN: Record<ISODate, SpreadBar> = {};
  for (const b of near.bars) mN[b.date] = b;
  const values: SpreadBar[] = [];
  for (const fb of far.bars) {
    const nb = mN[fb.date];
    if (!nb) continue;
    values.push({ date: fb.date, value: fb.value - nb.value });
  }
  return {
    symbol: name || `${far.symbol}-${near.symbol}`,
    method: "diff",
    bars: values,
    legs: [{ symbol: far.symbol, weight: +1, multiplier: 1 }, { symbol: near.symbol, weight: -1, multiplier: 1 }],
  };
}

/** Simple summary string for logs. */
export function summarize(spread: SpreadSeries): string {
  const n = spread.bars.length;
  if (!n) return `${spread.symbol}: (empty)`;
  const first = spread.bars[0], last = spread.bars[n - 1];
  const chg = last.value - first.value;
  return `${spread.symbol} [${spread.method}] n=${n} first=${first.value.toFixed(4)} last=${last.value.toFixed(4)} Δ=${chg.toFixed(4)}`;
}