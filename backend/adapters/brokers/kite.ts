// brokers/kite.ts
// Pure TypeScript, zero external imports. Minimal client for Zerodha Kite Connect v3 REST API.
// Uses global fetch/AbortController if available; otherwise falls back to mock mode.
// NOTE: For authenticated requests, set `apiKey` at construction and call `setAccessToken(token)` after login.

// ---------- Types ----------

type ISO8601 = string

type KiteClientConfig = {
  apiKey: string
  accessToken?: string
  baseUrl?: string // default https://api.kite.trade
  timeoutMs?: number
  retries?: number
  softFail?: boolean // if true, return undefined on network errors instead of throw
  mock?: boolean // force mock mode (no HTTP)
}

type Variety = "regular" | "amo" | "co" | "iceberg" | "bo"
type Product = "CNC" | "MIS" | "NRML" | "CO"
type OrderType = "MARKET" | "LIMIT" | "SL" | "SL-M"
type Validity = "DAY" | "IOC"
type TransactionType = "BUY" | "SELL"

type Exchange =
  | "NSE" | "BSE"
  | "NFO" | "BFO"
  | "CDS" | "BCD"
  | "MCX"

type PlaceOrderInput = {
  exchange: Exchange
  tradingsymbol: string
  transaction_type: TransactionType
  quantity: number
  product: Product
  order_type: OrderType
  price?: number
  trigger_price?: number
  disclosed_quantity?: number
  validity?: Validity
  validity_ttl?: number
  iceberg_legs?: number
  iceberg_quantity?: number
  tag?: string
}

type ModifyOrderInput = Partial<
  Pick<
    PlaceOrderInput,
    | "quantity"
    | "price"
    | "order_type"
    | "trigger_price"
    | "disclosed_quantity"
    | "validity"
    | "validity_ttl"
    | "iceberg_legs"
    | "iceberg_quantity"
    | "tag"
  >
>

type OrderResponse = { order_id: string }
type CancelResponse = { order_id: string; status: "canceled" | "not_found" | "error"; message?: string }

type Order = {
  order_id: string
  parent_order_id?: string
  exchange: Exchange
  tradingsymbol: string
  status: string
  status_message?: string
  status_message_raw?: string
  variety: Variety
  product: Product
  order_type: OrderType
  transaction_type: TransactionType
  quantity: number
  filled_quantity: number
  price?: number
  trigger_price?: number
  average_price?: number
  validity: Validity
  disclosed_quantity?: number
  exchange_order_id?: string
  placed_by?: string
  order_timestamp?: ISO8601
  exchange_timestamp?: ISO8601
  tag?: string
}

type PositionPNL = {
  realised?: number
  unrealised?: number
  m2m?: number
  day?: number
}

type Position = {
  product: Product
  exchange: Exchange
  tradingsymbol: string
  instrument_token?: number
  quantity: number
  overnight_quantity?: number
  average_price: number
  close_price?: number
  last_price?: number
  value?: number
  pnl?: PositionPNL
}

type Holding = {
  tradingsymbol: string
  exchange: Exchange
  isin?: string
  quantity: number
  average_price: number
  last_price?: number
  close_price?: number
  pnl?: number
}

type Margins = {
  equity?: {
    enabled: boolean
    net: number
    available: { cash: number; intraday_payin: number; opening_balance?: number; live_balance?: number }
    utilised: Record<string, number>
  }
  commodity?: {
    enabled: boolean
    net: number
    available: { cash: number; intraday_payin: number }
    utilised: Record<string, number>
  }
}

type LTPItem = { instrument: string; last_price: number }
type LTPResponse = Record<string, LTPItem>

type QuoteOHLC = { o: number; h: number; l: number; c: number }
type QuoteItem = {
  instrument: string
  last_price: number
  volume?: number
  ohlc?: QuoteOHLC
  change?: number
}
type QuoteResponse = Record<string, QuoteItem>

type Candle = [ISO8601, number, number, number, number, number] // time, open, high, low, close, volume

