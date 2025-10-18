// runtimes/scheduler.ts
// Tiny in-process job scheduler (no deps).
// - One-off jobs: scheduleAt / scheduleIn
// - Repeating jobs: scheduleEvery (fixed) or scheduleCron (basic 5-field cron)
// - Pause/resume/cancel per job
// - Concurrency control + error hooks
// - Optional jitter and maxRuns
//
// NOTE: This is an in-memory scheduler. Jobs are lost when the process ends.
// If you need persistence or exactly-once guarantees, use a proper job runner.

export type JobFn = () => void | Promise<void>;

export type RepeatKind = "interval" | "cron";

export interface BaseJobOptions {
  /** Human label for logs/inspection */
  name?: string;
  /** Randomize run time by +/- jitter*interval (0..1). Default 0. */
  jitter?: number;
  /** Max number of executions for repeating jobs (default: Infinity) */
  maxRuns?: number;
  /** Called when a job throws/rejects */
  onError?: (err: unknown, job: Job) => void;
}

export interface IntervalOptions extends BaseJobOptions {
  /** If true, run immediately once when scheduled (default: false) */
  runNow?: boolean;
  /** Align interval boundaries to wall-clock (e.g., every 5m on :00,:05,...) */
  align?: boolean;
}

export interface CronOptions extends BaseJobOptions {
  /** Timezone offset in minutes (e.g., -240 for EDT). Default: local TZ. */
  tzOffsetMin?: number;
}

export interface SchedulerOptions {
  /** Max concurrent jobs (default: Infinity) */
  concurrency?: number;
  /** Called for any job error when job.onError is not set */
  onError?: (err: unknown, job: Job) => void;
  /** Called whenever a job starts */
  onStart?: (job: Job) => void;
  /** Called whenever a job completes */
  onFinish?: (job: Job, durationMs: number) => void;
}

export type JobStatus = "scheduled" | "running" | "paused" | "cancelled" | "done";

export class Scheduler {
  private jobs = new Map<string, Job>();
  private timer: any = null;
  private running = 0;
  private opts: Required<SchedulerOptions>;

  constructor(opts: SchedulerOptions = {}) {
    this.opts = {
      concurrency: opts.concurrency ?? Number.POSITIVE_INFINITY,
      onError: opts.onError ?? (() => {}),
      onStart: opts.onStart ?? (() => {}),
      onFinish: opts.onFinish ?? (() => {}),
    };
  }

  /* ------------------------------ Public API ------------------------------ */

  /** one-off at an absolute Date (or epoch ms) */
  scheduleAt(when: Date | number, fn: JobFn, opts: BaseJobOptions = {}): JobHandle {
    const nextAt = toMs(when);
    const job = this.createJob({ kind: "once", fn, nextAt, ...opts });
    this.plan();
    return job.handle;
  }

  /** one-off after a delay (ms) */
  scheduleIn(delayMs: number, fn: JobFn, opts: BaseJobOptions = {}): JobHandle {
    return this.scheduleAt(Date.now() + Math.max(0, delayMs), fn, opts);
  }

  /** fixed-interval repeating job */
  scheduleEvery(everyMs: number, fn: JobFn, opts: IntervalOptions = {}): JobHandle {
    const now = Date.now();
    const interval = Math.max(1, Math.floor(everyMs));
    let nextAt = now + interval;

    if (opts.align && interval >= 1000) {
      nextAt = alignTime(now, interval);
    }
    if (opts.runNow) nextAt = now;

    const job = this.createJob({
      kind: "interval",
      fn,
      interval,
      nextAt,
      ...opts,
    });
    this.plan();
    return job.handle;
  }

