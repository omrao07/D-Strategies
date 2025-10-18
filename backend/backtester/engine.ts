// backtester/engine.ts

export type ISOTime = string;

export type Bar = {
  t: number | Date | ISOTime;
  o: number; h: number; l: number; c: number; v?: number;
  symbol?: string;
};

export type Tick = {
  t: number | Date | ISOTime;
  p: number;
  v?: number;
  symbol?: string;
};

export type FeedEvent =
  | { type: "bar"; bar: Bar }
  | { type: "tick"; tick: Tick }
  | { type: "eof" };

export type Side = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "STOP";
export type TimeInForce = "DAY" | "GTC" | "IOC" | "FOK";

export type Order = {
  id: string;
  symbol: string;
  side: Side;
  qty: number;                // absolute on order; becomes signed on fill
  type: OrderType;
  tif?: TimeInForce;
  limitPrice?: number;
  stopPrice?: number;
  ts: number;
  tag?: string;
  user?: Record<string, any>;
};

export type Fill = {
  orderId: string;
  symbol: string;
  qty: number;      // signed (+ buy, - sell)
  price: number;
  ts: number;
  fee: number;
  slippage: number;
  liquidity: "maker" | "taker";
};

export type Position = {
  symbol: string;
  qty: number;          // signed
  avgPrice: number;     // signed, same sign as qty
  realizedPnl: number;
};

export type AccountSnapshot = {
  ts: number;
  cash: number;
  equity: number;   // positions MtM
  nav: number;      // cash + equity
  drawdown: number; // nav - peak (<= 0)
};

export type EngineConfig = {
  initialCash?: number;
  symbols?: string[]; // optional filter list
  commission?: (fillValue: number, fill: Fill) => number;
  slippage?: (theo: number, side: Side, ev: FeedEvent, rnd: () => number) => number;
  priceOf?: (ev: FeedEvent, side: Side) => number;
  allowShort?: boolean;
  rngSeed?: number;
  maxLeverage?: number; // notional / equity
};

type NormalizedConfig =
  Omit<Required<EngineConfig>, "symbols"> & { symbols: string[] };

export type StrategyContext = {
  now(): number;
  cash(): number;
  equity(): number;
  position(symbol: string): Position | undefined;
  positions(): Readonly<Record<string, Position>>;
  submit(o: Omit<Order, "id" | "ts">): string;
  cancel(id: string): boolean;
  cancelAll(symbol?: string): void;
  log(msg: string, extra?: Record<string, any>): void;
};

export interface Strategy {
  onInit?(ctx: StrategyContext): void | Promise<void>;
  onBar?(ctx: StrategyContext, bar: Bar): void | Promise<void>;
  onTick?(ctx: StrategyContext, tick: Tick): void | Promise<void>;
  onClose?(ctx: StrategyContext): void | Promise<void>;
}

export type RunResult = {
  fills: Fill[];
  equityCurve: AccountSnapshot[];
  positions: Record<string, Position>;
  orders: Order[];
  metrics: Metrics;
};

/* -------------------------------- Engine -------------------------------- */

export class Engine {
  private cfg: NormalizedConfig;
  private strat: Strategy;

  private _now = 0;
  private cashBal: number;
  private positionsMap: Record<string, Position> = {};
  private openOrders = new Map<string, Order>();
  private fillsArr: Fill[] = [];
  private equityCurveArr: AccountSnapshot[] = [];
  private idSeq = 0;

  private rnd: () => number;

  constructor(strategy: Strategy, config: EngineConfig = {}) {
    this.strat = strategy;
    this.cfg = {
      initialCash: config.initialCash ?? 100_000,
      symbols: config.symbols ?? [], // <-- always an array (no undefined)
      commission: config.commission ?? ((val) => Math.max(0, Math.abs(val)) * 0.0005),
      slippage:
        config.slippage ??
        ((theo, side) => (side === "BUY" ? +0.5 : -0.5) * 0.0002 * theo),
      priceOf:
        config.priceOf ??
        ((ev) => {
          if (isBar(ev)) return ev.bar.c;
          if (isTick(ev)) return ev.tick.p;
          return NaN;
        }),
      allowShort: config.allowShort ?? true,
      rngSeed: config.rngSeed ?? 42,
      maxLeverage: config.maxLeverage ?? Infinity,
    };
    this.cashBal = this.cfg.initialCash;

    // deterministic RNG (LCG)
    let s = (this.cfg.rngSeed >>> 0) || 1;
    this.rnd = () => (s = (1664525 * s + 1013904223) >>> 0) / 2 ** 32;
  }

