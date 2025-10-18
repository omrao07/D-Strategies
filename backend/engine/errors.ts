// engine/error.ts
// Pure TypeScript utilities for engine/runtime errors (no imports).

type JSONValue = string | number | boolean | null | JSONValue[] | { [k: string]: JSONValue }

type ErrorKind =
  | "TaskError"
  | "TimeoutError"
  | "RetryableError"
  | "ValidationError"
  | "EngineStateError"
  | "UnknownError"

type ErrorData = {
  kind: ErrorKind
  name: string
  message: string
  code?: string
  cause?: unknown
  details?: Record<string, JSONValue>
  stack?: string
}

/** Narrow helper to coerce unknown into an Error-like object. */
function asError(e: unknown): Error {
  if (e instanceof Error) return e
  const msg =
    e === null || e === undefined
      ? String(e)
      : typeof e === "object"
      ? JSON.stringify(e)
      : String(e)
  const err = new Error(msg)
  ;(err as any).raw = e
  return err
}

/** Base typed error carrying a `kind` and optional metadata. */
class EngineError extends Error {
  kind: ErrorKind
  code?: string
  details?: Record<string, JSONValue>
  cause?: unknown

  constructor(
    kind: ErrorKind,
    message: string,
    options?: { code?: string; cause?: unknown; details?: Record<string, JSONValue> }
  ) {
    super(message)
    this.name = "EngineError"
    this.kind = kind
    this.code = options?.code
    this.details = options?.details
    this.cause = options?.cause
    // Ensure proper prototype chain in TS when targeting ES5
    Object.setPrototypeOf(this, new.target.prototype)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target)
    }
  }

  toJSON(): ErrorData {
    return {
      kind: this.kind,
      name: this.name,
      message: this.message,
      code: this.code,
      details: this.details,
      cause: serializeCause(this.cause),
      stack: this.stack,
    }
  }
}

class TaskError extends EngineError {
  constructor(message: string, opts?: ConstructorParameters<typeof EngineError>[2]) {
    super("TaskError", message, opts)
    this.name = "TaskError"
  }
}

class TimeoutError extends EngineError {
  constructor(message = "Task timed out", opts?: ConstructorParameters<typeof EngineError>[2]) {
    super("TimeoutError", message, opts)
    this.name = "TimeoutError"
    if (!this.code) this.code = "ETIMEDOUT"
  }
}

class RetryableError extends EngineError {
  constructor(message: string, opts?: ConstructorParameters<typeof EngineError>[2]) {
    super("RetryableError", message, opts)
    this.name = "RetryableError"
  }
}

class ValidationError extends EngineError {
  constructor(message: string, opts?: ConstructorParameters<typeof EngineError>[2]) {
    super("ValidationError", message, opts)
    this.name = "ValidationError"
    if (!this.code) this.code = "EVALIDATION"
  }
}

class EngineStateError extends EngineError {
  constructor(message: string, opts?: ConstructorParameters<typeof EngineError>[2]) {
    super("EngineStateError", message, opts)
    this.name = "EngineStateError"
  }
}

/** Type guards */
function isEngineError(e: unknown): e is EngineError {
  return !!e && typeof e === "object" && (e as any).name === "EngineError" || e instanceof EngineError
}
function isRetryable(e: unknown): boolean {
  return (e instanceof RetryableError) || (isEngineError(e) && (e as EngineError).kind === "RetryableError")
}
function isTimeout(e: unknown): boolean {
  return (e instanceof TimeoutError) || (isEngineError(e) && (e as EngineError).kind === "TimeoutError")
}

/** Safe JSON for unknown errors. */
function errorToJSON(e: unknown): ErrorData {
  if (isEngineError(e)) return e.toJSON()
  const err = asError(e)
  return {
    kind: "UnknownError",
    name: err.name || "Error",
    message: err.message || "Unknown error",
    code: (err as any).code,
    details: shallowDetails(err),
    cause: serializeCause((err as any).cause ?? (err as any).raw),
    stack: err.stack,
  }
}

