// engine/risk/limits.ts
// Pre-trade & post-trade risk limits and helpers (zero deps).
// Works with a minimal Portfolio/Order shape and does not depend on adapters.

export type Side = "buy" | "sell" | "short" | "cover";

export type Position = {
  symbol: string;
  qty: number;         // signed: long>0, short<0
  price?: number;      // last/mark (if missing, notional is inferred from px map)
  sector?: string;     // optional sector bucket for concentration checks
  avgPx?: number;      // optional cost basis
};

export type Order = {
  symbol: string;
  side: Side;
  qty: number;         // positive quantity requested
  price?: number;      // expected/limit price for notional checks
  tif?: "DAY" | "IOC" | "FOK" | "GTC";
  meta?: Record<string, any>;
};

export type Prices = Record<string, number>;       // symbol → last/mark
export type Sectors = Record<string, string>;      // symbol → sector

export type Portfolio = {
  equity: number;          // current equity (cash + positions MTM)
  cash: number;            // available cash (can be negative if margin)
  positions: Position[];   // current book
  currency?: string;       // e.g. "USD"
};

export type Limits = {
  // account-level
  maxLeverage?: number;           // max gross / equity (e.g., 3)
  maxNetLeverage?: number;        // max |net| / equity
  maxPositions?: number;          // distinct symbols cap
  maxGrossNotional?: number;      // absolute gross (currency units)
  maxOrderNotional?: number;      // per-order notional cap
  maxNameNotionalFrac?: number;   // per name |notional| <= frac * equity (e.g., 0.1)
  maxSectorNotionalFrac?: number; // per sector |notional| <= frac * equity
  maxConcentrationTopN?: { n: number; frac: number }; // sum top N names ≤ frac * gross
  maxDailyLossFrac?: number;      // e.g., 0.03 (if you pass dayStartEquity)
  // liquidity (best-effort)
  maxOrderADVFrac?: number;       // order notional ≤ frac * ADV (if adv map provided)
  maxHoldingsADVFrac?: number;    // per-name |notional| ≤ frac * ADV (optional)
  // shorting
  allowShorts?: boolean;          // default true
  maxShortGrossFrac?: number;     // |short gross| ≤ frac * gross or equity (choose one)
};

export type ADV = Record<string, number>;         // symbol → average daily value (currency)
export type Viol = { code: string; message: string; meta?: Record<string, any> };

/* =========================
   Helpers
   ========================= */

export function mapPositions(positions: Position[]) {
  const bySym = new Map<string, Position>();
  for (const p of positions || []) bySym.set(p.symbol, p);
  return bySym;
}

export function positionNotional(p: Position, px?: number) {
  const price = Number.isFinite(p.price!) ? (p.price as number) : (px ?? 0);
  return price * p.qty;
}

export function portfolioGrossNotional(port: Portfolio, prices?: Prices): number {
  let gross = 0;
  for (const p of port.positions || []) {
    const px = Number.isFinite(p.price!) ? (p.price as number) : (prices?.[p.symbol] ?? 0);
    gross += Math.abs(px * p.qty);
  }
  return gross;
}

export function portfolioNetNotional(port: Portfolio, prices?: Prices): number {
  let net = 0;
  for (const p of port.positions || []) {
    const px = Number.isFinite(p.price!) ? (p.price as number) : (prices?.[p.symbol] ?? 0);
    net += px * p.qty;
  }
  return net;
}

export function bySectorNotional(port: Portfolio, prices?: Prices, sectors?: Sectors) {
  const acc: Record<string, number> = {};
  for (const p of port.positions || []) {
    const sec = p.sector || sectors?.[p.symbol] || "UNCLASSIFIED";
    const px = Number.isFinite(p.price!) ? (p.price as number) : (prices?.[p.symbol] ?? 0);
    acc[sec] = (acc[sec] ?? 0) + Math.abs(px * p.qty);
  }
  return acc;
}

