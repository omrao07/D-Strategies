// engine/simulators.ts
// Lightweight simulators: clock, event bus, bar/tick replay, market micro-sim
// with slippage and latency, plus a GBM path generator. Zero deps.

export type Side = "buy" | "sell";
export type TIF = "GTC" | "IOC" | "FOK";

export type Quote = {
  symbol: string;
  bid?: number;
  ask?: number;
  last?: number;
  mid?: number;
  ts: number;
};

export type Bar = {
  symbol: string;
  ts: number | string;           // ISO or timestamp
  o: number; h: number; l: number; c: number;
  v?: number;
};

export type OrderReq = {
  id?: string;
  symbol: string;
  side: Side;
  type: "market" | "limit";
  qty: number;
  limit?: number;
  tif?: TIF;
};

export type Fill = {
  orderId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  fee?: number;
  ts: number;
};

export type BrokerLike = {
  onQuote: (symbol: string, q: Partial<Quote>) => void;
  submit: (req: OrderReq) => any;
  amend?: (id: string, patch: Partial<OrderReq>) => any;
  cancel?: (id: string) => any;
};

export type StrategyLike = {
  id: string;
  onStart?: (ctx: SimContext) => Promise<void> | void;
  onQuote?: (q: Quote, ctx: SimContext) => Promise<void> | void;
  onBar?: (b: Bar, ctx: SimContext) => Promise<void> | void;
  onEnd?: (ctx: SimContext) => Promise<void> | void;
};

export type SimContext = {
  clock: SimClock;
  broker: BrokerLike;
  bus: EventBus;
  state: Record<string, any>;
  submit: BrokerLike["submit"];
};

// ============================
// Event bus (tiny)
// ============================

export class EventBus {
  private map = new Map<string, Set<(p: any) => void>>();
  on<T = any>(ev: string, cb: (p: T) => void) {
    (this.map.get(ev) || this.map.set(ev, new Set()).get(ev)!)!.add(cb as any);
    return () => this.off(ev, cb as any);
  }
  off(ev: string, cb: (p: any) => void) { this.map.get(ev)?.delete(cb); }
  emit<T = any>(ev: string, p: T) { this.map.get(ev)?.forEach(fn => { try { fn(p); } catch{} }); }
}

// ============================
// Clock with controllable time/latency
// ============================

export class SimClock {
  private _now: number;
  private _latencyMs: number;
  constructor(start: number | string, latencyMs = 0) {
    this._now = typeof start === "string" ? new Date(start).getTime() : start;
    this._latencyMs = latencyMs;
  }
  now(): number { return this._now; }
  setLatency(ms: number) { this._latencyMs = Math.max(0, ms); }
  latency(): number { return this._latencyMs; }
  /** advance time to t (or by dt if `relative` true) */
  tick(toOrBy: number, relative = false) {
    this._now = relative ? this._now + toOrBy : toOrBy;
  }
  /** apply network/exchange latency */
  withLatency(ts?: number) { return (ts ?? this._now) + this._latencyMs; }
}

// ============================
// Slippage models
// ============================

export interface SlippageModel {
  /** Return execution price given ref price and order side. */
  execPx(ref: number, side: Side, context: { symbol: string; ts: number; qty: number }): number;
}

export class BpsSlippage implements SlippageModel {
  constructor(public bps = 0) {}
  execPx(ref: number, side: Side) {
    const m = (this.bps / 10_000);
    return side === "buy" ? ref * (1 + m) : ref * (1 - m);
  }
}

export class HalfSpreadPlusBps implements SlippageModel {
  constructor(public halfSpread: number, public bps = 0) {}
  execPx(ref: number, side: Side) {
    const base = side === "buy" ? ref + this.halfSpread : ref - this.halfSpread;
    const m = (this.bps / 10_000);
    return side === "buy" ? base * (1 + m) : base * (1 - m);
  }
}

// ============================
// QuoteBook (keeps latest quotes)
// ============================

export class QuoteBook {
  private quotes = new Map<string, Quote>();
  update(q: Quote) {
    const prev = this.quotes.get(q.symbol) || { symbol: q.symbol, ts: 0 };
    const merged: Quote = {
      ...prev,
      ...q,
      mid: q.mid ?? (isFiniteNum(q.bid) && isFiniteNum(q.ask) ? ((q.bid! + q.ask!) / 2) : prev.mid),
      ts: q.ts ?? Date.now(),
    };
    this.quotes.set(q.symbol, merged);
    return merged;
  }
  get(symbol: string): Quote | undefined { return this.quotes.get(symbol); }
}

