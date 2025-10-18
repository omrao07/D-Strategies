// errors/boundary.ts
// Centralized error boundary + typed error helpers

export type ErrorKind =
  | "Config"
  | "Data"
  | "Feed"
  | "Broker"
  | "Risk"
  | "Backtest"
  | "Persistence"
  | "Runtime"
  | "Unknown";

export interface AppError extends Error {
  kind: ErrorKind;
  cause?: unknown;
  details?: Record<string, any>;
}

/**
 * Factory for creating typed errors
 */
export function makeError(
  kind: ErrorKind,
  msg: string,
  cause?: unknown,
  details?: Record<string, any>
): AppError {
  const err = new Error(msg) as AppError;
  err.kind = kind;
  err.cause = cause;
  err.details = details;
  return err;
}

/**
 * Normalize unknown errors into AppError
 */
export function toAppError(e: unknown, fallbackKind: ErrorKind = "Unknown"): AppError {
  if (!e) return makeError(fallbackKind, "Unknown error (null/undefined)");
  if (typeof e === "string") return makeError(fallbackKind, e);
  if (e instanceof Error) {
    const ae = e as AppError;
    if (ae.kind) return ae;
    return makeError(fallbackKind, e.message, e);
  }
  return makeError(fallbackKind, "Non-error thrown", e, { value: e });
}

/**
 * Error boundary runner: catches, normalizes, logs, rethrows
 */
export async function runWithBoundary<T>(
  fn: () => Promise<T>,
  opts: { kind?: ErrorKind; rethrow?: boolean; logger?: (err: AppError) => void } = {}
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    const err = toAppError(e, opts.kind ?? "Unknown");
    if (opts.logger) opts.logger(err);
    if (opts.rethrow) throw err;
    return undefined;
  }
}