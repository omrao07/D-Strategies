// brokers/ibkr.ts
// Pure TypeScript, zero external imports. Minimal client for the IBKR Web API (Client Portal / Gateway).
// Uses global fetch/AbortController if available; otherwise falls back to mock mode.
//
// Notes:
// - IBKR's Web API is sessionful. You must be logged in to the Client Portal (CP) or running the Gateway.
// - This client implements a tiny subset: session keepalive, symbol search->conid, market snapshot,
//   basic order placement, positions, and account list.
// - Endpoints mirror IBKR's documented routes under `/v1/api` (default base for Client Portal).
// - For production, be sure to enforce your own rate limits and full error handling.

type ISO8601 = string
type Side = "BUY" | "SELL"
type TimeInForce = "DAY" | "GTC" | "IOC" | "FOK"
type OrderType = "MKT" | "LMT" | "STP" | "STP_LMT" | "MIT" | "MTL" | "TRAIL" | "REL" | "MOC" | "LOC"

type IBKRClientConfig = {
  baseUrl?: string // e.g. "https://localhost:5000/v1/api" for Client Portal (with proxy/SSL), or "http://127.0.0.1:5000/v1/api"
  timeoutMs?: number
  retries?: number
  softFail?: boolean  // return undefined on network errors instead of throw
  mock?: boolean      // force mock mode (no HTTP)
}

type IBKRAccount = {
  id: string           // account id (e.g., "U1234567")
  accountId?: string   // sometimes present as alternative key
  type?: string
  desc?: string
  linked?: boolean
}

type IBKRPosition = {
  acctId: string
  conid: number
  symbol?: string
  description?: string
  position: number
  mktPrice?: number
  mktValue?: number
  avgCost?: number
  currency?: string
}

type IBKRContractSearchItem = {
  conid: number
  companyName?: string
  symbol?: string
  description?: string
  secType?: string // STK, FUT, OPT, CFD, etc.
  exchange?: string
  currency?: string
}

type MarketSnapshot = {
  conid: number
  fields: Record<string, number | string | null> // raw snapshot key/value (e.g. 31: last, 84: bid, 86: ask, etc.)
  serverTime?: ISO8601
}

type PlaceOrderInput = {
  accountId: string     // target account (Uxxxxxxx)
  conid: number         // IBKR contract id (use search to resolve)
  side: Side            // BUY/SELL
  orderType: OrderType  // e.g. MKT, LMT, STP, STP_LMT
  quantity: number
  tif?: TimeInForce     // DAY/GTC/IOC/FOK
  limitPrice?: number
  stopPrice?: number
  outsideRTH?: boolean
  clientOrderId?: string
}

type PlaceOrderResult = {
  id?: string           // internal IBKR order id (string or numeric)
  status?: string       // "Submitted", "Filled", "Cancelled", etc. (varies)
  transmit?: boolean
  message?: string
  raw?: any             // raw API response for debugging
}

type CancelResult = {
  id: string
  status: "canceled" | "not_found" | "error"
  message?: string
}

type HTTPMethod = "GET" | "POST" | "DELETE"

class IBKRClient {
  private baseUrl: string
  private timeoutMs: number
  private retries: number
  private softFail: boolean
  private mock: boolean

  constructor(cfg: IBKRClientConfig = {}) {
    this.baseUrl = (cfg.baseUrl || "http://127.0.0.1:5000/v1/api").replace(/\/+$/, "")
    this.timeoutMs = cfg.timeoutMs ?? 12_000
    this.retries = cfg.retries ?? 2
    this.softFail = !!cfg.softFail
    this.mock = !!cfg.mock || !hasFetch()
  }

  /** ============ Session ============ */

  /** Ping the session to keep alive. Must be logged in via Client Portal/Gateway. */
  async tickle(): Promise<boolean> {
    if (this.mock) return true
    try {
      const res = await this.http<any>("/iserver/auth/status", "GET")
      // If session is ready => res.authenticated or similar flags (varies by version).
      return !!res
    } catch (e) {
      if (this.softFail) return false
      throw e
    }
  }

  /** ============ Accounts & Portfolio ============ */

  async accounts(): Promise<IBKRAccount[] | undefined> {
    if (this.mock) return [{ id: "U0000000", desc: "Mock Account", linked: false }]
    // Two-step: /iserver/accounts or /portfolio/accounts depending on version
    const a = await this.http<any>("/iserver/accounts", "GET")
    // Normalize to simple list
    const out: IBKRAccount[] = []
    if (a?.accounts && Array.isArray(a.accounts)) {
      for (const x of a.accounts) {
        out.push({ id: x, desc: "Account", linked: true })
      }
    } else if (Array.isArray(a)) {
      for (const x of a) {
        const id = x?.id || x?.accountId || String(x)
        out.push({ id, accountId: id, type: x?.type, desc: x?.desc, linked: !!x?.linked })
      }
    }
    return out
  }

