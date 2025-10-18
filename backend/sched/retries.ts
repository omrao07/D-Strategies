// sched/retries.ts
// Zero-dependency, production-ready retry utilities for async/sync tasks.
// Features:
// - Exponential / fixed / linear backoff
// - Full jitter / bounded jitter / none
// - Max attempts, max elapsed, per-attempt timeout, overall timeout
// - AbortSignal support (cancel anytime)
// - Retry predicate (by error/value), hooks (onAttempt/onSuccess/onGiveUp)
// - Wrap helper to decorate functions
// - Detailed RetryError with history

export type Millis = number;

export type BackoffMode = "fixed" | "linear" | "exponential" | "decorrelated";
export type JitterMode = "none" | "full" | "bounded";

export interface RetryOptions<T = unknown> {
  // attempts & timing
  maxAttempts?: number;          // default 5 (attempts = initial try + retries)
  baseDelayMs?: Millis;          // default 100ms
  maxDelayMs?: Millis;           // default 30_000ms
  backoff?: BackoffMode;         // default "exponential"
  jitter?: JitterMode;           // default "full"
  factor?: number;               // growth factor for linear/exponential (default 2)
  // limits
  overallTimeoutMs?: Millis;     // hard cap for the entire retry operation (default: none)
  attemptTimeoutMs?: Millis;     // per-attempt timeout (default: none)
  maxElapsedMs?: Millis;         // alternative to overallTimeoutMs: cap on elapsed between first start and finish
  // control
  shouldRetry?: (info: RetryDecision<T>) => boolean | Promise<boolean>; // default: retry on error
  // hooks
  onAttempt?: (info: AttemptInfo<T>) => void | Promise<void>;
  onSuccess?: (info: SuccessInfo<T>) => void | Promise<void>;
  onGiveUp?: (info: GiveUpInfo<T>) => void | Promise<void>;
  // cancellation
  signal?: AbortSignal;          // external cancellation
}

export interface AttemptInfo<T = unknown> {
  attempt: number;               // 1-based
  delayMs: Millis;               // planned wait before the attempt (0 for first)
  nextDelayMs: Millis;           // planned wait before a potential next retry
  elapsedMs: Millis;             // since first call started
  startAt: number;               // ms epoch of attempt start
  lastError?: unknown;           // error from previous attempt (if any)
  lastValue?: T;                 // value from previous attempt (if using value-based retry)
  aborted: boolean;              // true if AbortSignal is already aborted
}

export interface SuccessInfo<T = unknown> {
  attempt: number;
  elapsedMs: Millis;
  value: T;
  history: AttemptHistoryEntry[];
}

export interface GiveUpInfo<T = unknown> {
  attempt: number;               // last attempted
  elapsedMs: Millis;
  reason: "max-attempts" | "timeout" | "aborted" | "predicate";
  lastError?: unknown;
  lastValue?: T;
  history: AttemptHistoryEntry[];
}

export interface RetryDecision<T = unknown> {
  attempt: number;               // the attempt that just finished (failed or yielded retryable value)
  elapsedMs: Millis;
  error?: unknown;               // if thrown
  value?: T;                     // if returned successfully but still considered retryable
  nextDelayMs: Millis;           // computed delay if retrying
}

export interface AttemptHistoryEntry {
  attempt: number;
  startAt: number;
  durationMs: Millis;
  outcome: "error" | "value";
  errorMessage?: string;
  valueSample?: string; // tiny stringified preview (non-throw)
}

export class RetryError extends Error {
  readonly attempts: number;
  readonly lastError?: unknown;
  readonly lastValue?: unknown;
  readonly elapsedMs: Millis;
  readonly reason: GiveUpInfo["reason"];
  readonly history: AttemptHistoryEntry[];

