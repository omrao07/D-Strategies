// engine/src/exchange/cme.ts
// CME Exchange Adapter (FIX Gateway abstraction)
// NOTE: CME does NOT support REST trading directly

/* =========================
   Types
   ========================= */

export type CMEEnv = "sim" | "cert" | "prod";

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT";
export type TimeInForce = "DAY" | "GTC" | "IOC";

export interface CMEConfig {
  env: CMEEnv;
  gatewayUrl: string;     // Your FIX/iLink gateway
  senderCompId: string;
  targetCompId: string;
}

export interface OrderRequest {
  symbol: string;         // CME product symbol (e.g. ESU5)
  quantity: number;
  side: OrderSide;
  type: OrderType;
  price?: number;
  tif?: TimeInForce;
}

export interface CMEOrder {
  orderId: string;
  status: "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "REJECTED";
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

export class CMEExchange {
  private readonly config: CMEConfig;

  constructor(config: CMEConfig) {
    this.config = config;
  }

  /* =====================
     Internal FIX Gateway Call
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
        senderCompId: this.config.senderCompId,
        targetCompId: this.config.targetCompId,
        env: this.config.env,
        payload,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`CME Gateway error ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  /* =====================
     Orders
     ===================== */

  async placeOrder(order: OrderRequest): Promise<CMEOrder> {
    return this.gatewayRequest<CMEOrder>("/fix/order/new", {
      symbol: order.symbol,
      quantity: order.quantity,
      side: order.side,
      type: order.type,
      price: order.price,
      tif: order.tif ?? "DAY",
    });
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.gatewayRequest("/fix/order/cancel", { orderId });
  }

  async getOrder(orderId: string): Promise<CMEOrder> {
    return this.gatewayRequest<CMEOrder>("/fix/order/status", { orderId });
  }

  /* =====================
     Positions
     ===================== */

  async getPositions(): Promise<Position[]> {
    return this.gatewayRequest<Position[]>("/fix/positions", {});
  }

  async closePosition(symbol: string, quantity: number): Promise<void> {
    await this.placeOrder({
      symbol,
      quantity,
      side: "SELL",
      type: "MARKET",
    });
  }
}