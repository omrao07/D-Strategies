// brokers/alpaca.ts
// Pure TypeScript, zero imports. Minimal REST client for Alpaca (paper/live) with retries & timeouts.
// Uses global fetch/AbortController. If unavailable, falls back to a no-op mock mode.

type Side = "buy" | "sell"
type OrderType = "market" | "limit" | "stop" | "stop_limit" | "trailing_stop"
type TimeInForce = "day" | "gtc" | "opg" | "cls" | "ioc" | "fok"
type OrderClass = "simple" | "bracket" | "oco" | "oto"

type ISO8601 = string

type AlpacaClientConfig = {
  key: string
  secret: string
  paper?: boolean
  baseUrl?: string // override if needed
  dataBaseUrl?: string // market data v2 base
  timeoutMs?: number
  retries?: number
  softFail?: boolean // if true, returns undefined on network errors instead of throwing
  mock?: boolean // if true, no real HTTP calls
}

type Account = {
  id: string
  account_number: string
  status: string
  currency: string
  buying_power: string
  cash: string
  portfolio_value: string
  pattern_day_trader: boolean
  created_at: ISO8601
  trading_blocked: boolean
  transfers_blocked: boolean
  account_blocked: boolean
}

type Position = {
  asset_id: string
  symbol: string
  exchange: string
  asset_class: string
  qty: string
  avg_entry_price: string
  market_value: string
  cost_basis: string
  unrealized_pl: string
  unrealized_plpc: string
  current_price: string
  lastday_price: string
  change_today: string
}

type Order = {
  id: string
  client_order_id: string
  created_at: ISO8601
  submitted_at?: ISO8601
  filled_at?: ISO8601
  expired_at?: ISO8601
  canceled_at?: ISO8601
  failed_at?: ISO8601
  replaced_at?: ISO8601
  replaced_by?: string
  replaces?: string
  asset_id: string
  symbol: string
  asset_class: string
  notional?: string
  qty?: string
  filled_qty: string
  filled_avg_price?: string
  order_class: OrderClass
  type: OrderType
  side: Side
  time_in_force: TimeInForce
  limit_price?: string
  stop_price?: string
  trail_price?: string
  trail_percent?: string
  extended_hours?: boolean
  status:
    | "new" | "partially_filled" | "filled" | "done_for_day"
    | "canceled" | "expired" | "replaced" | "pending_cancel"
    | "pending_replace" | "accepted" | "pending_new" | "stopped"
}

type PlaceOrderInput = {
  symbol: string
  side: Side
  type: OrderType
  time_in_force: TimeInForce
  qty?: number | string
  notional?: number | string
  limit_price?: number | string
  stop_price?: number | string
  trail_price?: number | string
  trail_percent?: number | string
  extended_hours?: boolean
  order_class?: OrderClass
  take_profit?: { limit_price: number | string }
  stop_loss?: { stop_price: number | string; limit_price?: number | string }
  client_order_id?: string
}

type CancelResult = { id: string; status: "canceled" | "not_found" | "error"; message?: string }

type Clock = {
  timestamp: ISO8601
  is_open: boolean
  next_open: ISO8601
  next_close: ISO8601
}

type Bar = {
  t: ISO8601 // time
  o: number
  h: number
  l: number
  c: number
  v: number
  n?: number // number of trades (if provided)
  vw?: number // volume-weighted price
}

type BarsResponse = { symbol: string; timeframe: string; bars: Bar[]; next_page_token?: string }

type BarsQuery = {
  symbol: string
  timeframe: "1Min" | "5Min" | "15Min" | "1Hour" | "1Day"
  start?: ISO8601
  end?: ISO8601
  limit?: number // up to API caps
  page_token?: string
  adjustment?: "raw" | "split" | "dividend" | "all"
}

type HTTPMethod = "GET" | "POST" | "DELETE"

class AlpacaClient {
  private key: string
  private secret: string
  private baseUrl: string
  private dataBaseUrl: string
  private timeoutMs: number
  private retries: number
  private softFail: boolean
  private mock: boolean