  constructor(msg: string, data: { attempts: number; lastError?: unknown; lastValue?: unknown; elapsedMs: number; reason: GiveUpInfo["reason"]; history: AttemptHistoryEntry[] }) {
    super(msg);
    this.name = "RetryError";
    this.attempts = data.attempts;
    this.lastError = data.lastError;
    this.lastValue = data.lastValue;
    this.elapsedMs = data.elapsedMs;
    this.reason = data.reason;
    this.history = data.history;
  }
}

// ---------- Public API ----------

/**
 * Retry an operation with configurable backoff, jitter, timeouts, and hooks.
 * The provided function may be sync or async.
 *
 * By default, retries only when the function throws/rejects.
 * You can also trigger retries on "undesired" values by providing a shouldRetry that inspects {value}.
 */
export async function retry<T>(fn: () => Promise<T> | T, opts?: RetryOptions<T>): Promise<T> {
  const cfg = normalizeOptions<T>(opts);
  const originStart = now();
  const history: AttemptHistoryEntry[] = [];

  // Manage overall timeout via AbortSignal composition
  const { signal: combinedSignal, cancel: cancelCombined } = composeAbort(cfg.signal, cfg.overallTimeoutMs, originStart);

  let attempt = 0;
  let lastErr: unknown | undefined;
  let lastVal: T | undefined;
  let delayBefore: Millis = 0;

  while (true) {
    attempt += 1;

    // Abort checks before each attempt
    if (combinedSignal?.aborted) {
      const elapsed = elapsedSince(originStart);
      await cfg.onGiveUp?.({
        attempt: attempt - 1,
        elapsedMs: elapsed,
        reason: "aborted",
        lastError: lastErr,
        lastValue: lastVal,
        history: history.slice(),
      });
      throw new RetryError(`Retry aborted after ${attempt - 1} attempts (${elapsed}ms)`, {
        attempts: attempt - 1,
        lastError: lastErr,
        lastValue: lastVal,
        elapsedMs: elapsed,
        reason: "aborted",
        history: history.slice(),
      });
    }

    // Notify attempt start
    await cfg.onAttempt?.({
      attempt,
      delayMs: delayBefore,
      nextDelayMs: computeNextDelay(cfg, attempt), // informational
      elapsedMs: elapsedSince(originStart),
      startAt: now(),
      lastError: lastErr,
      lastValue: lastVal,
      aborted: !!combinedSignal?.aborted,
    });

    // Wait before attempt (not for the first)
    if (delayBefore > 0) {
      await sleep(delayBefore, combinedSignal);
    }

    // Execute with per-attempt timeout if configured
    const startedAt = now();
    const { signal: attemptSignal, cancel: cancelAttempt } =
      cfg.attemptTimeoutMs ? composeAbort(combinedSignal, cfg.attemptTimeoutMs, startedAt) : { signal: combinedSignal, cancel: undefined };

    let thrown: unknown | undefined;
    let value: T | undefined;

    try {
      const res = fn();
      value = isPromise(res) ? await resWithAbort(res as Promise<T>, attemptSignal) : (res as T);
    } catch (e) {
      thrown = e;
    } finally {
      cancelAttempt?.();
    }

    const duration = elapsedSince(startedAt);

    if (thrown !== undefined) {
      // record failure
      lastErr = thrown;
      lastVal = undefined;
      history.push({
        attempt,
        startAt: startedAt,
        durationMs: duration,
        outcome: "error",
        errorMessage: errorToString(thrown),
      });
    } else {
      // record success value (may still be retryable)
      lastVal = value as T;
      lastErr = undefined;
      history.push({
        attempt,
        startAt: startedAt,
        durationMs: duration,
        outcome: "value",
        valueSample: tinyPreview(value),
      });
    }

    // Evaluate retry predicate
    const elapsed = elapsedSince(originStart);
    const nextDelay = computeNextDelay(cfg, attempt);

    const wantRetry = await cfg.shouldRetry({
      attempt,
      elapsedMs: elapsed,
      error: lastErr,
      value: lastVal,
      nextDelayMs: nextDelay,
    });

    // Check terminal conditions
    const attemptsExhausted = attempt >= cfg.maxAttempts;
    const overElapsedCap =
      (cfg.maxElapsedMs != null && elapsed >= cfg.maxElapsedMs) ||
      (cfg.overallTimeoutMs != null && elapsed >= cfg.overallTimeoutMs);

    if (!wantRetry) {
      // SUCCESS (or predicate says stop)
      if (lastErr === undefined) {
        await cfg.onSuccess?.({ attempt, elapsedMs: elapsed, value: lastVal as T, history: history.slice() });
        cancelCombined?.();
        return lastVal as T;
      } else {
        // predicate said stop retrying on error
        await cfg.onGiveUp?.({
          attempt,
          elapsedMs: elapsed,
          reason: "predicate",
          lastError: lastErr,
          lastValue: lastVal,
          history: history.slice(),
        });
        cancelCombined?.();
        throw new RetryError(
          `Stopped by predicate after ${attempt} attempts (${elapsed}ms): ${errorToString(lastErr)}`,
          { attempts: attempt, lastError: lastErr, lastValue: lastVal, elapsedMs: elapsed, reason: "predicate", history: history.slice() }
        );
      }
    }

    if (attemptsExhausted) {
      await cfg.onGiveUp?.({
        attempt,
        elapsedMs: elapsed,
        reason: "max-attempts",
        lastError: lastErr,
        lastValue: lastVal,
        history: history.slice(),
      });
      cancelCombined?.();
      const msg = lastErr === undefined
        ? `Max attempts reached with retryable value after ${attempt} attempts (${elapsed}ms)`
        : `Max attempts reached after ${attempt} attempts (${elapsed}ms): ${errorToString(lastErr)}`;
      throw new RetryError(msg, {
        attempts: attempt,
        lastError: lastErr,
        lastValue: lastVal,
        elapsedMs: elapsed,
        reason: "max-attempts",
        history: history.slice(),
      });
    }

    if (overElapsedCap) {
      await cfg.onGiveUp?.({
        attempt,
        elapsedMs: elapsed,
        reason: "timeout",
        lastError: lastErr,
        lastValue: lastVal,
        history: history.slice(),
      });
      cancelCombined?.();
      const msg = lastErr === undefined
        ? `Retry timeout after ${attempt} attempts (${elapsed}ms) with retryable value`
        : `Retry timeout after ${attempt} attempts (${elapsed}ms): ${errorToString(lastErr)}`;
      throw new RetryError(msg, {
        attempts: attempt,
        lastError: lastErr,
        lastValue: lastVal,
        elapsedMs: elapsed,
        reason: "timeout",
        history: history.slice(),
      });
    }

    // Prepare next loop
    delayBefore = nextDelay;
  }
}

