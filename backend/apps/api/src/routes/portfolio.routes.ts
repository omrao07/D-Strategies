import { Router } from "express"
import {
  getPortfolioOverview,
  getHoldings,
  getPnL,
  getTransactions,
} from "../controllers/portfolio.controller"

const router = Router()

/*
|--------------------------------------------------------------------------
| Portfolio Routes
|--------------------------------------------------------------------------
| Portfolio state, holdings, PnL, and transactions
| Base path: /api/portfolio
|--------------------------------------------------------------------------
*/

// High-level portfolio overview (dashboard use)
router.get("/", getPortfolioOverview)

// Current holdings
router.get("/holdings", getHoldings)

// Profit & Loss
router.get("/pnl", getPnL)

// Transaction history
router.get("/transactions", getTransactions)

export default router