import { Router } from "express"
import {
  getEquities,
  getCrypto,
  getForex,
  getMarketSnapshot,
} from "../controllers/market.controller"

const router = Router()

/*
|--------------------------------------------------------------------------
| Market Routes
|--------------------------------------------------------------------------
| Market data aggregation (stocks, crypto, forex)
| Base path: /api/market
|--------------------------------------------------------------------------
*/

// High-level snapshot (dashboard use)
router.get("/snapshot", getMarketSnapshot)

// Equities market data
router.get("/equities", getEquities)

// Crypto market data
router.get("/crypto", getCrypto)

// Forex market data
router.get("/forex", getForex)

export default router