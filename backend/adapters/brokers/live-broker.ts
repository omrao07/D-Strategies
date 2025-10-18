// engine/brokers/live-broker.ts
// Generic live broker adapter (REST + WS/SSE optional). Zero external deps.
// Wire it by providing endpoint paths and, if needed, a request signer.

export type Side = "buy" | "sell";
export type OrdType = "market" | "limit";
export type TimeInForce = "GTC" | "IOC" | "FOK";

export type OrderReq = {
  id?: string;                 // client order id (optional; server may assign)
  symbol: string;
  side: Side;
  type: OrdType;
  qty: number;
  limit?: number;
  tif?: TimeInForce;
  meta?: Record<string, any>;  // venue-specific fields (e.g., venue symbol, exchange, etc.)
};

export type Order = {
  id: string;
  clientId?: string;
  symbol: string;
  side: Side;
  type: OrdType;
  qty: number;
  limit?: number;
  tif?: TimeInForce;
  status: "new" | "working" | "partiallyFilled" | "filled" | "canceled" | "rejected";
  filled: number;
  avgPx: number;
  reason?: string;
  ts: number;
  raw?: any; // raw venue payload
};

export type Fill = {
  orderId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  fee?: number;
  ts: number;
  raw?: any;
};

export type Position = {
  symbol: string;
  qty: number;        // signed
  avgPx: number;
  unrealizedPnl?: number;
  raw?: any;
};

export type Account = {
  id: string;
  cash: number;
  equity: number;
  buyingPower: number;
  realizedPnl: number;
  positions: Record<string, Position>;
  raw?: any;
};

export type Quote = {
  symbol: string;
  bid?: number;
  ask?: number;
  last?: number;
  mid?: number;
  ts: number;
};

export type EventSink = (event: string, payload: any) => void;

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type HttpClient = (req: {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: any; // string | Buffer | object
  timeoutMs?: number;
}) => Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: () => Promise<string> }>;

export type Signer = (req: {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: any;
}) => Promise<{ headers?: Record<string, string> }> | { headers?: Record<string, string> };

export type StreamClient = {
  /** Connect the market data stream and call `onMessage` with raw events (string or object). */
  connect: (onMessage: (msg: any) => void, onError?: (e: any) => void) => Promise<void> | void;
  /** Close the stream. */
  close?: () => void;
  /** Optional: send subscribe commands after connect (venue specific). */
  subscribe?: (topics: string[]) => void;
  /** Optional: send unsubscribe commands. */
  unsubscribe?: (topics: string[]) => void;
};

export type EndpointMap = {
  // Absolute or relative to baseUrl
  placeOrder: string;                 // POST
  amendOrder?: string;                // PATCH (use :id in path -> replaced)
  cancelOrder?: string;               // DELETE (use :id)
  getOrder?: string;                  // GET (use :id)
  listOpenOrders?: string;            // GET
  account?: string;                   // GET
  positions?: string;                 // GET
  // Optional mapping of request/response fields
  map?: {
    toVenueOrder?: (req: OrderReq) => any;                  // body for place
    fromVenueOrder?: (raw: any) => Order;                   // normalize venue order → Order
    fromVenueOrders?: (raw: any) => Order[];                // normalize list orders
    fromVenueAccount?: (raw: any) => Account;               // normalize account
    fromVenuePositions?: (raw: any) => Position[];          // normalize positions
    venueOrderId?: (raw: any) => string;                    // extract id from place response
  };
};

export type LiveBrokerConfig = {
  baseUrl: string;                              // e.g., "https://api.broker.com/v2"
  endpoints: EndpointMap;
  http?: HttpClient;                            // defaults to global fetch-based client
  sign?: Signer;                                // add auth headers, signatures, etc.
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;                           // per request
  onEvent?: EventSink;                          // event sink
  // Market data (optional)
  stream?: StreamClient;                        // WS/SSE client (optional)
  topicOf?: (q: Quote | any) => string | undefined; // to manage subs per-symbol (optional)
  parseStream?: (raw: any) => Quote | undefined;    // raw stream → Quote
};