type HistoricalQuery = {
  instrument_token: number
  interval: "minute" | "3minute" | "5minute" | "10minute" | "15minute" | "30minute" | "60minute" | "day" | "week" | "month"
  from: ISO8601
  to: ISO8601
  oi?: boolean
}

type HistoricalResponse = { candles: Candle[] }

type HTTPMethod = "GET" | "POST" | "PUT" | "DELETE"

// ---------- Client ----------

class KiteClient {
  private apiKey: string
  private accessToken?: string
  private baseUrl: string
  private timeoutMs: number
  private retries: number
  private softFail: boolean
  private mock: boolean

  constructor(cfg: KiteClientConfig) {
    this.apiKey = cfg.apiKey
    this.accessToken = cfg.accessToken
    this.baseUrl = (cfg.baseUrl || "https://api.kite.trade").replace(/\/+$/, "")
    this.timeoutMs = cfg.timeoutMs ?? 12_000
    this.retries = cfg.retries ?? 2
    this.softFail = !!cfg.softFail
    this.mock = !!cfg.mock || !hasFetch()
  }

  setAccessToken(token: string): void {
    this.accessToken = token
  }

  /** ----- Portfolio ----- */

  async margins(): Promise<Margins | undefined> {
    return this.http<Margins>("/margins", "GET")
  }

  async positions(): Promise<{ day: Position[]; net: Position[] } | undefined> {
    return this.http<{ day: Position[]; net: Position[] }>("/portfolio/positions", "GET")
  }

  async holdings(): Promise<Holding[] | undefined> {
    return this.http<Holding[]>("/portfolio/holdings", "GET")
  }

  /** ----- Orders ----- */