export function countOpenNames(port: Portfolio) {
  return (port.positions || []).filter(p => Math.abs(p.qty) > 0).length;
}

/** Returns arrays of {symbol, absNotional} sorted desc */
export function nameConcentration(port: Portfolio, prices?: Prices) {
  const rows = (port.positions || []).map(p => {
    const px = Number.isFinite(p.price!) ? (p.price as number) : (prices?.[p.symbol] ?? 0);
    return { symbol: p.symbol, absNotional: Math.abs(px * p.qty) };
  });
  rows.sort((a, b) => b.absNotional - a.absNotional);
  return rows;
}

/* =========================
   Core checks (post-trade portfolio snapshot)
   ========================= */

export function checkPortfolioLimits(
  port: Portfolio,
  limits: Limits,
  prices?: Prices,
  opts?: { dayStartEquity?: number; sectors?: Sectors; adv?: ADV }
): Viol[] {
  const V: Viol[] = [];
  const equity = Math.max(0, Number(port.equity || 0));
  const gross = portfolioGrossNotional(port, prices);
  const netAbs = Math.abs(portfolioNetNotional(port, prices));

  // leverage
  if (limits.maxLeverage != null && equity > 0) {
    const lev = gross / equity;
    if (lev > limits.maxLeverage) {
      V.push(v("MAX_LEVERAGE", `gross/equity ${lev.toFixed(2)} > ${limits.maxLeverage}`, { lev, gross, equity }));
    }
  }
  if (limits.maxNetLeverage != null && equity > 0) {
    const nlev = netAbs / equity;
    if (nlev > limits.maxNetLeverage) {
      V.push(v("MAX_NET_LEVERAGE", `|net|/equity ${nlev.toFixed(2)} > ${limits.maxNetLeverage}`, { nlev, netAbs, equity }));
    }
  }

  // positions count
  if (limits.maxPositions != null) {
    const n = countOpenNames(port);
    if (n > limits.maxPositions) {
      V.push(v("MAX_POSITIONS", `open names ${n} > ${limits.maxPositions}`, { n }));
    }
  }

  // absolute gross
  if (limits.maxGrossNotional != null && gross > limits.maxGrossNotional) {
    V.push(v("MAX_GROSS_NOTIONAL", `gross ${gross.toFixed(0)} > ${limits.maxGrossNotional}`, { gross }));
  }

  // per-name fraction of equity
  if (limits.maxNameNotionalFrac != null && equity > 0) {
    for (const p of port.positions || []) {
      const px = Number.isFinite(p.price!) ? (p.price as number) : (prices?.[p.symbol] ?? 0);
      const absN = Math.abs(px * p.qty);
      const cap = limits.maxNameNotionalFrac * equity;
      if (absN > cap) {
        V.push(v("MAX_NAME_FRACTION", `${p.symbol} notional ${absN.toFixed(0)} > ${(cap).toFixed(0)} (${(limits.maxNameNotionalFrac*100).toFixed(1)}% equity)`, { symbol: p.symbol, absN, cap }));
      }
    }
  }

  // sector fraction of equity
  if (limits.maxSectorNotionalFrac != null && equity > 0) {
    const map = bySectorNotional(port, prices, opts?.sectors);
    for (const [sec, absN] of Object.entries(map)) {
      const cap = limits.maxSectorNotionalFrac * equity;
      if (absN > cap) {
        V.push(v("MAX_SECTOR_FRACTION", `sector ${sec} notional ${absN.toFixed(0)} > ${(cap).toFixed(0)} (${(limits.maxSectorNotionalFrac*100).toFixed(1)}% equity)`, { sector: sec, absN, cap }));
      }
    }
  }

  // top-N concentration
  if (limits.maxConcentrationTopN && gross > 0) {
    const { n, frac } = limits.maxConcentrationTopN;
    const top = nameConcentration(port, prices).slice(0, n);
    const sumTop = top.reduce((a, r) => a + r.absNotional, 0);
    const conc = sumTop / gross;
    if (conc > frac) {
      V.push(v("MAX_CONCENTRATION_TOPN", `top ${n} = ${(conc*100).toFixed(1)}% > ${(frac*100).toFixed(1)}%`, { n, conc, gross }));
    }
  }

  // shorts allowed?
  if (limits.allowShorts === false) {
    const hasShort = (port.positions || []).some(p => p.qty < 0);
    if (hasShort) V.push(v("SHORTS_DISABLED", "short positions present while allowShorts=false"));
  }

  // short gross as fraction
  if (limits.maxShortGrossFrac != null && gross > 0) {
    let shortGross = 0;
    for (const p of port.positions || []) {
      if (p.qty < 0) {
        const px = Number.isFinite(p.price!) ? (p.price as number) : (prices?.[p.symbol] ?? 0);
        shortGross += Math.abs(px * p.qty);
      }
    }
    const frac = shortGross / gross;
    if (frac > limits.maxShortGrossFrac) {
      V.push(v("MAX_SHORT_GROSS_FRAC", `short gross ${(frac*100).toFixed(1)}% > ${(limits.maxShortGrossFrac*100).toFixed(1)}% of gross`, { shortGross, gross }));
    }
  }

  // daily loss (if day start provided)
  if (limits.maxDailyLossFrac != null && equity > 0 && Number.isFinite(opts?.dayStartEquity)) {
    const start = Math.max(1e-9, opts!.dayStartEquity as number);
    const draw = (start - equity) / start;
    if (draw > limits.maxDailyLossFrac) {
      V.push(v("MAX_DAILY_LOSS", `intraday drawdown ${(draw*100).toFixed(2)}% > ${(limits.maxDailyLossFrac*100).toFixed(2)}%`, { start, equity, draw }));
    }
  }

  // liquidity (best-effort)
  if (opts?.adv && limits.maxHoldingsADVFrac != null) {
    for (const p of port.positions || []) {
      const px = Number.isFinite(p.price!) ? (p.price as number) : (prices?.[p.symbol] ?? 0);
      const absN = Math.abs(px * p.qty);
      const adv = opts.adv[p.symbol];
      if (Number.isFinite(adv) && adv! > 0) {
        const frac = absN / adv!;
        if (frac > limits.maxHoldingsADVFrac) {
          V.push(v("MAX_HOLDINGS_ADV_FRAC", `${p.symbol} holdings ${(frac*100).toFixed(1)}% > ${(limits.maxHoldingsADVFrac*100).toFixed(1)}% of ADV`, { symbol: p.symbol, frac, adv, absN }));
        }
      }
    }
  }

  return V;
}

