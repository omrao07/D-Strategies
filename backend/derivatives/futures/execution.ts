// futures/execution.ts
// Pure TS, no imports. Lightweight execution simulator for futures.
// Supports MARKET, LIMIT, STOP, STOP_LIMIT; TIF = DAY/IOC/FOK; reduce-only; partial fills;
// gap-aware fills on bar data; simple slippage model; position & realized PnL tracking.

export type ISODate = string; // "YYYY-MM-DD"

export type Side = "BUY" | "SELL";
export type OrdType = "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
export type TIF = "DAY" | "IOC" | "FOK";
export type OrderStatus = "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "EXPIRED" | "REJECTED";

export type Bar = {
  date: ISODate;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type Order = {
  id: string;
  symbol: string;
  side: Side;
  qty: number;               // positive quantity (contracts)
  type: OrdType;
  tif?: TIF;                 // default DAY
  limitPx?: number;          // for LIMIT / STOP_LIMIT
  stopPx?: number;           // for STOP / STOP_LIMIT
  reduceOnly?: boolean;      // if true, cannot increase exposure
  tsClient?: number;         // optional client timestamp (ms)
  meta?: Record<string, any>;
};

export type Fill = {
  orderId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  ts: number;         // engine timestamp (ms since epoch)
  date: ISODate;      // bar date filled
  note?: string;
};

export type ExecutionReport = {
  order: Order;
  status: OrderStatus;
  cumQty: number;
  avgPx: number;
  leavesQty: number;
  lastFill?: Fill;
  fills?: Fill[];
  reason?: string;
};

export type Position = {
  symbol: string;
  qty: number;        // signed: >0 long, <0 short
  avgPx: number;      // average entry price for open qty (0 if flat)
  realizedPnl: number;
};

export type AccountState = {
  cash: number;       // not used for margin here; available for fees if needed
  positions: Record<string, Position>;
  realizedPnl: number;
};

export type SlippageFn = (px: number, side: Side, context: {
  symbol: string;
  bar: Bar;
  order: Order;
  remainingQty: number;
  engineTime: number;
}) => number;

/** Default: no slippage */
export function noSlippage(px: number, _side: Side): number { return px; }

/** Simple bps slippage: adds bps to adverse side. */
export function bpsSlippage(bps: number): SlippageFn {
  const f = Math.max(0, bps) / 1e4;
  return (px, side) => (side === "BUY" ? px * (1 + f) : px * (1 - f));
}

/** Engine configuration */
export type ExecEngineConfig = {
  slippage?: SlippageFn;
  feePerContract?: number;         // flat fee per filled contract (optional)
  allowCrossZeroOnReduceOnly?: boolean; // if false, reduce-only caps at flat
};

/** Internal working order with runtime state */
type LiveOrder = Order & {
  cumQty: number;
  avgPx: number;
  status: OrderStatus;
  fills: Fill[];
  createdAt: number;
};

export class ExecutionEngine {
  private orders: Record<string, LiveOrder> = {};
  private orderQueue: string[] = []; // fifo of order ids
  private nextId = 1;
  private nowMs = Date.now();
  private cfg: Required<ExecEngineConfig>;
  public acct: AccountState = { cash: 0, positions: {}, realizedPnl: 0 };

  constructor(cfg?: ExecEngineConfig) {
    this.cfg = {
      slippage: cfg?.slippage ?? noSlippage,
      feePerContract: cfg?.feePerContract ?? 0,
      allowCrossZeroOnReduceOnly: cfg?.allowCrossZeroOnReduceOnly ?? false,
    };
  }

  /** Create/submit an order. If id missing, engine assigns one. Returns assigned id. */
  submit(o: Partial<Order> & Pick<Order, "symbol" | "side" | "qty" | "type">): string {
    const id = o.id || `O${this.nextId++}`;
    const ord: LiveOrder = {
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
      cumQty: 0,
      avgPx: 0,
      status: "NEW",
      fills: [],
      createdAt: this.nowMs,
    };
    // Basic validation
    const err = this.validate(ord);
    if (err) {
      ord.status = "REJECTED";
      this.orders[id] = ord;
      return id;
    }
    this.orders[id] = ord;
    this.orderQueue.push(id);
    return id;
  }

  /** Cancel an existing order if still working. */
  cancel(orderId: string, reason = "Canceled by user"): ExecutionReport | null {
    const lo = this.orders[orderId];
    if (!lo) return null;
    if (lo.status === "FILLED" || lo.status === "CANCELED" || lo.status === "EXPIRED" || lo.status === "REJECTED") {
      return this.report(orderId, "CANCELED", undefined, reason);
    }
    lo.status = lo.cumQty > 0 ? "PARTIALLY_FILLED" : "CANCELED";
    lo.status = "CANCELED";
    return this.report(orderId, lo.status, undefined, reason);
  }

  /** Advance engine clock and process fills against a bar. */
  onBar(bar: Bar): void {
    this.nowMs += 1; // monotonic tick
    const ids = this.orderQueue.slice(); // snapshot; may mutate during loop
    for (const id of ids) {
      const lo = this.orders[id];
      if (!lo) continue;
      if (lo.symbol !== lo.symbol) continue; // placeholder symmetry
      if (lo.status === "FILLED" || lo.status === "CANCELED" || lo.status === "EXPIRED" || lo.status === "REJECTED") continue;

      // Evaluate executable quantity & price
      const leaves = lo.qty - lo.cumQty;
      if (leaves <= 0) { this.finalize(lo); continue; }

      const pxPlan = this.matchPlan(lo, bar);
      if (!pxPlan) {
        // Not triggered or not marketable
        if (lo.tif === "IOC" || lo.tif === "FOK") {
          // For IOC/FOK, if not filled this bar, expire immediately.
          this.expireOrder(lo, "Not marketable on IOC/FOK bar");
        }
        continue;
      }

      // For FOK: require full quantity available within plan; else expire.
      if (lo.tif === "FOK" && pxPlan.maxExecutable < leaves) {
        this.expireOrder(lo, "FOK: not all qty executable");
        continue;
      }

      // Determine execQty: for IOC, as much as possible; for DAY/MARKET/LIMIT, also as much as possible this bar.
      let execQty = Math.min(leaves, pxPlan.maxExecutable);
      if (lo.reduceOnly) {
        execQty = Math.min(execQty, this.reduceOnlyCap(lo));
        if (execQty <= 0) {
          this.expireOrder(lo, "Reduce-only: no exposure to reduce");
          continue;
        }
      }

      // Fill at slippage-adjusted price (gap-aware plan provides base price)
      const rawPx = pxPlan.fillPx;
      const slipPx = this.cfg.slippage(rawPx, lo.side, { symbol: lo.symbol, bar, order: lo, remainingQty: execQty, engineTime: this.nowMs });
      this.applyFill(lo, execQty, slipPx, bar.date, pxPlan.note);

      // For IOC: whatever we could fill is done; remaining expires.
      if (lo.tif === "IOC" && lo.cumQty < lo.qty) {
        this.expireOrder(lo, "IOC residual expired");
      }

      // If fully filled, finalize.
      if (lo.cumQty >= lo.qty) this.finalize(lo);
    }

    // Expire DAY orders at bar close? We choose to let DAY live until explicit end-of-day call.
    // Provide helper endOfDay() for that.
  }

  /** Expire all DAY orders (e.g., at end of session). */
  endOfDay(dateISO: ISODate): void {
    for (const id of Object.keys(this.orders)) {
      const lo = this.orders[id];
      if (!lo) continue;
      if (lo.tif === "DAY" && (lo.status === "NEW" || lo.status === "PARTIALLY_FILLED")) {
        lo.status = lo.cumQty > 0 ? "PARTIALLY_FILLED" : "EXPIRED";
        this.report(id, lo.status, undefined, `DAY expired ${dateISO}`);
      }
    }
    // Compact queue
    this.orderQueue = this.orderQueue.filter(id => {
      const s = this.orders[id]?.status;
      return s === "NEW" || s === "PARTIALLY_FILLED";
    });
  }

  /** Get report snapshot */
  report(orderId: string, forcedStatus?: OrderStatus, lastFill?: Fill, reason?: string): ExecutionReport | null {
    const lo = this.orders[orderId];
    if (!lo) return null;
    const status = forcedStatus || lo.status;
    const avgPx = lo.cumQty > 0 ? lo.avgPx : 0;
    const leaves = Math.max(0, lo.qty - lo.cumQty);
    return {
      order: { ...lo },
      status,
      cumQty: lo.cumQty,
      avgPx,
      leavesQty: leaves,
      lastFill,
      fills: lo.fills.slice(),
      reason,
    };
  }

  /** ===== Internals ===== */

  private validate(o: LiveOrder): string | null {
    if (o.qty <= 0) return "Qty must be > 0";
    if (o.type === "LIMIT" && !(o.limitPx! > 0)) return "LIMIT requires limitPx";
    if (o.type === "STOP" && !(o.stopPx! > 0)) return "STOP requires stopPx";
    if (o.type === "STOP_LIMIT" && (!(o.stopPx! > 0) || !(o.limitPx! > 0))) return "STOP_LIMIT requires stopPx and limitPx";
    return null;
  }

  /** Calculate how much can be executed under reduce-only constraint */
  private reduceOnlyCap(o: LiveOrder): number {
    const pos = this.acct.positions[o.symbol]?.qty || 0;
    if (pos === 0) return 0;
    if (o.side === "SELL" && pos > 0) {
      // selling reduces a long
      const cap = pos;
      return this.cfg.allowCrossZeroOnReduceOnly ? o.qty : Math.min(o.qty, cap);
    }
    if (o.side === "BUY" && pos < 0) {
      // buying reduces a short
      const cap = -pos;
      return this.cfg.allowCrossZeroOnReduceOnly ? o.qty : Math.min(o.qty, cap);
    }
    // Otherwise it would increase exposure
    return 0;
  }

  /** Determine if order can execute on this bar and at what price, with gap handling. */
  private matchPlan(o: LiveOrder, b: Bar): { maxExecutable: number; fillPx: number; note: string } | null {
    const side = o.side;
    const buy = side === "BUY";
    const { open, high, low } = b;

    // Helper: gap-through logic for price level L
    const gapFillPx = (L: number, direction: "BUY" | "SELL"): number => {
      // If bar opens beyond the level in the favorable direction, execute at open (gap-through).
      if (direction === "BUY") {
        if (open <= L) return open; // opened below/equal to limit -> better price at open
        // otherwise will it trade down to L?
        if (low <= L) return L;
      } else {
        if (open >= L) return open; // opened above/equal to limit -> better price at open
        if (high >= L) return L;
      }
      return NaN; // not touched
    };

    if (o.type === "MARKET") {
      // Market executes at open (session arrival) for our bar model
      const px = open;
      return { maxExecutable: o.qty - o.cumQty, fillPx: px, note: "MARKET@open" };
    }

    if (o.type === "LIMIT") {
      const L = o.limitPx!;
      if (buy) {
        // Buy LIMIT fills if market touches <= L
        const px = gapFillPx(L, "BUY");
        if (isFinite(px)) return { maxExecutable: o.qty - o.cumQty, fillPx: px, note: "LIMIT buy" };
      } else {
        const px = gapFillPx(L, "SELL");
        if (isFinite(px)) return { maxExecutable: o.qty - o.cumQty, fillPx: px, note: "LIMIT sell" };
      }
      return null;
    }

    if (o.type === "STOP") {
      const S = o.stopPx!;
      if (buy) {
        // Buy STOP triggers when price >= S; becomes market
        const triggered = open >= S || high >= S;
        if (!triggered) return null;
        // Gap: if open > S, fill at open; else at S
        const px = open >= S ? open : S;
        return { maxExecutable: o.qty - o.cumQty, fillPx: px, note: "STOP->MKT buy" };
      } else {
        const triggered = open <= S || low <= S;
        if (!triggered) return null;
        const px = open <= S ? open : S;
        return { maxExecutable: o.qty - o.cumQty, fillPx: px, note: "STOP->MKT sell" };
      }
    }

    if (o.type === "STOP_LIMIT") {
      const S = o.stopPx!, L = o.limitPx!;
      if (buy) {
        const triggered = open >= S || high >= S;
        if (!triggered) return null;
        // Once triggered, behave like a buy limit at L
        // If opening gap above S, check if L is reachable this bar
        const px = gapFillPx(L, "BUY");
        if (isFinite(px) && px <= L) return { maxExecutable: o.qty - o.cumQty, fillPx: px, note: "STOP_LIMIT buy" };
        return null;
      } else {
        const triggered = open <= S || low <= S;
        if (!triggered) return null;
        const px = gapFillPx(L, "SELL");
        if (isFinite(px) && px >= L) return { maxExecutable: o.qty - o.cumQty, fillPx: px, note: "STOP_LIMIT sell" };
        return null;
      }
    }

    return null;
  }

  private expireOrder(o: LiveOrder, why: string) {
    if (o.cumQty > 0) o.status = "PARTIALLY_FILLED"; else o.status = "EXPIRED";
    this.report(o.id, o.status, undefined, why);
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

    // Apply to account/positions
    this.bookTrade(fill);

    // Fees
    if (this.cfg.feePerContract > 0) {
      this.acct.cash -= this.cfg.feePerContract * qty;
      this.acct.realizedPnl -= this.cfg.feePerContract * qty;
    }

    // If fully filled, remove from working queue
    if (o.status === "FILLED") {
      this.orderQueue = this.orderQueue.filter(id => id !== o.id);
    }
  }

  /** Book trade to positions with realized PnL (futures, no cost of carry here). */
  private bookTrade(fill: Fill) {
    const sym = fill.symbol;
    const pos = this.acct.positions[sym] || { symbol: sym, qty: 0, avgPx: 0, realizedPnl: 0 } as Position;
    const signedQty = fill.side === "BUY" ? fill.qty : -fill.qty;

    // If adding to same direction or from flat -> update avg
    if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signedQty)) {
      const newQty = pos.qty + signedQty;
      // Weighted avg price update
      const newAvg = (Math.abs(pos.qty) * pos.avgPx + Math.abs(signedQty) * fill.price) / Math.max(1, Math.abs(newQty));
      pos.qty = newQty;
      pos.avgPx = newAvg;
    } else {
      // Reducing/closing/reversing
      const closingQty = Math.min(Math.abs(pos.qty), Math.abs(signedQty)) * Math.sign(signedQty); // sign of trade
      const pnlPer = (fill.price - pos.avgPx) * (pos.qty > 0 ? 1 : -1); // long: sell above avg -> +; short: buy below avg -> +
      const realized = Math.abs(closingQty) * pnlPer;
      pos.realizedPnl += realized;
      this.acct.realizedPnl += realized;

      const remaining = pos.qty + signedQty;
      if (remaining === 0) {
        pos.qty = 0;
        pos.avgPx = 0;
      } else if (Math.sign(remaining) === Math.sign(pos.qty)) {
        // Partial reduction, same direction remains
        pos.qty = remaining;
        // avgPx unchanged
      } else {
        // Reversal: new avg at fill price for the net opened side
        pos.qty = remaining;
        pos.avgPx = fill.price;
      }
    }

    this.acct.positions[sym] = pos;
  }

  private finalize(o: LiveOrder) {
    o.status = "FILLED";
  }

  /** ===== Convenience getters ===== */

  getOrder(id: string): LiveOrder | undefined { return this.orders[id]; }

  getOpenOrders(): LiveOrder[] {
    return Object.values(this.orders).filter(o =>
      o.status === "NEW" || o.status === "PARTIALLY_FILLED"
    );
  }

  getReports(): ExecutionReport[] {
    return Object.keys(this.orders).map(id => this.report(id)!).filter(Boolean) as ExecutionReport[];
  }

  getPosition(symbol: string): Position {
    return this.acct.positions[symbol] || { symbol, qty: 0, avgPx: 0, realizedPnl: 0 };
  }
}

/* ===== Example usage (remove or keep for quick sanity checks)
const eng = new ExecutionEngine({ slippage: bpsSlippage(1) }); // 1 bps slippage
const ordId = eng.submit({ symbol: "ESZ25", side: "BUY", qty: 2, type: "LIMIT", limitPx: 5000 });
eng.onBar({ date: "2025-10-01", open: 5010, high: 5020, low: 4995, close: 5005 }); // gap above -> no fill for buy limit 5000 unless trades down to 5000 (low=4995 => fill at 5000)
const rep = eng.report(ordId);
*/