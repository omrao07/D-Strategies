// options/execution.ts
// Pure TS (no imports). Lightweight options execution + lifecycle engine.
//
// Features
// - MARKET/LIMIT/STOP/STOP_LIMIT orders; TIF = DAY/IOC/FOK; reduce-only
// - Gap-aware bar matching (OHLC of the option premium)
// - Simple, pluggable slippage and per-contract fees
// - Positions tracked with avg premium, signed qty (>0 long, <0 short)
// - Cash settles premium at trade time (equity-style), realized PnL tracked
// - Expiry processing (European-style cash settlement): intrinsic * multiplier
// - Snapshot MTM using chosen field (open/close/settle)
//
// Notes
// - Quotes/prices are the option *premium* per 1 unit; notional cash is premium * multiplier * qty
// - For equities, multiplier is typically 100
// - Provide OptionSpec for each listed option you trade so expiry settlement works

export type ISODate = string; // "YYYY-MM-DD"
export type Side = "BUY" | "SELL";
export type OrdType = "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
export type TIF = "DAY" | "IOC" | "FOK";
export type OrderStatus = "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "EXPIRED" | "REJECTED";
export type Field = "settle" | "close" | "open";

export type OptionBar = {
  date: ISODate;
  open: number;
  high: number;
  low: number;
  close: number;
  settle?: number;  // optional
};

export type Order = {
  id: string;
  symbol: string;
  side: Side;
  qty: number;               // contracts (positive)
  type: OrdType;
  tif?: TIF;                 // default DAY
  limitPx?: number;          // premium
  stopPx?: number;           // premium
  reduceOnly?: boolean;
  tsClient?: number;
  meta?: Record<string, any>;
};

export type Fill = {
  orderId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;    // premium per unit
  ts: number;
  date: ISODate;
  note?: string;
  fee?: number;     // applied to cash if provided (per-contract already × qty)
};

export type Position = {
  symbol: string;
  qty: number;      // signed: >0 long, <0 short
  avgPx: number;    // avg premium of open qty (per unit)
  realizedPnl: number; // currency
};

export type AccountState = {
  cash: number;       // currency, changes with premiums/fees/settlements
  positions: Record<string, Position>;
  realizedPnl: number;
};

export type OptionSpec = {
  symbol: string;
  underlying: string;         // underlying symbol key for settlement lookup
  right: "C" | "P";
  strike: number;
  expiryISO: ISODate;
  multiplier: number;         // e.g., 100 for equity options
  style?: "european" | "american"; // used only for metadata; engine settles at expiry
};

export type UnderlyingPx = { underlying: string; price: number };

export type SlippageFn = (px: number, side: Side, ctx: {
  symbol: string;
  bar: OptionBar;
  order: Order;
  remainingQty: number;
  engineTime: number;
}) => number;

/** Default slippage: none */
export function noSlippage(px: number): number { return px; }

/** Simple bps slippage on premium (adverse). */
export function bpsSlippage(bps: number): SlippageFn {
  const f = Math.max(0, bps) / 1e4;
  return (px, side) => (side === "BUY" ? px * (1 + f) : px * (1 - f));
}

export type EngineConfig = {
  slippage?: SlippageFn;
  feePerContract?: number;           // flat fee per contract filled
  markField?: Field;                 // used by snapshot MTM; default "settle" then fallback
  allowCrossZeroOnReduceOnly?: boolean;
};

type LiveOrder = Order & {
  status: OrderStatus;
  cumQty: number;
  avgPx: number;     // average premium of fills (per unit)
  fills: Fill[];
  createdAt: number;
};

function isFiniteNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }

function getField(b: OptionBar, f: Field): number {
  if (f === "settle") return isFiniteNum(b.settle) ? (b.settle as number) : b.close;
  if (f === "close")  return b.close;
  return b.open;
}

