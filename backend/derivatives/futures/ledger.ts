// futures/ledger.ts
// Pure TS. No imports.
// Trade-aware ledger with FIFO lots, daily settlement (mark-to-market), cash & equity tracking,
// margin accounting (initial/maintenance), fees, and reporting helpers.

export type ISODate = string; // YYYY-MM-DD

export type Side = "BUY" | "SELL";

export type Fill = {
  orderId: string;
  symbol: string;
  side: Side;
  qty: number;     // contracts
  price: number;   // fill price
  date: ISODate;
  fee?: number;    // per-contract fee already multiplied by qty (optional)
  note?: string;
};

export type BarSettle = {
  symbol: string;
  date: ISODate;
  settle: number;
};

export type MarginSpec = {
  initial: number;      // per contract currency
  maintenance: number;  // per contract currency
};

export type ContractSpec = {
  symbol: string;       // matches fills/settles symbol
  multiplier: number;   // PnL $ per 1 point per contract
  margin: MarginSpec;
};

export type CashEntry = {
  date: ISODate;
  ref?: string;         // orderId or reason
  cashDelta: number;    // + deposit, - withdrawal/fees/variation
  note?: string;
};

export type VariationEntry = {
  date: ISODate;
  symbol: string;
  pnl: number;          // variation margin for the day (credited/debited to cash)
  fromPrice: number;
  toPrice: number;
  qty: number;          // end-of-day net qty this applied on
};

export type Lot = {
  openDate: ISODate;
  side: Side;           // "BUY" -> +qty; "SELL" -> -qty (for shorts)
  qty: number;          // remaining contracts in this lot (signed by side)
  price: number;        // entry price
};

export type Position = {
  symbol: string;
  qty: number;          // signed net contracts (>0 long, <0 short)
  avgPx: number;        // average entry price of open qty (0 if flat)
  lots: Lot[];          // FIFO open lots
};

export type Snapshot = {
  date: ISODate;
  cash: number;         // after all cash postings today
  equity: number;       // cash + unrealized (should be ~= cash post-settlement)
  unrealized: number;
  positions: Record<string, Position>;
  marginUsed: number;   // maintenance margin on open positions
  marginExcess: number; // equity - marginUsed
  nav: number;          // equals equity
  exposureNotional: number;
  leverage: number;     // exposureNotional / equity (safe if equity>0)
};

export type LedgerState = {
  /** Chronological */
  fills: Fill[];
  cashJournal: CashEntry[];
  variations: VariationEntry[];
  positions: Record<string, Position>; // rolling positions (lots)
  lastSettle: Record<string, { date: ISODate; price: number; qty: number }>;
  specs: Record<string, ContractSpec>;
  cash: number;         // running cash
  equity: number;       // last computed equity
  lastSnapshot?: Snapshot;
};

/** ===== Utilities ===== */
function round2(x: number): number { return Math.round((x + 1e-12) * 100) / 100; }
function sum(xs: number[]): number { let s = 0; for (const x of xs) s += x; return s; }
function clonePos(p: Position): Position {
  return { symbol: p.symbol, qty: p.qty, avgPx: p.avgPx, lots: p.lots.map(l => ({ ...l })) };
}
function getOrCreatePos(state: LedgerState, symbol: string): Position {
  const p = state.positions[symbol];
  if (p) return p;
  const np: Position = { symbol, qty: 0, avgPx: 0, lots: [] };
  state.positions[symbol] = np;
  return np;
}

/** Create new, empty ledger with contract specs and optional starting cash. */
export function createLedger(specs: ContractSpec[], startingCash = 0): LedgerState {
  const m: Record<string, ContractSpec> = {};
  for (const s of specs) m[s.symbol] = s;
  return {
    fills: [],
    cashJournal: startingCash !== 0 ? [{ date: "1970-01-01", ref: "INIT", cashDelta: startingCash, note: "Starting cash" }] : [],
    variations: [],
    positions: {},
    lastSettle: {},
    specs: m,
    cash: startingCash,
    equity: startingCash,
  };
}

/** Deposit/withdraw cash. Positive = deposit, Negative = withdrawal. */
export function postCash(state: LedgerState, entry: CashEntry): void {
  state.cashJournal.push(entry);
  state.cash = round2(state.cash + entry.cashDelta);
}

