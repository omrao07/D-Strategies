// sched/schedu.er.ts
// Zero-dependency task scheduler with support for:
// - one-off, fixed-interval, fixed-delay, and cron-like schedules (5-field: m h dom mon dow)
// - jitter, max runs, per-run timeout, basic retries, and concurrency limits
// - pause/resume/cancel, status & stats, and catch-up or skip-missed policies
// - single-wheel timer (efficient) with drift protection
//
// NOTE: No imports. Works in Node or browser.

export type Millis = number;

export type JobKind = "once" | "interval" | "fixed-delay" | "cron";

export type MissedPolicy = "catch-up" | "skip";

export interface RetryPolicy {
  maxAttempts?: number;       // default 1 (no retry)
  baseDelayMs?: Millis;       // default 100
  maxDelayMs?: Millis;        // default 10_000
  factor?: number;            // default 2 (exp)
  jitter?: "none" | "full" | "bounded"; // default "full"
}

export interface JobSpec {
  id?: string;                       // auto if not given
  name?: string;
  kind: JobKind;
  handler: () => Promise<unknown> | unknown;

  // time options
  runAt?: number | Date;             // for kind="once"
  intervalMs?: Millis;               // for kind="interval"
  delayMs?: Millis;                  // for kind="fixed-delay" (wait this long after each finish)
  cron?: string;                     // for kind="cron" (e.g., "*/5 * * * *")

  startAt?: number | Date;           // optional earliest start (default now)
  endAt?: number | Date;             // optional stop scheduling after this instant

  maxRuns?: number;                  // cap number of executions (default Infinity)
  runTimeoutMs?: Millis;             // per-run timeout (default none)
  retry?: RetryPolicy;               // basic retry on error

  // scheduling behavior
  jitterMs?: Millis;                 // add +/- jitter for interval/fixed-delay/once (default 0..jitterMs)
  missed?: MissedPolicy;             // default "skip" (cron/interval when the process was asleep)
  enabled?: boolean;                 // default true
  metadata?: Record<string, unknown>;
}

export type JobState = "scheduled" | "running" | "paused" | "canceled" | "completed" | "error";

export interface JobStats {
  runs: number;
  successes: number;
  failures: number;
  lastStartAt?: number;
  lastEndAt?: number;
  totalRunMs: number;
  lastError?: string;
}

interface InternalJob {
  spec: RequiredJobSpec;
  state: JobState;
  stats: JobStats;
  nextAt?: number;
  lastPlannedAt?: number; // for catch-up logic
}

type RequiredJobSpec = {
  id: string;
  name?: string;
  kind: JobKind;
  handler: () => Promise<unknown> | unknown;
  runAt?: number;
  intervalMs?: Millis;
  delayMs?: Millis;
  cron?: string;

  startAt?: number;
  endAt?: number;

  maxRuns: number;
  runTimeoutMs?: Millis;
  retry: RequiredRetryPolicy;

  jitterMs: Millis;
  missed: MissedPolicy;
  enabled: boolean;
  metadata?: Record<string, unknown>;
};

type RequiredRetryPolicy = {
  maxAttempts: number;
  baseDelayMs: Millis;
  maxDelayMs: Millis;
  factor: number;
  jitter: "none" | "full" | "bounded";
};

export interface SchedulerOptions {
  concurrency?: number;          // max concurrent runs (default Infinity)
  driftGuardMs?: Millis;         // if timer fires late by > this, recompute (default 250)
  idPrefix?: string;             // for auto IDs
}

export interface JobHandle {
  id: string;
  get(): Readonly<InternalJob>;
  pause(): void;
  resume(): void;
  cancel(reason?: string): void;
  runNow(): Promise<void>;       // enqueue immediate execution (respects concurrency)
  nextRunAt(): number | undefined;
  status(): JobState;
  stats(): JobStats;
}

export class Scheduler {
  private jobs = new Map<string, InternalJob>();
  private timer: any = null;
  private nextTimerAt = 0;
  private running = 0;
  private readonly maxConcurrent: number;
  private readonly driftGuard: Millis;
  private readonly idPrefix: string;
  private counter = 0;