  /* ------------------------------ Public API ----------------------------- */

  ctx: StrategyContext = {
    now: () => this._now,
    cash: () => this.cashBal,
    equity: () => this.markToMarket(),
    position: (sym) => this.positionsMap[sym],
    positions: () => this.positionsMap,
    submit: (o) => this.placeOrder(o),
    cancel: (id) => this.cancelOrder(id),
    cancelAll: (sym) => this.cancelAll(sym),
    log: (m, e) => console.log(`[BT ${new Date(this._now).toISOString()}] ${m}`, e ?? ""),
  };

  async run(feed: AsyncIterable<FeedEvent> | Iterable<FeedEvent>): Promise<RunResult> {
    if (this.strat.onInit) await this.strat.onInit(this.ctx);

    for await (const ev of (feed as any)) {
      // symbol filtering: empty array means "no filter"
      if (this.cfg.symbols.length && isSym(ev) && !this.cfg.symbols.includes(getSym(ev))) {
        continue;
      }

      this._now = getTs(ev);

      this.match(ev);

      if (isBar(ev) && this.strat.onBar) await this.strat.onBar(this.ctx, ev.bar);
      if (isTick(ev) && this.strat.onTick) await this.strat.onTick(this.ctx, ev.tick);

      this.pushSnapshot();
    }

    if (this.strat.onClose) await this.strat.onClose(this.ctx);

    return {
      fills: this.fillsArr,
      equityCurve: this.equityCurveArr,
      orders: Array.from(this.openOrders.values()),
      positions: this.positionsMap,
      metrics: computeMetrics(this.equityCurveArr.map((s) => s.nav)),
    };
  }

  /* -------------------------------- Orders ------------------------------- */

  private placeOrder(o: Omit<Order, "id" | "ts">): string {
    const id = `ord_${(++this.idSeq).toString(36)}`;
    const ord: Order = { ...o, id, ts: this._now, tif: o.tif ?? "GTC" };
    this.openOrders.set(id, ord);
    return id;
  }

  private cancelOrder(id: string): boolean {
    return this.openOrders.delete(id);
  }

  private cancelAll(symbol?: string) {
    if (!symbol) {
      this.openOrders.clear();
      return;
    }
    for (const [id, o] of this.openOrders) if (o.symbol === symbol) this.openOrders.delete(id);
  }

  /* ------------------------------- Matching ------------------------------ */

  private match(ev: FeedEvent) {
    if (this.openOrders.size === 0) return;
    const theo = this.cfg.priceOf(ev, "BUY");

    for (const [id, o] of Array.from(this.openOrders)) {
      if (isSym(ev) && o.symbol !== getSym(ev)) continue;

      let hit = false;
      let execPrice = theo;

      if (o.type === "MARKET") {
        hit = true;
        execPrice = theo;
      } else if (isBar(ev)) {
        const b = ev.bar;
        if (o.type === "LIMIT" && o.limitPrice != null) {
          if (o.side === "BUY" && b.l <= o.limitPrice) { hit = true; execPrice = Math.min(o.limitPrice, b.o); }
          if (o.side === "SELL" && b.h >= o.limitPrice) { hit = true; execPrice = Math.max(o.limitPrice, b.o); }
        } else if (o.type === "STOP" && o.stopPrice != null) {
          if (o.side === "BUY" && b.h >= o.stopPrice) { hit = true; execPrice = Math.max(b.o, o.stopPrice); }
          if (o.side === "SELL" && b.l <= o.stopPrice) { hit = true; execPrice = Math.min(b.o, o.stopPrice); }
        }
      } else if (isTick(ev)) {
        const p = ev.tick.p;
        if (o.type === "LIMIT" && o.limitPrice != null) {
          if (o.side === "BUY" ? p <= o.limitPrice : p >= o.limitPrice) { hit = true; execPrice = o.limitPrice; }
        } else if (o.type === "STOP" && o.stopPrice != null) {
          if (o.side === "BUY" ? p >= o.stopPrice : p <= o.stopPrice) { hit = true; execPrice = o.stopPrice; }
        }
      }

      // leverage gate (pre-fill)
      if (hit && Number.isFinite(this.cfg.maxLeverage) && this.cfg.maxLeverage < Infinity) {
        const notional = Math.abs(execPrice * o.qty);
        const equity = this.markToMarket();
        const levAfter = (this.grossNotional() + notional) / Math.max(1e-9, equity);
        if (levAfter > this.cfg.maxLeverage) hit = false;
      }

      if (!hit) continue;

      const slip = this.cfg.slippage(execPrice, o.side, ev, this.rnd);
      const fillPrice = execPrice + slip;
      const signedQty = o.side === "BUY" ? Math.abs(o.qty) : -Math.abs(o.qty);
      const fee = this.cfg.commission(fillPrice * Math.abs(signedQty), {
        orderId: id, symbol: o.symbol, qty: signedQty, price: fillPrice, ts: this._now, fee: 0, slippage: slip, liquidity: "taker",
      } as Fill);

      this.applyFill({
        orderId: id,
        symbol: o.symbol,
        qty: signedQty,
        price: fillPrice,
        ts: this._now,
        fee,
        slippage: slip,
        liquidity: "taker",
      });

      // simple engine: assume fully filled
      this.openOrders.delete(id);
    }
  }

