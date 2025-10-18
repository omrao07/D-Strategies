// runtime/retry.ts
// Generic retry utility for async operations with backoff + cancellation

export type BackoffStrategy = "fixed" | "linear" | "exponential";

export interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  retries?: number;
  /** Delay in ms for first retry (default: 500) */
  delay?: number;
  /** Backoff mode: fixed | linear | exponential (default: exponential) */
  backoff?: BackoffStrategy;
  /** Maximum delay between retries (default: 30s) */
  maxDelay?: number;
  /** Add random jitter to spread load (0–1, default: 0) */
  jitter?: number;
  /** AbortSignal to cancel retries */
  signal?: AbortSignal;
  /** Called before each retry (attempt #, error, next delay) */
  onRetry?: (info: { attempt: number; error: unknown; delay: number }) => void;
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    retries = 3,
    delay = 500,
    backoff = "exponential",
    maxDelay = 30_000,
    jitter = 0,
    signal,
    onRetry,
  } = opts;

  let attempt = 0;
  let err: unknown;

  while (attempt < retries) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await fn(attempt + 1);
    } catch (e) {
      err = e;
      attempt++;
      if (attempt >= retries) break;

      let d = computeDelay(delay, backoff, attempt);
      if (maxDelay > 0) d = Math.min(d, maxDelay);
      if (jitter > 0) {
        const j = d * jitter * Math.random();
        d = d - j / 2 + j; // +/- jitter
      }

      onRetry?.({ attempt, error: e, delay: d });

      await wait(d, signal);
    }
  }
  throw err;
}

/* ------------------------------- Helpers ------------------------------- */

function computeDelay(base: number, backoff: BackoffStrategy, attempt: number) {
  switch (backoff) {
    case "fixed":
      return base;
    case "linear":
      return base * attempt;
    case "exponential":
    default:
      return base * Math.pow(2, attempt - 1);
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const id = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(id);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    }
  });
}

/* ------------------------------- Example ------------------------------- */
// Usage:
//
// const data = await retry(
//   async (attempt) => {
//     console.log("fetch attempt", attempt);
//     const res = await fetch("https://api.example.com/data");
//     if (!res.ok) throw new Error("Failed");
//     return res.json();
//   },
//   { retries: 5, delay: 1000, backoff: "exponential", jitter: 0.2 }
// );
// ------------------------------- Example ------------------------------- */

// backend/strategies/utils/dates.ts
// Date utilities for business days, holidays, and day count conventions

export type DayCount = "ACT/365" | "ACT/360" | "30/360" | "30E/360";

// -------------------- Basic date ops --------------------
export function startOfUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function diffDays(date1: Date, date2: Date): number {
  const t1 = startOfUTC(date1).getTime();
  const t2 = startOfUTC(date2).getTime();
  return Math.round((t1 - t2) / (1000 * 60 * 60 * 24));
}

// -------------------- Business day utilities --------------------
export function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6; // Sunday=0, Saturday=6
}

export function isHoliday(date: Date, holidays: Set<string>): boolean {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const key = `${y}-${m}-${d}`;
  return holidays.has(key);
}

export function isBusinessDay(date: Date, holidays: Set<string>): boolean {
  return !isWeekend(date) && !isHoliday(date, holidays);
}

export function addBusinessDays(date: Date, days: number, holidays: Set<string>): Date {
  let d = new Date(date);
  let added = 0;
  const step = days >= 0 ? 1 : -1;
  while (added < Math.abs(days)) {
    d = addDays(d, step);
    if (isBusinessDay(d, holidays)) added++;
  }
  return d;
}

export function businessDaysBetween(start: Date, end: Date, holidays: Set<string>): number {
  let count = 0;
  let d = new Date(start);
  const step = start < end ? 1 : -1;
  while (d < end) {
    if (isBusinessDay(d, holidays)) count++;
    d = addDays(d, step);
  }
  return count;
}

// -------------------- Day count conventions --------------------
export function yearFraction(start: Date, end: Date, convention: DayCount): number {
  const days = diffDays(end, start);
  switch (convention) {
    case "ACT/365":
      return days / 365;
    case "ACT/360":
      return days / 360;
    case "30/360":
      return days360(start, end) / 360;
    case "30E/360":
      return days360E(start, end) / 360;
    default:
      throw new Error(`Unsupported day count convention: ${convention}`);
  }
}

function days360(start: Date, end: Date): number {
  let d1 = start.getUTCDate();
  let d2 = end.getUTCDate();
  const m1 = start.getUTCMonth() + 1;
  const m2 = end.getUTCMonth() + 1;
  const y1 = start.getUTCFullYear();
  const y2 = end.getUTCFullYear();

  if (d1 === 31) d1 = 30;
  if (d2 === 31 && d1 === 30) d2 = 30;

  return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
}

function days360E(start: Date, end: Date): number {
  let d1 = start.getUTCDate();
  let d2 = end.getUTCDate();
  const m1 = start.getUTCMonth() + 1;
  const m2 = end.getUTCMonth() + 1;
  const y1 = start.getUTCFullYear();
  const y2 = end.getUTCFullYear();

  if (d1 === 31) d1 = 30;
  if (d2 === 31) d2 = 30;

  return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
}

