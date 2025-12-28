import { Router } from "express"
import {
  runStrategy,
  getStrategies,
  getStrategyStatus,
} from "../controllers/strategy.controller"

const router = Router()

/*
|--------------------------------------------------------------------------
| Strategy Routes
|--------------------------------------------------------------------------
| Strategy execution, listing, and status
| Base path: /api/strategy
|--------------------------------------------------------------------------
*/

// List all available strategies
router.get("/", getStrategies)

// Run a strategy
router.post("/run", runStrategy)

// Get strategy execution status
router.get("/status/:strategyId", getStrategyStatus)

export default router