  constructor(cfg: AlpacaClientConfig) {
    this.key = cfg.key
    this.secret = cfg.secret
    const isPaper = !!cfg.paper
    this.baseUrl =
      cfg.baseUrl ||
      (isPaper
        ? "https://paper-api.alpaca.markets"
        : "https://api.alpaca.markets")
    this.dataBaseUrl =
      cfg.dataBaseUrl ||
      "https://data.alpaca.markets/v2"
    this.timeoutMs = cfg.timeoutMs ?? 12_000
    this.retries = cfg.retries ?? 2
    this.softFail = !!cfg.softFail
    this.mock = !!cfg.mock || !hasFetch()
  }

  /** ===== Core HTTP ===== */

  private async http<T>(
    path: string,
    method: HTTPMethod = "GET",
    body?: any,
    isDataAPI = false
  ): Promise<T> {
    if (this.mock) return this.mockResponse<T>(path, method, body)

    const url = (isDataAPI ? this.dataBaseUrl : this.baseUrl) + path
    const headers: Record<string, string> = {
      "APCA-API-KEY-ID": this.key,
      "APCA-API-SECRET-KEY": this.secret,
    }
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
        if (!res.ok) {
          // Try to parse error JSON, else text
          let msg = `${res.status} ${res.statusText}`
          try {
            const errJson = await res.json()
            msg = errJson?.message || errJson?.error || JSON.stringify(errJson)
          } catch {
            try {
              msg = await res.text()
            } catch {}
          }
          if (isRetryableStatus(res.status) && attempt < this.retries) {
            await delay(backoffMs(attempt))
            continue
          }
          throw new Error(`HTTP ${method} ${path} failed: ${msg}`)
        }
        // 204 no content
        if (res.status === 204) return undefined as any
        const text = await res.text()
        if (!text) return undefined as any
        try {
          return JSON.parse(text) as T
        } catch {
          // market data sometimes returns CSV? (not in v2 bars; still guard)
          return (text as any) as T
        }
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
    // Lightweight mock data for offline/tests
    if (path === "/v2/account" && method === "GET") {
      return {
        id: "mock",
        account_number: "PA-00000000",
        status: "ACTIVE",
        currency: "USD",
        buying_power: "100000.00",
        cash: "100000.00",
        portfolio_value: "100000.00",
        pattern_day_trader: false,
        created_at: new Date().toISOString(),
        trading_blocked: false,
        transfers_blocked: false,
        account_blocked: false,
      } as unknown as T
    }
    if (path.startsWith("/v2/positions") && method === "GET") {
      return [] as unknown as T
    }
    if (path === "/v2/orders" && method === "POST") {
      const now = new Date().toISOString()
      const o: Order = {
        id: "ord_mock_" + Math.random().toString(36).slice(2),
        client_order_id: body?.client_order_id || "cli_" + Math.random().toString(36).slice(2),
        created_at: now,
        asset_id: "asset_mock",
        symbol: String(body?.symbol || "SPY"),
        asset_class: "us_equity",
        order_class: (body?.order_class || "simple") as OrderClass,
        type: (body?.type || "market") as OrderType,
        side: (body?.side || "buy") as Side,
        time_in_force: (body?.time_in_force || "day") as TimeInForce,
        filled_qty: "0",
        status: "accepted",
        limit_price: body?.limit_price ? String(body.limit_price) : undefined,
        stop_price: body?.stop_price ? String(body.stop_price) : undefined,
        extended_hours: !!body?.extended_hours,
      }
      return o as unknown as T
    }
    if (path.startsWith("/v2/stocks/bars")) {
      const now = Date.now()
      const bars: Bar[] = new Array(10).fill(0).map((_, i) => ({
        t: new Date(now - (9 - i) * 60_000).toISOString(),
        o: 100 + i,
        h: 101 + i,
        l: 99 + i,
        c: 100.5 + i,
        v: 10000 + i * 100,
      }))
      return { symbol: getQueryParam(path, "symbols")?.split(",")[0] || "SPY", timeframe: getQueryParam(path, "timeframe") || "1Min", bars } as unknown as T
    }
    // Default mock: undefined
    return undefined as any
  }

