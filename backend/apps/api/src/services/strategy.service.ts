/*
|--------------------------------------------------------------------------
| Strategy Service
|--------------------------------------------------------------------------
| Handles strategy listing, execution, and status tracking
| Core strategy engines plug in here later
|--------------------------------------------------------------------------
*/

type Strategy = {
  id: string
  name: string
  description?: string
}

type StrategyExecutionPayload = {
  strategyId?: string
  parameters?: Record<string, any>
}

/* ---------------- Strategy Listing ---------------- */

export async function fetchStrategies() {
  const strategies: Strategy[] = [
    { id: "strat-1", name: "Momentum Strategy" },
    { id: "strat-2", name: "Mean Reversion Strategy" },
    { id: "strat-3", name: "Arbitrage Strategy" },
  ]

  return {
    strategies,
    total: strategies.length,
  }
}

/* ---------------- Strategy Execution ---------------- */

export async function executeStrategy(
  payload: StrategyExecutionPayload
) {
  return {
    status: "running",
    strategyId: payload.strategyId ?? `STRAT-${Date.now()}`,
    startedAt: new Date().toISOString(),
    parameters: payload.parameters ?? {},
  }
}

/* ---------------- Strategy Status ---------------- */

export async function fetchStrategyStatus(strategyId: string) {
  return {
    strategyId,
    status: "running",
    progress: 0.25,
    lastUpdated: new Date().toISOString(),
  }
}