/* =========================
   Pre-trade check (order against current snapshot)
   ========================= */

export function checkOrder(
  port: Portfolio,
  order: Order,
  limits: Limits,
  prices?: Prices,
  opts?: { sectors?: Sectors; adv?: ADV }
): Viol[] {
  const V: Viol[] = [];
  // quick per-order notional
  if (limits.maxOrderNotional != null) {
    const px = order.price ?? prices?.[order.symbol] ?? 0;
    const notional = px * order.qty;
    if (Math.abs(notional) > limits.maxOrderNotional) {
      V.push(v("MAX_ORDER_NOTIONAL", `order ${order.symbol} notional ${Math.abs(notional).toFixed(0)} > ${limits.maxOrderNotional}`, { symbol: order.symbol, notional }));
    }
  }
  // liquidity (order vs ADV)
  if (opts?.adv && limits.maxOrderADVFrac != null) {
    const px = order.price ?? prices?.[order.symbol] ?? 0;
    const adv = opts.adv[order.symbol];
    if (Number.isFinite(adv) && adv! > 0) {
      const frac = Math.abs(px * order.qty) / adv!;
      if (frac > limits.maxOrderADVFrac) {
        V.push(v("MAX_ORDER_ADV_FRAC", `order ${(frac*100).toFixed(1)}% > ${(limits.maxOrderADVFrac*100).toFixed(1)}% of ADV`, { symbol: order.symbol, frac, adv }));
      }
    }
  }
  // shorts allowed?
  if (limits.allowShorts === false) {
    const bySym = mapPositions(port.positions);
    const cur = bySym.get(order.symbol)?.qty || 0;
    const dir = (order.side === "short" || (order.side === "sell" && (cur - order.qty) < 0));
    if (dir) V.push(v("SHORTS_DISABLED", `would create/increase short in ${order.symbol}`));
  }
  return V;
}

