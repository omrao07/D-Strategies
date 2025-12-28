import { Router } from "express"
import {
  getDashboardOverview,
} from "../controllers/dashboard.controller"

const router = Router()

/*
|--------------------------------------------------------------------------
| Dashboard Routes
|--------------------------------------------------------------------------
| These routes power the main dashboard metrics, summaries, and widgets
| Frontend only calls these URLs — no business logic here
|
| Base path: /api/dashboard
|--------------------------------------------------------------------------
*/

// High-level dashboard overview
router.get("/", getDashboardOverview)

// Optional expansions (add later when needed)
// router.get("/metrics", getDashboardMetrics)
// router.get("/alerts", getDashboardAlerts)
// router.get("/positions", getDashboardPositions)

export default router