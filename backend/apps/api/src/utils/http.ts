import { Response } from "express"
import { ApiResponse, ApiError } from "../types/api.types"
import { AppError } from "./errors"

/*
|--------------------------------------------------------------------------
| HTTP Response Helpers
|--------------------------------------------------------------------------
| Centralized helpers for success & error responses
|--------------------------------------------------------------------------
*/

/* ---------------- Success Response ---------------- */

export function sendSuccess<T>(
  res: Response,
  data: T,
  message?: string,
  statusCode = 200
): Response<ApiResponse<T>> {
  return res.status(statusCode).json({
    success: true,
    data,
    message,
    timestamp: new Date().toISOString(),
  })
}

/* ---------------- Error Response ---------------- */

export function sendError(
  res: Response,
  error: unknown,
  statusCode = 500
): Response<ApiError> {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      success: false,
      error: {
        message: error.message,
        code: error.code,
        details: error.details,
      },
      timestamp: new Date().toISOString(),
    })
  }

  return res.status(statusCode).json({
    success: false,
    error: {
      message: "Internal server error",
    },
    timestamp: new Date().toISOString(),
  })
}

/* ---------------- Async Controller Wrapper ---------------- */

export function asyncHandler(
  fn: (
    req: any,
    res: Response,
    next?: any
  ) => Promise<any>
) {
  return function (
    req: any,
    res: Response,
    next: any
  ) {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}