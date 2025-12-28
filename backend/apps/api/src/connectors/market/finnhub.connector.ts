/*
|--------------------------------------------------------------------------
| Finnhub Market Data Connector
|--------------------------------------------------------------------------
| Stocks, crypto, forex, fundamentals, sentiment
| Docs: https://finnhub.io/docs/api
|--------------------------------------------------------------------------
*/

import axios from "axios"

const FINNHUB_BASE_URL = "https://finnhub.io/api/v1"

function getAuthParams() {
  if (!process.env.FINNHUB_API_KEY) {
    throw new Error("FINNHUB_API_KEY not configured")
  }

  return {
    token: process.env.FINNHUB_API_KEY,
  }
}

/* ---------------- Quote ---------------- */

export async function fetchQuote(symbol: string) {
  // Placeholder response
  return {
    provider: "finnhub",
    symbol,
    quote: {
      current: null,
      high: null,
      low: null,
      open: null,
      prevClose: null,
    },
    updatedAt: new Date().toISOString(),
  }

  /*
  const res = await axios.get(`${FINNHUB_BASE_URL}/quote`, {
    params: { symbol, ...getAuthParams() },
  })
  return res.data
  */
}

/* ---------------- Candles ---------------- */

export async function fetchCandles(
  symbol: string,
  resolution: "1" | "5" | "15" | "30" | "60" | "D" | "W" | "M",
  from: number,
  to: number
) {
  return {
    provider: "finnhub",
    symbol,
    resolution,
    candles: [],
  }

  /*
  const res = await axios.get(`${FINNHUB_BASE_URL}/stock/candle`, {
    params: {
      symbol,
      resolution,
      from,
      to,
      ...getAuthParams(),
    },
  })
  return res.data
  */
}

/* ---------------- Company Profile ---------------- */

export async function fetchCompanyProfile(symbol: string) {
  return {
    provider: "finnhub",
    symbol,
    profile: {},
  }

  /*
  const res = await axios.get(
    `${FINNHUB_BASE_URL}/stock/profile2`,
    {
      params: { symbol, ...getAuthParams() },
    }
  )
  return res.data
  */
}

/* ---------------- Market News ---------------- */

export async function fetchMarketNews(category = "general") {
  return {
    provider: "finnhub",
    category,
    articles: [],
  }

  /*
  const res = await axios.get(`${FINNHUB_BASE_URL}/news`, {
    params: { category, ...getAuthParams() },
  })
  return res.data
  */
}

/* ---------------- Insider Sentiment ---------------- */

export async function fetchInsiderSentiment(
  symbol: string,
  from: string,
  to: string
) {
  return {
    provider: "finnhub",
    symbol,
    sentiment: [],
  }

  /*
  const res = await axios.get(
    `${FINNHUB_BASE_URL}/stock/insider-sentiment`,
    {
      params: { symbol, from, to, ...getAuthParams() },
    }
  )
  return res.data
  */
}