  /** cron-style repeating job (basic 5-field: m h dom mon dow) */
  scheduleCron(cron: string, fn: JobFn, opts: CronOptions = {}): JobHandle {
    const parser = parseCron(cron);
    const tz = opts.tzOffsetMin ?? localTzOffsetMinutes();
    const nextAt = nextCronEpoch(parser, Date.now(), tz);
    const job = this.createJob({
      kind: "cron",
      fn,
      cronParser: parser,
      tzOffsetMin: tz,
      nextAt,
      ...opts,
    });
    this.plan();
    return job.handle;
  }

  /** Cancel all jobs and stop timers */
  stopAll() {
    for (const j of this.jobs.values()) j.cancel();
    this.jobs.clear();
    this.clearTimer();
  }

  /** Snapshot of scheduled jobs */
  list(): ReadonlyArray<Readonly<JobSnapshot>> {
    return Array.from(this.jobs.values()).map(j => j.snapshot());
  }

  /* ------------------------------ Internals ------------------------------- */

  private createJob(init: JobInit): Job {
    const id = randomId();
    const job = new Job(id, init, this);
    this.jobs.set(id, job);
    return job;
  }

  /** set a single timer to the nearest nextAt */
  private plan() {
    this.clearTimer();
    const next = this.nextDue();
    if (!next) return;
    const delay = Math.max(0, next.nextAt - Date.now());
    this.timer = setTimeout(() => this.tick(), delay);
  }

  private clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private nextDue(): Job | null {
    let winner: Job | null = null;
    for (const j of this.jobs.values()) {
      if (j.status !== "scheduled") continue;
      if (!winner || j.nextAt < winner.nextAt) winner = j;
    }
    return winner;
  }

  private async tick() {
    this.clearTimer();

    const due: Job[] = [];
    const now = Date.now();
    for (const j of this.jobs.values()) {
      if (j.status === "scheduled" && j.nextAt <= now) due.push(j);
    }
    // FIFO on time
    due.sort((a, b) => a.nextAt - b.nextAt);

    // execute honoring concurrency
    for (const job of due) {
      if (this.running >= this.opts.concurrency) break;
      this.runJob(job);
    }

    // Plan the next one
    this.plan();
  }

  private async runJob(job: Job) {
    this.running++;
    job.markRunning();
    this.opts.onStart(job);
    const start = performanceNow();

    try {
      await job.fn();
    } catch (err) {
      (job.onError ?? this.opts.onError)(err, job);
    } finally {
      const dur = performanceNow() - start;
      this.opts.onFinish(job, dur);
      this.running--;
      job.afterRun(); // reschedule or finalize
    }
  }

  /** Called by a job when it changes scheduling state */
  _rescheduleChanged(job: Job) {
    if (job.status === "cancelled" || job.status === "done") {
      this.jobs.delete(job.id);
    }
    this.plan();
  }
}

/* --------------------------------- Job ---------------------------------- */

type JobKindOnce = {
  kind: "once";
  fn: JobFn;
  nextAt: number;
} & BaseJobOptions;

type JobKindInterval = {
  kind: "interval";
  fn: JobFn;
  interval: number;
  nextAt: number;
} & IntervalOptions;

type JobKindCron = {
  kind: "cron";
  fn: JobFn;
  cronParser: CronParser;
  tzOffsetMin: number;
  nextAt: number;
} & CronOptions;

type JobInit = JobKindOnce | JobKindInterval | JobKindCron;

export type JobHandle = {
  id: string;
  name?: string;
  /** Cancel and remove the job */
  cancel(): void;
  /** Pause without removing; call resume() to continue */
  pause(): void;
  /** Resume a paused job */
  resume(): void;
  /** Next scheduled time (Date) or null if none */
  next(): Date | null;
  /** Current status */
  status(): JobStatus;
};

export type JobSnapshot = {
  id: string;
  name?: string;
  status: JobStatus;
  nextAt: number | null;
  runs: number;
  kind: RepeatKind | "once";
  info?: Record<string, unknown>;
};

class Job {
  readonly id: string;
  readonly fn: JobFn;
  readonly scheduler: Scheduler;