/**
 * Wrap a function so calls are automatically retried per options.
 * Useful for injecting into data sources, RPC clients, etc.
 */
export function withRetries<Args extends any[], R>(
  fn: (...args: Args) => Promise<R> | R,
  opts?: RetryOptions<R>
): (...args: Args) => Promise<R> {
  return async (...args: Args) => retry<R>(() => fn(...args), opts);
}

// ---------- Backoff & Jitter ----------

function computeNextDelay<T>(cfg: RequiredNormalizedOptions<T>, attempt: number): Millis {
  // attempt is 1-based; nextDelay corresponds to the wait *before* the next attempt
  const n = attempt; // use attempt index for growth
  let raw: number;
  switch (cfg.backoff) {
    case "fixed":
      raw = cfg.baseDelayMs;
      break;
    case "linear":
      raw = cfg.baseDelayMs * (1 + (n - 1) * cfg.factor);
      break;
    case "exponential":
      raw = cfg.baseDelayMs * Math.pow(cfg.factor, n - 1);
      break;
    case "decorrelated": // "decorrelated jitter" (AWS style): random between base and previous*factor
      // approximate without state by using exp but randomize wide
      const hi = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * Math.pow(cfg.factor, n));
      raw = randRange(cfg.baseDelayMs, hi);
      break;
    default:
      raw = cfg.baseDelayMs;
  }
  raw = Math.min(Math.max(0, raw), cfg.maxDelayMs);

  // Jitter
  let withJitter: number;
  switch (cfg.jitter) {
    case "none":
      withJitter = raw;
      break;
    case "full":
      withJitter = randRange(0, raw);
      break;
    case "bounded":
      // +/- 25% bounded jitter
      const jitterAmt = raw * 0.25;
      withJitter = clamp(raw + randRange(-jitterAmt, jitterAmt), 0, cfg.maxDelayMs);
      break;
    default:
      withJitter = raw;
  }
  return Math.floor(withJitter);
}