  constructor(opts?: SchedulerOptions) {
    this.maxConcurrent = Number.isFinite(opts?.concurrency as number) && (opts!.concurrency as number)! > 0 ? (opts!.concurrency as number) : Number.POSITIVE_INFINITY;
    this.driftGuard = Number.isFinite(opts?.driftGuardMs as number) ? (opts!.driftGuardMs as number) : 250;
    this.idPrefix = opts?.idPrefix ?? "job";
  }

  /** Create or replace a job. If a job with same id exists, it's canceled and replaced. */
  schedule(spec: JobSpec): JobHandle {
    const job = this.buildJob(spec);
    // compute first nextAt
    job.nextAt = this.computeNext(job, /*initial*/ true);
    this.jobs.set(job.spec.id, job);
    this.rearmTimer();
    return this.makeHandle(job.spec.id);
  }

  has(id: string): boolean { return this.jobs.has(id); }

  /** Pause a job (keeps it in registry; no executions while paused). */
  pause(id: string): void { const j = this.jobs.get(id); if (j && j.state !== "canceled" && j.state !== "completed") { j.state = "paused"; this.rearmTimer(); } }

  /** Resume a paused job. Recomputes next run from "now". */
  resume(id: string): void {
    const j = this.jobs.get(id);
    if (!j || j.state === "canceled" || j.state === "completed") return;
    j.state = "scheduled";
    j.nextAt = this.computeNext(j, /*initial*/ false);
    this.rearmTimer();
  }

  /** Cancel and remove job (cannot be resumed). */
  cancel(id: string, _reason?: string): void {
    const j = this.jobs.get(id);
    if (!j) return;
    j.state = "canceled";
    j.nextAt = undefined;
    this.jobs.delete(id);
    this.rearmTimer();
  }

  /** Force a run ASAP, even if it is not yet due. */
  async runNow(id: string): Promise<void> {
    const j = this.jobs.get(id);
    if (!j || j.state === "canceled" || j.state === "completed") return;
    if (j.state === "paused") j.state = "scheduled";
    j.nextAt = Math.min(now() + 1, j.nextAt ?? Number.POSITIVE_INFINITY);
    this.rearmTimer();
  }

  /** Inspect all jobs */
  list(): Array<Readonly<InternalJob>> {
    return Array.from(this.jobs.values()).map((j) => deepFreeze({ ...j }));
  }

  /** Next wakeup timestamp for scheduler */
  nextWake(): number | undefined {
    let next = Number.POSITIVE_INFINITY;
    for (const j of this.jobs.values()) {
      if (j.state === "scheduled" && j.nextAt != null) next = Math.min(next, j.nextAt);
    }
    return next === Number.POSITIVE_INFINITY ? undefined : next;
  }

  // ----------------- internals -----------------

  private buildJob(spec: JobSpec): InternalJob {
    const id = spec.id ?? `${this.idPrefix}-${++this.counter}`;
    const norm: RequiredJobSpec = {
      id,
      name: spec.name,
      kind: spec.kind,
      handler: spec.handler,
      runAt: toTs(spec.runAt),
      intervalMs: spec.intervalMs,
      delayMs: spec.delayMs,
      cron: spec.cron,

      startAt: toTs(spec.startAt) ?? now(),
      endAt: toTs(spec.endAt),

      maxRuns: Number.isFinite(spec.maxRuns as number) ? (spec.maxRuns as number) : Number.POSITIVE_INFINITY,
      runTimeoutMs: spec.runTimeoutMs,
      retry: {
        maxAttempts: spec.retry?.maxAttempts ?? 1,
        baseDelayMs: spec.retry?.baseDelayMs ?? 100,
        maxDelayMs: spec.retry?.maxDelayMs ?? 10_000,
        factor: spec.retry?.factor ?? 2,
        jitter: spec.retry?.jitter ?? "full",
      },

      jitterMs: spec.jitterMs ?? 0,
      missed: spec.missed ?? "skip",
      enabled: spec.enabled !== false,
      metadata: spec.metadata,
    };

    this.validate(norm);

    return {
      spec: norm,
      state: norm.enabled ? "scheduled" : "paused",
      stats: { runs: 0, successes: 0, failures: 0, totalRunMs: 0 },
      nextAt: undefined,
      lastPlannedAt: undefined,
    };
  }

