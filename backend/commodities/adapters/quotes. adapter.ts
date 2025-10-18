// adapters/quotes.adapters.ts
// Import-free, strict-TS-friendly adapters that normalize diverse quote feeds
// (ticks, books, trades, bars) into a single internal shape.
// Includes helpers for mids, spreads, microprice, VWAP, rolling OHLC merges,
// and a few provider-style mappers you can tweak.
//
// Nothing external is required; copy/paste and use.
//
// Example:
//   const q = adaptTick({
//     symbol: "CL",
//     bid: 82.34, ask: 82.36, bidSize: 5, askSize: 7, ts: 1719945600000
//   });
//
//   const normFromLoose = adaptLoose({
//     s: "CL", b: 82.34, a: 82.36, bs: 5, as: 7, t: "2025-06-30T00:00:00Z"
//   });
//
//   const book = adaptBook({
//     symbol: "CL", bids: [[82.34, 10],[82.33, 8]], asks: [[82.36,12],[82.37,9]], ts: Date.now()
//   });

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------- Core normalized types ----------

export interface NormalizedTick {
  kind: "tick";
  symbol: string;      // canonical (upper-case)
  ts: string;          // ISO-8601
  epochMs: number;     // unix ms
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  last?: number;
  lastSize?: number;
  mid?: number;        // (bid+ask)/2 when both present; else last
  spread?: number;     // ask - bid when both present
  microprice?: number; // weighted mid by sizes
  src?: string;        // optional source tag
  meta?: Record<string, any>;
}

export interface NormalizedTrade {
  kind: "trade";
  symbol: string;
  ts: string;
  epochMs: number;
  price: number;
  size?: number;
  isBuy?: boolean;     // if known (aggressor side)
  notional?: number;
  src?: string;
  meta?: Record<string, any>;
}

export interface NormalizedBar {
  kind: "bar";
  symbol: string;
  ts: string;          // bar end time ISO (or start—be consistent in your caller)
  epochMs: number;
  open: number; high: number; low: number; close: number;
  vwap?: number;       // if provided or derivable
  volume?: number;
  trades?: number;
  src?: string;
  meta?: Record<string, any>;
}

export interface NormalizedBook {
  kind: "book";
  symbol: string;
  ts: string;
  epochMs: number;
  bids: Array<{ price: number; size: number }>; // best-first
  asks: Array<{ price: number; size: number }>;
  bestBid?: number;
  bestAsk?: number;
  mid?: number;
  spread?: number;
  microprice?: number;
  depth?: number;      // total levels captured (min(bids,asks))
  src?: string;
  meta?: Record<string, any>;
}

export type NormalizedQuote = NormalizedTick | NormalizedTrade | NormalizedBar | NormalizedBook;

// ---------- Generic adapters (provider-agnostic) ----------

/** Normalize a simple tick (top of book and/or last trade). */
export function adaptTick(input: {
  symbol: string;
  ts?: number | string | Date;
  bid?: number; ask?: number;
  bidSize?: number; askSize?: number;
  last?: number; lastSize?: number;
  src?: string;
  meta?: Record<string, any>;
}): NormalizedTick {
  const symbol = normSym(input.symbol);
  const { iso, ms } = normTime(input.ts);
  const bid = toNumOrUndef(input.bid);
  const ask = toNumOrUndef(input.ask);
  const bidSize = toNumOrUndef(input.bidSize);
  const askSize = toNumOrUndef(input.askSize);
  const last = toNumOrUndef(input.last);
  const lastSize = toNumOrUndef(input.lastSize);

  const mid = (isFiniteNum(bid) && isFiniteNum(ask)) ? (bid + ask) / 2
            : (isFiniteNum(last) ? last : undefined);
  const spread = (isFiniteNum(bid) && isFiniteNum(ask)) ? Math.max(0, ask - bid) : undefined;
  const microprice = micro(bid, ask, bidSize, askSize);

  return { kind: "tick", symbol, ts: iso, epochMs: ms, bid, ask, bidSize, askSize, last, lastSize, mid, spread, microprice, src: input.src, meta: input.meta };
}