  // options
  readonly name?: string;
  readonly onError?: (err: unknown, job: Job) => void;
  readonly jitter: number;
  maxRuns: number;

  // repeat specifics
  interval?: number;
  cronParser?: CronParser;
  tzOffsetMin?: number;

  // state
  status: JobStatus = "scheduled";
  runs = 0;
  nextAt: number;

  // helpers
  private _kind: "once" | RepeatKind;

  get handle(): JobHandle {
    return {
      id: this.id,
      name: this.name,
      cancel: () => this.cancel(),
      pause: () => this.pause(),
      resume: () => this.resume(),
      next: () => (this.nextAt ? new Date(this.nextAt) : null),
      status: () => this.status,
    };
  }

  constructor(id: string, init: JobInit, scheduler: Scheduler) {
    this.id = id;
    this.scheduler = scheduler;
    this.fn = init.fn;
    this.name = init.name;
    this.onError = init.onError;
    this.jitter = clamp01(init.jitter ?? 0);
    this.maxRuns = Number.isFinite(init.maxRuns ?? Infinity) ? (init.maxRuns ?? Infinity) : Infinity;

    this.nextAt = init.nextAt;

    if (init.kind === "interval") {
      this._kind = "interval";
      this.interval = init.interval;
    } else if (init.kind === "cron") {
      this._kind = "cron";
      this.cronParser = init.cronParser;
      this.tzOffsetMin = init.tzOffsetMin;
    } else {
      this._kind = "once";
    }
  }

  snapshot(): JobSnapshot {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      nextAt: this.status === "scheduled" ? this.nextAt : null,
      runs: this.runs,
      kind: this._kind,
      info:
        this._kind === "interval"
          ? { interval: this.interval }
          : this._kind === "cron"
          ? { cron: this.cronParser?.expr, tzOffsetMin: this.tzOffsetMin }
          : undefined,
    };
  }

  markRunning() {
    if (this.status === "scheduled") this.status = "running";
  }

  afterRun() {
    this.runs++;
    if (this._kind === "once") {
      this.status = "done";
      this.scheduler._rescheduleChanged(this);
      return;
    }
    if (this.runs >= this.maxRuns) {
      this.status = "done";
      this.scheduler._rescheduleChanged(this);
      return;
    }
    // compute the next time and return to "scheduled"
    const now = Date.now();
    if (this._kind === "interval" && this.interval) {
      const base = now + this.interval;
      this.nextAt = applyJitter(base, this.interval, this.jitter);
    } else if (this._kind === "cron" && this.cronParser) {
      this.nextAt = nextCronEpoch(this.cronParser, now + 1_000, this.tzOffsetMin ?? localTzOffsetMinutes());
    }
    this.status = "scheduled";
    this.scheduler._rescheduleChanged(this);
  }

  pause() {
    if (this.status === "scheduled") {
      this.status = "paused";
      this.scheduler._rescheduleChanged(this);
    }
  }

  resume() {
    if (this.status === "paused") {
      this.status = "scheduled";
      if (!this.nextAt || this.nextAt < Date.now()) {
        // ensure we don't instantly skip after long pause
        if (this._kind === "interval" && this.interval) {
          this.nextAt = applyJitter(Date.now() + this.interval, this.interval, this.jitter);
        } else if (this._kind === "cron" && this.cronParser) {
          this.nextAt = nextCronEpoch(this.cronParser, Date.now(), this.tzOffsetMin ?? localTzOffsetMinutes());
        }
      }
      this.scheduler._rescheduleChanged(this);
    }
  }

  cancel() {
    if (this.status === "cancelled" || this.status === "done") return;
    this.status = "cancelled";
    this.scheduler._rescheduleChanged(this);
  }
}

/* ---------------------------- Cron parser --------------------------- */
type CronField = Set<number>;
type CronExpr = {
  min: CronField;    // 0..59
  hour: CronField;   // 0..23
  dom: CronField;    // 1..31
  mon: CronField;    // 1..12
  dow: CronField;    // 0..6
};

