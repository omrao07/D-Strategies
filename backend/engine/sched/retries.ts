// sched/retires.ts
// Lightweight retries + scheduler utilities. ESM/NodeNext friendly, zero deps.

// ---------- Types ----------
export type BackoffKind = "constant" | "linear" | "exponential" | "decorrelated-jitter";

export type BackoffOptions = {
  kind?: BackoffKind;
  baseMs?: number;        // starting delay (default 250)
  maxMs?: number;         // cap for any delay (default 30_000)
  factor?: number;        // growth factor for linear/exponential (default 2)
  jitter?: boolean;       // add +/- jitter (default true)
  rand?: () => number;    // RNG hook (default Math.random)
};

export type RetryOptions = BackoffOptions & {
  retries?: number;       // total attempts-1 (default 5) => attempts = retries+1
  timeoutMs?: number;     // per-attempt timeout (optional)
  onRetry?: (info: { attempt: number; error: any; delayMs: number }) => void;
  shouldRetry?: (error: any) => boolean; // default: always retry
};

export type Task<T = any> = () => Promise<T> | T;

// ---------- Backoff implementations ----------
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export function nextDelay(attempt: number, opts: BackoffOptions = {}): number {
  const kind   = opts.kind ?? "exponential";
  const base   = Math.max(0, opts.baseMs ?? 250);
  const maxMs  = Math.max(base, opts.maxMs ?? 30_000);
  const factor = opts.factor ?? 2;
  const rnd    = opts.rand ?? Math.random;
  const useJit = opts.jitter !== false;

  let d: number;
  switch (kind) {
    case "constant":
      d = base;
      break;
    case "linear":
      d = base + attempt * base * (factor - 1);
      break;
    case "decorrelated-jitter":
      // "Decorrelated jitter" (AWS architecture blog): next = clamp(rand(prev * factor, base), base, max)
      // We approximate without prev by using attempt to expand the range.
      {
        const hi = Math.min(maxMs, base * Math.pow(factor, attempt + 1));
        const lo = base;
        d = lo + rnd() * (hi - lo);
      }
      break;
    case "exponential":
    default:
      d = base * Math.pow(factor, attempt);
  }

  d = Math.min(d, maxMs);

  if (useJit) {
    // +/- up to 10% jitter
    const jitterPct = 0.1;
    const sign = rnd() < 0.5 ? -1 : 1;
    d = d + sign * d * jitterPct * rnd();
    d = clamp(d, 0, maxMs);
  }

  return Math.round(d);
}