/** Normalize a trade print. */
export function adaptTrade(input: {
  symbol: string;
  ts?: number | string | Date;
  price: number;
  size?: number;
  isBuy?: boolean;
  src?: string;
  meta?: Record<string, any>;
}): NormalizedTrade {
  const symbol = normSym(input.symbol);
  const { iso, ms } = normTime(input.ts);
  const price = num(input.price);
  const size = toNumOrUndef(input.size);
  return { kind: "trade", symbol, ts: iso, epochMs: ms, price, size, isBuy: input.isBuy, notional: (size != null ? size * price : undefined), src: input.src, meta: input.meta };
}

/** Normalize an OHLC bar. */
export function adaptBar(input: {
  symbol: string;
  ts?: number | string | Date;
  open: number; high: number; low: number; close: number;
  volume?: number; trades?: number; vwap?: number;
  src?: string; meta?: Record<string, any>;
}): NormalizedBar {
  const symbol = normSym(input.symbol);
  const { iso, ms } = normTime(input.ts);
  const open = num(input.open), high = num(input.high), low = num(input.low), close = num(input.close);
  const vwap = toNumOrUndef(input.vwap);
  const volume = toNumOrUndef(input.volume);
  const trades = toNumOrUndef(input.trades);
  return { kind: "bar", symbol, ts: iso, epochMs: ms, open, high, low, close, vwap, volume, trades, src: input.src, meta: input.meta };
}

/** Normalize an order book snapshot or top-N. Accepts raw arrays like [[price,size], ...]. */
export function adaptBook(input: {
  symbol: string;
  ts?: number | string | Date;
  bids: Array<[number, number] | { price: number; size: number }>;
  asks: Array<[number, number] | { price: number; size: number }>;
  src?: string; meta?: Record<string, any>;
}): NormalizedBook {
  const symbol = normSym(input.symbol);
  const { iso, ms } = normTime(input.ts);
  const bids = normalizeLevels(input.bids, "desc"); // best bid = highest price first
  const asks = normalizeLevels(input.asks, "asc");  // best ask = lowest price first

  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  const mid = (isFiniteNum(bestBid) && isFiniteNum(bestAsk)) ? (bestBid + bestAsk) / 2 : undefined;
  const spread = (isFiniteNum(bestBid) && isFiniteNum(bestAsk)) ? Math.max(0, bestAsk - bestBid) : undefined;
  const microprice = micro(bestBid, bestAsk, bids[0]?.size, asks[0]?.size);
  const depth = Math.min(bids.length, asks.length) || Math.max(bids.length, asks.length);

  return { kind: "book", symbol, ts: iso, epochMs: ms, bids, asks, bestBid, bestAsk, mid, spread, microprice, depth, src: input.src, meta: input.meta };
}

// ---------- Loose/forgiving mapper (rename common short keys) ----------

/**
 * Accepts a wide variety of keys often seen in feeds and maps to a NormalizedTick.
 * Supported aliases:
 *   symbol: s, sym
 *   bid: b; ask: a; bidSize: bs; askSize: as
 *   last: p or l; lastSize: ls
 *   ts: t (ms, s, or ISO)
 */
export function adaptLoose(obj: Record<string, any>): NormalizedTick {
  const symbol = normSym(obj.symbol ?? obj.s ?? obj.sym);
  const rawTs = obj.ts ?? obj.t;
  const { iso, ms } = normTime(rawTs);

  const bid = toNumOrUndef(obj.bid ?? obj.b);
  const ask = toNumOrUndef(obj.ask ?? obj.a);
  const bidSize = toNumOrUndef(obj.bidSize ?? obj.bs);
  const askSize = toNumOrUndef(obj.askSize ?? obj.as);
  const last = toNumOrUndef(obj.last ?? obj.p ?? obj.l);
  const lastSize = toNumOrUndef(obj.lastSize ?? obj.ls);

  const mid = (isFiniteNum(bid) && isFiniteNum(ask)) ? (bid + ask) / 2 : (isFiniteNum(last) ? last : undefined);
  const spread = (isFiniteNum(bid) && isFiniteNum(ask)) ? Math.max(0, ask - bid) : undefined;
  const microprice = micro(bid, ask, bidSize, askSize);

  return { kind: "tick", symbol, ts: iso, epochMs: ms, bid, ask, bidSize, askSize, last, lastSize, mid, spread, microprice, src: obj.src, meta: obj.meta };
}

