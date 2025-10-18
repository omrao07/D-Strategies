// options/ledger.ts
// Pure TS. No imports.
// Options-focused ledger with FIFO lots, premium cash handling at trade time,
// daily MTM (snapshot only; options are not futures-settled), expiry cash settlement,
// fees, and compact reporting.
//
// Conventions
// - Premium cash moves at trade time: BUY -> cash out, SELL -> cash in
// - Positions track signed qty (>0 long, <0 short) and avg premium
// - Realized PnL accumulates on closing trades (premium PnL) and at expiry (intrinsic)
// - Snapshot MTM uses option premium bars (open/close/settle) — no cash posting
// - Expiry is cash-settled by intrinsic * multiplier, then position is closed

export type ISODate = string; // YYYY-MM-DD
export type Field = "settle" | "close" | "open";
export type Side = "BUY" | "SELL";

export type Fill = {
  orderId?: string;
  symbol: string;
  side: Side;
  qty: number;        // contracts
  price: number;      // premium per unit
  date: ISODate;
  fee?: number;       // currency (already × qty)
  note?: string;
};

export type OptionBar = {
  symbol: string;
  date: ISODate;
  open: number;
  high: number;
  low: number;
  close: number;
  settle?: number;    // optional
};

export type OptionSpec = {
  symbol: string;
  underlying: string;
  right: "C" | "P";
  strike: number;
  expiryISO: ISODate;
  multiplier: number; // e.g., 100
};

export type UnderlyingPx = { underlying: string; price: number };

export type CashEntry = {
  date: ISODate;
  ref?: string;
  cashDelta: number;  // + deposit or inflow, - outflow
  note?: string;
};

export type Lot = {
  openDate: ISODate;
  side: Side;         // BUY => +qty, SELL => -qty
  qty: number;        // signed remaining
  price: number;      // entry premium
};

export type Position = {
  symbol: string;
  qty: number;        // net signed
  avgPx: number;      // avg premium of open qty
  lots: Lot[];        // FIFO
  realizedPnl: number;
};

export type Snapshot = {
  date: ISODate;
  cash: number;
  equity: number;
  unrealized: number;
  positions: Record<string, Position>;
  exposurePremium: number; // |qty| * price * multiplier summed (using chosen field)
};

export type LedgerState = {
  specs: Record<string, OptionSpec>;
  positions: Record<string, Position>;
  fills: Fill[];
  cashJournal: CashEntry[];
  cash: number;
  equity: number;
  lastSnapshot?: Snapshot;
};

/* ===== Utilities ===== */
function sum(xs: number[]): number { let s = 0; for (const x of xs) s += x; return s; }
function round2(x: number): number { return Math.round((x + 1e-12) * 100) / 100; }
function isNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }

function getOrCreatePos(state: LedgerState, symbol: string): Position {
  const p = state.positions[symbol];
  if (p) return p;
  const np: Position = { symbol, qty: 0, avgPx: 0, lots: [], realizedPnl: 0 };
  state.positions[symbol] = np;
  return np;
}

function clonePos(p: Position): Position {
  return { symbol: p.symbol, qty: p.qty, avgPx: p.avgPx, realizedPnl: p.realizedPnl, lots: p.lots.map(l => ({ ...l })) };
}

function markFieldOf(bar: OptionBar, f: Field): number {
  if (f === "settle") return isNum(bar.settle) ? (bar.settle as number) : bar.close;
  if (f === "close") return bar.close;
  return bar.open;
}

/* ===== Construction ===== */
export function createLedger(specs: OptionSpec[], startingCash = 0): LedgerState {
  const m: Record<string, OptionSpec> = {};
  for (const s of specs) m[s.symbol] = s;
  return {
    specs: m,
    positions: {},
    fills: [],
    cashJournal: startingCash !== 0 ? [{ date: "1970-01-01", ref: "INIT", cashDelta: startingCash, note: "Starting cash" }] : [],
    cash: startingCash,
    equity: startingCash,
  };
}