/** Post a trade fill: adjust lots (FIFO), realized via futures is zero at trade time (PnL realized at settlement). */
export function postFill(state: LedgerState, f: Fill): void {
  // Record fee immediately to cash
  if (f.fee && f.fee !== 0) {
    state.cashJournal.push({ date: f.date, ref: f.orderId || f.note || "FEE", cashDelta: -Math.abs(f.fee), note: "Trade fee" });
    state.cash = round2(state.cash - Math.abs(f.fee));
  }

  state.fills.push(f);

  const p = getOrCreatePos(state, f.symbol);
  const signedQty = f.side === "BUY" ? f.qty : -f.qty;

  if (p.qty === 0 || Math.sign(p.qty) === Math.sign(signedQty)) {
    // Adding in same direction or from flat -> push lot
    p.lots.push({ openDate: f.date, side: f.side, qty: signedQty, price: f.price });
    p.qty += signedQty;
    // Recompute avgPx from lots:
    const w = sum(p.lots.map(l => Math.abs(l.qty)));
    const vw = sum(p.lots.map(l => Math.abs(l.qty) * l.price));
    p.avgPx = w !== 0 ? vw / w : 0;
  } else {
    // Reducing or reversing: consume FIFO opposite lots
    let remaining = signedQty; // may be smaller or larger than |p.qty|
    const newLots: Lot[] = [];
    for (const lot of p.lots) {
      if (remaining === 0) { newLots.push(lot); continue; }
      // lot.qty has the sign of its side: BUY>0, SELL<0
      if (Math.sign(lot.qty) === Math.sign(remaining)) {
        // same direction as remaining (shouldn't happen in reduction loop)
        newLots.push(lot);
        continue;
      }
      const closeQty = Math.min(Math.abs(lot.qty), Math.abs(remaining)) * Math.sign(remaining); // sign of trade
      const lotAfter = lot.qty + closeQty; // since lot.qty is opposite sign, this reduces magnitude
      remaining -= closeQty;
      if (lotAfter !== 0) newLots.push({ ...lot, qty: lotAfter });
    }
    // If still remaining (reversal), push a new lot with residual side
    if (remaining !== 0) {
      newLots.push({ openDate: f.date, side: f.side, qty: remaining, price: f.price });
    }
    p.lots = newLots;
    // Update net qty and avg
    p.qty = sum(p.lots.map(l => l.qty));
    const w = sum(p.lots.map(l => Math.abs(l.qty)));
    const vw = sum(p.lots.map(l => Math.abs(l.qty) * l.price));
    p.avgPx = w !== 0 ? vw / w : 0;
  }
}

/** Mark-to-market for a given date using settlement prices. Variation is posted to cash immediately (futures daily settlement). */
export function settleDay(state: LedgerState, dateISO: ISODate, settles: BarSettle[]): Snapshot {
  // Build a price map for quick lookup
  const px: Record<string, number> = {};
  for (const s of settles) if (s.date === dateISO) px[s.symbol] = s.settle;

  // Variation margin per symbol
  let totalVariation = 0;
  const variationsToday: VariationEntry[] = [];

  for (const sym of Object.keys(state.positions)) {
    const pos = state.positions[sym];
    if (!pos || pos.qty === 0) continue;
    const spec = state.specs[sym];
    if (!spec) continue;
    const newSettle = px[sym];
    if (!(newSettle > 0)) continue;

    const last = state.lastSettle[sym];
    const prevPrice = last?.price ?? newSettle; // if first day, variation=0
    const qty = pos.qty;
    const pnl = round2((newSettle - prevPrice) * spec.multiplier * qty);

    if (pnl !== 0) {
      totalVariation += pnl;
      variationsToday.push({
        date: dateISO,
        symbol: sym,
        pnl,
        fromPrice: prevPrice,
        toPrice: newSettle,
        qty,
      });
      // Cash is credited/debited by variation today
      state.cash = round2(state.cash + pnl);
      state.cashJournal.push({ date: dateISO, ref: `VAR:${sym}`, cashDelta: pnl, note: "Daily variation margin" });
    }

    // Update last settle snapshot
    state.lastSettle[sym] = { date: dateISO, price: newSettle, qty };
  }

  // Compute unrealized should be ~0 after settlement (since base moves to new settle)
  const unrealized = 0;

  // Margin used = maintenance * |qty| (very simplified)
  let marginUsed = 0;
  let exposure = 0;
  for (const sym of Object.keys(state.positions)) {
    const p = state.positions[sym];
    if (!p || p.qty === 0) continue;
    const spec = state.specs[sym];
    const sPx = px[sym] ?? state.lastSettle[sym]?.price ?? p.avgPx;
    marginUsed += Math.abs(p.qty) * (spec?.margin.maintenance || 0);
    exposure += Math.abs(p.qty) * sPx * (spec?.multiplier || 1);
  }
  marginUsed = round2(marginUsed);
  exposure = round2(exposure);

  const equity = round2(state.cash + unrealized);
  state.equity = equity;

  const snap: Snapshot = {
    date: dateISO,
    cash: round2(state.cash),
    equity,
    unrealized,
    positions: Object.fromEntries(Object.entries(state.positions).map(([k, v]) => [k, clonePos(v)])),
    marginUsed,
    marginExcess: round2(equity - marginUsed),
    nav: equity,
    exposureNotional: exposure,
    leverage: equity > 0 ? exposure / equity : 0,
  };

  state.variations.push(...variationsToday);
  state.lastSnapshot = snap;
  return snap;
}