const isFiniteNum = (x: any) => typeof x === "number" && Number.isFinite(x);

// ============================
// Market micro-simulator
// ============================

export type MarketSimConfig = {
  broker: BrokerLike;
  clock: SimClock;
  slippage?: SlippageModel;           // price impact model
  feeBps?: number;                    // informational; broker may handle fees itself
};

export class MarketSimulator {
  readonly book = new QuoteBook();
  readonly cfg: Required<MarketSimConfig>;
  constructor(cfg: MarketSimConfig) {
    this.cfg = {
      slippage: cfg.slippage ?? new BpsSlippage(0),
      feeBps: cfg.feeBps ?? 0,
      broker: cfg.broker,
      clock: cfg.clock,
    };
  }

  /** publish a quote to broker & book */
  publishQuote(q: Quote) {
    const merged = this.book.update(q);
    this.cfg.broker.onQuote(merged.symbol, merged);
  }

  /** helper for bar → quote ping (simple mid with +/- half spread) */
  publishFromBar(b: Bar, halfSpread = 0) {
    const ts = typeof b.ts === "string" ? new Date(b.ts).getTime() : b.ts;
    const mid = b.c;
    this.publishQuote({ symbol: b.symbol, bid: mid - halfSpread, ask: mid + halfSpread, last: b.c, mid, ts });
  }

  /** calculate an execution reference (mid or side-of-book) */
  private refPx(symbol: string, side: Side): number | undefined {
    const q = this.book.get(symbol);
    if (!q) return undefined;
    if (isFiniteNum(q.mid)) return q.mid!;
    if (side === "buy") return q.ask ?? q.last;
    return q.bid ?? q.last;
  }

  /** Simulate immediate execution (hands order to broker, using slippage model for pricing hints if your broker reads quotes). */
  execute(req: OrderReq): { price?: number } {
    const ref = this.refPx(req.symbol, req.side);
    if (!isFiniteNum(ref)) {
      // still submit; broker might queue until quote arrives
      return { price: undefined };
    }
    const px = this.cfg.slippage.execPx(ref!, req.side, { symbol: req.symbol, ts: this.cfg.clock.now(), qty: req.qty });
    // Many brokers ignore this hint; but since we feed quotes before submit, the quote carries enough info.
    // Submit order (broker decides fills). Your paper broker can use current quote to fill at `mid/side`.
    this.cfg.broker.submit({ ...req, limit: req.type === "limit" ? (req.limit ?? px) : req.limit });
    return { price: px };
  }
}

// ============================
// Bar/Tick replay (player)
// ============================

export type ReplaySource = AsyncIterable<Bar> | Iterable<Bar> | Bar[];

export type ReplayOptions = {
  halfSpread?: number;      // constant half-spread to synthesize bid/ask from close
  speed?: number;           // 0 = as fast as possible, >0 = ms between events (sim clock will advance)
  onProgress?: (i: number) => void;
};

export class BarPlayer {
  private src: ReplaySource;
  private sim: MarketSimulator;
  private opts: Required<ReplayOptions>;
  constructor(sim: MarketSimulator, src: ReplaySource, opts: ReplayOptions = {}) {
    this.sim = sim;
    this.src = src;
    this.opts = {
      halfSpread: opts.halfSpread ?? 0,
      speed: opts.speed ?? 0,     // 0 -> max speed
      onProgress: opts.onProgress ?? (() => {}),
    };
  }

  async run() {
    let i = 0;
    for await (const b of asAsync(this.src)) {
      const ts = typeof b.ts === "string" ? new Date(b.ts).getTime() : b.ts;
      this.sim.cfg.clock.tick(ts);                               // move sim time to bar ts
      this.sim.publishFromBar(b, this.opts.halfSpread);          // publish quote
      this.opts.onProgress(i++);
      if (this.opts.speed > 0) await sleep(this.opts.speed);
    }
  }
}