export class OptionsExecutionEngine {
  private orders: Record<string, LiveOrder> = {};
  private queue: string[] = [];
  private nextId = 1;
  private nowMs = Date.now();
  private cfg: Required<EngineConfig>;
  public acct: AccountState = { cash: 0, positions: {}, realizedPnl: 0 };
  private specs: Record<string, OptionSpec> = {};

  constructor(cfg?: EngineConfig, specs?: OptionSpec[]) {
    this.cfg = {
      slippage: cfg?.slippage ?? noSlippage,
      feePerContract: cfg?.feePerContract ?? 0,
      markField: cfg?.markField ?? "settle",
      allowCrossZeroOnReduceOnly: cfg?.allowCrossZeroOnReduceOnly ?? false,
    };
    if (specs) for (const s of specs) this.specs[s.symbol] = s;
  }

  /** Register / update an option spec (required for correct expiry settlement). */
  upsertSpec(spec: OptionSpec): void { this.specs[spec.symbol] = spec; }

  /** Create & submit order (id auto-assigned if missing). Returns id. */
  submit(o: Partial<Order> & Pick<Order, "symbol" | "side" | "qty" | "type">): string {
    const id = o.id || `O${this.nextId++}`;
    const lo: LiveOrder = {
      id,
      symbol: o.symbol,
      side: o.side,
      qty: Math.max(0, Math.floor(o.qty)),
      type: o.type,
      tif: o.tif || "DAY",
      limitPx: o.limitPx,
      stopPx: o.stopPx,
      reduceOnly: !!o.reduceOnly,
      tsClient: o.tsClient,
      meta: o.meta,
      status: "NEW",
      cumQty: 0,
      avgPx: 0,
      fills: [],
      createdAt: this.nowMs,
    };
    const err = this.validate(lo);
    if (err) {
      lo.status = "REJECTED";
      this.orders[id] = lo;
      return id;
    }
    this.orders[id] = lo;
    this.queue.push(id);
    return id;
  }

  /** Cancel if working. */
  cancel(orderId: string, reason = "Canceled"): void {
    const lo = this.orders[orderId];
    if (!lo) return;
    if (lo.status === "FILLED" || lo.status === "CANCELED" || lo.status === "EXPIRED" || lo.status === "REJECTED") return;
    lo.status = lo.cumQty > 0 ? "PARTIALLY_FILLED" : "CANCELED";
    lo.status = "CANCELED";
    // remove from queue
    this.queue = this.queue.filter(id => id !== orderId);
  }

  /** Process fills against an option bar (premium OHLC). */
  onBar(symbol: string, bar: OptionBar): void {
    this.nowMs += 1;
    const ids = this.queue.slice();
    for (const id of ids) {
      const lo = this.orders[id];
      if (!lo || lo.symbol !== symbol) continue;
      if (lo.status === "FILLED" || lo.status === "CANCELED" || lo.status === "EXPIRED" || lo.status === "REJECTED") continue;

      const leaves = lo.qty - lo.cumQty;
      if (leaves <= 0) { this.finalize(lo); continue; }

      const plan = this.matchPlan(lo, bar);
      if (!plan) {
        if (lo.tif === "IOC" || lo.tif === "FOK") this.expire(lo, "Not marketable on IOC/FOK bar");
        continue;
      }

      if (lo.tif === "FOK" && plan.maxExecutable < leaves) { this.expire(lo, "FOK: not all qty executable"); continue; }

      let execQty = Math.min(leaves, plan.maxExecutable);
      if (lo.reduceOnly) {
        execQty = Math.min(execQty, this.reduceOnlyCap(lo));
        if (execQty <= 0) { this.expire(lo, "Reduce-only: no exposure to reduce"); continue; }
      }

      const raw = plan.fillPx;
      const slip = this.cfg.slippage(raw, lo.side, { symbol, bar, order: lo, remainingQty: execQty, engineTime: this.nowMs });
      this.applyFill(lo, execQty, slip, bar.date, plan.note);

      if (lo.tif === "IOC" && lo.cumQty < lo.qty) this.expire(lo, "IOC residual expired");
      if (lo.cumQty >= lo.qty) this.finalize(lo);
    }
  }

