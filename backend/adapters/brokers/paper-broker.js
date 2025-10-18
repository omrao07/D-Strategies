// adapters/brokers/paper-broker.js
// Minimal paper-trading broker (spot only). ESM/NodeNext, zero deps.

/**
 * @typedef {"buy"|"sell"} Side
 * @typedef {"market"|"limit"} OrdType
 * @typedef {"GTC"|"IOC"|"FOK"} TimeInForce
 *
 * @typedef {Object} Order
 * @property {string} id
 * @property {string} symbol
 * @property {Side} side
 * @property {OrdType} type
 * @property {number} qty            // positive number
 * @property {number=} limit         // for limit orders
 * @property {TimeInForce=} tif      // default GTC
 * @property {number=} ts            // created ms
 * @property {string} status         // "new"|"working"|"partiallyFilled"|"filled"|"canceled"|"rejected"
 * @property {number} filled         // filled qty
 * @property {number} avgPx          // VWAP of fills
 * @property {string=} reason        // if rejected/canceled
 *
 * @typedef {Object} Fill
 * @property {string} orderId
 * @property {string} symbol
 * @property {Side} side
 * @property {number} qty
 * @property {number} price
 * @property {number} fee
 * @property {number} ts
 *
 * @typedef {Object} Position
 * @property {string} symbol
 * @property {number} qty
 * @property {number} avgPx
 * @property {number} unrealizedPnl  // computed via last price
 *
 * @typedef {Object} Account
 * @property {string} id
 * @property {number} cash
 * @property {number} equity
 * @property {number} buyingPower
 * @property {number} realizedPnl
 * @property {Record<string, Position>} positions
 *
 * @typedef {Object} Quote
 * @property {number=} bid
 * @property {number=} ask
 * @property {number=} last
 * @property {number=} mid
 * @property {number} ts
 *
 * @typedef {Object} BrokerConfig
 * @property {string} [accountId="paper"]
 * @property {number} [startingCash=1_000_000]
 * @property {number} [feeBps=0]            // commission in basis points of notional
 * @property {number} [slippageBps=0]       // extra price bps on execution
 * @property {boolean} [instantFill=true]   // market fills at quote immediately
 * @property {number} [maxLeverage=1]       // cash-only by default
 * @property {(event:string, payload:any)=>void} [onEvent] // optional event sink
 */

