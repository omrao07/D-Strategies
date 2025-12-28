/*
|--------------------------------------------------------------------------
| News Connector Aggregator
|--------------------------------------------------------------------------
| Combines multiple news providers into a unified feed
|--------------------------------------------------------------------------
*/

import { fetchNewsData } from "./newsdata.connector"
import { fetchGlobalNews } from "./globalnews.connector"

export async function fetchAllNews(query: string) {
  const results = await Promise.allSettled([
    fetchNewsData({ q: query }),
    fetchGlobalNews({ q: query }),
  ])

  return results
    .filter(
      (r): r is PromiseFulfilledResult<any[]> =>
        r.status === "fulfilled"
    )
    .flatMap(r => r.value)
}