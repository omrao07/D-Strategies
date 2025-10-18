// engine/risk-hooks.ts
// Composable risk hooks for strategies & broker submits. Zero deps, NodeNext/ESM ready.

/* =========================
   Minimal shared types
   ========================= */

export type Side = "buy" | "sell";
export type TIF = "GTC" | "IOC" | "FOK";

export type OrderReq = {
  id?: string;
  symbol: string;
  side: Side;
  type: "market" | "limit";
  qty: number;
  limit?: number;
  tif?: TIF;
};

export type Quote = {
  symbol: string;
  bid?: number;
  ask?: number;
  last?: number;
  mid?: number;
  ts: number;
};

export type Position = {
  symbol: string;
  qty: number;     // signed
  avgPx: number;
  unrealizedPnl?: number;
};

export type Account = {
  id: string;
  cash: number;
  equity: number;
  buyingPower: number;
  realizedPnl: number;
  positions: Record<string, Position>;
};

export type BrokerLike = {
  submit: (req: OrderReq) => any;
  onQuote?: (symbol: string, q: Partial<Quote>) => void;
  getAccount?: () => Account;
};

export type QuoteBook = {
  get: (symbol: string) => Quote | undefined;
};

/* =========================
   Risk hook contracts
   ========================= */

export type RiskDecision =
  | { allow: true; amend?: Partial<OrderReq> }     // proceed (optionally patch the order)
  | { allow: false; reason: string; cooldownMs?: number }; // block & optional global cooldown

export type RiskCtx = {
  now: () => number;
  account: () => Account | undefined;
  priceOf: (symbol: string, side?: Side) => number | undefined; // best guess exec ref
  state: Record<string, any>; // per-strategy mutable store (in-memory)
};

export type RiskHook = {
  /** Called right before submit; return a decision. */
  beforeSubmit: (order: OrderReq, ctx: RiskCtx) => RiskDecision | Promise<RiskDecision>;
  /** Optional: receive quote updates (for vol, returns, etc.) */
  onQuote?: (q: Quote, ctx: RiskCtx) => void;
  /** Optional: called on allowed/blocked outcomes for logging/metrics. */
  onResult?: (order: OrderReq, decision: RiskDecision, ctx: RiskCtx) => void;
};

export type RiskManager = {
  guardSubmit: (order: OrderReq) => Promise<RiskDecision>;
  onQuote: (q: Quote) => void;
  hooks: RiskHook[];
  ctx: RiskCtx;
};

/* =========================
   Utilities
   ========================= */

const num = (x: any, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);
const abs = Math.abs;

function refPxFromQuote(q?: Quote, side?: Side): number | undefined {
  if (!q) return undefined;
  if (Number.isFinite(q.mid!)) return q.mid!;
  if (side === "buy") return q.ask ?? q.last;
  if (side === "sell") return q.bid ?? q.last;
  return q.last ?? q.bid ?? q.ask ?? q.mid;
}

function todayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${(d.getUTCMonth() + 1 + "").padStart(2, "0")}-${(d.getUTCDate() + "").padStart(2, "0")}`;
}

/* =========================
   Hook factory: compose
   ========================= */

export function composeRiskHooks(hooks: RiskHook[], ctx: RiskCtx): RiskManager {
  async function guardSubmit(order: OrderReq): Promise<RiskDecision> {
    for (const h of hooks) {
      const res = await h.beforeSubmit(order, ctx);
      h.onResult?.(order, res, ctx);
      if (!res.allow) return res;
      if (res.allow && res.amend) order = { ...order, ...res.amend };
    }
    return { allow: true };
  }
  function onQuote(q: Quote) {
    for (const h of hooks) h.onQuote?.(q, ctx);
  }
  return { guardSubmit, onQuote, hooks, ctx };
}

/* =========================
   Common hook implementations
   ========================= */

/** Cap absolute position size per symbol and/or order qty. */
export function limitMaxQty(options: {
  maxOrderQty?: number;
  maxPosQty?: number;                         // cap on |currentPos + orderQty|
}): RiskHook {
  return {
    async beforeSubmit(o, ctx) {
      if (options.maxOrderQty && o.qty > options.maxOrderQty) {
        return { allow: false, reason: `qty>${options.maxOrderQty}` };
      }
      if (options.maxPosQty && ctx.account) {
        const acct = ctx.account();
        const cur = acct?.positions?.[o.symbol]?.qty ?? 0;
        const next = cur + (o.side === "buy" ? +o.qty : -o.qty);
        if (abs(next) > options.maxPosQty) {
          return { allow: false, reason: `pos>${options.maxPosQty}` };
        }
      }
      return { allow: true };
    },
  };
}

/** Notional exposure limits (per order and/or total). */
export function limitNotional(options: {
  maxOrderNotional?: number;
  maxTotalNotional?: number;                  // sum over |qty * refPx| across positions
}): RiskHook {
  return {
    async beforeSubmit(o, ctx) {
      const px = ctx.priceOf(o.symbol, o.side);
      if (!Number.isFinite(px)) return { allow: false, reason: "no price" };
      const ordNotional = abs(px! * o.qty);
      if (options.maxOrderNotional && ordNotional > options.maxOrderNotional) {
        return { allow: false, reason: `notional>${options.maxOrderNotional}` };
      }
      if (options.maxTotalNotional && ctx.account) {
        const acct = ctx.account();
        let tot = 0;
        if (acct) {
          for (const p of Object.values(acct.positions || {})) {
            const ppx = ctx.priceOf(p.symbol, p.qty >= 0 ? "sell" : "buy") ?? p.avgPx;
            tot += abs(ppx * p.qty);
          }
        }
        const nextTot = tot + ordNotional;
        if (nextTot > options.maxTotalNotional) {
          return { allow: false, reason: `totalNotional>${options.maxTotalNotional}` };
        }
      }
      return { allow: true };
    },
  };
}

/** Daily loss guard relative to start-of-day equity. */
export function limitDailyLoss(options: {
  maxDraw?: number;     // e.g., 0.02 for -2% daily drop OR absolute if abs=true
  abs?: boolean;        // treat maxDraw as absolute currency if true
  coolDownMs?: number;  // optional cool-down after breach
}): RiskHook {
  return {
    async beforeSubmit(_o, ctx) {
      const acct = ctx.account?.();
      if (!acct) return { allow: true };
      const ts = ctx.now();
      const key = `dailyLoss:${acct.id}:${todayKey(ts)}`;
      const store = (ctx.state[key] ??= { baseline: acct.equity }); // set once per day
      const base = num(store.baseline, acct.equity);
      const drop = base - acct.equity;
      const breached = options.abs ? drop > (options.maxDraw ?? Infinity)
        : drop / base > (options.maxDraw ?? 1e9);
      if (breached) {
        return { allow: false, reason: "daily-loss-limit", cooldownMs: options.coolDownMs };
      }
      return { allow: true };
    },
  };
}

/** Peak-to-trough drawdown guard across run. */
export function limitRunDrawdown(options: {
  maxDD: number;        // e.g., 0.1 = 10%
  coolDownMs?: number;
}): RiskHook {
  return {
    async beforeSubmit(_o, ctx) {
      const acct = ctx.account?.();
      if (!acct) return { allow: true };
      const key = `runDD:${acct.id}`;
      const store = (ctx.state[key] ??= { peak: acct.equity });
      store.peak = Math.max(store.peak, acct.equity);
      const dd = store.peak > 0 ? (store.peak - acct.equity) / store.peak : 0;
      if (dd > options.maxDD) {
        return { allow: false, reason: "run-dd-limit", cooldownMs: options.coolDownMs };
      }
      return { allow: true };
    },
  };
}

/** Simple order rate limiter (token bucket). */
export function throttleOrders(options: {
  perMinute: number;     // allowed rate
  burst?: number;        // bucket size (default = perMinute)
}): RiskHook {
  const bucket = {
    tokens: options.burst ?? options.perMinute,
    lastTs: 0,
  };
  return {
    async beforeSubmit(_o, ctx) {
      const now = ctx.now();
      // refill
      const elapsedMin = (now - bucket.lastTs) / 60_000;
      const refill = elapsedMin * options.perMinute;
      bucket.tokens = Math.min(options.burst ?? options.perMinute, bucket.tokens + refill);
      bucket.lastTs = now;
      if (bucket.tokens < 1) {
        return { allow: false, reason: "rate-limit" };
      }
      bucket.tokens -= 1;
      return { allow: true };
    },
  };
}

/** Volatility halt using rolling std of returns vs threshold. */
export function haltOnVolatility(options: {
  window: number;          // number of returns points
  stdThreshold: number;    // e.g., 0.05 (5% dailyized) or raw returns unit
  annualize?: boolean;     // if true, multiply by sqrt(252) for daily bars
}): RiskHook {
  const retsBySym = new Map<string, number[]>();
  function pushRet(sym: string, r: number) {
    const v = retsBySym.get(sym) ?? [];
    v.push(r); if (v.length > options.window) v.shift();
    retsBySym.set(sym, v);
  }
  function stdev(a: number[]) {
    if (a.length < 2) return 0;
    const m = a.reduce((s, x) => s + x, 0) / a.length;
    const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
    return Math.sqrt(v);
  }
  return {
    onQuote(q, _ctx) {
      const last = q.last ?? q.mid ?? ((q.ask ?? 0) + (q.bid ?? 0)) / 2;
      const key = `__lastPx:${q.symbol}`;
      // @ts-ignore using internal state on this hook instance
      const s = (this as any);
      const prev = s[key]; s[key] = last;
      if (Number.isFinite(prev) && Number.isFinite(last)) {
        const r = last / prev - 1;
        pushRet(q.symbol, r);
      }
    },
    async beforeSubmit(o, _ctx) {
      const arr = retsBySym.get(o.symbol) ?? [];
      if (arr.length < options.window) return { allow: true };
      const sd = stdev(arr) * (options.annualize ? Math.sqrt(252) : 1);
      if (sd > options.stdThreshold) return { allow: false, reason: "vol-halt" };
      return { allow: true };
    },
  };
}

/** Global cool-down after any block, or on demand. */
export function cooldown(options: { ms: number }): RiskHook {
  const state = { until: 0 };
  return {
    async beforeSubmit(_o, ctx) {
      const now = ctx.now();
      if (now < state.until) return { allow: false, reason: "cooldown" };
      return { allow: true };
    },
    onResult(_o, res, ctx) {
      if (!res.allow) {
        const extra = res.cooldownMs ?? options.ms;
        state.until = Math.max(state.until, ctx.now() + extra);
      }
    },
  };
}

/* =========================
   Risk manager helpers
   ========================= */

/** Create a default RiskCtx with provided account getter & quote book. */
export function makeRiskCtx(args: {
  account?: () => Account | undefined;
  book?: QuoteBook;
  clock?: () => number;
  state?: Record<string, any>;
}): RiskCtx {
  const state = args.state ?? {};
  return {
    now: () => (args.clock ? args.clock() : Date.now()),
    account: () => args.account?.(),
    priceOf: (sym: string, side?: Side) => refPxFromQuote(args.book?.get(sym), side),
    state,
  };
}

/** Wrap a broker’s submit() with risk checks. Returns a guarded view. */
export function attachRiskToBroker(broker: BrokerLike, manager: RiskManager): BrokerLike {
  return {
    ...broker,
    submit: async (req: OrderReq) => {
      const decision = await manager.guardSubmit({ ...req });
      if (!decision.allow) {
        // bubble a structured rejection
        const err: any = new Error(decision.reason || "risk-blocked");
        err.code = "RISK_BLOCKED";
        err.reason = decision.reason;
        err.cooldownMs = decision.cooldownMs;
        throw err;
      }
      const patched = decision.amend ? { ...req, ...decision.amend } : req;
      return broker.submit(patched);
    },
    onQuote: (symbol: string, q: Partial<Quote>) => {
      // forward to original broker
      broker.onQuote?.(symbol, q);
      // try to build full quote for hook listeners if possible
      const full: Quote = {
        symbol,
        bid: q.bid,
        ask: q.ask,
        last: q.last,
        mid: q.mid ?? (Number.isFinite(q.bid!) && Number.isFinite(q.ask!) ? ((q.bid! + q.ask!) / 2) : undefined),
        ts: (q as any).ts ?? Date.now(),
      };
      manager.onQuote(full);
    },
    getAccount: broker.getAccount?.bind(broker),
  };
}

/* =========================
   Example (optional)
   ========================= */

if (import.meta.url === `file://${process.argv[1]}`) {
  // Tiny mock broker
  const broker: BrokerLike = {
    submit: (o) => (console.log("ORDER OK:", o), o),
    onQuote: () => {},
    getAccount: () => ({
      id: "acc1",
      cash: 100_000,
      equity: 100_000,
      buyingPower: 100_000,
      realizedPnl: 0,
      positions: { AAPL: { symbol: "AAPL", qty: 0, avgPx: 100 } },
    }),
  };

  // Minimal quote book
  const book: QuoteBook = {
    get: (sym) => ({ symbol: sym, bid: 99.9, ask: 100.1, last: 100, mid: 100, ts: Date.now() }),
  };

  // Build manager
  const manager = composeRiskHooks(
    [
      limitMaxQty({ maxOrderQty: 1_000, maxPosQty: 2_000 }),
      limitNotional({ maxOrderNotional: 200_000, maxTotalNotional: 500_000 }),
      limitDailyLoss({ maxDraw: 0.02, abs: false, coolDownMs: 60_000 }),
      limitRunDrawdown({ maxDD: 0.1, coolDownMs: 300_000 }),
      throttleOrders({ perMinute: 60, burst: 60 }),
      haltOnVolatility({ window: 20, stdThreshold: 0.5, annualize: true }),
      cooldown({ ms: 5_000 }),
    ],
    makeRiskCtx({ account: broker.getAccount, book, clock: () => Date.now() })
  );

  // Guard broker
  const guarded = attachRiskToBroker(broker, manager);

  // Feed a quote (for vol hook)
  guarded.onQuote?.("AAPL", { bid: 100, ask: 100.2, last: 100.1, ts: Date.now() });

  // Try order
  guarded.submit({ symbol: "AAPL", side: "buy", type: "market", qty: 10 })
    .catch((e: any) => console.error("BLOCKED:", e.reason));
}