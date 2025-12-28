/*
|--------------------------------------------------------------------------
| Dashboard Service
|--------------------------------------------------------------------------
| Orchestrates data for dashboard views
| This is where you later aggregate portfolio, market, strategy data
|--------------------------------------------------------------------------
*/

// High-level dashboard overview
export async function getDashboardOverviewData() {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    message: "Dashboard backend connected successfully",
  }
}

// Key dashboard metrics
export async function getDashboardMetricsData() {
  return {
    metrics: {
      totalPnL: 0,
      dayPnL: 0,
      exposure: 0,
      activeStrategies: 0,
      openPositions: 0,
    },
  }
}

// Alerts / notifications
export async function getDashboardAlertsData() {
  return {
    alerts: [],
  }
}