  /** ===== Public API ===== */

  async account(): Promise<Account | undefined> {
    return this.http<Account>("/v2/account", "GET")
  }

  async positions(): Promise<Position[] | undefined> {
    return this.http<Position[]>("/v2/positions", "GET")
  }

  async getPosition(symbol: string): Promise<Position | undefined> {
    return this.http<Position>(`/v2/positions/${encode(symbol)}`, "GET")
  }

  async orders(params?: {
    status?: "open" | "closed" | "all"
    limit?: number
    after?: ISO8601
    until?: ISO8601
    direction?: "asc" | "desc"
    nested?: boolean
    symbols?: string[]
  }): Promise<Order[] | undefined> {
    const q = new URLQuery()
      .add("status", params?.status)
      .add("limit", params?.limit)
      .add("after", params?.after)
      .add("until", params?.until)
      .add("direction", params?.direction)
      .add("nested", params?.nested)
      .add("symbols", params?.symbols?.join(","))
      .toString()
    return this.http<Order[]>(`/v2/orders${q}`, "GET")
  }

  async placeOrder(input: PlaceOrderInput): Promise<Order | undefined> {
    // Basic validations
    if (!input.symbol) throw new Error("symbol is required")
    if (!input.type) throw new Error("type is required")
    if (!input.time_in_force) throw new Error("time_in_force is required")
    if (!input.side) throw new Error("side is required")
    if (!input.qty && !input.notional) throw new Error("either qty or notional is required")

    const body: any = {
      symbol: input.symbol.toUpperCase(),
      side: input.side,
      type: input.type,
      time_in_force: input.time_in_force,
      qty: input.qty !== undefined ? String(input.qty) : undefined,
      notional: input.notional !== undefined ? String(input.notional) : undefined,
      limit_price: input.limit_price !== undefined ? String(input.limit_price) : undefined,
      stop_price: input.stop_price !== undefined ? String(input.stop_price) : undefined,
      trail_price: input.trail_price !== undefined ? String(input.trail_price) : undefined,
      trail_percent: input.trail_percent !== undefined ? String(input.trail_percent) : undefined,
      extended_hours: !!input.extended_hours,
      order_class: input.order_class || "simple",
      take_profit: input.take_profit ? { limit_price: String(input.take_profit.limit_price) } : undefined,
      stop_loss: input.stop_loss
        ? { stop_price: String(input.stop_loss.stop_price), limit_price: input.stop_loss.limit_price !== undefined ? String(input.stop_loss.limit_price) : undefined }
        : undefined,
      client_order_id: input.client_order_id,
    }

    return this.http<Order>("/v2/orders", "POST", body)
  }

  async cancelOrder(orderId: string): Promise<CancelResult> {
    try {
      await this.http<void>(`/v2/orders/${encode(orderId)}`, "DELETE")
      return { id: orderId, status: "canceled" }
    } catch (e: any) {
      const msg = String(e?.message || e)
      if (msg.includes("404")) return { id: orderId, status: "not_found" }
      if (this.softFail) return { id: orderId, status: "error", message: msg }
      throw e
    }
  }

  async getOrder(orderId: string): Promise<Order | undefined> {
    return this.http<Order>(`/v2/orders/${encode(orderId)}`, "GET")
  }

  async clock(): Promise<Clock | undefined> {
    return this.http<Clock>("/v2/clock", "GET")
  }

