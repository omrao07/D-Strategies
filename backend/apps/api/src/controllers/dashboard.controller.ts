import { Request, Response } from "express"
import {
  getDashboardOverviewData,
  getDashboardMetricsData,
  getDashboardAlertsData,
} from "../services/dashboard.service"

/*
|--------------------------------------------------------------------------
| Dashboard Controller
|--------------------------------------------------------------------------
| Thin HTTP glue layer
| No business logic here
|--------------------------------------------------------------------------
*/

// GET /api/dashboard
export async function getDashboardOverview(
  _req: Request,
  res: Response
) {
  const data = await getDashboardOverviewData()
  res.json(data)
}

// GET /api/dashboard/metrics (optional)
export async function getDashboardMetrics(
  _req: Request,
  res: Response
) {
  const data = await getDashboardMetricsData()
  res.json(data)
}

// GET /api/dashboard/alerts (optional)
export async function getDashboardAlerts(
  _req: Request,
  res: Response
) {
  const data = await getDashboardAlertsData()
  res.json(data)
}