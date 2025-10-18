// futures/continous.ts
// Build continuous futures from individual contract time series without imports.
// Supports back-adjusted (difference), ratio-adjusted, and simple splice methods.

export type ISODate = string; // "YYYY-MM-DD"

export type PriceBar = {
  date: ISODate;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  settle?: number; // preferred field for futures
  volume?: number;
  openInterest?: number;
};

export type ContractSeries = {
  symbol: string;           // e.g., ESZ25
  bars: PriceBar[];         // sorted by date asc, unique dates
};

export type RollSpec = {
  symbol: string;           // contract symbol
  expiryISO: ISODate;       // last trade/expiry ISO
  rollISO: ISODate;         // date you roll out of this to the next
};

export type BuildMethod = "back_adjust" | "ratio_adjust" | "splice";

export type Field = "settle" | "close" | "open";

export type ContinuousParams = {
  /** Ordered list of consecutive contracts you want to stitch (front to far). */
  series: ContractSeries[];
  /** Roll plan for the SAME order as `series` (length >= series.length-1). roll[i] describes the roll OUT of series[i] INTO series[i+1]. */
  rolls: RollSpec[];
  /** Construction method. */
  method: BuildMethod;
  /** Price field to use. Defaults to 'settle' then 'close' fallback. */
  field?: Field;
  /** If true, switch to next contract AT the roll date's close; else switch on next session. Default true. */
  rollAtClose?: boolean;
};

/** Result */
export type ContinuousSeries = {
  symbol: string;               // synthetic e.g., "ES_CONT"
  method: BuildMethod;
  field: Field;
  bars: PriceBar[];             // stitched, sorted asc
  meta: {
    segments: {
      srcSymbol: string;
      from: ISODate;
      to: ISODate;
      adjAtJoin: number;        // for back_adjust: cumulative difference; for ratio_adjust: cumulative ratio (multiplier)
    }[];
  };
};

/** ===== Utilities (no imports) ===== */

