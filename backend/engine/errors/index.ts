// errors/index.ts
// Single entry for the errors module: exports + small helpers.

export type { ErrorKind, AppError } from "./boundary";
export { makeError, toAppError, runWithBoundary } from "./boundary";

export {
  isObject,
  isString,
  isNumber,
  isArray,
  isDate,
  invariant,
  expectString,
  expectNumber,
  expectObject,
} from "./guards";

/* ===================== Result helpers ===================== */

/** Standard Result union for safe-return APIs. */
export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; error: Error };
export type Result<T> = Ok<T> | Err;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = (error: Error): Err => ({ ok: false, error });

/** Wrap an async fn into a Result. */
export async function resultify<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/** Wrap a sync fn into a Result. */
export function resultifySync<T>(fn: () => T): Result<T> {
  try {
    return ok(fn());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/* ===================== Misc predicates ===================== */

export function isAppError(e: unknown): e is import("./boundary").AppError {
  return !!e && typeof e === "object" && "message" in (e as any) && "kind" in (e as any);
}

/** Exhaustiveness guard for switch/case on discriminated unions. */
export function assertNever(x: never, msg = "Unreachable"): never {
  throw new Error(`${msg}: ${String(x)}`);
}

/** Attach/override a cause to an Error (keeps node >=16 semantics). */
export function withCause<E extends Error>(e: E, cause?: unknown): E {
  try {
    (e as any).cause = cause;
  } catch { /* ignore */ }
  return e;
}