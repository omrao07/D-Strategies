/*
|--------------------------------------------------------------------------
| News Service
|--------------------------------------------------------------------------
| Aggregates news from multiple providers
| Provider-specific logic lives in connectors/
|--------------------------------------------------------------------------
*/

import { fetchAllNews } from "../connectors/news"

type NewsQuery = {
  q?: string
  symbols?: string[]
  limit?: number
}

export async function getNews(query: NewsQuery) {
  const searchQuery =
    query.q ||
    (query.symbols && query.symbols.length > 0
      ? query.symbols.join(" OR ")
      : "markets")

  const articles = await fetchAllNews(searchQuery)

  return articles
    .sort(
      (a: any, b: any) =>
        new Date(b.publishedAt).getTime() -
        new Date(a.publishedAt).getTime()
    )
    .slice(0, query.limit ?? 50)
}