  async positions(accountId: string): Promise<IBKRPosition[] | undefined> {
    if (this.mock) {
      return [{
        acctId: "U0000000",
        conid: 265598, // AAPL
        symbol: "AAPL",
        description: "Apple Inc",
        position: 10,
        mktPrice: 200,
        mktValue: 2000,
        avgCost: 180,
        currency: "USD",
      }]
    }
    const res = await this.http<any>(`/portfolio/${enc(accountId)}/positions`, "GET")
    if (!res || !Array.isArray(res)) return []
    return res.map((r: any) => ({
      acctId: r?.acctId || accountId,
      conid: num(r?.conid) ?? 0,
      symbol: r?.ticker || r?.symbol,
      description: r?.description,
      position: num(r?.position) ?? 0,
      mktPrice: num(r?.mktPrice) ?? undefined,
      mktValue: num(r?.mktValue) ?? undefined,
      avgCost: num(r?.avgCost) ?? undefined,
      currency: r?.currency,
    }))
  }

  /** ============ Contract & Market Data ============ */

  /** Find contracts by symbol text; returns IBKR conids. */
  async searchContracts(query: string, params?: { secType?: string; name?: boolean }): Promise<IBKRContractSearchItem[] | undefined> {
    if (!query) throw new Error("query is required")
    if (this.mock) {
      return [{
        conid: 265598, // AAPL example
        symbol: query.toUpperCase(),
        description: "Mock Equity",
        secType: "STK",
        exchange: "SMART",
        currency: "USD",
      }]
    }
    const body = { symbol: query, name: !!params?.name }
    const rows = await this.http<any>(`/iserver/secdef/search`, "POST", body)
    if (!rows || !Array.isArray(rows)) return []
    const filtered = params?.secType ? rows.filter((r: any) => r?.secType === params.secType) : rows
    return filtered.map((r: any) => ({
      conid: num(r?.conid) ?? 0,
      companyName: r?.companyName,
      symbol: r?.symbol,
      description: r?.description,
      secType: r?.secType,
      exchange: r?.exchange,
      currency: r?.currency,
    }))
  }

  /** Market data snapshot. `fields` are IBKR numeric codes as strings (e.g., "31"=last, "84"=bid, "86"=ask, "85"=bid size, "88"=ask size, "55"=symbol). */
  async snapshot(conids: number[], fields: string[] = ["31","84","86","85","88"]): Promise<MarketSnapshot[] | undefined> {
    if (!conids?.length) throw new Error("conids is required")
    if (this.mock) {
      return conids.map(c => ({
        conid: c,
        fields: { "31": 100.5, "84": 100.4, "86": 100.6, "85": 100, "88": 120 },
        serverTime: new Date().toISOString(),
      }))
    }
    const body = { conids: conids.join(","), fields: fields.join(",") }
    const res = await this.http<any>(`/marketdata/snapshot`, "POST", body)
    if (!res || !Array.isArray(res)) return []
    return res.map((r: any) => ({
      conid: num(r?.conid) ?? 0,
      fields: r || {},
      serverTime: r?._updated || r?.serverTime,
    }))
  }

  /** ============ Orders ============ */

  /** Place an order. For simplicity, uses /iserver/account/{id}/orders. */
  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult | undefined> {
    this.assertPositive("quantity", input.quantity)
    if (!input.accountId) throw new Error("accountId is required")
    if (!isFinite(input.conid)) throw new Error("conid is required")
    if (!input.side) throw new Error("side is required")
    if (!input.orderType) throw new Error("orderType is required")

    if (this.mock) {
      return {
        id: "MOCK-" + Math.random().toString(36).slice(2),
        status: "Submitted",
        transmit: true,
      }
    }

    // IBKR expects a trading object payload. Keep it minimal.
    const body = {
      orders: [
        {
          conid: input.conid,
          orderType: input.orderType,
          side: input.side,
          tif: input.tif || "DAY",
          qty: input.quantity,
          lmtPrice: input.orderType === "LMT" || input.orderType === "STP_LMT" || input.orderType === "LOC" ? input.limitPrice : undefined,
          auxPrice: input.orderType === "STP" || input.orderType === "STP_LMT" || input.orderType === "MIT" ? input.stopPrice : undefined,
          outsideRTH: !!input.outsideRTH,
          cOID: input.clientOrderId, // client order id
          ref: "api",
          // Additional fields can be added as needed: "tifDate", "trailingAmt", "percentOffset", etc.
        }
      ]
    }

    // Step 1: Preview (optional). Some deployments require preview before place.
    // We'll attempt direct place; if error mentions preview, you can add a preview path here.

    const res = await this.http<any>(`/iserver/account/${enc(input.accountId)}/orders`, "POST", body)
    // Response shape varies; standard flow returns an array with order details or errors.
    if (!res) return { raw: res, message: "empty response" }
    const asArr = Array.isArray(res) ? res : [res]
    const first = asArr[0]

    const out: PlaceOrderResult = {
      id: first?.id || first?.order_id || String(first?.id || ""),
      status: first?.order_status || first?.status || "Submitted",
      transmit: true,
      raw: res,
      message: first?.message,
    }
    return out
  }

