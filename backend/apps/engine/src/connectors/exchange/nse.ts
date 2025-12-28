// engine/src/exchange/nse.ts
// NSE Exchange Adapter (Broker / Market Data Gateway abstraction)
// NOTE: NSE does NOT expose a direct trading REST API

/* =========================
   Types
   ========================= */

export type NSEEnv = "sim" | "paper" | "live";

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT";
export type TimeInForce = "DAY" | "IOC";

export interface NSEConfig {
  env: NSEEnv;
  gatewayUrl: string;        // Internal broker or data gateway
  exchange: "NSE";
}

export interface OrderRequest {
  symbol: string;            // e.g. RELIANCE, NIFTY24JANFUT
  quantity: number;
  side: OrderSide;
  type: OrderType;
  price?: number;
  tif?: TimeInForce;
  product?: "CNC" | "MIS" | "NRML";
}

export interface NSEOrder {
  orderId: string;
  status:
  | "NEW"
  | "OPEN"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "REJECTED";
  filledQty: number;
  avgPrice?: number;
}

export interface Position {
  symbol: string;
  quantity: number;
  avgPrice: number;
  unrealizedPnL: number;
}

/* =========================
   Exchange Adapter
   ========================= */

export class NSEExchange {
  private readonly config: NSEConfig;

  constructor(config: NSEConfig) {
    this.config = config;
  }

  /* =====================
     Internal Gateway Call
     ===================== */

  private async gatewayRequest<T>(
    endpoint: string,
    payload: unknown
  ): Promise<T> {
    const res = await fetch(`${this.config.gatewayUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        exchange: this.config.exchange,
        env: this.config.env,
        payload,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`NSE Gateway error ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  /* =====================
     Orders
     ===================== */

  async placeOrder(order: OrderRequest): Promise<NSEOrder> {
    return this.gatewayRequest<NSEOrder>("/order/place", {
      symbol: order.symbol,
      quantity: order.quantity,
      side: order.side,
      type: order.type,
      price: order.price,
      tif: order.tif ?? "DAY",
      product: order.product ?? "CNC",
    });
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.gatewayRequest("/order/cancel", { orderId });
  }

  async getOrder(orderId: string): Promise<NSEOrder> {
    return this.gatewayRequest<NSEOrder>("/order/status", { orderId });
  }

  /* =====================
     Positions
     ===================== */

  async getPositions(): Promise<Position[]> {
    return this.gatewayRequest<Position[]>("/positions", {});
  }

  async closePosition(symbol: string, quantity: number): Promise<void> {
    await this.placeOrder({
      symbol,
      quantity,
      side: quantity > 0 ? "SELL" : "BUY",
      type: "MARKET",
    });
  }
}