  /** Expire all DAY orders at end of session. */
  endOfDay(dateISO: ISODate): void {
    for (const id of Object.keys(this.orders)) {
      const lo = this.orders[id];
      if (!lo) continue;
      if (lo.tif === "DAY" && (lo.status === "NEW" || lo.status === "PARTIALLY_FILLED")) {
        lo.status = lo.cumQty > 0 ? "PARTIALLY_FILLED" : "EXPIRED";
      }
    }
    this.queue = this.queue.filter(id => {
      const s = this.orders[id]?.status;
      return s === "NEW" || s === "PARTIALLY_FILLED";
    });
  }

  /** Snapshot mark-to-market using the configured field (settle/close/open). */
  snapshot(dateISO: ISODate, bars: { symbol: string; bar: OptionBar }[]): {
    date: ISODate; cash: number; equity: number; unrealized: number;
  } {
    const markIdx: Record<string, OptionBar> = {};
    for (const { symbol, bar } of bars) markIdx[symbol] = bar;

    let unreal = 0;
    for (const sym of Object.keys(this.acct.positions)) {
      const pos = this.acct.positions[sym];
      if (!pos || pos.qty === 0) continue;
      const b = markIdx[sym];
      if (!b) continue;
      const px = getField(b, this.cfg.markField) ?? b.close;
      // unrealized on premium difference * multiplier
      const mult = this.specs[sym]?.multiplier || 1;
      unreal += (px - pos.avgPx) * mult * pos.qty; // signed qty
    }

    const equity = this.acct.cash + unreal;
    return { date: dateISO, cash: this.acct.cash, equity, unrealized: unreal };
  }

  /** Process expiries for given date: cash-settle intrinsic and close positions. */
  settleExpiries(dateISO: ISODate, underlyings: UnderlyingPx[]): void {
    const uMap: Record<string, number> = {};
    for (const u of underlyings) uMap[u.underlying] = u.price;

    for (const sym of Object.keys(this.acct.positions)) {
      const spec = this.specs[sym];
      if (!spec || spec.expiryISO !== dateISO) continue;

      const pos = this.acct.positions[sym];
      if (!pos || pos.qty === 0) { this.acct.positions[sym] = { symbol: sym, qty: 0, avgPx: 0, realizedPnl: pos?.realizedPnl || 0 }; continue; }

      const S = uMap[spec.underlying];
      if (!(S > 0)) {
        // if no underlying price, treat as worthless at expiry (no payout)
        this.closePositionAtExpiry(sym, 0);
        continue;
      }
      const intrinsic = Math.max(0, spec.right === "C" ? (S - spec.strike) : (spec.strike - S));
      const payoutPerContract = intrinsic * (spec.multiplier || 1);

      // Long qty receives payout; short pays payout
      const payout = payoutPerContract * pos.qty; // signed
      this.acct.cash += payout;
      this.acct.realizedPnl += payout;

      // Close position (avgPx zeroed)
      const realizedFromPremiumSide = -pos.avgPx * (spec.multiplier || 1) * pos.qty; // reversing premium (conceptual)
      // We already accounted premium at trade time, so no additional cash here.
      // Just record realized pnl if you want: not necessary; keep cash-based truth.

      // Reset position
      this.acct.positions[sym] = { symbol: sym, qty: 0, avgPx: 0, realizedPnl: pos.realizedPnl + payout };
    }
  }

  /** ===== Getters ===== */
  getOrder(id: string): LiveOrder | undefined { return this.orders[id]; }
  getOpenOrders(): LiveOrder[] { return Object.values(this.orders).filter(o => o.status === "NEW" || o.status === "PARTIALLY_FILLED"); }
  getPosition(symbol: string): Position { return this.acct.positions[symbol] || { symbol, qty: 0, avgPx: 0, realizedPnl: 0 }; }
  getReports(): { id: string; status: OrderStatus; cumQty: number; avgPx: number; leavesQty: number }[] {
    return Object.values(this.orders).map(o => ({
      id: o.id, status: o.status, cumQty: o.cumQty, avgPx: o.avgPx, leavesQty: Math.max(0, o.qty - o.cumQty),
    }));
  }