  async placeOrder(variety: Variety, input: PlaceOrderInput): Promise<OrderResponse | undefined> {
    this.assertAuth()
    this.assertPositive("quantity", input.quantity)
    const body: any = {
      exchange: input.exchange,
      tradingsymbol: input.tradingsymbol.toUpperCase(),
      transaction_type: input.transaction_type,
      quantity: input.quantity,
      product: input.product,
      order_type: input.order_type,
      price: numOrUndef(input.price),
      trigger_price: numOrUndef(input.trigger_price),
      disclosed_quantity: numOrUndef(input.disclosed_quantity),
      validity: input.validity || "DAY",
      validity_ttl: numOrUndef(input.validity_ttl),
      iceberg_legs: numOrUndef(input.iceberg_legs),
      iceberg_quantity: numOrUndef(input.iceberg_quantity),
      tag: input.tag,
    }
    // Remove undefined keys
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k]
    return this.http<OrderResponse>(`/orders/${enc(variety)}`, "POST", body)
  }

  async modifyOrder(variety: Variety, order_id: string, patch: ModifyOrderInput): Promise<OrderResponse | undefined> {
    this.assertAuth()
    const body: any = {
      order_id,
      quantity: numOrUndef(patch.quantity),
      price: numOrUndef(patch.price),
      order_type: patch.order_type,
      trigger_price: numOrUndef(patch.trigger_price),
      disclosed_quantity: numOrUndef(patch.disclosed_quantity),
      validity: patch.validity,
      validity_ttl: numOrUndef(patch.validity_ttl),
      iceberg_legs: numOrUndef(patch.iceberg_legs),
      iceberg_quantity: numOrUndef(patch.iceberg_quantity),
      tag: patch.tag,
    }
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k]
    return this.http<OrderResponse>(`/orders/${enc(variety)}/${enc(order_id)}`, "PUT", body)
  }

  async cancelOrder(variety: Variety, order_id: string): Promise<CancelResponse> {
    this.assertAuth()
    try {
      await this.http<void>(`/orders/${enc(variety)}/${enc(order_id)}`, "DELETE")
      return { order_id, status: "canceled" }
    } catch (e: any) {
      const msg = String(e?.message || e)
      if (this.softFail) return { order_id, status: "error", message: msg }
      throw e
    }
  }

  async orders(): Promise<Order[] | undefined> {
    return this.http<Order[]>("/orders", "GET")
  }

  async order(order_id: string): Promise<Order | undefined> {
    return this.http<Order>(`/orders/${enc(order_id)}`, "GET")
  }

  /** ----- Market data ----- */

  async ltp(instruments: string[]): Promise<LTPResponse | undefined> {
    if (!instruments?.length) throw new Error("instruments required, format 'EXCHANGE:SYMBOL'")
    const q = new URLQuery()
    for (const i of instruments) q.add("i", i)
    return this.http<{ data: LTPResponse }>(`/quote/ltp${q.toString()}`, "GET").then(r => r?.data as any)
  }

  async quote(instruments: string[]): Promise<QuoteResponse | undefined> {
    if (!instruments?.length) throw new Error("instruments required, format 'EXCHANGE:SYMBOL'")
    const q = new URLQuery()
    for (const i of instruments) q.add("i", i)
    return this.http<{ data: QuoteResponse }>(`/quote${q.toString()}`, "GET").then(r => r?.data as any)
  }

  async historical(q: HistoricalQuery): Promise<HistoricalResponse | undefined> {
    const qs = new URLQuery()
      .add("from", q.from)
      .add("to", q.to)
      .add("oi", q.oi ? "1" : undefined)
      .toString()
    return this.http<{ data: HistoricalResponse }>(
      `/instruments/historical/${enc(String(q.instrument_token))}/${enc(q.interval)}${qs}`,
      "GET"
    ).then(r => r?.data as any)
  }

  /** ----- Core HTTP ----- */

  private async http<T>(path: string, method: HTTPMethod, body?: any): Promise<T> {
    const url = this.baseUrl + path
    if (this.mock) return this.mockResponse<T>(path, method, body)

    const headers: Record<string, string> = {
      "X-Kite-Version": "3",
      "User-Agent": "kite-ts-min/1.0",
    }
    if (this.accessToken) headers["Authorization"] = `token ${this.apiKey}:${this.accessToken}`
    let payload: string | undefined
    if (body !== undefined) {
      headers["Content-Type"] = "application/json"
      payload = JSON.stringify(body)
    }

    let lastErr: any
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const ctl = newAbort(this.timeoutMs)
      try {
        const res = await (globalThis as any).fetch(url, {
          method,
          headers,
          body: payload,
          signal: ctl.signal,
        } as any)

        const text = await res.text()
        const parsed = safeJson(text)

        if (!res.ok) {
          const msg =
            (parsed && (parsed.message || parsed.error || parsed.status || parsed.data)) ||
            `${res.status} ${res.statusText}` ||
            text
          if (isRetryableStatus(res.status) && attempt < this.retries) {
            await delay(backoffMs(attempt))
            continue
          }
          throw new Error(`HTTP ${method} ${path} failed: ${String(msg)}`)
        }

        // Kite wraps payload in { status, data } often
        // If T expected is not wrapped, we still return parsed?.data or parsed as best-effort
        return (parsed?.data ?? parsed ?? (text as any)) as T
      } catch (e) {
        lastErr = e
        if (attempt < this.retries) {
          await delay(backoffMs(attempt))
          continue
        }
        if (this.softFail) return undefined as any
        throw e
      }
    }
    if (this.softFail) return undefined as any
    throw lastErr
  }

  private mockResponse<T>(path: string, method: HTTPMethod, body?: any): T {
    // Minimal offline responses
    if (path === "/margins" && method === "GET") {
      return {
        equity: {
          enabled: true,
          net: 100000,
          available: { cash: 100000, intraday_payin: 0 },
          utilised: { debits: 0, exposure: 0, m2m: 0, option_premium: 0, payout: 0, span: 0, holding_sales: 0, turnover: 0 },
        },
      } as unknown as T
    }
    if (path === "/portfolio/positions" && method === "GET") {
      return { day: [], net: [] } as unknown as T
    }
    if (path === "/portfolio/holdings" && method === "GET") {
      return [] as unknown as T
    }
    if (path.startsWith("/orders/") && method === "POST") {
      return { order_id: "MOCK-" + Math.random().toString(36).slice(2) } as unknown as T
    }
    if (path.startsWith("/orders/") && (method === "PUT" || method === "DELETE")) {
      return { order_id: path.split("/").pop() || "MOCK" } as unknown as T
    }
    if (path === "/orders" && method === "GET") {
      return [] as unknown as T
    }
    if (path.startsWith("/quote/ltp") && method === "GET") {
      const symbol = getQueryParams(path).i?.[0] || "NSE:INFY"
      const out: any = {}
      out[symbol] = { instrument: symbol, last_price: 1000.5 }
      return out as T
    }
    if (path.startsWith("/quote") && method === "GET") {
      const qs = getQueryParams(path).i || ["NSE:INFY"]
      const out: any = {}
      for (const s of qs) {
        out[s] = { instrument: s, last_price: 1000.5, ohlc: { o: 990, h: 1010, l: 985, c: 998 }, change: 0.5 }
      }
      return out as T
    }
    if (path.startsWith("/instruments/historical") && method === "GET") {
      const now = Date.now()
      const candles: Candle[] = new Array(10).fill(0).map((_, i) => {
        const t = new Date(now - (9 - i) * 24 * 3600 * 1000).toISOString()
        const o = 100 + i
        return [t, o, o + 2, o - 2, o + 1, 100000 + i * 100]
      })
      return { candles } as unknown as T
    }
    return undefined as any
  }

  // ---------- Utils ----------

  private assertAuth(): void {
    if (!this.accessToken) throw new Error("accessToken is not set. Call setAccessToken(token) after login.")
  }

  private assertPositive(name: string, v: number | undefined): void {
    if (!isFinite(v as number) || (v as number) <= 0) throw new Error(`${name} must be > 0`)
  }
}