const isFiniteNum = (x: any) => typeof x === "number" && Number.isFinite(x);

/* -------------------------------------------
 * Minimal default HTTP client using global fetch (Node 18+ / browsers)
 * ------------------------------------------- */
async function defaultHttpClient(req: {
  method: HttpMethod; url: string; headers?: Record<string, string>; body?: any; timeoutMs?: number;
}) {
  const ctrl = new AbortController();
  const t = req.timeoutMs && setTimeout(() => ctrl.abort(), req.timeoutMs);
  let body: any = req.body;
  const headers = { ...(req.headers ?? {}) };
  if (body && typeof body === "object" && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array) && typeof body !== "string") {
    body = JSON.stringify(body);
    if (!headers["content-type"]) headers["content-type"] = "application/json";
  }
  try {
    const res = await fetch(req.url, { method: req.method, headers, body, signal: ctrl.signal } as any);
    const text = async () => await res.text();
    // Node/browsers header types differ; coerce to plain dict:
    const headersObj: Record<string, string | string[] | undefined> = {};
    (res.headers as any).forEach?.((v: string, k: string) => { headersObj[k] = v; });
    return { status: res.status, headers: headersObj, text };
  } finally {
    if (t) clearTimeout(t);
  }
}

/* -------------------------------------------
 * Very small quote book (last prices per symbol)
 * ------------------------------------------- */
class QuoteBook {
  private m = new Map<string, Quote>();
  update(q: Quote) {
    const prev = this.m.get(q.symbol);
    const mid = q.mid ?? (isFiniteNum(q.bid) && isFiniteNum(q.ask) ? ((q.bid! + q.ask!) / 2) : prev?.mid);
    const merged: Quote = { ...(prev || { symbol: q.symbol, ts: 0 }), ...q, mid, ts: q.ts ?? Date.now() };
    this.m.set(q.symbol, merged);
    return merged;
  }
  get(symbol: string) { return this.m.get(symbol); }
}

/* -------------------------------------------
 * LiveBroker factory
 * ------------------------------------------- */
