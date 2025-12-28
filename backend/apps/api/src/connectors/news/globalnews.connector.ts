/*
|--------------------------------------------------------------------------
| Global News Connector
|--------------------------------------------------------------------------
| Fetches global macro, business, and market news
| Typical providers: GNews, Global News API, MediaStack, etc.
|--------------------------------------------------------------------------
*/

import axios from "axios"

const GLOBAL_NEWS_BASE_URL = "https://api.globalnewsprovider.com" // placeholder

function getAuthParams() {
  if (!process.env.GLOBAL_NEWS_API_KEY) {
    throw new Error("GLOBAL_NEWS_API_KEY not configured")
  }

  return {
    apiKey: process.env.GLOBAL_NEWS_API_KEY,
  }
}

type GlobalNewsQuery = {
  q?: string
  country?: string
  language?: string
  category?: string
  limit?: number
}

/* ---------------- Fetch News ---------------- */

export async function fetchGlobalNews(
  query: GlobalNewsQuery = {}
) {
  return [
    {
      provider: "global-news",
      title: "Global markets placeholder headline",
      description: "This is a placeholder global news article",
      url: "",
      source: "global-news",
      publishedAt: new Date().toISOString(),
    },
  ]

  /*
  const res = await axios.get(
    `${GLOBAL_NEWS_BASE_URL}/news`,
    {
      params: {
        q: query.q ?? "markets",
        country: query.country,
        language: query.language ?? "en",
        category: query.category ?? "business",
        limit: query.limit ?? 50,
        ...getAuthParams(),
      },
    }
  )

  return res.data.articles
  */
}