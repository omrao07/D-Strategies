// engine/src/exchange/binance.ts
// Binance Spot Exchange Adapter (REST API)
// No external dependencies

/* =========================
   Types
   ========================= */

export type BinanceEnv = "testnet" | "live";

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT";
export type TimeInForce = "GTC" | "IOC" | "FOK";

export interface BinanceConfig {
  apiKey: string;
  apiSecret: string;
  env?: BinanceEnv;
}

export interface OrderRequest {
  symbol: string;              // e.g. BTCUSDT
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  timeInForce?: TimeInForce;
}

export interface BinanceOrder {
  symbol: string;
  orderId: number;
  status: string;
  executedQty: string;
  cummulativeQuoteQty: string;
}

export interface Balance {
  asset: string;
  free: string;
  locked: string;
}

/* =========================
   Constants
   ========================= */

const BASE_URL: Record<BinanceEnv, string> = {
  live: "https://api.binance.com",
  testnet: "https://testnet.binance.vision",
};

/* =========================
   Utils
   ========================= */

async function hmacSHA256(
  secret: string,
  message: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message)
  );

  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* =========================
   Exchange
   ========================= */

export class BinanceExchange {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor(config: BinanceConfig) {
    const env = config.env ?? "live";
    this.baseUrl = BASE_URL[env];
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
  }

  /* =====================
     Internal Request
     ===================== */

  private async signedRequest<T>(
    path: string,
    params: URLSearchParams,
    method: "GET" | "POST" | "DELETE" = "GET"
  ): Promise<T> {
    params.append("timestamp", Date.now().toString());

    const query = params.toString();
    const signature = await hmacSHA256(this.apiSecret, query);
    params.append("signature", signature);

    const res = await fetch(`${this.baseUrl}${path}?${params.toString()}`, {
      method,
      headers: {
        "X-MBX-APIKEY": this.apiKey,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Binance API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  /* =====================
     Public (No Auth)
     ===================== */

  async ping(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v3/ping`);
    if (!res.ok) {
      throw new Error("Binance ping failed");
    }
  }

  async getServerTime(): Promise<number> {
    const res = await fetch(`${this.baseUrl}/api/v3/time`);
    const json = await res.json();
    return json.serverTime;
  }

  /* =====================
     Account
     ===================== */

  async getBalances(): Promise<Balance[]> {
    const data = await this.signedRequest<{ balances: Balance[] }>(
      "/api/v3/account",
      new URLSearchParams()
    );
    return data.balances;
  }

  /* =====================
     Orders
     ===================== */

  async placeOrder(order: OrderRequest): Promise<BinanceOrder> {
    const params = new URLSearchParams({
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity.toString(),
    });

    if (order.type === "LIMIT") {
      if (!order.price) {
        throw new Error("Limit order requires price");
      }
      params.append("price", order.price.toString());
      params.append("timeInForce", order.timeInForce ?? "GTC");
    }

    return this.signedRequest<BinanceOrder>(
      "/api/v3/order",
      params,
      "POST"
    );
  }

  async cancelOrder(
    symbol: string,
    orderId: number
  ): Promise<void> {
    const params = new URLSearchParams({
      symbol,
      orderId: orderId.toString(),
    });

    await this.signedRequest(
      "/api/v3/order",
      params,
      "DELETE"
    );
  }

  async getOpenOrders(symbol?: string): Promise<BinanceOrder[]> {
    const params = new URLSearchParams();
    if (symbol) params.append("symbol", symbol);

    return this.signedRequest<BinanceOrder[]>(
      "/api/v3/openOrders",
      params
    );
  }
}