export function LiveBroker(cfg: LiveBrokerConfig) {
  const http = cfg.http ?? defaultHttpClient;
  const H: Record<string, string> = { "accept": "application/json", ...(cfg.defaultHeaders ?? {}) };
  const events: EventSink = cfg.onEvent ?? (() => {});
  const quotes = new QuoteBook();

  function url(p: string, params?: Record<string, string | number>) {
    const base = cfg.baseUrl.replace(/\/+$/, "");
    let path = p.startsWith("http") ? p : `${base}/${p.replace(/^\/+/, "")}`;
    if (params) for (const [k, v] of Object.entries(params)) path = path.replace(`:${k}`, String(v));
    return path;
  }

  function refPxFromQuote(q?: Quote, side?: Side) {
    if (!q) return undefined;
    if (isFiniteNum(q.mid)) return q.mid!;
    if (side === "buy") return q.ask ?? q.last;
    if (side === "sell") return q.bid ?? q.last;
    return q.last ?? q.bid ?? q.ask ?? q.mid;
  }

  async function signed(method: HttpMethod, u: string, body?: any) {
    const headers = { ...H };
    if (cfg.sign) {
      const patch = await cfg.sign({ method, url: u, headers, body });
      Object.assign(headers, patch?.headers ?? {});
    }
    const res = await http({ method, url: u, headers, body, timeoutMs: cfg.timeoutMs ?? 15_000 });
    const rawTxt = await res.text();
    const raw = rawTxt ? safeJSON(rawTxt) : undefined;

    if (res.status < 200 || res.status >= 300) {
      const msg = (raw && (raw.message || raw.error)) ? `${raw.message || raw.error}` : `HTTP ${res.status}`;
      const err: any = new Error(msg);
      err.status = res.status; err.body = raw; err.url = u;
      throw err;
    }
    return raw;
  }

  function safeJSON(txt: string) { try { return JSON.parse(txt); } catch { return { text: txt }; } }

  /* ------------ Market data stream (optional) ------------ */
  let streamConnected = false;
  async function connectStream() {
    if (!cfg.stream || streamConnected) return;
    await cfg.stream.connect((raw) => {
      const q = cfg.parseStream?.(raw);
      if (!q) return;
      const merged = quotes.update(q);
      events("quote", merged);
    }, (e) => events("stream.error", { error: String(e) }));
    streamConnected = true;
  }

  /* ------------ Public API (BrokerLike) ------------ */
  async function submit(req: OrderReq): Promise<Order> {
    await connectStream().catch(() => {}); // best-effort
    const body = cfg.endpoints.map?.toVenueOrder ? cfg.endpoints.map.toVenueOrder(req) : {
      // sensible defaults (adjust mapper for your venue)
      symbol: req.symbol,
      side: req.side.toUpperCase(),
      type: req.type.toUpperCase(),
      qty: req.qty,
      price: req.limit,
      tif: req.tif ?? "GTC",
      client_id: req.id,
      ...req.meta,
    };
    const u = url(cfg.endpoints.placeOrder);
    const raw = await signed("POST", u, body);
    const id = cfg.endpoints.map?.venueOrderId?.(raw) ?? raw?.id ?? raw?.order_id ?? req.id ?? `${Date.now()}`;
    const o = cfg.endpoints.map?.fromVenueOrder?.(raw) ?? normalizeOrderFromPlace(raw, id);
    events("order.accepted", o);
    return o;
  }

  async function amend(id: string, patch: Partial<OrderReq>): Promise<Order> {
    if (!cfg.endpoints.amendOrder) throw new Error("amendOrder endpoint not configured");
    const body = {
      // generic defaults; override with mapper if needed
      qty: patch.qty,
      price: patch.limit,
      tif: patch.tif,
      ...patch.meta,
    };
    const u = url(cfg.endpoints.amendOrder, { id });
    const raw = await signed("PATCH", u, body);
    const o = cfg.endpoints.map?.fromVenueOrder?.(raw) ?? normalizeOrderGeneric(raw, id);
    events("order.amended", o);
    return o;
  }

  async function cancel(id: string): Promise<Order> {
    if (!cfg.endpoints.cancelOrder) throw new Error("cancelOrder endpoint not configured");
    const u = url(cfg.endpoints.cancelOrder, { id });
    const raw = await signed("DELETE", u);
    const o = cfg.endpoints.map?.fromVenueOrder?.(raw) ?? normalizeOrderGeneric(raw, id, "canceled");
    events("order.canceled", o);
    return o;
  }

  async function getOpenOrders(): Promise<Order[]> {
    if (!cfg.endpoints.listOpenOrders) throw new Error("listOpenOrders endpoint not configured");
    const u = url(cfg.endpoints.listOpenOrders);
    const raw = await signed("GET", u);
    const list = cfg.endpoints.map?.fromVenueOrders?.(raw) ?? normalizeOrderList(raw);
    return list;
  }

  async function getOrder(id: string): Promise<Order> {
    if (!cfg.endpoints.getOrder) throw new Error("getOrder endpoint not configured");
    const u = url(cfg.endpoints.getOrder, { id });
    const raw = await signed("GET", u);
    return cfg.endpoints.map?.fromVenueOrder?.(raw) ?? normalizeOrderGeneric(raw, id);
  }

  async function getPositions(): Promise<Record<string, Position>> {
    if (!cfg.endpoints.positions) throw new Error("positions endpoint not configured");
    const u = url(cfg.endpoints.positions);
    const raw = await signed("GET", u);
    const arr = cfg.endpoints.map?.fromVenuePositions?.(raw) ?? normalizePositions(raw);
    const map: Record<string, Position> = {};
    for (const p of arr) map[p.symbol] = p;
    // refresh unrealized using our last quotes
    for (const sym of Object.keys(map)) {
      const q = quotes.get(sym);
      const px = refPxFromQuote(q, map[sym].qty >= 0 ? "sell" : "buy") ?? map[sym].avgPx;
      map[sym].unrealizedPnl = (px - map[sym].avgPx) * map[sym].qty;
    }
    return map;
  }

  async function getAccount(): Promise<Account> {
    if (!cfg.endpoints.account) throw new Error("account endpoint not configured");
    const u = url(cfg.endpoints.account);
    const raw = await signed("GET", u);
    const acct = cfg.endpoints.map?.fromVenueAccount?.(raw) ?? normalizeAccount(raw);
    // recompute equity with our latest marks if venue doesn't provide it
    if (!isFiniteNum(acct.equity) || !isFiniteNum(acct.buyingPower)) {
      const pos = await getPositions().catch(() => ({}));
      let upnl = 0;
      for (const p of Object.values(pos)) upnl += p.unrealizedPnl ?? 0;
      acct.equity = acct.cash + upnl;
      acct.buyingPower = acct.equity; // adjust if your venue offers leverage
      acct.positions = pos;
    }
    return acct;
  }

  /** Ingest quotes from *your* market data layer (optional). */
  function onQuote(symbol: string, q: Partial<Quote>) {
    quotes.update({
      symbol,
      bid: q.bid,
      ask: q.ask,
      last: q.last,
      mid: q.mid ?? (isFiniteNum(q.bid!) && isFiniteNum(q.ask!) ? ((q.bid! + q.ask!) / 2) : undefined),
      ts: (q as any).ts ?? Date.now(),
    } as Quote);
  }

  function closeStream() { try { cfg.stream?.close?.(); } catch {} }

  return {
    // Trading API (BrokerLike)
    submit, amend, cancel,
    getOpenOrders, getOrder,
    getPositions, getAccount,
    onQuote,
    // Stream controls (optional)
    connectStream,
    closeStream,
    // Introspection
    refPrice: (sym: string, side?: Side) => refPxFromQuote(quotes.get(sym), side),
    _quotes: quotes, // expose if you want
  };
}

