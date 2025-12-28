import { Request, Response } from "express"
import {
  executeOrder,
  cancelExistingOrder,
  fetchExecutionStatus,
} from "../services/execution.service"

/*
|--------------------------------------------------------------------------
| Execution Controller
|--------------------------------------------------------------------------
| Handles request/response mapping for trade execution
| No broker or strategy logic here
|--------------------------------------------------------------------------
*/

// POST /api/execution/place
export async function placeOrder(req: Request, res: Response) {
  try {
    const result = await executeOrder(req.body)
    res.json(result)
  } catch (err: any) {
    res.status(500).json({
      error: "Failed to place order",
      message: err?.message,
    })
  }
}

// POST /api/execution/cancel
export async function cancelOrder(req: Request, res: Response) {
  try {
    const result = await cancelExistingOrder(req.body)
    res.json(result)
  } catch (err: any) {
    res.status(500).json({
      error: "Failed to cancel order",
      message: err?.message,
    })
  }
}

// GET /api/execution/status/:orderId
export async function getExecutionStatus(req: Request, res: Response) {
  try {
    const { orderId } = req.params
    const status = await fetchExecutionStatus(orderId)
    res.json(status)
  } catch (err: any) {
    res.status(500).json({
      error: "Failed to fetch execution status",
      message: err?.message,
    })
  }
}