type CronParser = {
  expr: string;
  fields: CronExpr;
};

export function parseCron(expr: string): CronParser {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron '${expr}' (need 5 fields)`);

  const [m, h, dom, mon, dow] = parts;
  const fields: CronExpr = {
    min: parseField(m, 0, 59),
    hour: parseField(h, 0, 23),
    dom: parseField(dom, 1, 31),
    mon: parseField(mon, 1, 12),
    dow: parseField(dow, 0, 6),
  };
  return { expr, fields };
}

export function nextCronEpoch(parser: CronParser, fromEpoch: number, tzOffsetMin: number): number {
  // We iterate minute by minute up to 366 days ahead (cheap for in-process).
  const { min, hour, dom, mon, dow } = parser.fields;
  const cap = fromEpoch + 366 * 24 * 60 * 60 * 1000;
  let t = floorToMinute(fromEpoch);

  while (t <= cap) {
    const local = new Date(t + (tzOffsetMin - localTzOffsetMinutes()) * 60_000); // shift to target TZ
    const m = local.getMinutes();
    const h = local.getHours();
    const D = local.getDate();
    const M = local.getMonth() + 1;
    const W = local.getDay();

    if (min.has(m) && hour.has(h) && mon.has(M) && (dom.has(D) || dow.has(W))) {
      return t;
    }
    t += 60_000; // +1 minute
  }
  // fallback: now + 1 minute
  return floorToMinute(Date.now()) + 60_000;
}

function parseField(s: string, lo: number, hi: number): CronField {
  const set = new Set<number>();
  const addRange = (a: number, b: number, step = 1) => {
    for (let v = a; v <= b; v += step) if (v >= lo && v <= hi) set.add(v);
  };
  if (s === "*") {
    addRange(lo, hi);
    return set;
  }
  for (const token of s.split(",")) {
    const m = token.match(/^\*\/(\d+)$/);
    if (m) {
      const step = Math.max(1, parseInt(m[1], 10));
      addRange(lo, hi, step);
      continue;
    }
    const r = token.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (r) {
      const a = parseInt(r[1], 10);
      const b = parseInt(r[2], 10);
      const step = r[3] ? Math.max(1, parseInt(r[3], 10)) : 1;
      addRange(Math.min(a, b), Math.max(a, b), step);
      continue;
    }
    const v = parseInt(token, 10);
    if (!Number.isFinite(v)) throw new Error(`Invalid cron value '${token}'`);
    if (v < lo || v > hi) continue;
    set.add(v);
  }
  if (set.size === 0) addRange(lo, hi);
  return set;
}

/* -------------------------------- Utils --------------------------------- */

function toMs(d: Date | number) {
  return d instanceof Date ? d.getTime() : d;
}

function alignTime(now: number, interval: number) {
  const next = Math.ceil(now / interval) * interval;
  return next;
}

function applyJitter(nextAt: number, interval: number, jitter: number) {
  if (!jitter) return nextAt;
  const span = interval * jitter;
  const delta = (Math.random() - 0.5) * 2 * span; // [-span..span]
  return Math.max(Date.now(), Math.floor(nextAt + delta));
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function floorToMinute(ms: number) {
  return Math.floor(ms / 60_000) * 60_000;
}

function localTzOffsetMinutes() {
  return -new Date().getTimezoneOffset(); // positive east
}

function randomId() {
  return Math.random().toString(36).slice(2);
}

function performanceNow() {
  if (typeof performance !== "undefined" && performance.now) return performance.now();
  return Date.now();
}

/* ------------------------------ Example usage ---------------------------- */
// const s = new Scheduler({ concurrency: 2 });
// s.scheduleEvery(5_000, async () => console.log("every 5s"), { runNow: true });
// s.scheduleCron("*/1 * * * *", () => console.log("every minute"));
// s.scheduleIn(1500, () => console.log("after 1.5s"));
