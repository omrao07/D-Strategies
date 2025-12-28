/*
|--------------------------------------------------------------------------
| NewsData Connector
|--------------------------------------------------------------------------
| Fetches real-time and historical news
| Typical provider: NewsData.io
|--------------------------------------------------------------------------
*/

import axios from "axios"

const NEWSDATA_BASE_URL = "https://newsdata.io/api/1"

function getAuthParams() {
  if (!process.env.NEWSDATA_API_KEY) {
    throw new Error("NEWSDATA_API_KEY not configured")
  }

  return {
    apikey: process.env.NEWSDATA_API_KEY,
  }
}

type NewsDataQuery = {
  q?: string
  country?: string
  language?: string
  category?: string
}

/* ---------------- Fetch News ---------------- */

export async function fetchNewsData(
  query: NewsDataQuery = {}
) {
  // Placeholder response
  return [
    {
      provider: "newsdata",
      title: "NewsData placeholder headline",
      description: "This is a placeholder article from NewsData",
      url: "",
      source: "newsdata",
      publishedAt: new Date().toISOString(),
    },
  ]

  /*
  const res = await axios.get(
    `${NEWSDATA_BASE_URL}/news`,
    {
      params: {
        q: query.q ?? "markets",
        country: query.country,
        language: query.language ?? "en",
        category: query.category ?? "business",
        ...getAuthParams(),
      },
    }
  )

  return res.data.results.map((article: any) => ({
    provider: "newsdata",
    title: article.title,
    description: article.description,
    url: article.link,
    source: article.source_id,
    publishedAt: article.pubDate,
  }))
  */
}