  /** Cancel an order (best-effort). */
  async cancelOrder(accountId: string, orderId: string): Promise<CancelResult> {
    if (this.mock) return { id: orderId, status: "canceled" }
    try {
      // Some versions use DELETE /iserver/account/{id}/order/{orderId}
      await this.http<void>(`/iserver/account/${enc(accountId)}/order/${enc(orderId)}`, "DELETE")
      return { id: orderId, status: "canceled" }
    } catch (e: any) {
      const msg = String(e?.message || e)
      if (msg.includes("404")) return { id: orderId, status: "not_found" }
      if (this.softFail) return { id: orderId, status: "error", message: msg }
      throw e
    }
  }

  /** ============ Core HTTP ============ */

  private async http<T>(path: string, method: HTTPMethod, body?: any): Promise<T> {
    const url = this.baseUrl + path
    if (this.mock) return this.mockResponse<T>(path, method, body)

    let payload: string | undefined
    const headers: Record<string, string> = {}
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
          // Try to parse JSON error for details
          let msg = `${res.status} ${res.statusText}`
          try {
            const j = await res.json()
            msg = j?.error || j?.message || JSON.stringify(j)
          } catch {
            try { msg = await res.text() } catch {}
          }
          if (isRetryableStatus(res.status) && attempt < this.retries) {
            await delay(backoffMs(attempt))
            continue
          }
          throw new Error(`HTTP ${method} ${path} failed: ${msg}`)
        }
        if (res.status === 204) return undefined as any
        const text = await res.text()
        if (!text) return undefined as any
        try {
          return JSON.parse(text) as T
        } catch {
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
    // Minimal offline behavior
    if (path === "/iserver/auth/status" && method === "GET") {
      return { authenticated: true, connected: true } as unknown as T
    }
    if (path.startsWith("/iserver/secdef/search") && method === "POST") {
      const sym = (body?.symbol || "MOCK").toUpperCase()
      return [{ conid: 999001, symbol: sym, description: sym + " Mock Equity", secType: "STK", exchange: "SMART", currency: "USD" }] as unknown as T
    }
    if (path.startsWith("/marketdata/snapshot") && method === "POST") {
      const conids = String(body?.conids || "").split(",").map(x => parseInt(x, 10)).filter(Boolean)
      return conids.map((c: number) => ({
        conid: c,
        "31": 100.5, "84": 100.4, "86": 100.6, "85": 100, "88": 120
      })) as unknown as T
    }
    if (path.startsWith("/iserver/account/") && path.endsWith("/orders") && method === "POST") {
      return [{ id: "MOCK-" + Math.random().toString(36).slice(2), status: "Submitted" }] as unknown as T
    }
    if (path.startsWith("/portfolio/") && path.endsWith("/positions") && method === "GET") {
      return [{
        acctId: "U0000000",
        conid: 265598,
        position: 10,
        mktPrice: 200,
        mktValue: 2000,
        avgCost: 180,
        currency: "USD",
        ticker: "AAPL",
        description: "Apple Inc",
      }] as unknown as T
    }
    if (path === "/iserver/accounts" && method === "GET") {
      return { accounts: ["U0000000"] } as unknown as T
    }
    return undefined as any
  }

  /** ============ Utils ============ */

  private assertPositive(name: string, v: number): void {
    if (!isFinite(v) || v <= 0) throw new Error(`${name} must be > 0`)
  }
}

/** ===== Helpers (no external deps) ===== */

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
  // 100, 200, 400 (+ jitter)
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

function num(x: any): number | undefined {
  if (x === null || x === undefined) return undefined
  const n = typeof x === "number" ? x : parseFloat(String(x))
  return isFinite(n) ? n : undefined
}

/** ===== Example Usage (comment in to test quickly)
const ib = new IBKRClient({ baseUrl: "http://127.0.0.1:5000/v1/api", mock: true })
;(async () => {
  console.log(await ib.tickle())
  console.log(await ib.accounts())
  const found = await ib.searchContracts("AAPL")
  const conid = found?.[0]?.conid!
  console.log(await ib.snapshot([conid]))
  const acc = (await ib.accounts())![0].id
  const order = await ib.placeOrder({ accountId: acc, conid, side: "BUY", orderType: "MKT", quantity: 1 })
  console.log(order)
})()
*/

export {
  IBKRClient,
  type IBKRClientConfig,
  type IBKRAccount,
  type IBKRPosition,
  type IBKRContractSearchItem,
  type MarketSnapshot,
  type PlaceOrderInput,
  type PlaceOrderResult,
  type CancelResult,
  type OrderType,
  type Side,
  type TimeInForce,
}