  private validate(s: RequiredJobSpec): void {
    if (!s.handler || typeof s.handler !== "function") throw new Error("handler is required");
    switch (s.kind) {
      case "once":
        if (!isFiniteNum(s.runAt)) throw new Error(`"once" requires runAt`);
        break;
      case "interval":
        if (!isFiniteNum(s.intervalMs) || (s.intervalMs as number) <= 0) throw new Error(`"interval" requires intervalMs>0`);
        break;
      case "fixed-delay":
        if (!isFiniteNum(s.delayMs) || (s.delayMs as number) <= 0) throw new Error(`"fixed-delay" requires delayMs>0`);
        break;
      case "cron":
        if (!s.cron) throw new Error(`"cron" requires cron string`);
        // will validate when computing next
        break;
    }
  }

  private computeNext(j: InternalJob, initial: boolean): number | undefined {
    const nowTs = now();
    const startAt = Math.max(j.spec.startAt ?? nowTs, nowTs);
    const endAt = j.spec.endAt;

    // If completed/canceled/paused or exceeded maxRuns => no next
    if (j.state === "canceled" || j.state === "completed" || j.state === "paused") return undefined;
    if (j.stats.runs >= j.spec.maxRuns) { j.state = "completed"; return undefined; }

    let base: number | undefined;

    switch (j.spec.kind) {
      case "once": {
        base = j.spec.runAt!;
        break;
      }
      case "interval": {
        const step = j.spec.intervalMs!;
        if (initial) {
          // first schedule aligns with startAt boundary
          base = startAt;
        } else {
          const last = j.lastPlannedAt ?? startAt;
          if (j.spec.missed === "catch-up") {
            // next tick is last+step until >= now
            const ticks = Math.max(1, Math.ceil((nowTs - last) / step));
            base = last + ticks * step;
          } else {
            base = nowTs + step;
          }
        }
        break;
      }
      case "fixed-delay": {
        const step = j.spec.delayMs!;
        if (initial) {
          base = startAt;
        } else {
          base = nowTs + step;
        }
        break;
      }
      case "cron": {
        const cronNext = nextCron(j.spec.cron!, initial ? new Date(startAt) : new Date(Math.max(nowTs, (j.lastPlannedAt ?? startAt))));
        base = cronNext?.getTime();
        break;
      }
    }

    if (base == null) return undefined;
    // if before startAt, shift forward
    if (base < startAt) base = startAt;

    // if beyond endAt, no next
    if (endAt != null && base > endAt) return undefined;

    // jitter
    const jittered = applyJitter(base, j.spec.jitterMs);

    j.lastPlannedAt = base;
    return jittered;
  }