/** simple id */
function uid(prefix = "ord") {
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${r}`;
}

/** clamp to finite number */
function num(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

/** pick execution reference price from a quote */
function referencePx(quote, side) {
  if (!quote) return undefined;
  if (Number.isFinite(quote.mid)) return quote.mid;
  if (side === "buy") {
    if (Number.isFinite(quote.ask)) return quote.ask;
    if (Number.isFinite(quote.last)) return quote.last;
  } else {
    if (Number.isFinite(quote.bid)) return quote.bid;
    if (Number.isFinite(quote.last)) return quote.last;
  }
  return undefined;
}

/** apply slippage in bps: buy worse (higher), sell worse (lower) */
function applySlippage(px, side, bps) {
  if (!Number.isFinite(bps) || bps === 0) return px;
  const m = bps / 10_000;
  return side === "buy" ? px * (1 + m) : px * (1 - m);
}

/**
 * Create a paper broker instance.
 * @param {BrokerConfig} cfg
 */
export function PaperBroker(cfg = {}) {
  const config = {
    accountId: cfg.accountId ?? "paper",
    startingCash: num(cfg.startingCash, 1_000_000),
    feeBps: num(cfg.feeBps, 0),
    slippageBps: num(cfg.slippageBps, 0),
    instantFill: cfg.instantFill !== false,
    maxLeverage: num(cfg.maxLeverage, 1),
    onEvent: typeof cfg.onEvent === "function" ? cfg.onEvent : () => {},
  };

  /** @type {Record<string, Quote>} */
  const quotes = {};
  /** @type {Map<string, Order>} */
  const orders = new Map();
  /** @type {Fill[]} */
  const fills = [];
  /** @type {Record<string, Position>} */
  const positions = {};
  let cash = config.startingCash;
  let realizedPnl = 0;

  function emit(event, payload) {
    try { config.onEvent(event, payload); } catch {}
  }

  function pos(symbol) {
    return (positions[symbol] ??= { symbol, qty: 0, avgPx: 0, unrealizedPnl: 0 });
  }

  function mark(symbol, q) {
    quotes[symbol] = { ...quotes[symbol], ...q, ts: q.ts ?? Date.now() };
    // update unrealized PnL
    const p = positions[symbol];
    if (p && p.qty !== 0) {
      const px = referencePx(quotes[symbol], p.qty >= 0 ? "sell" : "buy") ?? p.avgPx;
      p.unrealizedPnl = (px - p.avgPx) * p.qty;
    }
  }

  function recomputeEquity() {
    let upnl = 0;
    for (const s of Object.keys(positions)) upnl += positions[s].unrealizedPnl || 0;
    return { equity: cash + upnl, upnl };
  }

  function notional(price, qty) {
    return Math.abs(price * qty);
  }

  function fee(price, qty) {
    const bps = config.feeBps / 10_000;
    return notional(price, qty) * bps;
  }

  function canAfford(side, price, qty) {
    // Simple cash/leverage check
    const { equity } = recomputeEquity();
    const req = notional(price, qty) / config.maxLeverage;
    if (side === "buy") return equity >= req - 1e-8;
    // sells are allowed if we have qty or allow short via leverage (here: allow)
    return equity >= 0; // adjust if you want to restrict shorting
  }

  function vwap(accPx, accQty, addPx, addQty) {
    if (accQty <= 0) return addPx;
    return (accPx * accQty + addPx * addQty) / (accQty + addQty);
  }

  function settleFill(order, px, qtyFilled) {
    const f = {
      orderId: order.id,
      symbol: order.symbol,
      side: order.side,
      qty: qtyFilled,
      price: px,
      fee: fee(px, qtyFilled),
      ts: Date.now(),
    };
    fills.push(f);
    emit("fill", f);

    // update order stats
    order.filled += qtyFilled;
    order.avgPx = vwap(order.avgPx, order.filled - qtyFilled, px, qtyFilled);

    // update position + cash/realizedPnL
    const p = pos(order.symbol);
    const signedQty = order.side === "buy" ? qtyFilled : -qtyFilled;

    // If crossing position (reduce), compute realized PnL component
    let realized = 0;
    if (p.qty !== 0 && Math.sign(p.qty) !== Math.sign(signedQty)) {
      // closing magnitude is limited by opposite side
      const closeQty = Math.min(Math.abs(signedQty), Math.abs(p.qty));
      realized = (px - p.avgPx) * (p.qty > 0 ? closeQty : -closeQty);
      realizedPnl += realized;
    }

    // new position state
    const newQty = p.qty + signedQty;

    if (newQty === 0) {
      p.qty = 0;
      p.avgPx = 0;
      p.unrealizedPnl = 0;
    } else if (Math.sign(newQty) === Math.sign(p.qty) || p.qty === 0) {
      // add in direction: adjust avg
      p.avgPx = vwap(p.avgPx, Math.abs(p.qty), px, Math.abs(signedQty));
      p.qty = newQty;
    } else {
      // flipped through zero: set avg to execution price for remaining qty
      p.qty = newQty;
      p.avgPx = px;
    }

    // cash flow (buy -> outflow; sell -> inflow) minus fee
    cash += (order.side === "buy" ? -1 : 1) * px * qtyFilled - f.fee;

    // refresh unrealized on this symbol
    mark(order.symbol, {});
  }

  function maybeComplete(order) {
    if (order.filled >= order.qty - 1e-12) {
      order.status = "filled";
      emit("order", { kind: "filled", order: { ...order } });
      return true;
    }
    order.status = order.filled > 0 ? "partiallyFilled" : order.status;
    return false;
  }

  /**
   * Attempt to execute order against current quote (used for instant fill or on tick).
   * @param {Order} order
   */
  function matchAgainstQuote(order) {
    const q = quotes[order.symbol];
    const ref = referencePx(q, order.side);
    if (!Number.isFinite(ref)) return;

    // limit checks
    if (order.type === "limit") {
      if (order.side === "buy" && !(ref <= order.limit + 1e-12)) return;
      if (order.side === "sell" && !(ref >= order.limit - 1e-12)) return;
    }

    // slippage
    const px = applySlippage(ref, order.side, config.slippageBps);

    // risk check
    if (!canAfford(order.side, px, order.qty - order.filled)) {
      order.status = "rejected";
      order.reason = "insufficient buying power";
      emit("order", { kind: "rejected", order: { ...order } });
      return;
    }

    // TIF logic
    const remaining = order.qty - order.filled;
    if (order.type === "market") {
      settleFill(order, px, remaining);
      maybeComplete(order);
      return;
    }

    // limit order here
    if (order.tif === "IOC") {
      settleFill(order, px, remaining);
      maybeComplete(order) || cancel(order.id, "IOC remainder canceled");
      return;
    }
    if (order.tif === "FOK") {
      // In this simplified model, if we reached here, we can fill fully
      settleFill(order, px, remaining);
      maybeComplete(order);
      return;
    }

    // GTC: fill all remaining now (since we only have top-of-book model)
    settleFill(order, px, remaining);
    maybeComplete(order);
  }

  /* =========================
     Public API
     ========================= */

  /** @returns {Account} */
  function getAccount() {
    const { equity } = recomputeEquity();
    return {
      id: config.accountId,
      cash: +cash,
      equity: +equity,
      buyingPower: equity * config.maxLeverage,
      realizedPnl: +realizedPnl,
      positions: JSON.parse(JSON.stringify(positions)),
    };
  }

  /** @returns {Order[]} */
  function getOpenOrders() {
    return Array.from(orders.values()).filter(o =>
      o.status === "new" || o.status === "working" || o.status === "partiallyFilled"
    );
  }

  /** @returns {Fill[]} */
  function getFills() {
    return fills.slice();
  }

  /** @param {string} symbol @param {Quote} q */
  function onQuote(symbol, q) {
    mark(symbol, q);
    // try to match working orders for this symbol
    for (const o of getOpenOrders()) {
      if (o.symbol !== symbol) continue;
      matchAgainstQuote(o);
    }
  }

  /**
   * Submit an order.
   * @param {Partial<Order> & {symbol:string, side:Side, type:OrdType, qty:number, limit?:number, tif?:TimeInForce}} req
   * @returns {Order}
   */
  function submit(req) {
    const id = req.id ?? uid("ord");
    /** @type {Order} */
    const o = {
      id,
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      qty: Math.max(0, num(req.qty)),
      limit: req.limit != null ? num(req.limit) : undefined,
      tif: /** @type {TimeInForce} */ (req.tif ?? "GTC"),
      ts: Date.now(),
      status: "new",
      filled: 0,
      avgPx: 0,
    };

    // Validate
    if (!o.symbol || !o.qty || !o.side || !o.type) {
      o.status = "rejected"; o.reason = "invalid order";
      emit("order", { kind: "rejected", order: { ...o } });
      return o;
    }
    if (o.type === "limit" && !Number.isFinite(o.limit)) {
      o.status = "rejected"; o.reason = "limit price required";
      emit("order", { kind: "rejected", order: { ...o } });
      return o;
    }

    o.status = "working";
    orders.set(o.id, o);
    emit("order", { kind: "accepted", order: { ...o } });

    if (config.instantFill) {
      matchAgainstQuote(o);
    }
    return { ...o };
  }

  /**
   * Amend an existing working order (only qty up/down and limit).
   * @param {string} id
   * @param {{qty?:number, limit?:number, tif?:TimeInForce}} patch
   * @returns {Order|undefined}
   */
  function amend(id, patch = {}) {
    const o = orders.get(id);
    if (!o || o.status === "filled" || o.status === "canceled" || o.status === "rejected") return;
    if (patch.qty != null) {
      const newQty = Math.max(0, num(patch.qty));
      if (newQty < o.filled) {
        o.status = "rejected"; o.reason = "qty < already filled";
        emit("order", { kind: "rejected", order: { ...o } });
        return;
      }
      o.qty = newQty;
    }
    if (patch.limit != null) o.limit = num(patch.limit);
    if (patch.tif) o.tif = patch.tif;
    emit("order", { kind: "amended", order: { ...o } });
    // try to execute after amend
    matchAgainstQuote(o);
    return { ...o };
  }

  /**
   * Cancel a working order.
   * @param {string} id
   * @param {string=} reason
   * @returns {Order|undefined}
   */
  function cancel(id, reason = "canceled by user") {
    const o = orders.get(id);
    if (!o || o.status === "filled" || o.status === "canceled" || o.status === "rejected") return;
    o.status = "canceled";
    o.reason = reason;
    emit("order", { kind: "canceled", order: { ...o } });
    return { ...o };
  }

  /**
   * Convenience: market buy/sell helpers.
   */
  function buy(symbol, qty) {
    return submit({ symbol, side: "buy", type: "market", qty });
  }
  function sell(symbol, qty) {
    return submit({ symbol, side: "sell", type: "market", qty });
  }

  return {
    // state
    getAccount,
    getOpenOrders,
    getFills,
    getPositions: () => JSON.parse(JSON.stringify(positions)),
    // trading
    submit,
    amend,
    cancel,
    buy,
    sell,
    // market data hook
    onQuote,
    // util
    config,
  };
}

export default PaperBroker;

/* =========================
   Quick demo (optional)
   ========================= */

if (import.meta.url === `file://${process.argv[1]}`) {
  const broker = PaperBroker({
    startingCash: 100_000,
    feeBps: 1,           // 0.01%
    slippageBps: 2,      // 0.02%
    onEvent: (e, p) => console.log(`[${e}]`, p),
  });

  // seed quote
  broker.onQuote("AAPL", { bid: 99.9, ask: 100.1, last: 100, ts: Date.now() });

  // market buy
  broker.buy("AAPL", 10);
  console.log("acct:", broker.getAccount());

  // limit sell @ 101
  const ord = broker.submit({ symbol: "AAPL", side: "sell", type: "limit", qty: 10, limit: 101, tif: "GTC" });
  // move market up → should fill
  broker.onQuote("AAPL", { bid: 101.1, ask: 101.2, last: 101.15, ts: Date.now() });

  console.log("fills:", broker.getFills());
  console.log("acct:", broker.getAccount());
}