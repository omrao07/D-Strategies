// examples/mean reversion.ts
// Simple illustrative mean reversion strategy example

type PricePoint = {
  date: string
  close: number
}

type Signal = "buy" | "sell" | "hold"

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / (values.length || 1)
}

function rollingMean(prices: PricePoint[], window: number, idx: number): number {
  const start = Math.max(0, idx - window + 1)
  const slice = prices.slice(start, idx + 1).map(p => p.close)
  return mean(slice)
}

function generateSignal(
  prices: PricePoint[],
  idx: number,
  lookback: number = 20,
  threshold: number = 0.02
): Signal {
  if (idx < lookback) return "hold"

  const price = prices[idx].close
  const avg = rollingMean(prices, lookback, idx)

  const deviation = (price - avg) / avg

  if (deviation > threshold) return "sell"
  if (deviation < -threshold) return "buy"
  return "hold"
}

function backtest(prices: PricePoint[], lookback = 20, threshold = 0.02): { date: string; price: number; signal: Signal }[] {
  return prices.map((p, i) => ({
    date: p.date,
    price: p.close,
    signal: generateSignal(prices, i, lookback, threshold),
  }))
}

// Example usage
const sampleData: PricePoint[] = [
  { date: "2025-01-01", close: 100 },
  { date: "2025-01-02", close: 102 },
  { date: "2025-01-03", close: 101 },
  { date: "2025-01-04", close: 98 },
  { date: "2025-01-05", close: 97 },
  { date: "2025-01-06", close: 99 },
]

const signals = backtest(sampleData, 3, 0.02)
console.log(signals)

export { PricePoint, Signal, generateSignal, backtest }
//   npx ts-node --esm backtester/cli.ts backtest --id=examples.mean_reversion --start=2024-01-01 --end=2024-12-31 --lookback=20 --threshold=0.02
//
// This will run the mean reversion strategy over the specified date range with given parameters.
// The results will be saved to outputs/runs/ and outputs/curves/ as JSON and CSV files respectively.
//
// Note: This is a simplified example for illustrative purposes only. Real-world strategies would involve more complexity.      