  private rearmTimer(): void {
    // cancel current timer
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.nextTimerAt = 0;
    }
    const t = this.nextWake();
    if (t == null) return;
    const delay = Math.max(0, t - now());
    this.nextTimerAt = t;
    this.timer = setTimeout(() => this.onTick(), delay);
  }

  private async onTick(): Promise<void> {
    this.timer = null;
    const nowTs = now();

    // Drift guard: if fired too early (rare) or too late, we still process due jobs.
    const due: InternalJob[] = [];
    for (const j of this.jobs.values()) {
      if (j.state === "scheduled" && j.nextAt != null && j.nextAt - nowTs <= this.driftGuard) {
        due.push(j);
      }
    }

    // Run as many as concurrency allows; remainder will wait for next rearm
    // Sort due by nextAt for deterministic order
    due.sort((a, b) => (a.nextAt! - b.nextAt!));

    let launched = 0;
    for (const j of due) {
      if (this.running >= this.maxConcurrent) break;
      // Mark and clear nextAt before run
      j.nextAt = undefined;
      this.launch(j).catch(() => { /* handled in launch */ });
      launched++;
    }

    // Jobs not launched remain scheduled; ensure they will wake soon
    this.rearmTimer();
  }

  private async launch(j: InternalJob): Promise<void> {
    if (j.state !== "scheduled") return;
    this.running++;
    j.state = "running";
    const start = now();
    j.stats.lastStartAt = start;

    try {
      const val = await this.runWithPolicy(j);
      void val; // unused
      j.stats.successes++;
    } catch (e) {
      j.stats.failures++;
      j.stats.lastError = errToString(e);
    } finally {
      const end = now();
      j.stats.lastEndAt = end;
      j.stats.totalRunMs += Math.max(0, end - start);
      j.stats.runs++;

      // compute next or finalize
      if (j.stats.runs >= j.spec.maxRuns || (j.spec.endAt != null && end > j.spec.endAt)) {
        j.state = "completed";
        j.nextAt = undefined;
      } else {
        j.state = "scheduled";
        j.nextAt = this.computeNext(j, /*initial*/ false);
      }

      this.running--;
      this.rearmTimer();
    }
  }

  private async runWithPolicy(j: InternalJob): Promise<unknown> {
    const attempts = Math.max(1, j.spec.retry.maxAttempts);
    let attempt = 0;
    let lastErr: unknown;

    while (attempt < attempts) {
      attempt++;
      try {
        const res = await this.execWithTimeout(j.spec.handler, j.spec.runTimeoutMs);
        return res;
      } catch (e) {
        lastErr = e;
        if (attempt >= attempts) break;
        const delay = computeBackoffDelay(
          attempt,
          j.spec.retry.baseDelayMs,
          j.spec.retry.maxDelayMs,
          j.spec.retry.factor,
          j.spec.retry.jitter
        );
        await sleep(delay);
      }
    }
    throw lastErr;
  }

  private execWithTimeout(fn: () => Promise<unknown> | unknown, timeout?: Millis): Promise<unknown> {
    if (!timeout || !isFiniteNum(timeout)) {
      return Promise.resolve().then(() => fn());
    }
    let to: any;
    return new Promise((resolve, reject) => {
      let settled = false;
      const clear = () => { if (to) clearTimeout(to); };
      to = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`run timed out after ${timeout}ms`));
      }, timeout);
      Promise.resolve()
        .then(() => fn())
        .then((v) => { if (!settled) { settled = true; clear(); resolve(v); } })
        .catch((e) => { if (!settled) { settled = true; clear(); reject(e); } });
    });
  }

  private makeHandle(id: string): JobHandle {
    return {
      id,
      get: () => {
        const j = this.jobs.get(id);
        if (!j) throw new Error(`Unknown job ${id}`);
        return deepFreeze({ ...j });
      },
      pause: () => this.pause(id),
      resume: () => this.resume(id),
      cancel: (reason?: string) => this.cancel(id, reason),
      runNow: async () => this.runNow(id),
      nextRunAt: () => this.jobs.get(id)?.nextAt,
      status: () => this.jobs.get(id)?.state ?? "canceled",
      stats: () => ({ ...(this.jobs.get(id)?.stats ?? { runs: 0, successes: 0, failures: 0, totalRunMs: 0 }) }),
    };
  }
}

// ---------------- Utilities ----------------

const now = () => Date.now();

function toTs(d?: number | Date): number | undefined {
  if (d == null) return undefined;
  if (typeof d === "number") return d;
  if (d instanceof Date) return d.getTime();
  return undefined;
}

function isFiniteNum(v: any): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function deepFreeze<T extends object>(o: T): T {
  try {
    Object.freeze(o);
  } catch { /* ignore */ }
  return o;
}

function sleep(ms: Millis): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

function errToString(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  try { return JSON.stringify(e); } catch { return String(e); }
}

