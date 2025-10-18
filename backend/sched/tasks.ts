// sched/tasks.ts
// Zero-dependency, in-memory task queue with:
// - priorities, delays, scheduled runAt, visibility timeouts (lease)
// - retries with backoff & jitter, max attempts, dead-letter queue
// - concurrency-controlled worker runner with pause/resume
// - dedup (by key), idempotency keys, cancel/peek/find
// - snapshots (serialize/restore) and basic stats
//
// Works in Node or browser. No imports.

export type Millis = number;

export type TaskState = "queued" | "running" | "succeeded" | "failed" | "dead";

export type JitterMode = "none" | "full" | "bounded";

export interface BackoffPolicy {
  mode?: "fixed" | "linear" | "exponential" | "decorrelated"; // default exponential
  baseDelayMs?: Millis;   // default 100
  maxDelayMs?: Millis;    // default 30_000
  factor?: number;        // default 2
  jitter?: JitterMode;    // default full
}

export interface EnqueueOptions {
  priority?: number;          // higher runs first when available (default 0)
  delayMs?: Millis;           // schedule after now + delay
  runAt?: number | Date;      // schedule exactly at
  visibilityTimeoutMs?: Millis; // lease duration while running (default 30_000)
  maxAttempts?: number;       // default 5
  dedupeKey?: string;         // if same key exists & not terminal -> ignore
  idempotencyKey?: string;    // if same key previously succeeded -> skip enqueue
  ttlMs?: Millis;             // discard if not started within this (optional)
  metadata?: Record<string, unknown>;
  backoff?: BackoffPolicy;    // retry backoff
}

export interface Task<T = unknown> {
  id: string;
  payload: T;
  state: TaskState;
  priority: number;
  attempts: number;
  maxAttempts: number;
  enqueuedAt: number;
  availableAt: number;        // when eligible to run
  visibilityTimeoutMs: number;
  leaseUntil?: number;        // if running
  lastError?: string;
  lastStart?: number;
  lastEnd?: number;
  dedupeKey?: string;
  idempotencyKey?: string;
  ttlMs?: number;
  metadata?: Record<string, unknown>;
  backoff: RequiredBackoff;
}

type RequiredBackoff = {
  mode: NonNullable<BackoffPolicy["mode"]>;
  baseDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitter: JitterMode;
};

export interface QueueStats {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  dead: number;
  enqueuedTotal: number;
  completedTotal: number;
  retriesTotal: number;
  lastDispatchAt?: number;
  lastCompleteAt?: number;
}

export interface WorkerOptions<T = unknown> {
  concurrency?: number;             // default: 1
  pollIntervalMs?: Millis;          // default: 50
  batch?: number;                   // fetch up to N ready tasks per tick (default: concurrency)
  paused?: boolean;                 // start paused
  // Optional rate limit (token bucket)
  rate?: { capacity: number; refillEveryMs: Millis; tokensPerRefill: number };

  // Hooks
  onDispatch?: (task: Task<T>) => void;
  onSuccess?: (task: Task<T>, value: unknown) => void;
  onFailure?: (task: Task<T>, err: unknown, willRetry: boolean) => void;
  onDead?: (task: Task<T>) => void;
}

export type TaskHandler<T = unknown> = (task: Task<T>) => Promise<unknown> | unknown;

// --------------------- Queue ---------------------

