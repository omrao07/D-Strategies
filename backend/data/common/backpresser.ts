// common/backpressure.ts
// Backpressure + resilience primitives. No external deps.

// ---------- Utilities ----------
const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
const now = () => Date.now();

// ========== Concurrency limiter (p-limit style) ==========
export function pLimit(concurrency: number) {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error("pLimit: concurrency must be >= 1");
  }
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    active--;
    if (queue.length) queue.shift()!();
  };

  async function run<T>(fn: () => Promise<T> | T): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>(r => queue.push(r));
    }
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  }

  return Object.assign(run, {
    get active() { return active; },
    get pending() { return queue.length; }
  });
}

// ========== Sliding-window rate limiter ==========
export function rateLimiter(opts: { max: number; windowMs: number }) {
  const { max, windowMs } = opts;
  if (max < 1 || windowMs <= 0) throw new Error("rateLimiter: invalid args");
  const hits: number[] = [];

  async function acquire(): Promise<void> {
    const t = now();
    // purge old
    while (hits.length && t - hits[0] >= windowMs) hits.shift();
    if (hits.length < max) {
      hits.push(t);
      return;
    }
    const waitFor = windowMs - (t - hits[0]);
    await sleep(waitFor);
    return acquire();
  }

  return { acquire };
}

// ========== Token bucket (bursty) ==========
export function tokenBucket(opts: { capacity: number; refillRatePerSec: number }) {
  const { capacity, refillRatePerSec } = opts;
  if (capacity <= 0 || refillRatePerSec <= 0) throw new Error("tokenBucket: invalid args");
  let tokens = capacity;
  let last = now();

  function refill() {
    const t = now();
    const delta = (t - last) / 1000;
    tokens = Math.min(capacity, tokens + delta * refillRatePerSec);
    last = t;
  }

  async function take(n = 1) {
    for (;;) {
      refill();
      if (tokens >= n) { tokens -= n; return; }
      const need = n - tokens;
      // time until enough tokens
      const waitMs = (need / refillRatePerSec) * 1000;
      await sleep(waitMs);
    }
  }

  return { take, get tokens() { refill(); return tokens; } };
}

// ========== Leaky bucket queue (smooth drain) ==========
export function leakyBucket<T>(opts: { intervalMs: number; capacity?: number }) {
  const { intervalMs, capacity = Infinity } = opts;
  if (intervalMs <= 0) throw new Error("leakyBucket: invalid interval");
  const q: T[] = [];
  const waiters: Array<(v: T) => void> = [];
  let timer: any;

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      if (!q.length) return;
      const item = q.shift()!;
      const w = waiters.shift();
      if (w) w(item);
    }, intervalMs);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = undefined; }
  }

  async function push(item: T): Promise<void> {
    if (q.length >= capacity) throw new Error("leakyBucket: queue capacity exceeded");
    q.push(item);
    start();
  }

  function next(): Promise<T> {
    if (q.length) return Promise.resolve(q.shift()!);
    return new Promise<T>(res => waiters.push(res));
  }

  return { push, next, stop, size: () => q.length };
}

// ========== Exponential backoff w/ full jitter ==========
export type RetryBackoffOptions = {
  retries: number;           // max attempts (including first)
  baseMs?: number;           // base delay
  maxMs?: number;            // cap delay
  factor?: number;           // exponential factor
  jitter?: "none" | "full";  // full jitter recommended
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
};

export async function retryBackoff<T>(
  fn: () => Promise<T>,
  {
    retries,
    baseMs = 100,
    maxMs = 20_000,
    factor = 2,
    jitter = "full",
    onRetry
  }: RetryBackoffOptions
): Promise<T> {
  let attempt = 0;
  let delay = baseMs;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= retries) throw err;
      const j = jitter === "full" ? Math.random() * delay : delay;
      const wait = Math.min(maxMs, j);
      onRetry?.(err, attempt, wait);
      await sleep(wait);
      delay = Math.min(maxMs, delay * factor);
    }
  }
}

// ========== Circuit breaker ==========
export type BreakerState = "closed" | "open" | "half-open";