  /** Market data v2 bars. If limit exceeds API cap, you'll get fewer. Use page_token for pagination. */
  async bars(q: BarsQuery): Promise<BarsResponse | undefined> {
    if (!q?.symbol) throw new Error("symbol is required")
    const query = new URLQuery()
      .add("timeframe", q.timeframe || "1Min")
      .add("symbols", q.symbol.toUpperCase())
      .add("start", q.start)
      .add("end", q.end)
      .add("limit", q.limit)
      .add("page_token", q.page_token)
      .add("adjustment", q.adjustment)
      .toString()

    // Data API path differs: /stocks/bars?symbols=... returns { bars: { SYMBOL: [ {t,...} ] }, next_page_token }
    const raw = await this.http<any>(`/stocks/bars${query}`, "GET", undefined, true)
    if (!raw) return undefined
    const bars: Bar[] = (raw?.bars?.[q.symbol.toUpperCase()] || []).map((b: any) => ({
      t: b?.t || b?.Timestamp || b?.time,
      o: num(b?.o) ?? 0,
      h: num(b?.h) ?? 0,
      l: num(b?.l) ?? 0,
      c: num(b?.c) ?? 0,
      v: num(b?.v) ?? 0,
      n: num(b?.n) ?? undefined,
      vw: num(b?.vw) ?? undefined,
    }))
    return {
      symbol: q.symbol.toUpperCase(),
      timeframe: q.timeframe,
      bars,
      next_page_token: raw?.next_page_token,
    }
  }

  /** Convenience: fetch up to `maxBars` by following page tokens. */
  async barsAll(q: BarsQuery & { maxBars?: number }): Promise<Bar[] | undefined> {
    const out: Bar[] = []
    let token: string | undefined = undefined
    let remain = q.maxBars ?? q.limit ?? 1000
    do {
      const page = await this.bars({ ...q, limit: Math.min(10_000, remain), page_token: token })
      if (!page?.bars?.length) break
      out.push(...page.bars)
      remain -= page.bars.length
      token = page.next_page_token
    } while (token && remain > 0)
    return out
  }
}

/** ===== Helpers (no imports) ===== */

function hasFetch(): boolean {
  return typeof (globalThis as any).fetch === "function"
}

function newAbort(timeoutMs: number): AbortController {
  const ctl = new (globalThis as any).AbortController()
  if (typeof (globalThis as any).setTimeout === "function") {
    const t = setTimeout(() => {
      try { ctl.abort() } catch {}
    }, Math.max(1, timeoutMs))
    // Best-effort cleanup when signal aborts
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
  // attempt: 0,1,2... => 100, 200, 400 (+ jitter)
  const base = 100 * Math.pow(2, Math.max(0, attempt))
  const jitter = Math.floor(Math.random() * 100)
  return base + jitter
}

function isRetryableStatus(code: number): boolean {
  return code === 408 || code === 425 || code === 429 || (code >= 500 && code <= 599)
}

function encode(s: string): string {
  return encodeURIComponent(s)
}

class URLQuery {
  private pairs: string[] = []
  add(k: string, v: any): URLQuery {
    if (v === undefined || v === null || v === "") return this
    this.pairs.push(`${encode(k)}=${encode(String(v))}`)
    return this
  }
  toString(): string {
    return this.pairs.length ? "?" + this.pairs.join("&") : ""
  }
}

function num(x: any): number | undefined {
  if (x === null || x === undefined) return undefined
  const n = typeof x === "number" ? x : parseFloat(String(x))
  return isFinite(n) ? n : undefined
}

function getQueryParam(url: string, key: string): string | undefined {
  const i = url.indexOf("?")
  if (i < 0) return undefined
  const qs = url.substring(i + 1).split("&")
  for (const kv of qs) {
    const [k, v] = kv.split("=")
    if (decodeURIComponent(k) === key) return decodeURIComponent(v || "")
  }
  return undefined
}

/** ===== Example Usage (comment out in production) =====
const alpaca = new AlpacaClient({
  key: "<YOUR_KEY>",
  secret: "<YOUR_SECRET>",
  paper: true,
  mock: false,
  softFail: false,
})

;(async () => {
  console.log(await alpaca.account())
  console.log(await alpaca.positions())
  const ord = await alpaca.placeOrder({
    symbol: "AAPL",
    side: "buy",
    type: "market",
    time_in_force: "day",
    qty: 1,
  })
  console.log(ord)
  console.log(await alpaca.bars({ symbol: "AAPL", timeframe: "1Day", limit: 50 }))
})()
*/

export {
  AlpacaClient,
  type AlpacaClientConfig,
  type Account,
  type Position,
  type Order,
  type PlaceOrderInput,
  type Bar,
  type BarsResponse,
  type BarsQuery,
}