  private applyFill(f: Fill) {
    const pos = this.positionsMap[f.symbol] ?? { symbol: f.symbol, qty: 0, avgPrice: 0, realizedPnl: 0 };

    // cash
    this.cashBal -= f.qty * f.price + f.fee;

    const newQty = pos.qty + f.qty;

    if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(f.qty)) {
      // opening/increasing
      const notional = Math.abs(pos.qty * pos.avgPrice) + Math.abs(f.qty * f.price);
      const qty = Math.abs(pos.qty) + Math.abs(f.qty);
      pos.avgPrice = qty ? Math.sign(newQty) * (notional / qty) : 0;
      pos.qty = newQty;
    } else {
      // reducing/flip
      const closed = Math.min(Math.abs(pos.qty), Math.abs(f.qty));
      const pnl = closed * (f.price * Math.sign(f.qty) - pos.avgPrice * Math.sign(pos.qty));
      pos.realizedPnl += pnl;
      pos.qty = newQty;
      pos.avgPrice = pos.qty === 0 ? 0 : f.price * Math.sign(pos.qty);
    }

    this.positionsMap[f.symbol] = pos;
    this.fillsArr.push(f);
  }

  /* ------------------------------- Accounting ---------------------------- */

  private markToMarket(): number {
    let eq = this.cashBal;
    for (const pos of Object.values(this.positionsMap)) {
      const px = Math.abs(pos.qty) > 0 ? Math.abs(pos.avgPrice) : 0; // fallback
      eq += pos.qty * px;
    }
    return eq;
  }

  private grossNotional(): number {
    let n = 0;
    for (const p of Object.values(this.positionsMap)) n += Math.abs(p.qty * Math.abs(p.avgPrice));
    return n;
  }

  private pushSnapshot() {
    const nav = this.markToMarket();
    const prev = this.equityCurveArr[this.equityCurveArr.length - 1];
    const prevPeak = prev ? prev.nav - prev.drawdown : nav; // since drawdown = nav - peak
    const peak = Math.max(prevPeak, nav);
    const dd = nav - peak; // <= 0
    this.equityCurveArr.push({
      ts: this._now,
      cash: this.cashBal,
      equity: nav - this.cashBal,
      nav,
      drawdown: dd,
    });
  }
}

/* -------------------------------- Metrics -------------------------------- */

export type Metrics = {
  cagr?: number;
  sharpe?: number;
  sortino?: number;
  maxDD?: number;
};

export function computeMetrics(nav: number[], periodsPerYear = 252): Metrics {
  if (nav.length < 2) return {};
  const rets: number[] = [];
  for (let i = 1; i < nav.length; i++) {
    const r = (nav[i] - nav[i - 1]) / Math.max(1e-9, nav[i - 1]);
    rets.push(r);
  }
  const mean = avg(rets);
  const stdev = std(rets);
  const neg = rets.filter((x) => x < 0);
  const stdevNeg = std(neg.length ? neg : [0]);

  const years = rets.length / periodsPerYear;
  const cagr = years > 0 ? (nav[nav.length - 1] / nav[0]) ** (1 / years) - 1 : undefined;
  const sharpe = stdev > 0 ? (mean * Math.sqrt(periodsPerYear)) / stdev : undefined;
  const sortino = stdevNeg > 0 ? (mean * Math.sqrt(periodsPerYear)) / stdevNeg : undefined;

  const maxDD = maxDrawdown(nav);

  return { cagr, sharpe, sortino, maxDD };
}