export function circuitBreaker(opts: {
  failureThreshold: number;       // consecutive failures to open
  cooldownMs: number;             // open → half-open after cooldown
  halfOpenMaxInFlight?: number;   // allow N trial requests in half-open
}) {
  const { failureThreshold, cooldownMs, halfOpenMaxInFlight = 1 } = opts;

  let state: BreakerState = "closed";
  let failures = 0;
  let openedAt = 0;
  let halfOpenInFlight = 0;

  function canPass(): boolean {
    const t = now();
    if (state === "closed") return true;
    if (state === "open") {
      if (t - openedAt >= cooldownMs) {
        state = "half-open";
        halfOpenInFlight = 0;
      } else {
        return false;
      }
    }
    // half-open
    return halfOpenInFlight < halfOpenMaxInFlight;
  }

  async function exec<T>(fn: () => Promise<T>): Promise<T> {
    if (!canPass()) throw Object.assign(new Error("circuit open"), { code: "CIRCUIT_OPEN" });
    if (state === "half-open") halfOpenInFlight++;

    try {
      const res = await fn();
      // success path
      failures = 0;
      if (state === "half-open") {
        // close after a successful probe
        state = "closed";
        halfOpenInFlight = 0;
      }
      return res;
    } catch (e) {
      failures++;
      if (state === "half-open") {
        // revert to open on failure
        state = "open"; openedAt = now(); halfOpenInFlight = 0;
      } else if (state === "closed" && failures >= failureThreshold) {
        state = "open"; openedAt = now();
      }
      throw e;
    }
  }

  return {
    exec,
    get state() { return state; },
    get failures() { return failures; }
  };
}

// ========== Counting semaphore ==========
export class Semaphore {
  private _value: number;
  private queue: Array<() => void> = [];

  constructor(value: number) {
    if (!Number.isFinite(value) || value < 0) throw new Error("Semaphore: invalid initial value");
    this._value = value;
  }

  async acquire(): Promise<() => void> {
    if (this._value > 0) {
      this._value--;
      return () => this._release();
    }
    await new Promise<void>(r => this.queue.push(r));
    this._value--;
    return () => this._release();
  }

  private _release() {
    this._value++;
    const n = this.queue.shift();
    if (n) n();
  }

  get value() { return this._value; }
  get pending() { return this.queue.length; }
}

// ========== Awaitable bounded queue ==========
export class BoundedQueue<T> {
  private buf: T[] = [];
  private readonly max: number;
  private takers: Array<(v: T) => void> = [];
  private putters: Array<() => void> = [];

  constructor(max: number) {
    if (!Number.isFinite(max) || max < 1) throw new Error("BoundedQueue: max must be >= 1");
    this.max = max;
  }

  async put(v: T): Promise<void> {
    if (this.takers.length) {
      this.takers.shift()!(v);
      return;
    }
    if (this.buf.length >= this.max) {
      await new Promise<void>(r => this.putters.push(r));
    }
    this.buf.push(v);
  }

  async take(): Promise<T> {
    if (this.buf.length) {
      const v = this.buf.shift()!;
      if (this.putters.length) this.putters.shift()!(); // free a blocked producer
      return v;
    }
    return new Promise<T>(res => this.takers.push(res));
  }

  size() { return this.buf.length; }
  pendingPuts() { return this.putters.length; }
  pendingTakes() { return this.takers.length; }
}

/* ==================== Examples (commented) ====================

/// 1) Concurrency-limited fetches
const limit = pLimit(5);
await Promise.all(urls.map(u => limit(() => fetch(u))));

/// 2) Global rate limit: 100 ops / 60s
const rl = rateLimiter({ max: 100, windowMs: 60_000 });
await rl.acquire(); // before each call

/// 3) Token bucket: 10 tokens capacity, 5 tokens/sec refill
const tb = tokenBucket({ capacity: 10, refillRatePerSec: 5 });
await tb.take(3); // proceed when tokens available

/// 4) Retry with backoff + jitter
await retryBackoff(
  () => doFragileThing(),
  { retries: 5, baseMs: 200, maxMs: 5000, jitter: "full", onRetry: (e,a,d)=>console.warn(a,d) }
);

/// 5) Circuit breaker
const breaker = circuitBreaker({ failureThreshold: 3, cooldownMs: 10_000 });
const res = await breaker.exec(() => externalCall());

/// 6) Semaphore
const sem = new Semaphore(3);
const release = await sem.acquire();
try { /* critical section */ /* } finally { release(); }

/// 7) BoundedQueue
const q = new BoundedQueue<string>(100);
producer: await q.put("task");
consumer: const t = await q.take();

=============================================================== */