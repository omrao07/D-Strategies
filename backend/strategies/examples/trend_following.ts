// examples/trend following.ts
// Simple illustrative trend-following strategy example

type PricePoint = {
  date: string
  close: number
}

type Signal = "buy" | "sell" | "hold"

function movingAverage(prices: PricePoint[], window: number, idx: number): number {
  if (idx < window - 1) return prices[idx].close
  const slice = prices.slice(idx - window + 1, idx + 1).map(p => p.close)
  return slice.reduce((a, b) => a + b, 0) / slice.length
}

function generateSignal(
  prices: PricePoint[],
  idx: number,
  shortWindow: number = 10,
  longWindow: number = 50
): Signal {
  if (idx < longWindow) return "hold"

  const shortMA = movingAverage(prices, shortWindow, idx)
  const longMA = movingAverage(prices, longWindow, idx)

  if (shortMA > longMA) return "buy"
  if (shortMA < longMA) return "sell"
  return "hold"
}

function backtest(
  prices: PricePoint[],
  shortWindow = 10,
  longWindow = 50
): { date: string; price: number; signal: Signal }[] {
  return prices.map((p, i) => ({
    date: p.date,
    price: p.close,
    signal: generateSignal(prices, i, shortWindow, longWindow),
  }))
}

// Example usage
const sampleData: PricePoint[] = [
  { date: "2025-01-01", close: 100 },
  { date: "2025-01-02", close: 101 },
  { date: "2025-01-03", close: 103 },
  { date: "2025-01-04", close: 105 },
  { date: "2025-01-05", close: 107 },
  { date: "2025-01-06", close: 110 },
  { date: "2025-01-07", close: 112 },
  { date: "2025-01-08", close: 111 },
  { date: "2025-01-09", close: 113 },
  { date: "2025-01-10", close: 115 },
]

const signals = backtest(sampleData, 3, 5)
console.log(signals)

export { PricePoint, Signal, generateSignal, backtest }