// ---------- Book merge/update helpers ----------

/** Merge a partial book update into an existing snapshot (price level granularity). */
export function mergeBook(
  prev: NormalizedBook,
  patch: { bids?: Array<[number, number]>; asks?: Array<[number, number]>; ts?: number | string | Date }
): NormalizedBook {
  const bids = mapToPriceSize(prev.bids);
  const asks = mapToPriceSize(prev.asks);

  // apply patch levels (size=0 removes)
  if (patch.bids) {
    for (const [p, s] of patch.bids) { if (s <= 0) bids.delete(p); else bids.set(p, s); }
  }
  if (patch.asks) {
    for (const [p, s] of patch.asks) { if (s <= 0) asks.delete(p); else asks.set(p, s); }
  }

  // rebuild sorted arrays
  const newBids = [...bids.entries()].map(([price, size]) => ({ price, size })).sort((a,b)=>b.price - a.price);
  const newAsks = [...asks.entries()].map(([price, size]) => ({ price, size })).sort((a,b)=>a.price - b.price);

  const { iso, ms } = normTime(patch.ts ?? prev.epochMs);
  const bestBid = newBids[0]?.price;
  const bestAsk = newAsks[0]?.price;
  const mid = (isFiniteNum(bestBid) && isFiniteNum(bestAsk)) ? (bestBid + bestAsk) / 2 : undefined;
  const spread = (isFiniteNum(bestBid) && isFiniteNum(bestAsk)) ? Math.max(0, bestAsk - bestBid) : undefined;
  const microprice = micro(bestBid, bestAsk, newBids[0]?.size, newAsks[0]?.size);
  const depth = Math.min(newBids.length, newAsks.length) || Math.max(newBids.length, newAsks.length);

  return { ...prev, bids: newBids, asks: newAsks, bestBid, bestAsk, mid, spread, microprice, depth, ts: iso, epochMs: ms };
}

// ---------- Rolling VWAP / microprice / EMA utilities ----------

export function computeMicroprice(bid?: number, ask?: number, bidSize?: number, askSize?: number): number | undefined {
  return micro(bid, ask, bidSize, askSize);
}

/** Classic microprice = (a*bs + b*as)/(bs+as). */
function micro(bid?: number, ask?: number, bidSize?: number, askSize?: number): number | undefined {
  if (!isFiniteNum(bid) || !isFiniteNum(ask)) return undefined;
  const bs = isFiniteNum(bidSize) ? bidSize! : 0;
  const as = isFiniteNum(askSize) ? askSize! : 0;
  const denom = bs + as;
  if (denom <= 0) return (bid + ask) / 2;
  return (ask * bs + bid * as) / denom;
}

/** One-pass rolling VWAP accumulator. Call add(price, size) repeatedly. */
export function makeVWAP() {
  let notional = 0, volume = 0;
  return {
    add(price: number, size = 1) { if (isFiniteNum(price) && isFiniteNum(size)) { notional += price * size; volume += size; } },
    vwap(): number | undefined { return volume > 0 ? notional / volume : undefined; },
    volume(): number { return volume; },
  };
}

/** Simple EMA calculator. alpha in (0,1], returns a function that updates with new price. */
export function makeEMA(alpha = 0.2, seed?: number) {
  const a = clamp(alpha, 1e-6, 1);
  let x = isFiniteNum(seed) ? seed! : undefined;
  return (price: number): number => {
    const p = num(price);
    x = x == null ? p : (a * p + (1 - a) * x);
    return x;
  };
}

// ---------- Provider-style convenience mappers ----------

/** Map a CME-style settlement CSV row into a bar (fields are examples; adjust to your schema). */
export function adaptCmeSettle(row: Record<string, any>, symbolKey = "Symbol"): NormalizedBar {
  // expected fields: Symbol, Date, Open, High, Low, Settle, Volume
  return adaptBar({
    symbol: row[symbolKey],
    ts: row.Date ?? row.date,
    open: row.Open ?? row.open ?? row.Settle ?? row.settle,
    high: row.High ?? row.high ?? row.Settle ?? row.settle,
    low:  row.Low  ?? row.low  ?? row.Settle ?? row.settle,
    close: row.Settle ?? row.settle ?? row.Close ?? row.close,
    volume: row.Volume ?? row.volume,
    src: "CME",
    meta: row,
  });
}

