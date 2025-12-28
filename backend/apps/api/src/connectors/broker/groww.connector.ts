/*
|--------------------------------------------------------------------------
| Groww Broker Connector
|--------------------------------------------------------------------------
| Handles communication with Groww APIs
| Authentication, order placement, portfolio fetch
|--------------------------------------------------------------------------
*/

import axios from "axios"

type GrowwOrderPayload = {
  symbol: string
  quantity: number
  side: "BUY" | "SELL"
  orderType?: string
  price?: number
}

const GROWW_BASE_URL = "https://api.groww.in" // placeholder

function getAuthHeaders() {
  if (!process.env.GROWW_CLIENT_ID || !process.env.GROWW_CLIENT_SECRET) {
    throw new Error("Groww credentials not configured")
  }

  return {
    "X-CLIENT-ID": process.env.GROWW_CLIENT_ID,
    "X-CLIENT-SECRET": process.env.GROWW_CLIENT_SECRET,
    "Content-Type": "application/json",
  }
}

/* ---------------- Orders ---------------- */

export async function placeGrowwOrder(payload: GrowwOrderPayload) {
  // Placeholder – replace endpoint when Groww API is finalized
  return {
    broker: "groww",
    status: "submitted",
    orderId: `GRW-${Date.now()}`,
    payload,
  }

  /*
  const response = await axios.post(
    `${GROWW_BASE_URL}/orders/place`,
    payload,
    { headers: getAuthHeaders() }
  )
  return response.data
  */
}

export async function cancelGrowwOrder(orderId: string) {
  return {
    broker: "groww",
    status: "cancelled",
    orderId,
  }

  /*
  const response = await axios.post(
    `${GROWW_BASE_URL}/orders/cancel`,
    { orderId },
    { headers: getAuthHeaders() }
  )
  return response.data
  */
}

/* ---------------- Portfolio ---------------- */

export async function fetchGrowwHoldings() {
  return {
    broker: "groww",
    holdings: [],
  }

  /*
  const response = await axios.get(
    `${GROWW_BASE_URL}/portfolio/holdings`,
    { headers: getAuthHeaders() }
  )
  return response.data
  */
}

export async function fetchGrowwOrders() {
  return {
    broker: "groww",
    orders: [],
  }

  /*
  const response = await axios.get(
    `${GROWW_BASE_URL}/orders`,
    { headers: getAuthHeaders() }
  )
  return response.data
  */
}