/* -------------------------------------------
 * Default normalizers (works as a template; override via cfg.endpoints.map)
 * ------------------------------------------- */

function normalizeOrderFromPlace(raw: any, id: string): Order {
  // Fallback mapping for common venues; customize as needed.
  const side = (raw?.side ?? raw?.order?.side ?? "buy").toString().toLowerCase() as Side;
  const type = (raw?.type ?? raw?.order?.type ?? "market").toString().toLowerCase() as OrdType;
  const symbol = raw?.symbol ?? raw?.order?.symbol ?? raw?.instrument ?? "UNKNOWN";
  const tif = (raw?.time_in_force ?? raw?.tif ?? "GTC").toUpperCase() as TimeInForce;
  const status = toLocalStatus(raw?.status ?? raw?.order?.status ?? "working");
  const filled = Number(raw?.filled_qty ?? raw?.filled ?? 0) || 0;
  const avgPx = Number(raw?.avg_price ?? raw?.avgPx ?? 0) || 0;
  const qty = Number(raw?.qty ?? raw?.quantity ?? raw?.order?.qty ?? 0) || 0;
  const limit = Number(raw?.limit_price ?? raw?.price ?? raw?.limit ?? undefined);

  return {
    id: (raw?.id ?? raw?.order_id ?? id)?.toString() || id,
    clientId: raw?.client_order_id ?? raw?.clientId,
    symbol, side, type, qty, limit, tif,
    status, filled, avgPx,
    ts: Date.now(),
    raw,
  };
}

function normalizeOrderGeneric(raw: any, id: string, forced?: Order["status"]): Order {
  const base = normalizeOrderFromPlace(raw, id);
  return { ...base, status: forced ?? base.status };
}

function normalizeOrderList(raw: any): Order[] {
  const arr = Array.isArray(raw) ? raw : (raw?.orders ?? raw?.data ?? []);
  return arr.map((r: any, i: number) => normalizeOrderFromPlace(r, r?.id ?? `ord_${i}`));
}