/** Force revaluation without cash posting (e.g., intraday MTM for analytics). */
export function snapshot(state: LedgerState, dateISO: ISODate, prices: { symbol: string; price: number }[]): Snapshot {
  const px: Record<string, number> = {};
  for (const p of prices) px[p.symbol] = p.price;

  let unreal = 0;
  let marginUsed = 0;
  let exposure = 0;

  for (const sym of Object.keys(state.positions)) {
    const pos = state.positions[sym];
    if (!pos || pos.qty === 0) continue;
    const spec = state.specs[sym];
    const price = px[sym] ?? state.lastSettle[sym]?.price ?? pos.avgPx;
    const ref = state.lastSettle[sym]?.price ?? pos.avgPx;
    unreal += (price - ref) * (spec?.multiplier || 1) * pos.qty;
    marginUsed += Math.abs(pos.qty) * (spec?.margin.maintenance || 0);
    exposure += Math.abs(pos.qty) * price * (spec?.multiplier || 1);
  }

  unreal = round2(unreal);
  marginUsed = round2(marginUsed);
  exposure = round2(exposure);
  const equity = round2(state.cash + unreal);

  const snap: Snapshot = {
    date: dateISO,
    cash: round2(state.cash),
    equity,
    unrealized: unreal,
    positions: Object.fromEntries(Object.entries(state.positions).map(([k, v]) => [k, clonePos(v)])),
    marginUsed,
    marginExcess: round2(equity - marginUsed),
    nav: equity,
    exposureNotional: exposure,
    leverage: equity > 0 ? exposure / equity : 0,
  };
  state.lastSnapshot = snap;
  return snap;
}

/** Maintenance margin check. Returns deficit (>0) if equity < marginUsed, else 0. */
export function marginDeficit(state: LedgerState): number {
  const snap = state.lastSnapshot;
  if (!snap) return 0;
  const def = round2(Math.max(0, snap.marginUsed - snap.equity));
  return def;
}

/** Liquidate a quantity at a given price (e.g., risk control). Returns realized variation posted to cash immediately. */
export function forceLiquidate(state: LedgerState, dateISO: ISODate, symbol: string, qtyToClose: number, price: number): number {
  const spec = state.specs[symbol];
  if (!spec) return 0;
  const pos = state.positions[symbol];
  if (!pos || pos.qty === 0) return 0;

  const closeSide: Side = pos.qty > 0 ? "SELL" : "BUY";
  const closeQty = Math.min(Math.abs(pos.qty), Math.max(0, Math.floor(Math.abs(qtyToClose))));
  if (closeQty === 0) return 0;

  // Variation from last settle to liquidation price on closed qty
  const lastPx = state.lastSettle[symbol]?.price ?? pos.avgPx;
  const signed = (closeSide === "SELL" ? -closeQty : closeQty);
  const pnl = round2((price - lastPx) * spec.multiplier * signed);

  // Post cash and update last settle qty (remaining qty)
  state.cash += pnl;
  state.cashJournal.push({ date: dateISO, ref: `LIQ:${symbol}`, cashDelta: pnl, note: "Forced liquidation variation" });

  // Update lots by consuming FIFO opposite
  postFill(state, {
    orderId: `LIQ-${symbol}-${dateISO}`,
    symbol,
    side: closeSide,
    qty: closeQty,
    price,
    date: dateISO,
    note: "Forced liquidation",
  });

  // After posting the trade, update lastSettle qty snapshot (same price reference)
  const newQty = state.positions[symbol]?.qty || 0;
  state.lastSettle[symbol] = { date: dateISO, price: lastPx, qty: newQty };

  return pnl;
}

/** ===== Queries & helpers ===== */

/** Return a compact equity curve computed at the end of each unique date with settlements. */
export function equityCurve(state: LedgerState): { date: ISODate; cash: number; equity: number }[] {
  const dates = new Set<string>();
  for (const v of state.variations) dates.add(v.date);
  for (const c of state.cashJournal) dates.add(c.date);
  const sorted = Array.from(dates).sort();
  const out: { date: ISODate; cash: number; equity: number }[] = [];
  let cash = 0, equity = 0;

  // Rebuild via journal order
  const cj = state.cashJournal.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let i = 0;
  for (const d of sorted) {
    while (i < cj.length && cj[i].date <= d) {
      cash = round2(cash + cj[i].cashDelta);
      i++;
    }
    // Equity ~= cash after daily settlement
    equity = cash;
    out.push({ date: d, cash, equity });
  }
  return out;
}

/** Lightweight PnL attribution for a date: sum of variation entries. */
export function pnlOn(state: LedgerState, dateISO: ISODate): number {
  return round2(sum(state.variations.filter(v => v.date === dateISO).map(v => v.pnl)));
}

/** Current net position for a symbol. */
export function positionOf(state: LedgerState, symbol: string): Position {
  return state.positions[symbol] || { symbol, qty: 0, avgPx: 0, lots: [] };
}

/** Ensure contract spec exists; throw otherwise. */
export function requireSpec(state: LedgerState, symbol: string): ContractSpec {
  const s = state.specs[symbol];
  if (!s) throw new Error(`Missing contract spec for ${symbol}`);
  return s;
}