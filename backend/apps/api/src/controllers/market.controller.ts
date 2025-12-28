import { Request, Response } from "express"
import {
  fetchMarketSnapshot,
  fetchEquities,
  fetchCrypto,
  fetchForex,
} from "../services/market.service"

/*
|--------------------------------------------------------------------------
| Market Controller
|--------------------------------------------------------------------------
| Thin HTTP glue layer for market data
| No vendor or API-key logic here
|--------------------------------------------------------------------------
*/

// GET /api/market/snapshot
export async function getMarketSnapshot(
  _req: Request,
  res: Response
) {
  try {
    const data = await fetchMarketSnapshot()
    res.json(data)
  } catch (err: any) {
    res.status(500).json({
      error: "Failed to fetch market snapshot",
      message: err?.message,
    })
  }
}

// GET /api/market/equities
export async function getEquities(
  req: Request,
  res: Response
) {
  try {
    const data = await fetchEquities(req.query)
    res.json(data)
  } catch (err: any) {
    res.status(500).json({
      error: "Failed to fetch equities data",
      message: err?.message,
    })
  }
}

// GET /api/market/crypto
export async function getCrypto(
  req: Request,
  res: Response
) {
  try {
    const data = await fetchCrypto(req.query)
    res.json(data)
  } catch (err: any) {
    res.status(500).json({
      error: "Failed to fetch crypto data",
      message: err?.message,
    })
  }
}

// GET /api/market/forex
export async function getForex(
  req: Request,
  res: Response
) {
  try {
    const data = await fetchForex(req.query)
    res.json(data)
  } catch (err: any) {
    res.status(500).json({
      error: "Failed to fetch forex data",
      message: err?.message,
    })
  }
}