/* --------------------------------- Utils -------------------------------- */

function isBar(ev: FeedEvent): ev is { type: "bar"; bar: Bar } {
  return ev.type === "bar";
}
function isTick(ev: FeedEvent): ev is { type: "tick"; tick: Tick } {
  return ev.type === "tick";
}
function isSym(ev: FeedEvent): boolean {
  if (isBar(ev)) return !!ev.bar.symbol;
  if (isTick(ev)) return !!ev.tick.symbol;
  return false;
}
function getSym(ev: FeedEvent): string {
  if (isBar(ev)) return ev.bar.symbol ?? "";
  if (isTick(ev)) return ev.tick.symbol ?? "";
  return "";
}
function getTs(ev: FeedEvent): number {
  const t = isBar(ev) ? ev.bar.t : isTick(ev) ? ev.tick.t : Date.now();
  return t instanceof Date ? t.getTime() : typeof t === "string" ? Date.parse(t) : (t as number);
}
function avg(a: number[]) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function std(a: number[]) {
  if (a.length <= 1) return 0;
  const m = avg(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function maxDrawdown(nav: number[]) {
  let peak = nav[0], maxDD = 0;
  for (const v of nav) { peak = Math.max(peak, v); maxDD = Math.min(maxDD, v - peak); }
  return maxDD;
}

/* --------------------------- Feed helper (demo) -------------------------- */
export async function* barsFeed(bars: Bar[]): AsyncGenerator<FeedEvent> {
  for (const bar of bars) yield { type: "bar", bar } as FeedEvent;
  return { type: "eof" } as FeedEvent;
}
// export async function* ticksFeed(ticks: Tick[]): AsyncGenerator<FeedEvent> {
//   for (const tick of ticks) yield { type: "tick", tick } as FeedEvent;
//   return { type: "eof" } as FeedEvent;
// }
// export async function* mixedFeed(events: FeedEvent[]): AsyncGenerator<FeedEvent> {
//   for (const ev of events) yield ev;
//   return { type: "eof" } as FeedEvent;
// }

/* -------------------------------- Rate Arb -------------------------------- */
// strategies/macro/rateArb.ts

export type RateArbMetrics = {
  annReturn: number;          // geometric annualized
  annVol: number;             // annualized volatility
  sharpe: number;             // annReturn / annVol (0 if annVol=0)
  maxDD: number;              // max drawdown (absolute, <= 0)
  calmar: number;             // -annReturn / maxDD (0 if maxDD=0)
  winRate: number;            // fraction of    winning trades  (0..1)
  avgWin: number;             // avg pct return of winning trades
  avgLoss: number;            // avg pct return of losing trades (negative)
  expectancy: number;         // winRate * avgWin + (1 - winRate) * avgLoss
};

/* ----------------- Carry signal ----------------- */

export type CarrySignal = {
  signal: number;             // -1..+1
  edge: number;               // unbounded
};

/* ----------------- Performance summary ----------------- */

export type CarryPerf = {
  totalReturn: number;        // geometric total return (nav[n]/nav[0] - 1)
  annReturn: number;          // annualized geometric return
  totalTrades: number;        // count of closed trades
  winRate: number;            // fraction of winning trades (0..1)
  avgWin: number;             // avg pct return of winning trades
  avgLoss: number;            // avg pct return of losing trades (negative)
  expectancy: number;         // winRate * avgWin + (1 - winRate) * avgLoss
  maxDD: number;              // max drawdown (absolute, <= 0)
  calmar: number;             // -annReturn / maxDD (0 if maxDD=0)
  annVol: number;             // annualized volatility of dailyStrategyRet
  sharpe: number;             // annReturn / annVol (0 if annVol=0)
};

/* ----------------- Full result ----------------- */

export type CarryResult = {
  perf: CarryPerf;
  metrics: RateArbMetrics;
  nav: number[];              // daily nav
  dailyMarketRet: number[];   // daily market return (e.g. spot)
  dailyCarryRet: number[];    // daily carry return (e.g. roll yield)
  dailyStrategyRet: number[]; // daily strategy return (based on signal)
  positions: number[];        // daily position (-1..+1)
  signals: CarrySignal[];     // daily signal
};

