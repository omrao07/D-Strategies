import { Request, Response } from "express"
import {
  fetchStrategies,
  executeStrategy,
  fetchStrategyStatus,
} from "../services/strategy.service"

/*
|--------------------------------------------------------------------------
| Strategy Controller
|--------------------------------------------------------------------------
| HTTP glue layer for strategy operations
| No business logic or API keys here
|--------------------------------------------------------------------------
*/

// GET /api/strategy
export async function getStrategies(
  _req: Request,
  res: Response
) {
  try {
    const data = await fetchStrategies()
    res.json(data)
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to fetch strategies",
      message: error?.message,
    })
  }
}

// POST /api/strategy/run
export async function runStrategy(
  req: Request,
  res: Response
) {
  try {
    const result = await executeStrategy(req.body)
    res.json(result)
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to run strategy",
      message: error?.message,
    })
  }
}

// GET /api/strategy/status/:strategyId
export async function getStrategyStatus(
  req: Request,
  res: Response
) {
  try {
    const { strategyId } = req.params
    const status = await fetchStrategyStatus(strategyId)
    res.json(status)
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to fetch strategy status",
      message: error?.message,
    })
  }
}