  /** ===== Internals ===== */

  private validate(o: LiveOrder): string | null {
    if (o.qty <= 0) return "Qty must be > 0";
    if (o.type === "LIMIT" && !(o.limitPx! > 0)) return "LIMIT requires limitPx";
    if (o.type === "STOP" && !(o.stopPx! > 0)) return "STOP requires stopPx";
    if (o.type === "STOP_LIMIT" && (!(o.stopPx! > 0) || !(o.limitPx! > 0))) return "STOP_LIMIT requires stopPx and limitPx";
    return null;
  }

  private reduceOnlyCap(o: LiveOrder): number {
    const pos = this.acct.positions[o.symbol]?.qty || 0;
    if (pos === 0) return 0;
    if (o.side === "SELL" && pos > 0) return this.cfg.allowCrossZeroOnReduceOnly ? o.qty : Math.min(o.qty, pos);
    if (o.side === "BUY" && pos < 0)  return this.cfg.allowCrossZeroOnReduceOnly ? o.qty : Math.min(o.qty, -pos);
    return 0;
  }

  private expire(o: LiveOrder, why: string) {
    if (o.cumQty > 0) o.status = "PARTIALLY_FILLED"; else o.status = "EXPIRED";
    // remove from queue
    this.queue = this.queue.filter(id => id !== o.id);
    // (could log 'why' in o.meta if desired)
  }

  private matchPlan(o: LiveOrder, b: OptionBar): { maxExecutable: number; fillPx: number; note: string } | null {
    const open = b.open, high = b.high, low = b.low;
    const buy = o.side === "BUY";

    const gapFillPx = (L: number, dir: Side): number => {
      if (dir === "BUY") {
        if (open <= L) return open;
        if (low <= L) return L;
      } else {
        if (open >= L) return open;
        if (high >= L) return L;
      }
      return NaN;
    };

    if (o.type === "MARKET") {
      return { maxExecutable: o.qty - o.cumQty, fillPx: open, note: "MKT@open" };
    }

    if (o.type === "LIMIT") {
      const L = o.limitPx!;
      if (buy) {
        const px = gapFillPx(L, "BUY");
        if (isFinite(px)) return { maxExecutable: o.qty - o.cumQty, fillPx: px, note: "LMT buy" };
      } else {
        const px = gapFillPx(L, "SELL");
        if (isFinite(px)) return { maxExecutable: o.qty - o.cumQty, fillPx: px, note: "LMT sell" };
      }
      return null;
    }

    if (o.type === "STOP") {
      const S = o.stopPx!;
      if (buy) {
        const trig = open >= S || high >= S;
        if (!trig) return null;
        const px = open >= S ? open : S;
        return { maxExecutable: o.qty - o.cumQty, fillPx: px, note: "STP->MKT buy" };
      } else {
        const trig = open <= S || low <= S;
        if (!trig) return null;
        const px = open <= S ? open : S;
        return { maxExecutable: o.qty - o.cumQty, fillPx: px, note: "STP->MKT sell" };
      }
    }

    if (o.type === "STOP_LIMIT") {
      const S = o.stopPx!, L = o.limitPx!;
      if (buy) {
        const trig = open >= S || high >= S;
        if (!trig) return null;
        const px = gapFillPx(L, "BUY");
        if (isFinite(px) && px <= L) return { maxExecutable: o.qty - o.cumQty, fillPx: px, note: "STP_LMT buy" };
        return null;
      } else {
        const trig = open <= S || low <= S;
        if (!trig) return null;
        const px = gapFillPx(L, "SELL");
        if (isFinite(px) && px >= L) return { maxExecutable: o.qty - o.cumQty, fillPx: px, note: "STP_LMT sell" };
        return null;
      }
    }

    return null;
  }

