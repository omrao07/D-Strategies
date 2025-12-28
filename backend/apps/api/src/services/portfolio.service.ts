/*
|--------------------------------------------------------------------------
| Portfolio Service
|--------------------------------------------------------------------------
| Aggregates portfolio state, holdings, PnL, and transactions
| Real broker / data integrations plug in here later
|--------------------------------------------------------------------------
*/

type Holding = {
  symbol: string
  quantity: number
  averagePrice: number
  currentPrice?: number
}

type Transaction = {
  id: string
  symbol: string
  quantity: number
  side: "BUY" | "SELL"
  price: number
  timestamp: string
}

/* ---------------- Portfolio Overview ---------------- */

export async function fetchPortfolioOverview() {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    message: "Portfolio backend connected successfully",
  }
}

/* ---------------- Holdings ---------------- */

export async function fetchHoldings() {
  const holdings: Holding[] = []

  return {
    holdings,
    totalHoldings: holdings.length,
  }
}

/* ---------------- Profit & Loss ---------------- */

export async function fetchPnL() {
  return {
    pnl: 0,
    dayPnl: 0,
    currency: "INR",
    updatedAt: new Date().toISOString(),
  }
}

/* ---------------- Transactions ---------------- */

export async function fetchTransactions() {
  const transactions: Transaction[] = []

  return {
    transactions,
    totalTransactions: transactions.length,
  }
}