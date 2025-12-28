/*
|--------------------------------------------------------------------------
| Portfolio Types
|--------------------------------------------------------------------------
| Shared portfolio contracts across services, controllers & strategies
|--------------------------------------------------------------------------
*/

/* ---------------- Holdings ---------------- */

export type Holding = {
  symbol: string
  exchange?: string
  quantity: number
  averagePrice: number
  currentPrice?: number
  marketValue?: number
  unrealizedPnL?: number
  realizedPnL?: number
  currency?: string
}

/* ---------------- Portfolio Summary ---------------- */

export type PortfolioSummary = {
  totalValue: number
  investedValue: number
  totalPnL: number
  dayPnL: number
  currency: string
  updatedAt: string
}

/* ---------------- Transactions ---------------- */

export type Transaction = {
  id: string
  symbol: string
  exchange?: string
  quantity: number
  side: "BUY" | "SELL"
  price: number
  fees?: number
  broker?: string
  orderId?: string
  timestamp: string
}

/* ---------------- Orders ---------------- */

export type Order = {
  orderId: string
  symbol: string
  quantity: number
  side: "BUY" | "SELL"
  orderType: "MARKET" | "LIMIT"
  price?: number
  status:
  | "submitted"
  | "filled"
  | "partial"
  | "cancelled"
  | "rejected"
  broker?: string
  createdAt: string
  updatedAt?: string
}

/* ---------------- Portfolio State ---------------- */

export type PortfolioState = {
  summary: PortfolioSummary
  holdings: Holding[]
  openOrders?: Order[]
  transactions?: Transaction[]
}

/* ---------------- Strategy Input ---------------- */

export type PortfolioStrategyInput = {
  holdings: Holding[]
  cashBalance: number
  currency: string
}

/* ---------------- Utility ---------------- */

export function calculateMarketValue(
  holding: Holding
): number | null {
  if (
    holding.currentPrice == null ||
    holding.quantity == null
  ) {
    return null
  }
  return holding.currentPrice * holding.quantity
}