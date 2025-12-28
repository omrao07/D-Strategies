/*
|--------------------------------------------------------------------------
| Weather Data Connector
|--------------------------------------------------------------------------
| Current weather, forecasts, historical climate data
| Typical providers: OpenWeather, WeatherAPI, IMD feeds
|--------------------------------------------------------------------------
*/

import axios from "axios"

const WEATHER_BASE_URL = "https://api.weatherprovider.com" // placeholder

function getAuthParams() {
  if (!process.env.WEATHER_API_KEY) {
    throw new Error("WEATHER_API_KEY not configured")
  }

  return {
    key: process.env.WEATHER_API_KEY,
  }
}

type WeatherQuery = {
  city?: string
  lat?: number
  lon?: number
}

/* ---------------- Current Weather ---------------- */

export async function fetchCurrentWeather(
  query: WeatherQuery
) {
  return {
    provider: "weather",
    query,
    conditions: {
      temperature: null,
      humidity: null,
      windSpeed: null,
      description: null,
    },
    observedAt: new Date().toISOString(),
  }

  /*
  const res = await axios.get(
    `${WEATHER_BASE_URL}/current`,
    {
      params: {
        ...query,
        ...getAuthParams(),
      },
    }
  )
  return res.data
  */
}

/* ---------------- Forecast ---------------- */

export async function fetchWeatherForecast(
  query: WeatherQuery,
  days = 7
) {
  return {
    provider: "weather",
    query,
    days,
    forecast: [],
  }

  /*
  const res = await axios.get(
    `${WEATHER_BASE_URL}/forecast`,
    {
      params: {
        ...query,
        days,
        ...getAuthParams(),
      },
    }
  )
  return res.data
  */
}

/* ---------------- Historical Weather ---------------- */

export async function fetchHistoricalWeather(
  query: WeatherQuery & { from: string; to: string }
) {
  return {
    provider: "weather",
    query,
    history: [],
  }

  /*
  const res = await axios.get(
    `${WEATHER_BASE_URL}/history`,
    {
      params: {
        ...query,
        ...getAuthParams(),
      },
    }
  )
  return res.data
  */
}