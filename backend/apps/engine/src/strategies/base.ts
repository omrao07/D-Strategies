// strategies/base.ts
// Pure TypeScript backtesting base layer (strict-safe, no imports)

/* ============================== Types ============================== */

export type Side = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop";
export type TIF = "DAY" | "GTC";

export type Bar = {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type Series = Bar[];

export type Fill = {
  idx: number;
  price: number;
  qty: number; // signed
  fee: number;
  slippage: number;
};

export type Order = {
  id: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  limitPrice?: number;
  stopPrice?: number;
  tif: TIF;
  placedIdx: number;
  status: "open" | "filled" | "canceled" | "expired" | "rejected";
  fills: Fill[];
  note?: string;
};

export type Position = {
  symbol: string;
  qty: number;
  avgPrice: number;
  realizedPnl: number;
  lastIdx: number;
};

export type Trade = {
  symbol: string;
  entryIdx: number;
  exitIdx: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  ret: number;
};

export type Portfolio = {
  cash: number;
  equity: number;
  positions: Record<string, Position>;
};

export type RiskConfig = {
  maxGrossLeverage?: number;
  maxPositionWeight?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
};

export type StrategyOptions = {
  initialCash?: number;
  feeBps?: number;
  slippageBps?: number;
  allowShort?: boolean;
  risk?: RiskConfig;
  name?: string;
};

export type Summary = {
  cagr: number;
  vol: number;
  sharpe: number;
  maxDD: number;
  hitRate: number;
  avgTrade: number;
  nTrades: number;
};

export type RunReport = {
  equity: number[];
  returns: number[];
  orders: Order[];
  trades: Trade[];
  portfolio: Portfolio;
  logs: string[];
  symbols: string[];
  n: number;
  summary: Summary;
};

export type OrderInput = {
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  limitPrice?: number;
  stopPrice?: number;
  tif?: TIF;
  note?: string;
};

export type Ctx = {
  readonly name: string;
  readonly idx: number;
  readonly n: number;
  readonly now: number;
  price(symbol: string): number;
  bar(symbol: string, k?: number): Bar | undefined;
  hist(symbol: string, n: number): number[];
  equity(): number;
  cash(): number;
  pos(symbol: string): Position | undefined;
  mv(symbol?: string): number;
  place(o: OrderInput): string | null;
  cancel(id: string): boolean;
  targetWeight(symbol: string, w: number): string | null;
  flat(symbol: string): string | null;
  note(msg: string): void;
  config: Readonly<Required<StrategyOptions>>;
};

type EngineState = {
  opt: Required<StrategyOptions>;
  bars: Record<string, Series>;
  symbols: string[];
  idx: number;
  n: number;
  portfolio: Portfolio;
  orders: Order[];
  trades: Trade[];
  logs: string[];
  uid: number;
};

/* ============================ Base Class ============================ */

export default abstract class StrategyBase {
  protected state!: EngineState;

  constructor(protected readonly options: StrategyOptions = {}) { }

  protected onInit(_ctx: Ctx): void { }
  protected onBar(_ctx: Ctx): void { }
  protected onEnd(_ctx: Ctx): void { }

  run(data: Record<string, Series>): RunReport {
    const symbols = Object.keys(data).sort();
    if (!symbols.length) throw new Error("No symbols");

    const n = Math.min(...symbols.map((s) => data[s].length));

    const opt: Required<StrategyOptions> = {
      initialCash: this.options.initialCash ?? 100_000,
      feeBps: this.options.feeBps ?? 1,
      slippageBps: this.options.slippageBps ?? 0,
      allowShort: this.options.allowShort ?? true,
      risk: {
        maxGrossLeverage: this.options.risk?.maxGrossLeverage ?? 1,
        maxPositionWeight: this.options.risk?.maxPositionWeight ?? 1,
        stopLossPct: this.options.risk?.stopLossPct,
        takeProfitPct: this.options.risk?.takeProfitPct,
      },
      name: this.options.name ?? this.constructor.name,
    };

    this.state = {
      opt,
      bars: data,
      symbols,
      idx: 0,
      n,
      portfolio: { cash: opt.initialCash, equity: opt.initialCash, positions: {} },
      orders: [],
      trades: [],
      logs: [],
      uid: 1,
    };

    const equity: number[] = Array(n).fill(opt.initialCash);
    const returns: number[] = Array(n).fill(0);

    this.onInit(this.ctx());

    for (let i = 0; i < n; i++) {
      this.state.idx = i;

      this.expireDayOrders(i);
      this.onBar(this.ctx());
      this.matchOrders(i);
      this.applyStops(i);

      equity[i] = this.markToMarket(i);
      if (i > 0) returns[i] = equity[i] / equity[i - 1] - 1;
    }

    this.onEnd(this.ctx());

    return {
      equity,
      returns,
      orders: this.state.orders.slice(),
      trades: this.state.trades.slice(),
      portfolio: clonePortfolio(this.state.portfolio),
      logs: this.state.logs.slice(),
      symbols,
      n,
      summary: summarize(equity, returns, this.state.trades),
    };
  }

  /* ============================ Context ============================ */

  private ctx(): Ctx {
    const st = this.state;
    const first = st.symbols[0];

    return {
      name: st.opt.name,
      idx: st.idx,
      n: st.n,
      now: st.bars[first][st.idx].t,
      price: (s) => st.bars[s]?.[st.idx]?.close ?? NaN,
      bar: (s, k = 0) => st.bars[s]?.[st.idx + k],
      hist: (s, n) => {
        const out: number[] = [];
        for (let i = Math.max(0, st.idx - n + 1); i <= st.idx; i++) {
          out.push(st.bars[s][i].close);
        }
        return out;
      },
      equity: () => st.portfolio.equity,
      cash: () => st.portfolio.cash,
      pos: (s) => st.portfolio.positions[s],
      mv: (s) => marketValue(st, s),
      place: (o) => this.placeOrder(o),
      cancel: (id) => this.cancelOrder(id),
      targetWeight: (s, w) => this.placeTargetWeight(s, w),
      flat: (s) => this.placeTargetWeight(s, 0),
      note: (m) => st.logs.push(`[${fmtTs(st.bars[first][st.idx].t)}] ${m}`),
      config: st.opt,
    };
  }

  /* ============================ Orders ============================ */

  private placeTargetWeight(symbol: string, w: number): string | null {
    const st = this.state;
    const px = this.ctx().price(symbol);
    if (!Number.isFinite(px)) return null;

    const maxW = st.opt.risk.maxPositionWeight ?? 1;
    const equity = st.portfolio.equity;

    const targetMV = clamp(-maxW, maxW, w) * equity;
    const curQty = st.portfolio.positions[symbol]?.qty ?? 0;
    const diffMV = targetMV - curQty * px;
    const qty = Math.floor(diffMV / px);

    if (qty === 0) return null;

    return this.placeOrder({
      symbol,
      side: qty > 0 ? "buy" : "sell",
      type: "market",
      qty: Math.abs(qty),
      note: `targetWeight=${w.toFixed(3)}`,
    });
  }

  private placeOrder(o: OrderInput): string | null {
    const st = this.state;
    if (o.qty <= 0) return null;

    if (!this.passesRisk(o)) {
      st.logs.push(`risk_reject ${o.symbol}`);
      return null;
    }

    const id = this.uid();
    st.orders.push({
      id,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      qty: Math.floor(o.qty),
      limitPrice: o.limitPrice,
      stopPrice: o.stopPrice,
      tif: o.tif ?? "DAY",
      placedIdx: st.idx,
      status: "open",
      fills: [],
      note: o.note,
    });
    return id;
  }

  private cancelOrder(id: string): boolean {
    const o = this.state.orders.find((x) => x.id === id && x.status === "open");
    if (!o) return false;
    o.status = "canceled";
    return true;
  }

  /* ============================ Matching ============================ */

  private matchOrders(i: number) {
    const st = this.state;

    for (const o of st.orders) {
      if (o.status !== "open" || o.placedIdx === i) continue;

      const b = st.bars[o.symbol][i];
      const px = executionPrice(o, b, st.opt.slippageBps);
      if (px == null) continue;

      const signedQty = (o.side === "buy" ? 1 : -1) * o.qty;
      const fee = Math.abs(px * o.qty) * st.opt.feeBps * 1e-4;

      o.fills.push({
        idx: i,
        price: px,
        qty: signedQty,
        fee,
        slippage: Math.abs(px - b.open),
      });
      o.status = "filled";

      this.applyFill(o.symbol, signedQty, px, fee, i);
    }
  }

  private expireDayOrders(i: number) {
    for (const o of this.state.orders) {
      if (o.status === "open" && o.tif === "DAY" && o.placedIdx < i) {
        o.status = "expired";
      }
    }
  }

  /* ============================ Portfolio ============================ */

  private applyFill(symbol: string, signedQty: number, px: number, fee: number, i: number) {
    const st = this.state;
    st.portfolio.cash -= signedQty * px + fee;

    const p =
      st.portfolio.positions[symbol] ??
      (st.portfolio.positions[symbol] = {
        symbol,
        qty: 0,
        avgPrice: 0,
        realizedPnl: 0,
        lastIdx: i,
      });

    if (Math.sign(p.qty) === Math.sign(signedQty) || p.qty === 0) {
      const newQty = p.qty + signedQty;
      const cost = p.avgPrice * Math.abs(p.qty) + px * Math.abs(signedQty);
      p.qty = newQty;
      p.avgPrice = newQty !== 0 ? cost / Math.abs(newQty) : 0;
    } else {
      const closing = Math.min(Math.abs(p.qty), Math.abs(signedQty));
      const pnl = (px - p.avgPrice) * closing * Math.sign(p.qty);
      p.realizedPnl += pnl;
      p.qty += signedQty;
      if (p.qty === 0) p.avgPrice = 0;
    }

    p.lastIdx = i;
  }

  private markToMarket(i: number): number {
    let mv = 0;
    for (const s of Object.keys(this.state.portfolio.positions)) {
      const p = this.state.portfolio.positions[s];
      mv += p.qty * this.state.bars[s][i].close;
    }
    this.state.portfolio.equity = this.state.portfolio.cash + mv;
    return this.state.portfolio.equity;
  }

  /* ============================ Risk ============================ */

  private passesRisk(o: OrderInput): boolean {
    const st = this.state;
    const px = o.limitPrice ?? this.ctx().price(o.symbol);
    if (!Number.isFinite(px)) return false;

    const equity = st.portfolio.equity;
    const posQty = st.portfolio.positions[o.symbol]?.qty ?? 0;
    const nextQty = posQty + (o.side === "buy" ? o.qty : -o.qty);

    if (!st.opt.allowShort && nextQty < 0) return false;

    const maxPosW = st.opt.risk.maxPositionWeight ?? 1;
    const nextMV = Math.abs(nextQty * px);
    if (equity > 0 && nextMV / equity > maxPosW) return false;

    const maxGross = st.opt.risk.maxGrossLeverage ?? 1;
    let gross = nextMV;

    for (const s of Object.keys(st.portfolio.positions)) {
      if (s === o.symbol) continue;
      const p = st.portfolio.positions[s];
      const ps = this.ctx().price(s);
      if (Number.isFinite(ps)) gross += Math.abs(p.qty * ps);
    }

    if (equity > 0 && gross / equity > maxGross) return false;

    return true;
  }

  private applyStops(i: number) {
    const st = this.state;
    const stop = st.opt.risk.stopLossPct;
    const take = st.opt.risk.takeProfitPct;

    if (stop == null && take == null) return;

    for (const s of Object.keys(st.portfolio.positions)) {
      const p = st.portfolio.positions[s];
      if (!p.qty) continue;

      const px = st.bars[s][i].close;
      const ret = p.qty > 0 ? px / p.avgPrice - 1 : p.avgPrice / px - 1;

      if ((stop != null && ret <= -Math.abs(stop)) || (take != null && ret >= Math.abs(take))) {
        this.placeOrder({
          symbol: s,
          side: p.qty > 0 ? "sell" : "buy",
          type: "market",
          qty: Math.abs(p.qty),
          note: "risk-exit",
        });
      }
    }
  }

  private uid() {
    return `${this.state.opt.name}_${this.state.uid++}`;
  }
}

/* ============================ Helpers ============================ */

function executionPrice(o: Order, b: Bar, slipBps: number): number | null {
  const slip = (p: number) => p * (1 + (o.side === "buy" ? 1 : -1) * slipBps * 1e-4);
  if (o.type === "market") return slip(b.open);

  if (o.type === "limit") {
    if (o.side === "buy" && b.low <= (o.limitPrice ?? -Infinity)) return slip(Math.min(b.open, o.limitPrice!));
    if (o.side === "sell" && b.high >= (o.limitPrice ?? Infinity)) return slip(Math.max(b.open, o.limitPrice!));
  }

  if (o.type === "stop") {
    if (o.side === "buy" && b.high >= (o.stopPrice ?? Infinity)) return slip(Math.max(b.open, o.stopPrice!));
    if (o.side === "sell" && b.low <= (o.stopPrice ?? -Infinity)) return slip(Math.min(b.open, o.stopPrice!));
  }
  return null;
}

function marketValue(st: EngineState, sym?: string): number {
  if (sym) {
    const p = st.portfolio.positions[sym];
    return p ? p.qty * st.bars[sym][st.idx].close : 0;
  }
  let sum = 0;
  for (const s of Object.keys(st.portfolio.positions)) {
    sum += Math.abs(st.portfolio.positions[s].qty * st.bars[s][st.idx].close);
  }
  return sum;
}

function summarize(eq: number[], rets: number[], trades: Trade[]): Summary {
  const daily = rets.slice(1).filter(Number.isFinite);
  const m = mean(daily);
  const sd = stdev(daily, m);
  return {
    cagr: eq.length > 1 ? Math.pow(eq[eq.length - 1] / eq[0], 252 / Math.max(1, eq.length - 1)) - 1 : 0,
    vol: sd * Math.sqrt(252),
    sharpe: sd > 0 ? (m * 252) / (sd * Math.sqrt(252)) : 0,
    maxDD: maxDrawdown(eq),
    hitRate: trades.length ? trades.filter((t) => t.pnl > 0).length / trades.length : 0,
    avgTrade: trades.length ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length : 0,
    nTrades: trades.length,
  };
}

function clonePortfolio(p: Portfolio): Portfolio {
  const out: Portfolio = { cash: p.cash, equity: p.equity, positions: {} };
  for (const k of Object.keys(p.positions)) out.positions[k] = { ...p.positions[k] };
  return out;
}

function mean(a: number[]) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
function stdev(a: number[], m: number) {
  if (a.length < 2) return 0;
  let s = 0;
  for (const x of a) s += (x - m) ** 2;
  return Math.sqrt(s / (a.length - 1));
}
function maxDrawdown(eq: number[]) {
  let peak = eq[0] ?? 1;
  let max = 0;
  for (const v of eq) {
    peak = Math.max(peak, v);
    max = Math.max(max, 1 - v / peak);
  }
  return max;
}
function clamp(lo: number, hi: number, x: number) {
  return Math.max(lo, Math.min(hi, x));
}
function fmtTs(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}