// ---------- Internals ----------

type RequiredNormalizedOptions<T> = Required<
  Omit<
    RetryOptions<T>,
    | "shouldRetry"
    | "onAttempt"
    | "onSuccess"
    | "onGiveUp"
    | "signal"
    | "overallTimeoutMs"
    | "attemptTimeoutMs"
    | "maxElapsedMs"
  >
> & {
  shouldRetry: NonNullable<RetryOptions<T>["shouldRetry"]>;
  onAttempt?: RetryOptions<T>["onAttempt"];
  onSuccess?: RetryOptions<T>["onSuccess"];
  onGiveUp?: RetryOptions<T>["onGiveUp"];
  signal?: AbortSignal;
  overallTimeoutMs?: Millis;
  attemptTimeoutMs?: Millis;
  maxElapsedMs?: Millis;
};

function normalizeOptions<T>(opts?: RetryOptions<T>): RequiredNormalizedOptions<T> {
  const o = opts ?? {};
  const maxAttempts = isPosInt(o.maxAttempts) ? (o.maxAttempts as number) : 5;
  const baseDelayMs = isPosInt(o.baseDelayMs) ? (o.baseDelayMs as number) : 100;
  const maxDelayMs = isPosInt(o.maxDelayMs) ? (o.maxDelayMs as number) : 30_000;
  const factor = Number.isFinite(o.factor as number) && (o.factor as number) > 0 ? (o.factor as number) : 2;

  const shouldRetry = o.shouldRetry ?? (async (d: RetryDecision<T>) => d.error !== undefined);

  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    backoff: (o.backoff ?? "exponential") as BackoffMode,
    jitter: (o.jitter ?? "full") as JitterMode,
    factor,
    shouldRetry,
    onAttempt: o.onAttempt,
    onSuccess: o.onSuccess,
    onGiveUp: o.onGiveUp,
    signal: o.signal,
    overallTimeoutMs: o.overallTimeoutMs,
    attemptTimeoutMs: o.attemptTimeoutMs,
    maxElapsedMs: o.maxElapsedMs,
  };
}

function isPosInt(v: any): v is number {
  return Number.isInteger(v) && v > 0;
}

function now(): number {
  return Date.now();
}

function elapsedSince(t0: number): Millis {
  return Math.max(0, now() - t0);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let done = false;
    const id = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    const cleanup = () => {
      clearTimeout(id);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        return reject(new DOMException("Aborted", "AbortError"));
      }
      signal.addEventListener("abort", onAbort);
    }
  });
}

function isPromise<T = unknown>(v: any): v is Promise<T> {
  return !!v && typeof v.then === "function";
}

function errorToString(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  try { return JSON.stringify(e); } catch { return String(e); }
}

function tinyPreview(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (v === null) return "null";
  const t = typeof v;
  
  if (t === "number" || t === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 64 ? s.slice(0, 61) + "..." : s;
  } catch {
    return Object.prototype.toString.call(v);
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function resWithAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (!("aborted" in signal)) return p;
  if (!signal.aborted) {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", onAbort);
      p.then(
        (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
        (e) => { signal.removeEventListener("abort", onAbort); reject(e); }
      );
    });
  }
  return Promise.reject(new DOMException("Aborted", "AbortError"));
}