function toISO(d: Date): ISODate {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function fromISO(s: ISODate): Date {
  const [y, m, d] = s.split("-").map(x => parseInt(x, 10));
  return new Date(Date.UTC(y, m - 1, d));
}
function cmpISO(a: ISODate, b: ISODate): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
function isFiniteNum(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
function getField(bar: PriceBar, pref: Field): number | undefined {
  if (pref === "settle") return isFiniteNum(bar.settle) ? bar.settle : (isFiniteNum(bar.close) ? bar.close : undefined);
  if (pref === "close")  return isFiniteNum(bar.close) ? bar.close : (isFiniteNum(bar.settle) ? bar.settle : undefined);
  return isFiniteNum(bar.open) ? bar.open : (isFiniteNum(bar.settle) ? bar.settle : (isFiniteNum(bar.close) ? bar.close : undefined));
}
function dedupeSortBars(bars: PriceBar[]): PriceBar[] {
  const map: Record<ISODate, PriceBar> = {};
  for (const b of bars) map[b.date] = b;
  return Object.values(map).sort((a, b) => cmpISO(a.date, b.date));
}
function indexByDate(bars: PriceBar[]): Record<ISODate, PriceBar> {
  const m: Record<ISODate, PriceBar> = {};
  for (const b of bars) m[b.date] = b;
  return m;
}
function uniqueSortedDates(series: ContractSeries[]): ISODate[] {
  const set: Record<ISODate, 1> = {};
  for (const s of series) for (const b of s.bars) set[b.date] = 1;
  return Object.keys(set).sort(cmpISO);
}
function clampDate(d: ISODate, lo: ISODate, hi: ISODate): ISODate | null {
  if (cmpISO(d, lo) < 0 || cmpISO(d, hi) > 0) return null;
  return d;
}

/** Find the roll date for leaving series[i] into series[i+1]. Assumes rolls aligned to series order. */
function rollOutDate(rolls: RollSpec[], i: number): ISODate | null {
  if (i < 0 || i >= rolls.length) return null;
  return rolls[i].rollISO;
}

/** Determine active segment index for a given date. */
function activeIndexAtDate(d: ISODate, series: ContractSeries[], rolls: RollSpec[], rollAtClose: boolean): number {
  // Contract 0 is active until its roll date boundary; then 1, etc.
  let idx = 0;
  for (let i = 0; i < series.length - 1; i++) {
    const rDate = rollOutDate(rolls, i);
    if (!rDate) break;
    const cmp = cmpISO(d, rDate);
    if (rollAtClose) {
      // Use series[i] on the roll date; switch from next session
      if (cmp > 0) idx = i + 1;
    } else {
      // Switch on the roll date at open
      if (cmp >= 0) idx = i + 1;
    }
  }
  return idx;
}

/** Compute adjustment step at a join (i -> i+1) based on method and chosen field at the roll date. */
function computeJoinAdj(
  sPrev: ContractSeries,
  sNext: ContractSeries,
  rollDate: ISODate,
  field: Field,
  method: BuildMethod,
  rollAtClose: boolean
): number {
  const prevIdx = indexByDate(sPrev.bars);
  const nextIdx = indexByDate(sNext.bars);

  // Price to align on the boundary:
  // If rollAtClose=true: align on roll date close/settle.
  // Else: align using previous session close (i.e., roll session open implies previous day match).
  let keyDate = rollDate;
  if (!rollAtClose) {
    // previous business day with data in both series
    keyDate = previousCommonDate(rollDate, prevIdx, nextIdx) ?? rollDate;
  }

  const p0 = getField(prevIdx[keyDate] || {}, field);
  const p1 = getField(nextIdx[keyDate] || {}, field);

  if (!isFiniteNum(p0) || !isFiniteNum(p1)) return method === "ratio_adjust" ? 1 : 0;

  if (method === "ratio_adjust") {
    if (p1 === 0) return 1;
    return p0 / p1; // multiply next (and its history) by this to match prev level
  } else if (method === "back_adjust") {
    return p0 - p1; // add to next (and its history) to match prev level
  } else {
    // splice: no historical adjustment
    return 0;
  }
}

function previousCommonDate(anchorISO: ISODate, a: Record<ISODate, PriceBar>, b: Record<ISODate, PriceBar>): ISODate | null {
  // Walk back up to 10 days to find a date present in both series
  let d = fromISO(anchorISO);
  for (let i = 0; i < 10; i++) {
    const iso = toISO(d);
    if (a[iso] && b[iso]) return iso;
    d = new Date(d.getTime() - 86400000);
  }
  return null;
}

/** ===== Main builder ===== */

export function buildContinuous(params: ContinuousParams): ContinuousSeries {
  const field: Field = params.field || "settle";
  const rollAtClose = params.rollAtClose !== false; // default true
  const series = params.series.map(s => ({ symbol: s.symbol, bars: dedupeSortBars(s.bars) }));
  const rolls = params.rolls.slice(0);

  // Sanity: align lengths
  if (rolls.length < Math.max(0, series.length - 1)) {
    throw new Error("rolls[] must have at least series.length - 1 entries");
  }

  const allDates = uniqueSortedDates(series);
  if (allDates.length === 0) {
    return { symbol: "CONT", method: params.method, field, bars: [], meta: { segments: [] } };
  }

  // Precompute cumulative adjustments per segment
  // For back_adjust: cumulative difference to add to segment i and all earlier history of that segment.
  // For ratio_adjust: cumulative multiplier to apply to segment i and its history.
  const method = params.method;
  const segAdj: number[] = new Array(series.length).fill(0);
  const segMul: number[] = new Array(series.length).fill(1);

  for (let i = 0; i < series.length - 1; i++) {
    const rDate = rollOutDate(rolls, i) || series[i].bars[series[i].bars.length - 1]?.date || allDates[0];
    const step = computeJoinAdj(series[i], series[i + 1], rDate, field, method, rollAtClose);

    if (method === "back_adjust") {
      // next segment needs to be shifted by cumulative + step to match previous
      // propagate: segAdj[i+1] = segAdj[i] + step, and carry forward
      segAdj[i + 1] = segAdj[i] + step;
      for (let k = i + 2; k < series.length; k++) segAdj[k] = segAdj[i + 1]; // same base for later segments
    } else if (method === "ratio_adjust") {
      const nextMul = segMul[i] * (isFiniteNum(step) ? step : 1);
      segMul[i + 1] = nextMul;
      for (let k = i + 2; k < series.length; k++) segMul[k] = nextMul;
    } else {
      // splice: nothing accumulates
    }
  }

  // Build output bars
  const outBars: PriceBar[] = [];
  const segmentsMeta: { srcSymbol: string; from: ISODate; to: ISODate; adjAtJoin: number }[] = [];

  // Track current segment range in output
  let currentSeg = -1;
  let segStartISO: ISODate | null = null;

  for (const d of allDates) {
    const idx = activeIndexAtDate(d, series, rolls, rollAtClose);
    const src = series[idx];
    const srcBar = indexByDate(src.bars)[d];

    if (!srcBar) continue; // no data for this date in active contract

    let v = getField(srcBar, field);
    if (!isFiniteNum(v)) continue;

    if (method === "back_adjust") {
      v = v! + segAdj[idx];
    } else if (method === "ratio_adjust") {
      v = v! * segMul[idx];
    } // splice leaves v as is

    // Push output bar (carry other fields raw; only chosen field adjusted)
    const ob: PriceBar = { date: d };
    if (field === "open") ob.open = v!;
    else if (field === "close") ob.close = v!;
    else ob.settle = v!;

    outBars.push(ob);

    // Segment bookkeeping
    if (idx !== currentSeg) {
      // close previous segment
      if (currentSeg >= 0 && segStartISO) {
        const prevDate = outBars.length >= 2 ? outBars[outBars.length - 2].date : d;
        segmentsMeta.push({
          srcSymbol: series[currentSeg].symbol,
          from: segStartISO,
          to: prevDate,
          adjAtJoin: method === "ratio_adjust" ? segMul[currentSeg] : (method === "back_adjust" ? segAdj[currentSeg] : 0),
        });
      }
      currentSeg = idx;
      segStartISO = d;
    }
  }

  // Close final segment
  if (currentSeg >= 0 && segStartISO && outBars.length) {
    segmentsMeta.push({
      srcSymbol: series[currentSeg].symbol,
      from: segStartISO,
      to: outBars[outBars.length - 1].date,
      adjAtJoin: method === "ratio_adjust" ? segMul[currentSeg] : (method === "back_adjust" ? segAdj[currentSeg] : 0),
    });
  }

  return {
    symbol: "CONT",
    method,
    field,
    bars: outBars,
    meta: { segments: segmentsMeta },
  };
}

/** ===== Optional helpers ===== */

/** Compute simple arithmetic returns for a continuous series (based on chosen field). */
export function seriesReturns(cont: ContinuousSeries): { date: ISODate; ret: number }[] {
  const out: { date: ISODate; ret: number }[] = [];
  const valAt = (b: PriceBar): number | undefined =>
    cont.field === "open" ? b.open :
    cont.field === "close" ? b.close : b.settle;

  for (let i = 1; i < cont.bars.length; i++) {
    const p0 = valAt(cont.bars[i - 1]);
    const p1 = valAt(cont.bars[i]);
    if (isFiniteNum(p0) && isFiniteNum(p1) && p0 !== 0) {
      out.push({ date: cont.bars[i].date, ret: (p1 - p0) / p0 });
    }
  }
  return out;
}

/** Forward-fill missing days (optional), useful after splice/back-adjust if you need contiguous calendar. */
export function forwardFill(bars: PriceBar[], field: Field = "settle"): PriceBar[] {
  const out: PriceBar[] = [];
  let last: number | undefined;
  for (const b of dedupeSortBars(bars)) {
    const v = getField(b, field);
    if (isFiniteNum(v)) last = v;
    const nb: PriceBar = { date: b.date };
    if (field === "open") nb.open = isFiniteNum(v) ? v! : last;
    else if (field === "close") nb.close = isFiniteNum(v) ? v! : last;
    else nb.settle = isFiniteNum(v) ? v! : last;
    out.push(nb);
  }
  return out;
}

/** Build a naive roll plan if you only have expiries: roll N business days before expiry.
 *  Weekends-only calendar; adjust to your needs upstream if holidays matter.
 */
export function naiveRollsFromExpiries(
  expiries: { symbol: string; expiryISO: ISODate }[],
  bizDaysBefore: number
): RollSpec[] {
  const out: RollSpec[] = [];
  for (let i = 0; i < expiries.length - 1; i++) {
    const e = expiries[i];
    const rollISO = bizDaysBefore <= 0 ? e.expiryISO : bizShift(e.expiryISO, -bizDaysBefore);
    out.push({ symbol: e.symbol, expiryISO: e.expiryISO, rollISO });
  }
  return out;
}

function isWeekendISO(iso: ISODate): boolean {
  const d = fromISO(iso);
  const w = d.getUTCDay();
  return w === 0 || w === 6;
}
function bizShift(iso: ISODate, delta: number): ISODate {
  let d = fromISO(iso);
  const step = delta >= 0 ? 1 : -1;
  let left = Math.abs(delta);
  while (left > 0) {
    d = new Date(d.getTime() + step * 86400000);
    if (!isWeekendISO(toISO(d))) left--;
  }
  // If landing on weekend, push to previous business day
  while (isWeekendISO(toISO(d))) d = new Date(d.getTime() - 86400000);
  return toISO(d);
}

/** Merge multiple continuous builds by average (same dates), for robustness checks. */
export function averageContinuous(inputs: ContinuousSeries[], field?: Field): ContinuousSeries {
  if (inputs.length === 0) return { symbol: "AVG_CONT", method: "splice", field: field || "settle", bars: [], meta: { segments: [] } };
  const f: Field = field || inputs[0].field;
  const allDates: Record<ISODate, 1> = {};
  for (const c of inputs) for (const b of c.bars) allDates[b.date] = 1;
  const dates = Object.keys(allDates).sort(cmpISO);

  const bars: PriceBar[] = [];
  for (const d of dates) {
    let sum = 0, n = 0;
    for (const c of inputs) {
      const m = indexByDate(c.bars);
      const b = m[d];
      if (!b) continue;
      const v = f === "open" ? b.open : (f === "close" ? b.close : b.settle);
      if (isFiniteNum(v)) { sum += v!; n++; }
    }
    if (n > 0) {
      const ob: PriceBar = { date: d };
      const v = sum / n;
      if (f === "open") ob.open = v;
      else if (f === "close") ob.close = v;
      else ob.settle = v;
      bars.push(ob);
    }
  }

  return { symbol: "AVG_CONT", method: "splice", field: f, bars, meta: { segments: [] } };
}