// styles/trend.ts

export type TrendOutput = {
  direction: "up" | "down" | "sideways";
  magnitude: number;   // normalized trend intensity [0–1]
  confidence: number;  // normalized certainty [0–1]
};

/**
 * Trend style strategy:
 * Uses moving averages and slope detection to classify trend.
 */
export function trend(prices: number[], fast: number = 20, slow: number = 50): TrendOutput {
  if (prices.length < slow) {
    return { direction: "sideways", magnitude: 0, confidence: 0 };
  }

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const fastMA = avg(prices.slice(-fast));
  const slowMA = avg(prices.slice(-slow));

  let direction: "up" | "down" | "sideways" = "sideways";
  let magnitude = 0;

  if (fastMA > slowMA) {
    direction = "up";
    magnitude = (fastMA - slowMA) / slowMA;
  } else if (fastMA < slowMA) {
    direction = "down";
    magnitude = (slowMA - fastMA) / slowMA;
  }

  // cap between 0–1
  magnitude = Math.min(Math.max(magnitude, 0), 1);

  // confidence = steeper divergence → more confidence
  const confidence = Math.min(magnitude * 2, 1);

  return { direction, magnitude, confidence };
}