function rnd(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function applyJitter(ts: number, jitterMs: number): number {
  if (!jitterMs || jitterMs <= 0) return ts;
  return Math.floor(ts + rnd(0, jitterMs));
}

function computeBackoffDelay(attempt: number, base: Millis, cap: Millis, factor: number, jitter: "none" | "full" | "bounded"): Millis {
  const n = Math.max(1, attempt - 1);
  let raw = Math.min(cap, base * Math.pow(Math.max(1.01, factor), n));
  if (jitter === "full") raw = rnd(0, raw);
  else if (jitter === "bounded") raw = Math.max(0, raw + rnd(-raw * 0.25, raw * 0.25));
  return Math.floor(raw);
}

// ---------------- Cron parser (5-field: m h dom mon dow) ----------------
// Supports: "*", "*/n", "a-b", "a,b,c", numeric values, ranges with step "a-b/n".
// DOW: 0-6 (0=Sun). DOM: 1-31. MON: 1-12. Minute: 0-59. Hour: 0-23.
// Resolution: minute. Finds next time strictly >= given date (minute aligned).

type Field = { any: boolean; values: Set<number> };

function parseCron(expr: string): { minute: Field; hour: Field; dom: Field; mon: Field; dow: Field } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron must have 5 fields (got ${parts.length})`);
  const [m, h, d, mo, dw] = parts;

  return {
    minute: parseField(m, 0, 59),
    hour: parseField(h, 0, 23),
    dom: parseField(d, 1, 31),
    mon: parseField(mo, 1, 12),
    dow: parseField(dw, 0, 6),
  };
}

function parseField(src: string, lo: number, hi: number): Field {
  if (src === "*") return { any: true, values: new Set() };
  const out = new Set<number>();
  const pieces = src.split(",");
  for (const p of pieces) {
    const stepSplit = p.split("/");
    const rangePart = stepSplit[0];
    const step = stepSplit.length > 1 ? clampInt(parseInt(stepSplit[1], 10), 1, hi - lo + 1) : 1;

    if (rangePart === "*" || rangePart === `${lo}-${hi}`) {
      for (let v = lo; v <= hi; v += step) out.add(v);
      continue;
    }

    const dashIdx = rangePart.indexOf("-");
    if (dashIdx >= 0) {
      const a = clampInt(parseInt(rangePart.slice(0, dashIdx), 10), lo, hi);
      const b = clampInt(parseInt(rangePart.slice(dashIdx + 1), 10), lo, hi);
      const start = Math.min(a, b);
      const end = Math.max(a, b);
      for (let v = start; v <= end; v += step) out.add(v);
    } else {
      const v = clampInt(parseInt(rangePart, 10), lo, hi);
      if (!Number.isNaN(v)) out.add(v);
    }
  }
  if (out.size === 0) throw new Error(`invalid cron field "${src}" [${lo}-${hi}]`);
  return { any: false, values: out };
}

function clampInt(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function fieldOk(f: Field, v: number): boolean {
  return f.any || f.values.has(v);
}

function nextCron(expr: string, from: Date): Date | null {
  const cfg = parseCron(expr);
  // Search up to 5 years in minutes (guard)
  const maxSteps = 5 * 366 * 24 * 60;
  // Round to the next minute (truncate seconds)
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  // If not exactly on minute, move to next minute
  if (from.getTime() > d.getTime()) d.setMinutes(d.getMinutes() + 1);

  for (let i = 0; i < maxSteps; i++) {
    const minute = d.getMinutes();
    const hour = d.getHours();
    const dom = d.getDate();
    const mon = d.getMonth() + 1; // 1..12
    const dow = d.getDay();       // 0..6

    if (fieldOk(cfg.minute, minute) &&
        fieldOk(cfg.hour, hour) &&
        fieldOk(cfg.dom, dom) &&
        fieldOk(cfg.mon, mon) &&
        fieldOk(cfg.dow, dow)) {
      return new Date(d.getTime());
    }
    // advance one minute
    d.setMinutes(d.getMinutes() + 1);
    d.setSeconds(0, 0);
  }
  return null;
}

