/*
|--------------------------------------------------------------------------
| Market Types
|--------------------------------------------------------------------------
| Shared market data contracts across connectors, services & strategies
|--------------------------------------------------------------------------
*/

/* ---------------- Symbols ---------------- */

export type MarketSymbol = {
  symbol: string
  exchange?: string
  name?: string
  type?: "EQUITY" | "INDEX" | "CRYPTO" | "FOREX" | "COMMODITY"
}

/* ---------------- Quotes ---------------- */

export type MarketQuote = {
  provider: string
  symbol: string
  price: number | null
  open?: number | null
  high?: number | null
  low?: number | null
  prevClose?: number | null
  volume?: number | null
  currency?: string
  updatedAt: string
}

/* ---------------- Candles / OHLC ---------------- */

export type Candle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

export type CandleSeries = {
  provider: string
  symbol: string
  interval: string
  candles: Candle[]
}

/* ---------------- Indices ---------------- */

export type MarketIndex = {
  name: string
  value: number | null
  change?: number | null
  changePercent?: number | null
  updatedAt: string
}

/* ---------------- Market Snapshot ---------------- */

export type MarketSnapshot = {
  timestamp: string
  equitiesOpen?: boolean
  forexOpen?: boolean
  cryptoOpen?: boolean
  indices?: MarketIndex[]
}

/* ---------------- Technical Indicators ---------------- */

export type IndicatorValue = {
  time: number
  value: number
}

export type IndicatorSeries = {
  provider: string
  indicator: string
  symbol: string
  interval: string
  values: IndicatorValue[]
}

/* ---------------- Forex ---------------- */

export type ForexRate = {
  pair: string
  rate: number | null
  base?: string
  quote?: string
  updatedAt: string
}

/* ---------------- Crypto ---------------- */

export type CryptoAsset = {
  symbol: string
  price: number | null
  marketCap?: number | null
  volume24h?: number | null
  updatedAt: string
}

/* ---------------- Aggregated Market Response ---------------- */

export type AggregatedMarketData = {
  symbol: string
  sources: string[]
  quote?: MarketQuote
  candles?: CandleSeries[]
  indicators?: IndicatorSeries[]
}

/* ---------------- Strategy Input ---------------- */

export type MarketStrategyInput = {
  symbol: string
  timeframe: string
  candles: Candle[]
  indicators?: Record<string, IndicatorSeries>
}

/* ---------------- Utility ---------------- */

export type MarketProvider =
  | "finnhub"
  | "polygon"
  | "twelvedata"
  | "india-market"
  | "groww"