// factors/growth.ts

/**
 * Growth Factor
 * Measures earnings/revenue growth over a lookback period
 * Returns a normalized score (higher = stronger growth)
 */

type InputRow = {
  ts: number
  ticker: string
  eps?: number        // earnings per share
  revenue?: number    // revenue
}

type Params = {
  lookback: number    // # periods to measure growth (e.g. 4 quarters)
  weightEPS?: number  // weight given to EPS growth
  weightRev?: number  // weight given to Revenue growth
}

type ScoreRow = {
  ts: number
  ticker: string
  score: number
}

export function growthFactor(rows: InputRow[], params: Params): ScoreRow[] {
  const { lookback, weightEPS = 0.5, weightRev = 0.5 } = params

  // group data by ticker
  const grouped: Record<string, InputRow[]> = {}
  for (const r of rows) {
    if (!grouped[r.ticker]) grouped[r.ticker] = []
    grouped[r.ticker].push(r)
  }

  const out: ScoreRow[] = []
  for (const [ticker, series] of Object.entries(grouped)) {
    // sort by time
    series.sort((a, b) => a.ts - b.ts)
    if (series.length <= lookback) continue

    const recent = series[series.length - 1]
    const past = series[series.length - 1 - lookback]

    let epsGrowth = 0
    if (recent.eps && past.eps && past.eps !== 0) {
      epsGrowth = (recent.eps - past.eps) / Math.abs(past.eps)
    }

    let revGrowth = 0
    if (recent.revenue && past.revenue && past.revenue !== 0) {
      revGrowth = (recent.revenue - past.revenue) / Math.abs(past.revenue)
    }

    const score = weightEPS * epsGrowth + weightRev * revGrowth

    out.push({
      ts: recent.ts,
      ticker,
      score
    })
  }

  // normalize scores (z-score style)
  const scores = out.map(r => r.score)
  const mean = scores.reduce((a, b) => a + b, 0) / (scores.length || 1)
  const std = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / (scores.length || 1)) || 1

  return out.map(r => ({
    ...r,
    score: (r.score - mean) / std
  }))
}