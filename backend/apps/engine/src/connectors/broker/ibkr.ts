// engine/src/brokers/ibkr.ts
// Interactive Brokers (IBKR) Client Portal Gateway Adapter
// No external dependencies

/* =========================
   Types
   ========================= */

export type IBKREnv = "paper" | "live";

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MKT" | "LMT" | "STP" | "STP_LMT";
export type TimeInForce = "DAY" | "GTC";

export interface IBKRConfig {
  baseUrl: string; // e.g. http://localhost:5000 (Client Portal Gateway)
  accountId: string;
}

export interface OrderRequest {
  conid: number;          // IBKR contract ID
  side: OrderSide;
  quantity: number;
  type?: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  tif?: TimeInForce;
}

export interface IBKROrder {
  order_id: number;
  status: string;
}

export interface Position {
  conid: number;
  symbol: string;
  position: number;
  avgCost: number;
  marketValue: number;
  unrealizedPNL: number;
}

/* =========================
   Broker
   ========================= */

export class IBKRBroker {
  private readonly baseUrl: string;
  private readonly accountId: string;

  constructor(config: IBKRConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.accountId = config.accountId;
  }

  /* =====================
     Internal Request
     ===================== */

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      credentials: "include", // IBKR auth via cookies
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`IBKR API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  /* =====================
     Session
     ===================== */

  async tickle(): Promise<void> {
    await this.request("/v1/api/tickle", { method: "POST" });
  }

  async isAuthenticated(): Promise<boolean> {
    const res = await this.request<{ authenticated: boolean }>(
      "/v1/api/iserver/auth/status"
    );
    return res.authenticated;
  }

  /* =====================
     Orders
     ===================== */

  async placeOrder(order: OrderRequest): Promise<IBKROrder[]> {
    const payload = {
      orders: [
        {
          conid: order.conid,
          side: order.side,
          quantity: order.quantity,
          orderType: order.type ?? "MKT",
          price: order.limitPrice,
          auxPrice: order.stopPrice,
          tif: order.tif ?? "DAY",
        },
      ],
    };

    return this.request<IBKROrder[]>(
      `/v1/api/iserver/account/${this.accountId}/orders`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    );
  }

  async cancelOrder(orderId: number): Promise<void> {
    await this.request(
      `/v1/api/iserver/account/${this.accountId}/order/${orderId}`,
      { method: "DELETE" }
    );
  }

  async getOpenOrders(): Promise<IBKROrder[]> {
    return this.request("/v1/api/iserver/account/orders");
  }

  /* =====================
     Positions
     ===================== */

  async getPositions(): Promise<Position[]> {
    return this.request(
      `/v1/api/portfolio/${this.accountId}/positions/0`
    );
  }

  async closePosition(conid: number, quantity: number): Promise<void> {
    await this.placeOrder({
      conid,
      side: "SELL",
      quantity,
      type: "MKT",
    });
  }
}