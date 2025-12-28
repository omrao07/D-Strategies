// utils/env.ts
// Centralized environment access (single source of truth)

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: Number(process.env.PORT ?? 8080),

  // Market APIs
  FINNHUB_API_KEY: process.env.FINNHUB_API_KEY ?? "",
  POLYGON_API_KEY: process.env.POLYGON_API_KEY ?? "",
  TWELVE_DATA_API_KEY: process.env.TWELVE_DATA_API_KEY ?? "",
  INDIA_MARKET_API_KEY: process.env.INDIA_MARKET_API_KEY ?? "",

  // News APIs
  NEWSDATA_API_KEY: process.env.NEWSDATA_API_KEY ?? "",
  GLOBAL_NEWS_API_KEY: process.env.GLOBAL_NEWS_API_KEY ?? "",

  // Broker
  GROWW_CLIENT_ID: process.env.GROWW_CLIENT_ID ?? "",
  GROWW_API_KEY: process.env.GROWW_API_KEY ?? "",
  GROWW_API_SECRET: process.env.GROWW_API_SECRET ?? "",

  // Macro / Logistics
  SHIP_TRACKING_API_KEY: process.env.SHIP_TRACKING_API_KEY ?? "",
  WEATHER_API_KEY: process.env.WEATHER_API_KEY ?? "",
  FUEL_PRICE_API_KEY: process.env.FUEL_PRICE_API_KEY ?? "",

  // Satellite
  GEE_PROJECT_ID: process.env.GEE_PROJECT_ID ?? ""
} as const