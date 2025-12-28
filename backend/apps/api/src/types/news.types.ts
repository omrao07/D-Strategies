/*
|--------------------------------------------------------------------------
| News Types
|--------------------------------------------------------------------------
| Shared news data contracts across connectors, services & strategies
|--------------------------------------------------------------------------
*/

/* ---------------- News Provider ---------------- */

export type NewsProvider =
  | "newsdata"
  | "global-news"
  | "finnhub"
  | "polygon"

/* ---------------- News Article ---------------- */

export type NewsArticle = {
  provider: NewsProvider
  title: string
  description?: string
  url: string
  source?: string
  publishedAt: string
  symbols?: string[]
  sentiment?: number
}

/* ---------------- News Query ---------------- */

export type NewsQuery = {
  q?: string
  symbols?: string[]
  category?: string
  language?: string
  country?: string
  limit?: number
}

/* ---------------- Aggregated News Response ---------------- */

export type AggregatedNewsResponse = {
  total: number
  articles: NewsArticle[]
  providers: NewsProvider[]
  fetchedAt: string
}

/* ---------------- Sentiment ---------------- */

export type NewsSentiment = {
  score: number
  label: "positive" | "neutral" | "negative"
}

/* ---------------- Strategy Input ---------------- */

export type NewsStrategyInput = {
  symbol: string
  recentNews: NewsArticle[]
}

/* ---------------- Utility ---------------- */

export function normalizeNewsArticle(
  article: NewsArticle
): NewsArticle {
  return {
    ...article,
    title: article.title.trim(),
    publishedAt: new Date(article.publishedAt).toISOString(),
  }
}