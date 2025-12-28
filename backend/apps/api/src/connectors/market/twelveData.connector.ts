/*
|--------------------------------------------------------------------------
| Twelve Data Market Connector
|--------------------------------------------------------------------------
| Equities, forex, crypto, time series, indicators
| Docs: https://twelvedata.com/docs
|--------------------------------------------------------------------------
*/

import axios from "axios"

const TWELVE_DATA_BASE_URL = "https://api.twelvedata.com"

function getAuthParams() {
  if (!process.env.TWELVE_DATA_API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY not configured")
  }

  return {
    apikey: process.env.TWELVE_DATA_API_KEY,
  }
}

/* ---------------- Quote ---------------- */

export async function fetchQuote(symbol: string) {
  return {
    provider: "twelvedata",
    symbol,
    price: null,
    updatedAt: new Date().toISOString(),
  }

  /*
  const res = await axios.get(
    `${TWELVE_DATA_BASE_URL}/quote`,
    {
      params: {
        symbol,
        ...getAuthParams(),
      },
    }
  )
  return res.data
  */
}

/* ---------------- Time Series ---------------- */

export async function fetchTimeSeries(
  symbol: string,
  interval:
    | "1min"
    | "5min"
    | "15min"
    | "30min"
    | "1h"
    | "1day"
    | "1week",
  outputsize = 100
) {
  return {
    provider: "twelvedata",
    symbol,
    interval,
    candles: [],
  }

  /*
  const res = await axios.get(
    `${TWELVE_DATA_BASE_URL}/time_series`,
    {
      params: {
        symbol,
        interval,
        outputsize,
        ...getAuthParams(),
      },
    }
  )
  return res.data
  */
}

/* ---------------- Technical Indicators ---------------- */

export async function fetchIndicator(
  indicator: string,
  symbol: string,
  interval: string,
  timePeriod = 14
) {
  return {
    provider: "twelvedata",
    indicator,
    symbol,
    interval,
    values: [],
  }

  /*
  const res = await axios.get(
    `${TWELVE_DATA_BASE_URL}/${indicator}`,
    {
      params: {
        symbol,
        interval,
        time_period: timePeriod,
        ...getAuthParams(),
      },
    }
  )
  return res.data
  */
}

/* ---------------- Forex Rates ---------------- */

export async function fetchForexRate(pair: string) {
  return {
    provider: "twelvedata",
    pair,
    rate: null,
    updatedAt: new Date().toISOString(),
  }

  /*
  const res = await axios.get(
    `${TWELVE_DATA_BASE_URL}/exchange_rate`,
    {
      params: {
        symbol: pair,
        ...getAuthParams(),
      },
    }
  )
  return res.data
  */
}