function normalizeAccount(raw: any): Account {
  // Try to detect common fields; override for your venue via map.fromVenueAccount.
  const id = (raw?.id ?? raw?.account_id ?? "live").toString();
  const cash = Number(raw?.cash ?? raw?.cash_balance ?? raw?.buying_power ?? 0) || 0;
  const equity = Number(raw?.equity ?? raw?.portfolio_value ?? cash) || cash;
  const bp = Number(raw?.buying_power ?? equity) || equity;
  const realized = Number(raw?.realized_pnl ?? raw?.pnl ?? 0) || 0;
  return { id, cash, equity, buyingPower: bp, realizedPnl: realized, positions: {}, raw };
}

function normalizePositions(raw: any): Position[] {
  const arr = Array.isArray(raw) ? raw : (raw?.positions ?? raw?.data ?? []);
  return arr.map((p: any) => ({
    symbol: p?.symbol ?? p?.ticker ?? p?.instrument ?? "UNKNOWN",
    qty: Number(p?.qty ?? p?.quantity ?? p?.position ?? 0) || 0,
    avgPx: Number(p?.avg_price ?? p?.avgPx ?? p?.cost_basis ?? 0) || 0,
    raw: p,
  }));
}

function toLocalStatus(s: any): Order["status"] {
  const x = String(s ?? "").toLowerCase();
  if (["filled", "done", "executed", "closed"].includes(x)) return "filled";
  if (["canceled", "cancelled"].includes(x)) return "canceled";
  if (["rejected", "reject"].includes(x)) return "rejected";
  if (["partial", "partiallyfilled", "partially_filled"].includes(x)) return "partiallyFilled";
  if (["new", "accepted", "open", "active", "working"].includes(x)) return "working";
  return "working";
}

/* -------------------------------------------
 * Example wiring (optional): run file directly
 * ------------------------------------------- */
if (import.meta.url === `file://${process.argv[1]}`) {
  // Example: pseudo venue with Alpaca-like fields (adjust endpoints+signer).
  const broker = LiveBroker({
    baseUrl: "https://api.example-broker.com/v2",
    endpoints: {
      placeOrder: "/orders",
      amendOrder: "/orders/:id",
      cancelOrder: "/orders/:id",
      getOrder: "/orders/:id",
      listOpenOrders: "/orders?status=open",
      account: "/account",
      positions: "/positions",
      // Optional: custom mappers (remove if defaults fit your venue)
      map: {
        toVenueOrder: (o) => ({
          symbol: o.symbol,
          qty: o.qty,
          side: o.side,
          type: o.type,
          time_in_force: o.tif ?? "GTC",
          limit_price: o.limit,
          client_order_id: o.id,
          ...o.meta,
        }),
      },
    },
    // Example HMAC signer (pseudo); replace with your venue scheme.
    sign: async ({ method, url, headers, body }) => {
      const h = { ...headers, "x-api-key": process.env.API_KEY || "demo" };
      // Add more signature headers if needed
      return { headers: h };
    },
    defaultHeaders: { "user-agent": "hf-live-broker/0.1" },
    timeoutMs: 10_000,
    onEvent: (e, p) => console.log(`[${e}]`, p?.id ?? "", p?.status ?? ""),
    // Market data stream (optional): plug your WS/SSE client here.
    // stream: {
    //   async connect(onMsg) { /* connect & on message call onMsg(raw) */ },
    //   close() { /* close */ },
    // },
    parseStream: (raw) => {
      // Example: accept JSON strings or objects with {symbol,bid,ask,last,ts}
      try {
        const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!obj?.symbol) return undefined;
        return { symbol: obj.symbol, bid: obj.bid, ask: obj.ask, last: obj.last, ts: obj.ts ?? Date.now() };
      } catch { return undefined; }
    },
  });

  (async () => {
    try {
      // Submit a sample order
      const ord = await broker.submit({ symbol: "AAPL", side: "buy", type: "market", qty: 1, id: "cli-001" });
      console.log("placed:", ord);

      // Inspect account/positions
      console.log(await broker.getAccount());
      console.log(await broker.getOpenOrders());
    } catch (e) {
      console.error("live error:", e);
    } finally {
      broker.closeStream();
    }
  })();
}