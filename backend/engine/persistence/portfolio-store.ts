// engine/portfolio/store.ts
// Minimal portfolio state store with events + optional persistence.
// ESM/NodeNext friendly. No external deps.

export type Position = {
  symbol: string;
  qty: number;          // signed quantity
  avgPrice?: number;    // average cost (in portfolio currency)
  price?: number;       // latest mark (optional; can be set ad hoc)
  sector?: string;
  meta?: Record<string, unknown>;
};

export type Portfolio = {
  currency?: string;
  cash: number;
  equity?: number;        // optional override; usually computed
  positions: Position[];
  updatedAt?: string;
};

export type Trade = {
  symbol: string;
  qty: number;            // signed (+ buy / - sell)
  price: number;          // execution price
  fees?: number;          // commissions/fees (positive number)
  ts?: string;
};

export type Prices = Record<string, number>;
export type Sectors = Record<string, string>;

export type StoreSnapshot = {
  portfolio: Portfolio;
  totals: {
    grossNotional: number;
    netNotional: number;
    equity: number;
    leverage?: number;
    netLeverage?: number;
    positionsCount: number;
  };
};

type Listener<T> = (payload: T) => void;

// Tiny event emitter (no Node typings needed)
class Evt {
  private map = new Map<string, Set<Listener<any>>>();
  on<T>(ev: string, fn: Listener<T>) { if (!this.map.has(ev)) this.map.set(ev, new Set()); this.map.get(ev)!.add(fn as any); }
  off<T>(ev: string, fn: Listener<T>) { this.map.get(ev)?.delete(fn as any); }
  emit<T>(ev: string, payload: T) { this.map.get(ev)?.forEach(fn => fn(payload)); }
}

/* =========================
   Core store
   ========================= */

export class PortfolioStore {
  private state: Portfolio;
  private ev = new Evt();

  constructor(seed?: Partial<Portfolio>) {
    this.state = {
      currency: seed?.currency ?? "USD",
      cash: seed?.cash ?? 0,
      positions: (seed?.positions ?? []).map(p => ({ ...p })),
      updatedAt: new Date().toISOString(),
    };
  }

  /* -------- Events -------- */
  onChange(fn: Listener<Portfolio>) { this.ev.on("change", fn); }
  offChange(fn: Listener<Portfolio>) { this.ev.off("change", fn); }
  private notify() { this.state.updatedAt = new Date().toISOString(); this.ev.emit("change", this.get()); }

  /* -------- Accessors -------- */
  get(): Portfolio {
    return {
      currency: this.state.currency,
      cash: this.state.cash,
      equity: this.state.equity,
      positions: this.state.positions.map(p => ({ ...p })),
      updatedAt: this.state.updatedAt,
    };
  }

  setCurrency(ccy: string) { this.state.currency = ccy; this.notify(); }

  /* -------- Positions CRUD -------- */
  upsertPosition(p: Position) {
    const i = this.state.positions.findIndex(x => x.symbol === p.symbol);
    if (i >= 0) this.state.positions[i] = { ...this.state.positions[i], ...p };
    else this.state.positions.push({ ...p });
    this.compactIfZero(p.symbol);
    this.notify();
  }

  removePosition(symbol: string) {
    this.state.positions = this.state.positions.filter(p => p.symbol !== symbol);
    this.notify();
  }

  clearPositions() { this.state.positions = []; this.notify(); }