export function upsertSpec(state: LedgerState, spec: OptionSpec): void {
  state.specs[spec.symbol] = spec;
}

/* ===== Cash ===== */
export function postCash(state: LedgerState, entry: CashEntry): void {
  state.cashJournal.push(entry);
  state.cash = round2(state.cash + entry.cashDelta);
}

/* ===== Trades (premium moves cash immediately) ===== */
export function postFill(state: LedgerState, f: Fill): void {
  // record fee
  if (isNum(f.fee) && f.fee !== 0) {
    state.cashJournal.push({ date: f.date, ref: f.orderId || "FEE", cashDelta: -Math.abs(f.fee as number), note: f.note || "Trade fee" });
    state.cash = round2(state.cash - Math.abs(f.fee as number));
  }

  state.fills.push(f);
  const pos = getOrCreatePos(state, f.symbol);
  const mult = state.specs[f.symbol]?.multiplier || 1;
  const signedQty = f.side === "BUY" ? +f.qty : -f.qty;

  // premium cash movement
  const cashDelta = (f.side === "BUY" ? -1 : +1) * f.price * mult * f.qty;
  state.cash = round2(state.cash + cashDelta);
  state.cashJournal.push({ date: f.date, ref: f.orderId || f.symbol, cashDelta, note: f.note || "Premium" });

  if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signedQty)) {
    // add/extend same direction -> push lot & recompute avg
    pos.lots.push({ openDate: f.date, side: f.side, qty: signedQty, price: f.price });
    pos.qty += signedQty;
    const w = sum(pos.lots.map(l => Math.abs(l.qty)));
    const vw = sum(pos.lots.map(l => Math.abs(l.qty) * l.price));
    pos.avgPx = w !== 0 ? vw / w : 0;
  } else {
    // reduce or reverse: consume FIFO
    let remaining = signedQty;
    const newLots: Lot[] = [];
    for (const lot of pos.lots) {
      if (remaining === 0) { newLots.push(lot); continue; }
      if (Math.sign(lot.qty) === Math.sign(remaining)) { newLots.push(lot); continue; } // same direction lot (shouldn’t happen here)
      const closeQty = Math.min(Math.abs(lot.qty), Math.abs(remaining)) * Math.sign(remaining);
      const lotAfter = lot.qty + closeQty; // closes against opposite sign
      // realized premium PnL: (entry - exit) * multiplier for closed qty, sign depends on original side
      const originalLong = lot.qty > 0;
      const perUnitRealized = originalLong ? (closeQty < 0 ? (f.price - lot.price) : (lot.price - f.price)) // selling against +lot => SELL (closeQty negative)
                                           : (closeQty > 0 ? (lot.price - f.price) : (f.price - lot.price)); // buying against -lot
      const realized = Math.abs(closeQty) * perUnitRealized * mult;
      pos.realizedPnl = round2(pos.realizedPnl + realized);

      remaining -= closeQty;
      if (lotAfter !== 0) newLots.push({ ...lot, qty: lotAfter });
    }
    if (remaining !== 0) {
      // reversal residual as new lot at current trade price
      newLots.push({ openDate: f.date, side: f.side, qty: remaining, price: f.price });
    }
    pos.lots = newLots;
    pos.qty = sum(pos.lots.map(l => l.qty));
    const w = sum(pos.lots.map(l => Math.abs(l.qty)));
    const vw = sum(pos.lots.map(l => Math.abs(l.qty) * l.price));
    pos.avgPx = w !== 0 ? vw / w : 0;
  }
}