/** Wrap unknown into a specific EngineError kind (preserving cause). */
function wrapAs(kind: ErrorKind, e: unknown, message?: string, details?: Record<string, JSONValue>): EngineError {
  const err = asError(e)
  const msg = message ? `${message}: ${err.message}` : err.message
  switch (kind) {
    case "TaskError": return new TaskError(msg, { cause: err, details })
    case "TimeoutError": return new TimeoutError(msg, { cause: err, details })
    case "RetryableError": return new RetryableError(msg, { cause: err, details })
    case "ValidationError": return new ValidationError(msg, { cause: err, details })
    case "EngineStateError": return new EngineStateError(msg, { cause: err, details })
    default: return new EngineError("UnknownError", msg, { cause: err, details })
  }
}

/** Convenience creators */
const Errors = {
  task: (msg: string, details?: Record<string, JSONValue>) => new TaskError(msg, { details }),
  timeout: (msg = "Task timed out", details?: Record<string, JSONValue>) => new TimeoutError(msg, { details }),
  retryable: (msg: string, details?: Record<string, JSONValue>) => new RetryableError(msg, { details }),
  validation: (msg: string, details?: Record<string, JSONValue>) => new ValidationError(msg, { details }),
  state: (msg: string, details?: Record<string, JSONValue>) => new EngineStateError(msg, { details }),
  wrapAs,
}

/** Utility: extract shallow enumerable props for diagnostics. */
function shallowDetails(err: Error): Record<string, JSONValue> | undefined {
  const out: Record<string, JSONValue> = {}
  for (const k of Object.keys(err as any)) {
    const v = (err as any)[k]
    if (isJSONValue(v)) out[k] = v
    else out[k] = String(v)
  }
  return Object.keys(out).length ? out : undefined
}

/** Utility: test JSON-safe value */
function isJSONValue(v: unknown): v is JSONValue {
  if (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  ) return true
  if (Array.isArray(v)) return v.every(isJSONValue)
  if (typeof v === "object") {
    for (const k in v as any) {
      if (!isJSONValue((v as any)[k])) return false
    }
    return true
  }
  return false
}

/** Utility: serialize unknown cause safely */
function serializeCause(cause: unknown): JSONValue {
  if (cause instanceof EngineError) return cause.toJSON() as unknown as JSONValue
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      stack: cause.stack || null,
    } as unknown as JSONValue
  }
  if (isJSONValue(cause)) return cause
  return String(cause) as unknown as JSONValue
}

/** Produce a concise, single-line message for logs. */
function toLogLine(e: unknown): string {
  if (isEngineError(e)) {
    const parts = [`[${e.kind}] ${e.message}`]
    if (e.code) parts.push(`code=${e.code}`)
    return parts.join(" ")
  }
  const err = asError(e)
  return `[UnknownError] ${err.message}`
}

export {
  EngineError,
  TaskError,
  TimeoutError,
  RetryableError,
  ValidationError,
  EngineStateError,
  Errors,
  isEngineError,
  isRetryable,
  isTimeout,
  errorToJSON,
  toLogLine,
  asError,
  type ErrorKind,
  type JSONValue,
  type ErrorData,
}
// pipelines/single.ts
// Run ONE strategy with optional params, save outputs, optional CSV + ASCII chart.
//
// Usage:
//   npx ts-node --esm pipelines/single.ts \
//     --id=examples.mean_reversion \
//     --start=2024-01-01 --end=2024-12-31 \
//     --params='{"symbol":"SPY","lookback":20}' \
//     --saveCsv=true --chart=true
//
// Flags:
//   --id=<strategyId>           (required)
//   --start=YYYY-MM-DD          default 2024-01-01
//   --end=YYYY-MM-DD            default 2024-12-31
//   --mode=backtest|paper|live  default backtest
//   --params='{"k":"v"}'        JSON string of params
//   --saveCsv=true|false        write outputs/curves/<id>-<ts>.csv (default true)
//   --chart=true|false          print ASCII chart to terminal (default true)

import * as fs from "fs";
import * as path from "path";

/* ---------------- small utils ---------------- */
type Dict<T = any> = Record<string, T>;
const asNum = (x: any, d = 0) => (x === undefined ? d : (Number.isFinite(+x) ? +x : d));
const asStr = (x: any, d = "") => (typeof x === "string" ? x : d);
function asBool(x: any, d = false) {
  if (typeof x === "boolean") return x;
  if (typeof x === "string") return ["1","true","yes","y","on"].includes(x.toLowerCase());
  return d;
}
function need<T>(v: T | undefined, msg: string): T { if (v == null) { console.error(msg); process.exit(1); } return v; }