import { Request, Response } from "express"
import {
  fetchPortfolioOverview,
  fetchHoldings,
  fetchPnL,
  fetchTransactions,
} from "../services/portfolio.service"

/*
|--------------------------------------------------------------------------
| Portfolio Controller
|--------------------------------------------------------------------------
| Handles portfolio state, holdings, PnL, transactions
| Thin HTTP glue layer only
|--------------------------------------------------------------------------
*/

// GET /api/portfolio
export async function getPortfolioOverview(
  _req: Request,
  res: Response
) {
  try {
    const data = await fetchPortfolioOverview()
    res.json(data)
  } catch (err: any) {
    res.status(500).json({
      error: "Failed to fetch portfolio overview",
      message: err?.message,
    })
  }
}

// GET /api/portfolio/holdings
export async function getHoldings(
  _req: Request,
  res: Response
) {
  try {
    const data = await fetchHoldings()
    res.json(data)
  } catch (err: any) {
    res.status(500).json({
      error: "Failed to fetch holdings",
      message: err?.message,
    })
  }
}

// GET /api/portfolio/pnl
export async function getPnL(
  _req: Request,
  res: Response
) {
  try {
    const data = await fetchPnL()
    res.json(data)
  } catch (err: any) {
    res.status(500).json({
      error: "Failed to fetch PnL",
      message: err?.message,
    })
  }
}

// GET /api/portfolio/transactions
export async function getTransactions(
  _req: Request,
  res: Response
) {
  try {
    const data = await fetchTransactions()
    res.json(data)
  } catch (err: any) {
    res.status(500).json({
      error: "Failed to fetch transactions",
      message: err?.message,
    })
  }
}