export class TaskQueue<T = unknown> {
  private heap = new MinHeap<Task<T>>((a, b) => {
    // earlier availableAt first; if equal, higher priority first; tie-breaker by id
    if (a.availableAt !== b.availableAt) return a.availableAt - b.availableAt;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  private byId = new Map<string, Task<T>>();
  private dedupe = new Map<string, string>();        // dedupeKey -> taskId (non-terminal)
  private idempoSuccess = new Set<string>();         // idempotencyKey that already succeeded
  private stats: QueueStats = { queued: 0, running: 0, succeeded: 0, failed: 0, dead: 0, enqueuedTotal: 0, completedTotal: 0, retriesTotal: 0 };
  private idCounter = 0;

  // Enqueue a task (returns task)
  enqueue(payload: T, opts?: EnqueueOptions): Task<T> | null {
    const nowTs = now();
    const idKey = opts?.idempotencyKey;
    if (idKey && this.idempoSuccess.has(idKey)) return null; // already done

    if (opts?.dedupeKey) {
      const existingId = this.dedupe.get(opts.dedupeKey);
      if (existingId) {
        const exists = this.byId.get(existingId);
        if (exists && !isTerminal(exists.state)) return null;
      }
    }

    const backoff = normalizeBackoff(opts?.backoff);
    const t: Task<T> = {
      id: `${nowTs}-${++this.idCounter}`,
      payload,
      state: "queued",
      priority: opts?.priority ?? 0,
      attempts: 0,
      maxAttempts: isPosInt(opts?.maxAttempts) ? (opts!.maxAttempts as number) : 5,
      enqueuedAt: nowTs,
      availableAt: computeAvailableAt(nowTs, opts?.runAt, opts?.delayMs),
      visibilityTimeoutMs: isPosInt(opts?.visibilityTimeoutMs) ? (opts!.visibilityTimeoutMs as number) : 30_000,
      dedupeKey: opts?.dedupeKey,
      idempotencyKey: idKey,
      ttlMs: opts?.ttlMs,
      metadata: opts?.metadata,
      backoff,
    };

    this.byId.set(t.id, t);
    if (t.dedupeKey) this.dedupe.set(t.dedupeKey, t.id);
    this.heap.push(t);
    this.stats.queued++;
    this.stats.enqueuedTotal++;
    return t;
  }

  // Try to lease up to N ready tasks
  leaseReady(max: number): Task<T>[] {
    const out: Task<T>[] = [];
    const nowTs = now();

    while (out.length < max && this.heap.size() > 0) {
      const top = this.heap.peek()!;
      if (!this.byId.has(top.id)) { this.heap.pop(); continue; } // stale
      if (!isEligible(top, nowTs)) break;

      const task = this.heap.pop()!;
      if (task.state !== "queued") continue;

      if (isExpired(task, nowTs)) {
        // drop expired
        this.markFailed(task, new Error("task expired before start"), /*dead*/ false);
        continue;
      }

      // lease
      task.state = "running";
      task.leaseUntil = nowTs + task.visibilityTimeoutMs;
      task.lastStart = nowTs;
      this.stats.queued--;
      this.stats.running++;
      out.push(task);
    }
    if (out.length) this.stats.lastDispatchAt = nowTs;
    return out;
  }

  // Ack success (from worker)
  ack(id: string, value?: unknown): void {
    const t = this.byId.get(id);
    if (!t || t.state !== "running") return;
    t.state = "succeeded";
    t.lastEnd = now();
    this.stats.running--;
    this.stats.succeeded++;
    this.stats.completedTotal++;
    // clear dedupe if any (terminal)
    if (t.dedupeKey) this.dedupe.delete(t.dedupeKey);
    if (t.idempotencyKey) this.idempoSuccess.add(t.idempotencyKey);
    // remove from index; keep a small tail? we remove to keep memory down
    this.byId.delete(id);
  }

  // Nack (failure), will retry or dead-letter
  nack(id: string, err: unknown): void {
    const t = this.byId.get(id);
    if (!t || t.state !== "running") return;
    const nowTs = now();
    t.lastEnd = nowTs;
    t.lastError = errToString(err);
    t.attempts++;
    this.stats.running--;

    const willRetry = t.attempts < t.maxAttempts;
    if (willRetry) {
      this.stats.retriesTotal++;
      t.state = "queued";
      t.availableAt = nowTs + computeBackoffDelay(t.backoff, t.attempts);
      t.leaseUntil = undefined;
      this.heap.push(t);
      this.stats.queued++;
    } else {
      this.markFailed(t, err, /*dead*/ true);
    }
  }

  // Re-enqueue tasks whose visibility (lease) expired (called by worker loop)
  reapExpired(): number {
    const nowTs = now();
    let count = 0;
    for (const t of this.byId.values()) {
      if (t.state === "running" && (t.leaseUntil ?? 0) <= nowTs) {
        // Treat as failed attempt (timeout)
        t.attempts++;
        this.stats.running--;
        if (t.attempts < t.maxAttempts) {
          this.stats.retriesTotal++;
          t.state = "queued";
          t.availableAt = nowTs + computeBackoffDelay(t.backoff, t.attempts);
          t.leaseUntil = undefined;
          t.lastError = "lease expired (visibility timeout)";
          this.heap.push(t);
          this.stats.queued++;
        } else {
          this.markFailed(t, new Error("lease expired (visibility timeout)"), /*dead*/ true);
        }
        count++;
      }
    }
    return count;
  }

  // Cancel (remove) if not already terminal; returns true if removed
  cancel(id: string, reason?: string): boolean {
    const t = this.byId.get(id);
    if (!t) return false;
    if (t.state === "running") return false; // avoid races; prefer nack from worker
    if (t.state === "queued") this.stats.queued--;
    if (t.state === "failed") this.stats.failed--;
    if (t.state === "dead") this.stats.dead--;

    t.state = "failed";
    t.lastError = reason ?? "canceled";
    // terminal -> clean
    if (t.dedupeKey) this.dedupe.delete(t.dedupeKey);
    this.byId.delete(id);
    return true;
  }

  // Introspection
  peekReady(): Task<T>[] {
    const nowTs = now();
    const arr = this.heap.toArray().filter((t) => isEligible(t, nowTs)).sort((a, b) => a.availableAt - b.availableAt);
    return arr.slice(0, 50).map(cloneTask);
  }

  get(id: string): Task<T> | undefined {
    const t = this.byId.get(id);
    return t ? cloneTask(t) : undefined;
  }

  findByDedupe(key: string): Task<T> | undefined {
    const id = this.dedupe.get(key);
    return id ? this.get(id) : undefined;
  }

  statsSnapshot(): QueueStats {
    return { ...this.stats };
  }

  size(): number { return this.byId.size; }

  // Snapshot/restore (best-effort)
  snapshot(): TaskQueueSnapshot<T> {
    const tasks = Array.from(this.byId.values()).map(cloneTask);
    return {
      version: 1,
      takenAt: now(),
      tasks,
      stats: { ...this.stats },
      dedupe: Array.from(this.dedupe.entries()),
      idempotent: Array.from(this.idempoSuccess.values()),
      idCounter: this.idCounter,
    };
  }

  restore(snap: TaskQueueSnapshot<T>): void {
    this.heap.clear();
    this.byId.clear();
    this.dedupe.clear();
    this.idempoSuccess.clear();

    for (const t of snap.tasks) {
      const copy = { ...t } as Task<T>;
      this.byId.set(copy.id, copy);
      if (copy.state === "queued") this.heap.push(copy);
    }
    for (const [k, v] of snap.dedupe) this.dedupe.set(k, v);
    for (const k of snap.idempotent) this.idempoSuccess.add(k);
    this.stats = { ...snap.stats };
    this.idCounter = Math.max(this.idCounter, snap.idCounter);
    this.heap.reheap();
  }

  // -------- private
  private markFailed(t: Task<T>, err: unknown, dead: boolean): void {
    t.state = dead ? "dead" : "failed";
    t.lastError = errToString(err);
    this.stats[dead ? "dead" : "failed"]++;
    this.stats.completedTotal++;
    if (t.dedupeKey) this.dedupe.delete(t.dedupeKey);
    this.byId.delete(t.id);
  }
}

// --------------------- Worker ---------------------

export class TaskWorker<T = unknown> {
  private running = 0;
  private paused = false;
  private timer: any = null;
  private tokens: number;
  private lastRefill = now();

  constructor(
    private readonly queue: TaskQueue<T>,
    private readonly handler: TaskHandler<T>,
    private readonly opts?: WorkerOptions<T>
  ) {
    this.running = 0;
    this.paused = !!opts?.paused;
    this.tokens = opts?.rate?.capacity ?? Number.POSITIVE_INFINITY;
  }

  start(): void {
    if (!this.timer) this.timer = setInterval(() => this.tick(), this.opts?.pollIntervalMs ?? 50);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }

  concurrency(): number { return Math.max(1, Math.floor(this.opts?.concurrency ?? 1)); }

  private tick(): void {
    if (this.paused) { this.queue.reapExpired(); return; }
    this.refillRateTokens();

    const cap = this.concurrency();
    const want = Math.min(this.tokensAvailable(), cap - this.running);
    if (want <= 0) { this.queue.reapExpired(); return; }

    // lease & launch
    const batch = Math.max(1, Math.min(this.opts?.batch ?? cap, want));
    const tasks = this.queue.leaseReady(batch);
    this.consumeTokens(tasks.length);
    for (const t of tasks) this.launch(t);

    // reap expired leases opportunistically
    this.queue.reapExpired();
  }

  private async launch(t: Task<T>): Promise<void> {
    this.running++;
    try {
      this.opts?.onDispatch?.(t);
      const val = await this.execWithVisibility(t);
      this.queue.ack(t.id, val);
      this.opts?.onSuccess?.(t, val);
    } catch (e) {
      const willRetry = (t.attempts + 1) < t.maxAttempts;
      this.queue.nack(t.id, e);
      this.opts?.onFailure?.(t, e, willRetry);
      if (!willRetry) this.opts?.onDead?.(t);
    } finally {
      this.running--;
    }
  }

  // Enforce visibility timeout: if handler runs longer than lease, it's still allowed,
  // but the queue will reap & requeue. We don't cancel the handler here (no AbortSignal).
  private async execWithVisibility(t: Task<T>): Promise<unknown> {
    // Provide helper heartbeat to extend lease if desired in the future.
    return this.handler(t);
  }

  // --- rate limiter helpers ---
  private refillRateTokens(): void {
    const r = this.opts?.rate;
    if (!r) return;
    const nowTs = now();
    const elapsed = nowTs - this.lastRefill;
    if (elapsed >= r.refillEveryMs) {
      const n = Math.floor(elapsed / r.refillEveryMs);
      this.tokens = Math.min(r.capacity, this.tokens + n * r.tokensPerRefill);
      this.lastRefill = nowTs;
    }
  }
  private tokensAvailable(): number { return Math.floor(this.tokens); }
  private consumeTokens(n: number): void { this.tokens = Math.max(0, this.tokens - n); }
}

// --------------------- Snapshot type ---------------------

export interface TaskQueueSnapshot<T = unknown> {
  version: 1;
  takenAt: number;
  tasks: Task<T>[];
  stats: QueueStats;
  dedupe: Array<[string, string]>;
  idempotent: string[];
  idCounter: number;
}

// --------------------- Utilities ---------------------

const now = () => Date.now();

function isPosInt(v: any): v is number {
  return Number.isInteger(v) && v > 0;
}

function errToString(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  try { return JSON.stringify(e); } catch { return String(e); }
}

function isTerminal(s: TaskState): boolean {
  return s === "succeeded" || s === "failed" || s === "dead";
}

function toTs(v?: number | Date): number | undefined {
  if (v == null) return undefined;
  return typeof v === "number" ? v : v.getTime();
}

function computeAvailableAt(nowTs: number, runAt?: number | Date, delayMs?: number): number {
  if (runAt != null) {
    const at = toTs(runAt)!;
    return at;
  }
  if (delayMs && delayMs > 0) return nowTs + delayMs;
  return nowTs;
}

function isEligible<T>(t: Task<T>, nowTs: number): boolean {
  return t.state === "queued" && t.availableAt <= nowTs;
}

function isExpired<T>(t: Task<T>, nowTs: number): boolean {
  return !!t.ttlMs && nowTs - t.enqueuedAt > t.ttlMs;
}

function cloneTask<T>(t: Task<T>): Task<T> {
  return JSON.parse(JSON.stringify(t));
}

function normalizeBackoff(b?: BackoffPolicy): RequiredBackoff {
  return {
    mode: (b?.mode ?? "exponential"),
    baseDelayMs: isPosInt(b?.baseDelayMs) ? (b!.baseDelayMs as number) : 100,
    maxDelayMs: isPosInt(b?.maxDelayMs) ? (b!.maxDelayMs as number) : 30_000,
    factor: Number.isFinite(b?.factor as number) && (b!.factor as number) > 0 ? (b!.factor as number) : 2,
    jitter: (b?.jitter ?? "full"),
  };
}

function computeBackoffDelay(b: RequiredBackoff, attempt: number): Millis {
  const n = Math.max(1, attempt); // 1-based
  let raw: number;
  switch (b.mode) {
    case "fixed": raw = b.baseDelayMs; break;
    case "linear": raw = b.baseDelayMs * (1 + (n - 1) * b.factor); break;
    case "exponential": raw = b.baseDelayMs * Math.pow(b.factor, n - 1); break;
    case "decorrelated": {
      const hi = Math.min(b.maxDelayMs, b.baseDelayMs * Math.pow(b.factor, n));
      raw = rand(b.baseDelayMs, hi);
      break;
    }
    default: raw = b.baseDelayMs;
  }
  raw = Math.min(Math.max(0, raw), b.maxDelayMs);
  switch (b.jitter) {
    case "none": return Math.floor(raw);
    case "full": return Math.floor(rand(0, raw));
    case "bounded": return Math.floor(clamp(raw + rand(-raw * 0.25, raw * 0.25), 0, b.maxDelayMs));
  }
}

function rand(min: number, max: number) { return min + Math.random() * (max - min); }
function clamp(x: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, x)); }

