/*
|--------------------------------------------------------------------------
| Market Service
|--------------------------------------------------------------------------
| Orchestrates market data across equities, crypto, forex
| Vendor connectors (Finnhub, Polygon, TwelveData) plug in here later
|--------------------------------------------------------------------------
*/

type MarketQuery = {
  symbols?: string | string[]
  limit?: number
}

/* ---------------- Market Snapshot ---------------- */

export async function fetchMarketSnapshot() {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    message: "Market snapshot connected successfully",
  }
}

/* ---------------- Equities ---------------- */

export async function fetchEquities(_query: MarketQuery) {
  return {
    type: "equities",
    data: [],
  }
}

/* ---------------- Crypto ---------------- */

export async function fetchCrypto(_query: MarketQuery) {
  return {
    type: "crypto",
    data: [],
  }
}

/* ---------------- Forex ---------------- */

export async function fetchForex(_query: MarketQuery) {
  return {
    type: "forex",
    data: [],
  }
}