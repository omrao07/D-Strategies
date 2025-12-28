/*
|--------------------------------------------------------------------------
| API Types
|--------------------------------------------------------------------------
| Shared response & request contracts across backend
|--------------------------------------------------------------------------
*/

/* ---------------- Generic API Response ---------------- */

export type ApiResponse<T = any> = {
  success: boolean
  data: T
  message?: string
  timestamp: string
}

/* ---------------- Pagination ---------------- */

export type Pagination = {
  page: number
  limit: number
  total: number
}

/* ---------------- Error Response ---------------- */

export type ApiError = {
  success: false
  error: {
    message: string
    code?: string
    details?: any
  }
  timestamp: string
}

/* ---------------- Market ---------------- */

export type MarketQuote = {
  symbol: string
  price: number | null
  open?: number | null
  high?: number | null
  low?: number | null
  volume?: number | null
  updatedAt: string
}

export type Candle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

/* ---------------- Portfolio ---------------- */

export type Holding = {
  symbol: string
  quantity: number
  averagePrice: number
  currentPrice?: number
}

export type Transaction = {
  id: string
  symbol: string
  quantity: number
  side: "BUY" | "SELL"
  price: number
  timestamp: string
}

/* ---------------- Execution ---------------- */

export type OrderRequest = {
  symbol: string
  quantity: number
  side: "BUY" | "SELL"
  orderType?: "MARKET" | "LIMIT"
  price?: number
}

export type OrderResponse = {
  orderId: string
  status: "submitted" | "filled" | "cancelled" | "rejected"
  broker?: string
}

/* ---------------- Strategy ---------------- */

export type Strategy = {
  id: string
  name: string
  description?: string
}

export type StrategyExecutionRequest = {
  strategyId: string
  parameters?: Record<string, any>
}

export type StrategyExecutionStatus = {
  strategyId: string
  status: "running" | "completed" | "failed"
  progress?: number
  updatedAt: string
}

/* ---------------- News ---------------- */

export type NewsArticle = {
  provider: string
  title: string
  description?: string
  url: string
  source?: string
  publishedAt: string
}

/* ---------------- Macro / Weather ---------------- */

export type WeatherData = {
  temperature: number | null
  humidity: number | null
  windSpeed: number | null
  description?: string | null
}

export type FuelPrice = {
  fuelType: string
  price: number | null
  currency: string
  updatedAt: string
}

/* ---------------- Utility ---------------- */

export function successResponse<T>(
  data: T,
  message?: string
): ApiResponse<T> {
  return {
    success: true,
    data,
    message,
    timestamp: new Date().toISOString(),
  }
}

export function errorResponse(
  message: string,
  details?: any,
  code?: string
): ApiError {
  return {
    success: false,
    error: {
      message,
      code,
      details,
    },
    timestamp: new Date().toISOString(),
  }
}