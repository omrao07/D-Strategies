// errors/guards.ts
// Type guards + invariant helpers for safer runtime checks

import { makeError } from "./boundary";

// --------- Type Guards ---------

export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function isString(v: unknown): v is string {
  return typeof v === "string";
}

export function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function isArray<T = unknown>(v: unknown): v is T[] {
  return Array.isArray(v);
}

export function isDate(v: unknown): v is Date {
  return v instanceof Date && !isNaN(v.getTime());
}

// --------- Invariant helpers ---------

/**
 * Asserts a condition and throws typed error if violated
 */
export function invariant(
  cond: any,
  msg: string,
  kind: Parameters<typeof makeError>[0] = "Runtime",
  details?: Record<string, any>
): asserts cond {
  if (!cond) {
    throw makeError(kind, msg, undefined, details);
  }
}

/**
 * Narrow a value, or throw
 */
export function expectString(
  v: unknown,
  msg = "Expected string"
): string {
  invariant(isString(v), msg, "Config", { value: v });
  return v;
}

export function expectNumber(
  v: unknown,
  msg = "Expected number"
): number {
  invariant(isNumber(v), msg, "Config", { value: v });
  return v;
}

export function expectObject<T extends object = Record<string, unknown>>(
  v: unknown,
  msg = "Expected object"
): T {
  invariant(isObject(v), msg, "Config", { value: v });
  return v as T;
}