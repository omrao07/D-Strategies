import dotenv from "dotenv"

dotenv.config()

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export const env = {
  /* ---------------- Server ---------------- */
  PORT: Number(process.env.PORT ?? 8080),
  NODE_ENV: process.env.NODE_ENV ?? "development",

  /* ---------------- Market APIs ---------------- */
  FINNHUB_API_KEY: required("FINNHUB_API_KEY"),
  POLYGON_API_KEY: required("POLYGON_API_KEY"),
  TWELVE_DATA_API_KEY: required("TWELVE_DATA_API_KEY"),
  INDIA_MARKET_API_KEY: required("INDIA_MARKET_API_KEY"),

  /* ---------------- News APIs ---------------- */
  NEWSDATA_API_KEY: required("NEWSDATA_API_KEY"),
  GLOBAL_NEWS_API_KEY: required("GLOBAL_NEWS_API_KEY"),

  /* ---------------- Broker ---------------- */
  GROWW_CLIENT_ID: required("GROWW_CLIENT_ID"),
  GROWW_CLIENT_SECRET: required("GROWW_CLIENT_SECRET"),

  /* ---------------- Macro / Logistics ---------------- */
  WEATHER_API_KEY: required("WEATHER_API_KEY"),
  FUEL_PRICE_API_KEY: required("FUEL_PRICE_API_KEY"),
  SHIP_TRACKING_API_KEY: required("SHIP_TRACKING_API_KEY"),

  /* ---------------- Satellite ---------------- */
  GEE_PROJECT_ID: required("GEE_PROJECT_ID"),
}