// ---------- Per-attempt timeout ----------
async function withTimeout<T>(p: Promise<T>, ms?: number): Promise<T> {
  if (!ms || ms <= 0) return p;
  let t: NodeJS.Timeout;
  return new Promise<T>((resolve, reject) => {
    t = setTimeout(() => reject(new Error(`retry: attempt timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// ---------- Retry wrapper ----------
export async function retry<T>(fn: Task<T>, opts: RetryOptions = {}): Promise<T> {
  const totalRetries = Math.max(0, opts.retries ?? 5);
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let lastErr: any;
  for (let attempt = 0; attempt <= totalRetries; attempt++) {
    try {
      const res = await withTimeout(Promise.resolve(fn()), opts.timeoutMs);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt === totalRetries || !shouldRetry(err)) break;
      const delay = nextDelay(attempt, opts);
      opts.onRetry?.({ attempt: attempt + 1, error: err, delayMs: delay });
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Convenience: retry a function factory (so each attempt gets a fresh task). */
export async function retryFactory<T>(factory: () => Task<T>, opts?: RetryOptions) {
  return retry<T>(() => factory()(), opts);
}

// ---------- Simple scheduler with cancellation ----------
export type Scheduled = {
  id: string;
  cancel: () => void;
  nextRunAt: () => number | null; // epoch ms or null if cancelled
};

let _taskSeq = 0;

export function scheduleEvery(
  intervalMs: number,
  task: Task<void>,
  opts?: { runNow?: boolean; jitterPct?: number; rand?: () => number }
): Scheduled {
  const rand = opts?.rand ?? Math.random;
  const jitterPct = clamp(opts?.jitterPct ?? 0, 0, 1);
  const id = `task-${Date.now()}-${_taskSeq++}`;
  let cancelled = false;
  let nextAt: number | null = null;
  let timer: NodeJS.Timeout | null = null;

  const plan = () => {
    if (cancelled) return;
    let delay = intervalMs;
    if (jitterPct > 0) {
      const sign = rand() < 0.5 ? -1 : 1;
      delay = Math.round(intervalMs + sign * intervalMs * jitterPct * rand());
      delay = Math.max(0, delay);
    }
    nextAt = Date.now() + delay;
    timer = setTimeout(async () => {
      try { await Promise.resolve(task()); } catch { /* swallow */ }
      plan();
    }, delay);
  };

  if (opts?.runNow) {
    Promise.resolve(task()).finally(plan);
  } else {
    plan();
  }

  return {
    id,
    cancel() {
      cancelled = true;
      nextAt = null;
      if (timer) clearTimeout(timer);
    },
    nextRunAt: () => nextAt,
  };
}

// ---------- Tiny token-bucket rate limiter ----------
export class RateLimiter {
  private capacity: number;
  private tokens: number;
  private refillPerSec: number;
  private last: number;

  constructor(capacity: number, refillPerSec: number) {
    this.capacity = Math.max(1, capacity);
    this.tokens = this.capacity;
    this.refillPerSec = Math.max(0, refillPerSec);
    this.last = Date.now();
  }

  private refill() {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
  }

  tryRemove(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** Wait until tokens are available, then run `fn`. */
  async schedule<T>(fn: Task<T>, tokens = 1, checkEveryMs = 25): Promise<T> {
    while (!this.tryRemove(tokens)) {
      await new Promise(r => setTimeout(r, checkEveryMs));
    }
    return Promise.resolve(fn());
  }
}

// ---------- Helpers for common cases ----------
export const Retriers = {
  network: (overrides: Partial<RetryOptions> = {}) =>
    ({
      retries: 6,
      timeoutMs: 10_000,
      kind: "decorrelated-jitter" as const,
      baseMs: 200,
      maxMs: 30_000,
      factor: 2,
      jitter: true,
      shouldRetry: (e: any) => {
        const msg = String(e?.message ?? e ?? "");
        // Retry on common transient network-ish errors
        return /timeout|ECONN|ENET|EAI_AGAIN|429|5\d\d/i.test(msg);
      },
      ...overrides,
    } satisfies RetryOptions),

  io: (overrides: Partial<RetryOptions> = {}) =>
    ({
      retries: 4,
      kind: "exponential" as const,
      baseMs: 100,
      maxMs: 5_000,
      factor: 2,
      jitter: true,
      shouldRetry: () => true,
      ...overrides,
    } satisfies RetryOptions),
};

// ---------- Example convenience wrappers ----------
export async function retryNetwork<T>(fn: Task<T>, overrides?: Partial<RetryOptions>) {
  return retry(fn, Retriers.network(overrides));
}

export async function retryIO<T>(fn: Task<T>, overrides?: Partial<RetryOptions>) {
  return retry(fn, Retriers.io(overrides));
}

// ---------- Minimal tests (optional manual) ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const demo = async () => {
    console.log("retry demo:");
    let n = 0;
    const val = await retry(async () => {
      n++;
      if (n < 3) throw new Error("fail until 3");
      return "ok";
    }, { retries: 5, baseMs: 50, kind: "exponential", onRetry: i => console.log(" retry", i) });
    console.log(" result:", val);

    console.log("\nscheduleEvery demo (runs 3 times):");
    let c = 0;
    const sched = scheduleEvery(200, () => { c++; console.log(" tick", c); if (c >= 3) sched.cancel(); }, { runNow: true, jitterPct: 0.2 });

    console.log("\nrate limiter demo:");
    const rl = new RateLimiter(2, 4); // 2 tokens burst, 4 tokens/sec
    const jobs = Array.from({ length: 6 }, (_, i) => rl.schedule(async () => {
      console.log(" job", i, "at", Date.now() % 100000);
    }));
    await Promise.all(jobs);
  };
  demo().catch(e => console.error(e));
}