async function* asAsync<T>(src: AsyncIterable<T> | Iterable<T>) {
  if (isAsyncIterable(src)) { for await (const x of src) yield x; return; }
  for (const x of src as Iterable<T>) yield x;
}
function isAsyncIterable(x: any): x is AsyncIterable<any> {
  return x && typeof x[Symbol.asyncIterator] === "function";
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ============================
// Strategy harness (wire a StrategyLike to the replay)
// ============================

export class StrategyHarness {
  constructor(
    public strategy: StrategyLike,
    public sim: MarketSimulator,
    public bus: EventBus = new EventBus(),
  ) {}

  context(): SimContext {
    const { broker, clock } = this.sim.cfg;
    return {
      clock,
      broker,
      bus: this.bus,
      state: {},
      submit: broker.submit.bind(broker),
    };
  }

  async runBars(source: ReplaySource, opts: ReplayOptions = {}) {
    const ctx = this.context();
    await this.strategy.onStart?.(ctx);

    let i = 0;
    for await (const b of asAsync(source)) {
      const ts = typeof b.ts === "string" ? new Date(b.ts).getTime() : b.ts;
      this.sim.cfg.clock.tick(ts);
      this.sim.publishFromBar(b, opts.halfSpread ?? 0);

      await this.strategy.onBar?.({ ...b, ts }, ctx);

      // optional throttling
      if ((opts.speed ?? 0) > 0) await sleep(opts.speed!);
      opts.onProgress?.(i++);
    }

    await this.strategy.onEnd?.(ctx);
  }
}

// ============================
// Synthetic path generator (GBM)
// ============================

export type GBMParams = {
  s0: number;          // initial price
  mu: number;          // drift (annualized)
  sigma: number;       // vol (annualized)
  dtDays?: number;     // time step in days (default 1)
  days?: number;       // number of steps
  symbol: string;
  start: number | string; // start timestamp
};

export function* gbmBars(p: GBMParams): Generator<Bar> {
  const dtDays = p.dtDays ?? 1;
  const n = p.days ?? 252;
  const dt = dtDays / 252;                   // trading day year basis
  const start = typeof p.start === "string" ? new Date(p.start).getTime() : p.start;

  let s = p.s0;
  for (let i = 0; i < n; i++) {
    const eps = normal01();
    s = s * Math.exp((p.mu - 0.5 * p.sigma * p.sigma) * dt + p.sigma * Math.sqrt(dt) * eps);
    const ts = start + i * dtDays * 86_400_000;
    const o = s * (1 - 0.002), h = s * (1 + 0.004), l = s * (1 - 0.004), c = s;
    yield { symbol: p.symbol, ts, o, h, l, c, v: 1_000 };
  }
}

// Box–Muller normal
function normal01() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/* =========================
   Quick demo (optional)
   ========================= */

if (import.meta.url === `file://${process.argv[1]}`) {
  // Minimal “broker” adapter: forwards quotes to console and stores last quote
  const lastQuote = new Map<string, Quote>();
  const broker: BrokerLike = {
    onQuote: (_symbol, q) => {
      const full = { symbol: (q as any).symbol, ...q } as any;
      lastQuote.set(full.symbol, full);
    },
    submit: (req) => { console.log("SUBMIT", req); return req; },
  };

  const clock = new SimClock(Date.now(), 5);
  const sim = new MarketSimulator({ broker, clock, slippage: new HalfSpreadPlusBps(0.01, 1) });

  // Generate synthetic path and replay as bars
  const series = [...gbmBars({ s0: 100, mu: 0.08, sigma: 0.2, days: 20, symbol: "DEMO", start: Date.now() })];

  // Strategy that buys first bar and sells last
  const strat: StrategyLike = {
    id: "toy",
    async onStart(ctx) { console.log("start @", new Date(ctx.clock.now()).toISOString()); },
    async onBar(b, ctx) {
      if ((b as any)._did) return;
      if (b === series[0]) ctx.submit({ symbol: "DEMO", side: "buy", type: "market", qty: 1 });
      if (b === series.at(-1)) ctx.submit({ symbol: "DEMO", side: "sell", type: "market", qty: 1 });
    },
    async onEnd() { console.log("done"); },
  };

  const harness = new StrategyHarness(strat, sim);
  harness.runBars(series, { halfSpread: 0.01, speed: 0 }).then(() => {
    console.log("replay complete");
  });
}