/* =========================
   Simulate fill → check post-trade
   ========================= */

/** Returns a cloned portfolio with the order applied at given price (default: order.price or prices[symbol] or 0). */
export function simulateFill(port: Portfolio, order: Order, prices?: Prices): Portfolio {
  const px = order.price ?? prices?.[order.symbol] ?? 0;
  const qty = Math.max(0, order.qty);
  const sign = (order.side === "buy" || order.side === "cover") ? +1 : -1;
  const dq = sign * qty;

  const out: Portfolio = {
    equity: port.equity,
    cash: port.cash - dq * px, // pay for buys; receive for sells (simplified, no comms/slippage)
    positions: port.positions.map(p => ({ ...p })),
    currency: port.currency,
  };

  const p = out.positions.find(p => p.symbol === order.symbol);
  if (p) {
    p.qty += dq;
    p.price = px; // update mark
  } else {
    out.positions.push({ symbol: order.symbol, qty: dq, price: px });
  }
  // recompute equity (rough mark-to-market)
  const mark = (sym: string, fallback = 0) => {
    const mpx = prices?.[sym];
    return Number.isFinite(mpx) ? (mpx as number) : fallback;
  };
  let posPnl = 0;
  for (const pos of out.positions) {
    posPnl += (mark(pos.symbol, pos.price ?? 0)) * pos.qty;
  }
  out.equity = out.cash + posPnl;
  return out;
}

/** Convenience: pre-trade checks + simulated post-trade checks with one call. */
export function assessOrder(
  port: Portfolio,
  order: Order,
  limits: Limits,
  prices?: Prices,
  opts?: { sectors?: Sectors; adv?: ADV; dayStartEquity?: number }
): { pre: Viol[]; post: Viol[]; simulated: Portfolio } {
  const pre = checkOrder(port, order, limits, prices, opts);
  const sim = simulateFill(port, order, prices);
  const post = checkPortfolioLimits(sim, limits, prices, { sectors: opts?.sectors, adv: opts?.adv, dayStartEquity: opts?.dayStartEquity });
  return { pre, post, simulated: sim };
}

/* =========================
   Formatting
   ========================= */

export function formatViolations(V: Viol[]): string[] {
  return V.map(v => `${v.code}: ${v.message}`);
}

function v(code: string, message: string, meta?: Record<string, any>): Viol {
  return { code, message, meta };
}

/* =========================
   Defaults
   ========================= */

export const DEFAULT_LIMITS: Limits = {
  maxLeverage: 2.0,
  maxNetLeverage: 1.0,
  maxPositions: 50,
  maxGrossNotional: undefined,
  maxOrderNotional: undefined,
  maxNameNotionalFrac: 0.10,
  maxSectorNotionalFrac: 0.35,
  maxConcentrationTopN: { n: 5, frac: 0.6 },
  allowShorts: true,
  maxShortGrossFrac: 0.75,
  maxOrderADVFrac: 0.10,
  maxHoldingsADVFrac: 1.00,
  maxDailyLossFrac: 0.05,
};

export default {
  checkPortfolioLimits,
  checkOrder,
  simulateFill,
  assessOrder,
  portfolioGrossNotional,
  portfolioNetNotional,
  nameConcentration,
  bySectorNotional,
  countOpenNames,
  positionNotional,
  formatViolations,
  DEFAULT_LIMITS,
};