/* ===== Expiry settlement (cash, then flat) ===== */
export function settleExpiries(
  state: LedgerState,
  dateISO: ISODate,
  underlyings: UnderlyingPx[]
): void {
  const uMap: Record<string, number> = {};
  for (const u of underlyings) uMap[u.underlying] = u.price;

  for (const sym of Object.keys(state.positions)) {
    const spec = state.specs[sym];
    if (!spec || spec.expiryISO !== dateISO) continue;

    const pos = state.positions[sym];
    if (!pos || pos.qty === 0) { // nothing open — ensure flat record
      state.positions[sym] = { symbol: sym, qty: 0, avgPx: 0, realizedPnl: pos?.realizedPnl || 0, lots: [] };
      continue;
    }

    const S = uMap[spec.underlying];
    const intrinsic = isNum(S) ? Math.max(0, spec.right === "C" ? (S - spec.strike) : (spec.strike - S)) : 0;
    const payout = intrinsic * spec.multiplier * pos.qty; // signed
    state.cash = round2(state.cash + payout);
    state.cashJournal.push({ date: dateISO, ref: `EXP:${sym}`, cashDelta: payout, note: "Expiry cash settlement" });
    pos.realizedPnl = round2(pos.realizedPnl + payout);

    // Flat the position
    pos.qty = 0;
    pos.avgPx = 0;
    pos.lots = [];
    state.positions[sym] = pos;
  }
}

/* ===== Snapshot MTM (no cash move) ===== */
export function snapshot(
  state: LedgerState,
  dateISO: ISODate,
  bars: OptionBar[],
  field: Field = "settle"
): Snapshot {
  const idx: Record<string, OptionBar> = {};
  for (const b of bars) idx[b.symbol] = b;

  let unreal = 0;
  let exposure = 0;
  for (const sym of Object.keys(state.positions)) {
    const p = state.positions[sym];
    if (!p || p.qty === 0) continue;
    const spec = state.specs[sym];
    const bar = idx[sym];
    if (!bar) continue;
    const px = markFieldOf(bar, field);
    unreal += (px - p.avgPx) * (spec?.multiplier || 1) * p.qty;
    exposure += Math.abs(p.qty) * px * (spec?.multiplier || 1);
  }
  unreal = round2(unreal);
  exposure = round2(exposure);
  const equity = round2(state.cash + unreal);
  state.equity = equity;

  const snap: Snapshot = {
    date: dateISO,
    cash: round2(state.cash),
    equity,
    unrealized: unreal,
    positions: Object.fromEntries(Object.entries(state.positions).map(([k, v]) => [k, clonePos(v)])),
    exposurePremium: exposure,
  };
  state.lastSnapshot = snap;
  return snap;
}

/* ===== Queries / Helpers ===== */
export function positionOf(state: LedgerState, symbol: string): Position {
  return state.positions[symbol] || { symbol, qty: 0, avgPx: 0, lots: [], realizedPnl: 0 };
}

export function equityCurve(state: LedgerState): { date: ISODate; cash: number; equity: number }[] {
  // Build from cash journal + last snapshot unrealized where available (simple reconstruction)
  const dates = new Set<string>();
  for (const c of state.cashJournal) dates.add(c.date);
  const sorted = Array.from(dates).sort();
  const out: { date: ISODate; cash: number; equity: number }[] = [];
  let cash = 0;
  const cj = state.cashJournal.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let i = 0;
  for (const d of sorted) {
    while (i < cj.length && cj[i].date <= d) { cash = round2(cash + cj[i].cashDelta); i++; }
    out.push({ date: d as ISODate, cash, equity: cash }); // equity≈cash absent MTM context
  }
  return out;
}

/* ===== Pretty summaries ===== */
export function summarizePosition(p: Position, mult = 1): string {
  return `${p.symbol} qty=${p.qty} avgPx=${p.avgPx.toFixed(4)} realized=${(p.realizedPnl / mult).toFixed(2)}×${mult}`;
}

export function summarizeLedger(s: LedgerState): string {
  const syms = Object.keys(s.positions);
  const posStr = syms.length
    ? syms.map(k => summarizePosition(s.positions[k], s.specs[k]?.multiplier || 1)).join(" | ")
    : "(flat)";
  return `Cash=${s.cash.toFixed(2)} Equity=${s.equity.toFixed(2)} Positions=${posStr}`;
}