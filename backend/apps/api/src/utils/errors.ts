/*
|--------------------------------------------------------------------------
| Custom Error Utilities
|--------------------------------------------------------------------------
| Standardized error handling across backend
|--------------------------------------------------------------------------
*/

export class AppError extends Error {
  statusCode: number
  code?: string
  details?: any
  isOperational: boolean

  constructor(
    message: string,
    statusCode = 500,
    code?: string,
    details?: any
  ) {
    super(message)

    this.statusCode = statusCode
    this.code = code
    this.details = details
    this.isOperational = true

    Error.captureStackTrace(this, this.constructor)
  }
}

/* ---------------- Common Errors ---------------- */

export class BadRequestError extends AppError {
  constructor(message = "Bad request", details?: any) {
    super(message, 400, "BAD_REQUEST", details)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401, "UNAUTHORIZED")
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, 403, "FORBIDDEN")
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(message, 404, "NOT_FOUND")
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(message, 409, "CONFLICT")
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: any) {
    super(message, 422, "VALIDATION_ERROR", details)
  }
}

/* ---------------- Helper ---------------- */

export function isAppError(
  error: unknown
): error is AppError {
  return error instanceof AppError
}