/** Map a generic WebSocket tick often like { s, b, a, bs, as, t }. */
export function adaptWsTick(ws: Record<string, any>): NormalizedTick {
  return adaptLoose(ws);
}

/** Map a L2 book message { s, t, bids:[[p,s],...], asks:[[p,s],...] }. */
export function adaptWsBook(ws: Record<string, any>): NormalizedBook {
  return adaptBook({
    symbol: ws.symbol ?? ws.s,
    ts: ws.ts ?? ws.t,
    bids: ws.bids ?? ws.bid ?? [],
    asks: ws.asks ?? ws.ask ?? [],
    src: ws.src ?? "WS",
    meta: ws,
  });
}

// ---------- Tiny helpers ----------

function normalizeLevels(levels: Array<[number, number] | { price: number; size: number }>, order: "asc" | "desc") {
  const arr = levels.map(l => Array.isArray(l) ? ({ price: num(l[0]), size: num(l[1]) }) : ({ price: num((l as any).price), size: num((l as any).size) }));
  arr.sort((a, b) => order === "asc" ? (a.price - b.price) : (b.price - a.price));
  // collapse duplicate price levels by summing size
  const out: Array<{ price: number; size: number }> = [];
  for (const lv of arr) {
    if (out.length && Math.abs(out[out.length - 1].price - lv.price) < 1e-12) {
      out[out.length - 1].size += lv.size;
    } else out.push({ price: lv.price, size: lv.size });
  }
  return out;
}

function mapToPriceSize(levels: Array<{ price: number; size: number }>): Map<number, number> {
  const m = new Map<number, number>();
  for (const lv of levels) m.set(lv.price, lv.size);
  return m;
}

function normSym(s: string): string { return String(s || "").trim().toUpperCase(); }

function normTime(t?: number | string | Date): { iso: string; ms: number } {
  if (t == null) {
    const ms = Date.now();
    return { ms, iso: new Date(ms).toISOString() };
  }
  if (typeof t === "number") {
    // could be seconds or ms; decide by magnitude
    const ms = t > 1e12 ? Math.floor(t) : Math.floor(t * 1000);
    return { ms, iso: new Date(ms).toISOString() };
  }
  if (t instanceof Date) {
    const ms = t.getTime();
    return { ms, iso: t.toISOString() };
  }
  // string
  const d = new Date(t);
  const ms = d.getTime();
  return { ms, iso: d.toISOString() };
}

function isFiniteNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }
function num(x: any): number { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function toNumOrUndef(x: any): number | undefined { const n = Number(x); return Number.isFinite(n) ? n : undefined; }
function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }

// ---------- Pretty printers (optional) ----------

export function prettyTick(t: NormalizedTick): string {
  const parts = [`${t.symbol} @ ${t.ts}`];
  if (isFiniteNum(t.bid)) parts.push(`bid=${t.bid}`);
  if (isFiniteNum(t.ask)) parts.push(`ask=${t.ask}`);
  if (isFiniteNum(t.mid)) parts.push(`mid=${round4(t.mid!)}`);
  if (isFiniteNum(t.spread)) parts.push(`spr=${round6(t.spread!)}`);
  return parts.join("  ");
}
export function prettyBook(b: NormalizedBook): string {
  const bb = isFiniteNum(b.bestBid) ? b.bestBid!.toFixed(2) : "--";
  const ba = isFiniteNum(b.bestAsk) ? b.bestAsk!.toFixed(2) : "--";
  const mp = isFiniteNum(b.microprice) ? b.microprice!.toFixed(4) : "--";
  return `${b.symbol} ${b.ts}  bb=${bb} ba=${ba} mid=${b.mid?.toFixed(3) ?? "--"} micro=${mp} depth=${b.depth ?? 0}`;
}
function round4(x: number): number { return Math.round(x * 1e4) / 1e4; }
function round6(x: number): number { return Math.round(x * 1e6) / 1e6; }