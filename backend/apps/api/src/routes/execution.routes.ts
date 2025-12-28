import { Router } from "express"
import {
  placeOrder,
  cancelOrder,
  getExecutionStatus,
} from "../controllers/execution.controller"

const router = Router()

/*
|--------------------------------------------------------------------------
| Execution Routes
|--------------------------------------------------------------------------
| Handles trade/order execution
| Base path: /api/execution
|--------------------------------------------------------------------------
*/

// Place a new order
router.post("/place", placeOrder)

// Cancel an existing order
router.post("/cancel", cancelOrder)

// Get execution / order status
router.get("/status/:orderId", getExecutionStatus)

export default router