/**
 * Compose an AbortSignal with an optional timeout. If both provided, either can cancel.
 * Returns a synthetic AbortController-like pair (signal, cancel).
 */
function composeAbort(parent?: AbortSignal, timeoutMs?: Millis, t0?: number): { signal?: AbortSignal; cancel?: () => void } {
  if (!parent && timeoutMs == null) return { signal: undefined, cancel: undefined };

  // If a DOM-like AbortController exists, use it; otherwise, shim a minimal one.
  const controller = createAbortController();
  const signal = controller.signal;
  let timeoutId: any;

  const cancel = () => {
    try { controller.abort(); } catch {/* noop */}
    if (timeoutId) clearTimeout(timeoutId);
    if (parent) parent.removeEventListener("abort", onParentAbort);
  };

  const onParentAbort = () => cancel();
  if (parent) {
    if (parent.aborted) cancel();
    else parent.addEventListener("abort", onParentAbort);
  }

  if (timeoutMs != null) {
    const start = t0 ?? now();
    const remain = Math.max(0, timeoutMs - (now() - start));
    timeoutId = setTimeout(cancel, remain);
  }

  return { signal, cancel };
}

// Minimal AbortController polyfill if not present (e.g., older Node runtimes)
function createAbortController(): { signal: AbortSignal; abort: () => void } {
  if (typeof AbortController !== "undefined") {
    return new AbortController();
  }
  // Polyfill
  const listeners: Array<() => void> = [];
  const sig: any = {
    aborted: false,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener: (_: string, fn: () => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatchEvent: () => true,
    reason: undefined,
    throwIfAborted: () => { if (sig.aborted) throw new DOMException("Aborted", "AbortError"); },
  };
  return {
    signal: sig as AbortSignal,
    abort: () => { if (!sig.aborted) { sig.aborted = true; listeners.slice().forEach((f) => f()); } },
  };
}

// ---------- Convenience Presets ----------

/** Retry on any error, 5 attempts, exponential backoff with full jitter. */
export const RETRY_DEFAULT: RetryOptions = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 100,
  maxDelayMs: 30_000,
  backoff: "exponential",
  jitter: "full",
  factor: 2,
});

/** "Aggressive": 8 attempts, smaller base delay. */
export const RETRY_AGGRESSIVE: RetryOptions = Object.freeze({
  maxAttempts: 8,
  baseDelayMs: 50,
  maxDelayMs: 10_000,
  backoff: "exponential",
  jitter: "full",
  factor: 2,
});

/** "Gentle": 4 attempts, fixed delay, bounded jitter. */
export const RETRY_GENTLE: RetryOptions = Object.freeze({
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 250,
  backoff: "fixed",
  jitter: "bounded",
  factor: 1,
});

// ---------- Example usage (commented) ----------
/*
const fetchJson = withRetries(async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}, {
  ...RETRY_DEFAULT,
  attemptTimeoutMs: 2000,
  overallTimeoutMs: 15_000,
  shouldRetry: async ({ error, value }) => {
    if (error) return true;               // retry on errors
    if (value && value.status === "retry_later") return true; // retry on sentinel values
    return false;
  },
  onAttempt: ({ attempt, delayMs }) => console.info(`Attempt #${attempt} (delay=${delayMs}ms)`),
  onSuccess: ({ attempt, elapsedMs }) => console.info(`Succeeded on attempt #${attempt} in ${elapsedMs}ms`),
  onGiveUp: (g) => console.warn(`Giving up after #${g.attempt} (${g.reason})`),
});

const aborter = new AbortController();
setTimeout(() => aborter.abort(), 5000);

retry(() => fetchJson("https://api.example.com/data"), { signal: aborter.signal })
  .then(console.log)
  .catch((e) => console.error(e));
*/