  /* -------- Trading / P&L -------- */
  // Realized cash changes; avgPrice tracks remaining inventory cost (FIFO-lite: running average)
  applyTrade(t: Trade) {
    const { symbol, qty, price, fees = 0 } = t;
    if (!Number.isFinite(qty) || !Number.isFinite(price)) return;

    let pos = this.state.positions.find(p => p.symbol === symbol);
    if (!pos) { pos = { symbol, qty: 0, avgPrice: 0 }; this.state.positions.push(pos); }

    const prevQty = pos.qty;
    const newQty = prevQty + qty;

    if ((prevQty >= 0 && newQty >= 0) || (prevQty <= 0 && newQty <= 0)) {
      // Same side → adjust running average
      const notionalPrev = (pos.avgPrice ?? 0) * Math.abs(prevQty);
      const notionalNew  = price * Math.abs(qty);
      const denom = Math.abs(prevQty) + Math.abs(qty);
      pos.avgPrice = denom > 0 ? (notionalPrev + notionalNew) / denom : pos.avgPrice;
      pos.qty = newQty;
    } else {
      // Crossing through zero (partial/complete close); keep avgPrice for remaining side based on executed shares
      pos.qty = newQty;
      if (newQty === 0) pos.avgPrice = 0; // flat
      // (If you want realized P&L tracking, compute here and emit another event)
    }

    // Cash impact (buy uses cash; sell adds cash). Fees reduce cash.
    this.state.cash -= qty * price + fees;

    this.compactIfZero(symbol);
    this.notify();
  }

  markPrices(prices: Prices) {
    for (const p of this.state.positions) {
      const px = prices[p.symbol];
      if (Number.isFinite(px)) p.price = px;
    }
    this.notify();
  }

  /* -------- Valuation -------- */
  // Notional for a position using provided prices (or stored mark)
  static notional(p: Position, prices?: Prices) {
    const px = Number.isFinite(p.price!) ? (p.price as number) : prices?.[p.symbol];
    return Number.isFinite(px) ? px! * p.qty : 0;
  }

  // Gross, net, equity computed with prices
  totals(prices?: Prices) {
    let gross = 0, net = 0;
    for (const p of this.state.positions) {
      const px = Number.isFinite(p.price!) ? (p.price as number) : prices?.[p.symbol];
      if (!Number.isFinite(px)) continue;
      const notion = px! * p.qty;
      gross += Math.abs(notion);
      net   += notion;
    }
    const equity = this.state.cash + net;
    const leverage = equity > 0 ? gross / equity : undefined;
    const netLev   = equity > 0 ? Math.abs(net) / equity : undefined;
    return {
      grossNotional: gross,
      netNotional: net,
      equity,
      leverage,
      netLeverage: netLev,
      positionsCount: this.state.positions.length,
    };
  }

  snapshot(prices?: Prices): StoreSnapshot {
    // Impute current mark into returned positions
    const pos = this.state.positions.map(p => {
      const px = Number.isFinite(p.price!) ? (p.price as number) : prices?.[p.symbol];
      return { ...p, price: Number.isFinite(px) ? px : p.price };
    });
    const totals = this.totals(prices);
    return { portfolio: { ...this.get(), positions: pos }, totals };
  }

  /* -------- Utilities -------- */
  compactIfZero(symbol: string) {
    const i = this.state.positions.findIndex(p => p.symbol === symbol);
    if (i >= 0) {
      const p = this.state.positions[i];
      if (Math.abs(p.qty) < 1e-12) this.state.positions.splice(i, 1);
    }
  }

  reset(seed?: Partial<Portfolio>) {
    this.state = {
      currency: seed?.currency ?? this.state.currency ?? "USD",
      cash: seed?.cash ?? 0,
      positions: (seed?.positions ?? []).map(p => ({ ...p })),
      updatedAt: new Date().toISOString(),
    };
    this.notify();
  }

  /* -------- Persistence (optional) -------- */
  // Any object exposing .save(key,obj) / .load(key) like FSRepo
  saveWith(repo: { save: (k: string, v: any) => void }, key: string) {
    repo.save(key, this.get());
  }
  loadWith(repo: { load: (k: string, f?: any) => any }, key: string) {
    const data = repo.load(key);
    if (data) {
      this.state = {
        currency: data.currency ?? "USD",
        cash: Number(data.cash ?? 0),
        positions: Array.isArray(data.positions) ? data.positions.map((p: any) => ({ ...p })) : [],
        updatedAt: new Date().toISOString(),
      };
      this.notify();
    }
  }
}

/* =========================
   Convenience factory
   ========================= */

export function createPortfolioStore(seed?: Partial<Portfolio>) {
  return new PortfolioStore(seed);
}

export default PortfolioStore;