  private applyFill(o: LiveOrder, qty: number, px: number, date: ISODate, note?: string) {
    const fill: Fill = {
      orderId: o.id,
      symbol: o.symbol,
      side: o.side,
      qty,
      price: px,
      ts: this.nowMs,
      date,
      note,
    };

    // Update order aggregates
    const newCum = o.cumQty + qty;
    const newAvg = o.cumQty === 0 ? px : (o.avgPx * o.cumQty + px * qty) / newCum;
    o.cumQty = newCum;
    o.avgPx = newAvg;
    o.fills.push(fill);
    o.status = o.cumQty >= o.qty ? "FILLED" : "PARTIALLY_FILLED";

    // Fees
    const fee = (this.cfg.feePerContract || 0) * qty;
    if (fee > 0) {
      this.acct.cash -= fee;
      this.acct.realizedPnl -= fee;
      fill.fee = fee;
    }

    // Cash movement for premium at trade time
    const mult = this.specs[o.symbol]?.multiplier || 1;
    const cashDelta = (o.side === "BUY" ? -1 : +1) * px * mult * qty;
    this.acct.cash += cashDelta;
    this.acct.realizedPnl += 0; // premium itself is cash out/in; realized PnL realized over lifecycle (expiry/exercise). Keep zero here.

    // Book to position (avg premium & signed qty)
    this.bookTrade(fill, mult);

    // Remove from queue if filled
    if (o.status === "FILLED") this.queue = this.queue.filter(id => id !== o.id);
  }

  private bookTrade(fill: Fill, multiplier: number) {
    const sym = fill.symbol;
    const pos = this.acct.positions[sym] || { symbol: sym, qty: 0, avgPx: 0, realizedPnl: 0 } as Position;
    const signedQty = fill.side === "BUY" ? fill.qty : -fill.qty;

    // If same direction or from flat: weighted avg premium
    if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signedQty)) {
      const newQty = pos.qty + signedQty;
      const newAvg = (Math.abs(pos.qty) * pos.avgPx + Math.abs(signedQty) * fill.price) / Math.max(1, Math.abs(newQty));
      pos.qty = newQty;
      pos.avgPx = newAvg;
    } else {
      // Reducing/closing/reversing
      const closingQty = Math.min(Math.abs(pos.qty), Math.abs(signedQty)) * Math.sign(signedQty);
      // On options, realized PnL component when closing before expiry is (entry premium - exit premium) * multiplier * closedQty (with correct sign)
      const realizedPerUnit = (pos.avgPx - fill.price) * (pos.qty > 0 ? 1 : -1); // if long then sell higher premium => +, if short then buy back lower => +
      const realized = Math.abs(closingQty) * realizedPerUnit * multiplier;
      pos.realizedPnl += realized;
      this.acct.realizedPnl += realized;
      // Cash already moved for premium; realized just records PnL

      const remaining = pos.qty + signedQty;
      if (remaining === 0) {
        pos.qty = 0;
        pos.avgPx = 0;
      } else if (Math.sign(remaining) === Math.sign(pos.qty)) {
        pos.qty = remaining; // partial reduction, avg unchanged
      } else {
        // Reversal: new side at current trade premium
        pos.qty = remaining;
        pos.avgPx = fill.price;
      }
    }

    this.acct.positions[sym] = pos;
  }

  private closePositionAtExpiry(sym: string, payoutPerContract: number) {
    const pos = this.acct.positions[sym];
    if (!pos) return;
    const mult = this.specs[sym]?.multiplier || 1;
    // payoutPerContract already incorporates multiplier outside if desired; here we assume it's per 1 contract total currency.
    // (We compute payout as intrinsic * multiplier upstream.)
    // Close position:
    pos.qty = 0;
    pos.avgPx = 0;
    this.acct.positions[sym] = pos;
  }

  private finalize(o: LiveOrder) { o.status = "FILLED"; }
}