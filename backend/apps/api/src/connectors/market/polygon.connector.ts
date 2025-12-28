/*
|--------------------------------------------------------------------------
| Polygon Market Data Connector
|--------------------------------------------------------------------------
| Equities, indices, aggregates, market data
| Docs: https://polygon.io/docs
|--------------------------------------------------------------------------
*/

import axios from "axios"

const POLYGON_BASE_URL = "https://api.polygon.io"

function getAuthParams() {
  if (!process.env.POLYGON_API_KEY) {
    throw new Error("POLYGON_API_KEY not configured")
  }

  return {
    apiKey: process.env.POLYGON_API_KEY,
  }
}

/* ---------------- Last Trade ---------------- */

export async function fetchLastTrade(symbol: string) {
  return {
    provider: "polygon",
    symbol,
    trade: null,
    updatedAt: new Date().toISOString(),
  }

  /*
  const res = await axios.get(
    `${POLYGON_BASE_URL}/v2/last/trade/${symbol}`,
    { params: getAuthParams() }
  )
  return res.data
  */
}

/* ---------------- Aggregates (OHLC) ---------------- */

export async function fetchAggregates(
  symbol: string,
  multiplier: number,
  timespan: "minute" | "hour" | "day" | "week" | "month",
  from: string,
  to: string
) {
  return {
    provider: "polygon",
    symbol,
    multiplier,
    timespan,
    candles: [],
  }

  /*
  const res = await axios.get(
    `${POLYGON_BASE_URL}/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${from}/${to}`,
    { params: getAuthParams() }
  )
  return res.data
  */
}

/* ---------------- Market Tickers ---------------- */

export async function fetchTickers(limit = 50) {
  return {
    provider: "polygon",
    tickers: [],
    limit,
  }

  /*
  const res = await axios.get(
    `${POLYGON_BASE_URL}/v3/reference/tickers`,
    {
      params: {
        limit,
        ...getAuthParams(),
      },
    }
  )
  return res.data
  */
}

/* ---------------- Market News ---------------- */

export async function fetchPolygonNews(symbol?: string) {
  return {
    provider: "polygon",
    symbol,
    articles: [],
  }

  /*
  const res = await axios.get(
    `${POLYGON_BASE_URL}/v2/reference/news`,
    {
      params: {
        ticker: symbol,
        ...getAuthParams(),
      },
    }
  )
  return res.data
  */
}