// ---------- Small helpers (no imports) ----------

function hasFetch(): boolean {
  return typeof (globalThis as any).fetch === "function"
}

function newAbort(timeoutMs: number): AbortController {
  const ctl = new (globalThis as any).AbortController()
  if (typeof (globalThis as any).setTimeout === "function") {
    const t = setTimeout(() => {
      try { ctl.abort() } catch {}
    }, Math.max(1, timeoutMs))
    ctl.signal.addEventListener?.("abort", () => {
      try { clearTimeout(t) } catch {}
    })
  }
  return ctl
}

function delay(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms))
}

function backoffMs(attempt: number): number {
  // 100, 200, 400 + jitter
  const base = 100 * Math.pow(2, Math.max(0, attempt))
  const jitter = Math.floor(Math.random() * 100)
  return base + jitter
}

function isRetryableStatus(code: number): boolean {
  return code === 408 || code === 425 || code === 429 || (code >= 500 && code <= 599)
}

function enc(s: string): string {
  return encodeURIComponent(s)
}

function safeJson(text: string | undefined): any {
  if (!text) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

class URLQuery {
  private pairs: string[] = []
  add(k: string, v: any): URLQuery {
    if (v === undefined || v === null || v === "") return this
    this.pairs.push(`${enc(k)}=${enc(String(v))}`)
    return this
  }
  toString(): string {
    return this.pairs.length ? "?" + this.pairs.join("&") : ""
  }
}

function numOrUndef(x: any): number | undefined {
  if (x === null || x === undefined) return undefined
  const n = typeof x === "number" ? x : parseFloat(String(x))
  return isFinite(n) ? n : undefined
}

function getQueryParams(url: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const i = url.indexOf("?")
  if (i < 0) return out
  const qs = url.substring(i + 1).split("&")
  for (const kv of qs) {
    if (!kv) continue
    const [k, v] = kv.split("=")
    const key = decodeURIComponent(k || "")
    const val = decodeURIComponent(v || "")
    if (!out[key]) out[key] = []
    out[key].push(val)
  }
  return out
}

// ---------- Exports ----------

export {
  KiteClient,
  type KiteClientConfig,
  type Variety,
  type Product,
  type OrderType,
  type Validity,
  type TransactionType,
  type Exchange,
  type PlaceOrderInput,
  type ModifyOrderInput,
  type OrderResponse,
  type CancelResponse,
  type Order,
  type Position,
  type Holding,
  type Margins,
  type LTPResponse,
  type QuoteResponse,
  type QuoteItem,
  type Candle,
  type HistoricalQuery,
  type HistoricalResponse,
}
