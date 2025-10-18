// styles/volatilitytarget.ts

export type VolatilityTargetOutput = {
  targetVol: number;    // desired volatility level
  currentVol: number;   // realized volatility
  leverage: number;     // scaling factor applied to position
};

/**
 * Volatility Targeting Strategy:
 * Adjusts position size to keep portfolio volatility near target.
 */
export function volatilityTarget(
  returns: number[],
  targetVol: number = 0.15,
  lookback: number = 20
): VolatilityTargetOutput {
  if (returns.length < lookback) {
    return { targetVol, currentVol: 0, leverage: 0 };
  }

  const recent = returns.slice(-lookback);

  // compute realized volatility (annualized)
  const mean = recent.reduce((a, b) => a + b, 0) / lookback;
  const variance =
    recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (lookback - 1);
  const realizedVol = Math.sqrt(variance) * Math.sqrt(252);

  let leverage = 0;
  if (realizedVol > 0) {
    leverage = targetVol / realizedVol;
  }

  return {
    targetVol,
    currentVol: realizedVol,
    leverage,
  };
}
