// engine/src/brokers/zerodha.ts
// Zerodha Kite Connect Broker Adapter
// No external dependencies

/* =========================
   Types
   ========================= */

export type ZerodhaEnv = "paper" | "live";

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "SL" | "SL-M";
export type ProductType = "CNC" | "MIS" | "NRML";
export type Exchange = "NSE" | "BSE" | "NFO" | "CDS" | "MCX";
export type Validity = "DAY" | "IOC";

export interface ZerodhaConfig {
  apiKey: string;
  accessToken: string; // generated via login flow
  env?: ZerodhaEnv;
}

export interface OrderRequest {
  exchange: Exchange;
  tradingsymbol: string;
  quantity: number;
  side: OrderSide;
  type?: OrderType;
  product?: ProductType;
  validity?: Validity;
  price?: number;
  triggerPrice?: number;
}

export interface ZerodhaOrder {
  order_id: string;
  status: string;
}

export interface Position {
  tradingsymbol: string;
  exchange: Exchange;
  quantity: number;
  average_price: number;
  pnl: number;
}

/* =========================
   Constants
   ========================= */

const BASE_URL = "https://api.kite.trade";

/* =========================
   Broker
   ========================= */

export class ZerodhaBroker {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: ZerodhaConfig) {
    this.baseUrl = BASE_URL;

    this.headers = {
      "X-Kite-Version": "3",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `token ${config.apiKey}:${config.accessToken}`,
    };
  }

  /* =====================
     Internal Request
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
      throw new Error(`Zerodha API error ${res.status}: ${text}`);
    }

    const json = await res.json();
    return json.data as T;
  }

  /* =====================
     Orders
     ===================== */

  async placeOrder(order: OrderRequest): Promise<ZerodhaOrder> {
    const body = new URLSearchParams({
      exchange: order.exchange,
      tradingsymbol: order.tradingsymbol,
      transaction_type: order.side,
      quantity: String(order.quantity),
      order_type: order.type ?? "MARKET",
      product: order.product ?? "CNC",
      validity: order.validity ?? "DAY",
    });

    if (order.price !== undefined) {
      body.append("price", String(order.price));
    }

    if (order.triggerPrice !== undefined) {
      body.append("trigger_price", String(order.triggerPrice));
    }

    return this.request<ZerodhaOrder>("/orders/regular", {
      method: "POST",
      body,
    });
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request(`/orders/regular/${orderId}`, {
      method: "DELETE",
    });
  }

  async getOrders(): Promise<ZerodhaOrder[]> {
    return this.request("/orders");
  }

  /* =====================
     Positions
     ===================== */

  async getPositions(): Promise<Position[]> {
    const res = await this.request<{
      net: Position[];
    }>("/portfolio/positions");

    return res.net;
  }

  async closePosition(
    exchange: Exchange,
    tradingsymbol: string,
    quantity: number
  ): Promise<void> {
    await this.placeOrder({
      exchange,
      tradingsymbol,
      quantity: Math.abs(quantity),
      side: quantity > 0 ? "SELL" : "BUY",
      type: "MARKET",
      product: "CNC",
    });
  }
}