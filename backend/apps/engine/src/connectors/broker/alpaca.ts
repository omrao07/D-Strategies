// engine/src/brokers/alpaca.ts
// Alpaca Broker Adapter (REST v2)
// No external dependencies

/* =========================
   Types
   ========================= */

export type AlpacaEnv = "paper" | "live";

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop" | "stop_limit";
export type TimeInForce = "day" | "gtc" | "ioc" | "fok";

export interface AlpacaConfig {
  apiKey: string;
  apiSecret: string;
  env?: AlpacaEnv;
}

export interface OrderRequest {
  symbol: string;
  qty: number;
  side: OrderSide;
  type?: OrderType;
  timeInForce?: TimeInForce;
  limitPrice?: number;
  stopPrice?: number;
}

export interface AlpacaOrder {
  id: string;
  symbol: string;
  qty: string;
  side: OrderSide;
  type: OrderType;
  status: string;
  filled_qty: string;
  created_at: string;
}

export interface Position {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  unrealized_pl: string;
}

/* =========================
   Constants
   ========================= */

const BASE_URLS: Record<AlpacaEnv, string> = {
  paper: "https://paper-api.alpaca.markets",
  live: "https://api.alpaca.markets",
};

/* =========================
   Broker
   ========================= */

export class AlpacaBroker {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: AlpacaConfig) {
    const env: AlpacaEnv = config.env ?? "paper";

    this.baseUrl = BASE_URLS[env];
    this.headers = {
      "APCA-API-KEY-ID": config.apiKey,
      "APCA-API-SECRET-KEY": config.apiSecret,
      "Content-Type": "application/json",
    };
  }

  /* =====================
     Internal Fetch
     ===================== */

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        ...this.headers,
        ...(options.headers || {}),
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Alpaca API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  /* =====================
     Account
     ===================== */

  async getAccount(): Promise<any> {
    return this.request("/v2/account");
  }

  /* =====================
     Orders
     ===================== */

  async placeOrder(order: OrderRequest): Promise<AlpacaOrder> {
    const payload: Record<string, unknown> = {
      symbol: order.symbol,
      qty: order.qty,
      side: order.side,
      type: order.type ?? "market",
      time_in_force: order.timeInForce ?? "day",
    };

    if (order.limitPrice) payload.limit_price = order.limitPrice;
    if (order.stopPrice) payload.stop_price = order.stopPrice;

    return this.request<AlpacaOrder>("/v2/orders", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request(`/v2/orders/${orderId}`, {
      method: "DELETE",
    });
  }

  async getOrders(status: "open" | "closed" | "all" = "open"): Promise<AlpacaOrder[]> {
    return this.request(`/v2/orders?status=${status}`);
  }

  /* =====================
     Positions
     ===================== */

  async getPositions(): Promise<Position[]> {
    return this.request("/v2/positions");
  }

  async closePosition(symbol: string): Promise<void> {
    await this.request(`/v2/positions/${symbol}`, {
      method: "DELETE",
    });
  }

  async closeAllPositions(): Promise<void> {
    await this.request("/v2/positions", {
      method: "DELETE",
    });
  }
}