// --------------------- Tiny Binary Heap ---------------------

class MinHeap<T> {
  private arr: T[] = [];
  constructor(private cmp: (a: T, b: T) => number) {}

  size(): number { return this.arr.length; }
  clear(): void { this.arr = []; }
  toArray(): T[] { return this.arr.slice(); }
  peek(): T | undefined { return this.arr[0]; }

  push(x: T): void {
    this.arr.push(x);
    this.siftUp(this.arr.length - 1);
  }

  pop(): T | undefined {
    const n = this.arr.length;
    if (n === 0) return undefined;
    this.swap(0, n - 1);
    const out = this.arr.pop()!;
    this.siftDown(0);
    return out;
  }

  reheap(): void {
    for (let i = Math.floor(this.arr.length / 2); i >= 0; i--) this.siftDown(i);
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (this.cmp(this.arr[i], this.arr[p]) >= 0) break;
      this.swap(i, p);
      i = p;
    }
  }
  private siftDown(i: number): void {
    const n = this.arr.length;
    while (true) {
      let m = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.cmp(this.arr[l], this.arr[m]) < 0) m = l;
      if (r < n && this.cmp(this.arr[r], this.arr[m]) < 0) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
  }
  private swap(i: number, j: number): void {
    const tmp = this.arr[i]; this.arr[i] = this.arr[j]; this.arr[j] = tmp;
  }
}

// --------------------- Example (commented) ---------------------
/*
type Job = { url: string };

const q = new TaskQueue<Job>();
const worker = new TaskWorker<Job>(
  q,
  async (task) => {
    // do work
    await new Promise((r) => setTimeout(r, 100));
    if (Math.random() < 0.2) throw new Error("flaky");
    return { ok: true };
  },
  {
    concurrency: 4,
    rate: { capacity: 10, refillEveryMs: 1000, tokensPerRefill: 10 },
    onDispatch: (t) => console.log("dispatch", t.id),
    onSuccess: (t) => console.log("success", t.id),
    onFailure: (t, e, retry) => console.log("fail", t.id, e, "retry?", retry),
    onDead: (t) => console.log("dead-letter", t.id),
  }
);

worker.start();

for (let i = 0; i < 25; i++) {
  q.enqueue({ url: `https://example.com/${i}` }, { priority: Math.floor(Math.random() * 3), backoff: { mode: "exponential", baseDelayMs: 200 } });
}
*/
