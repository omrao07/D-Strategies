// sched/tasks.ts
// Task registry built on top of sched/scheduler.ts
// ESM/NodeNext, zero external deps.

import { Scheduler, scheduler as defaultScheduler, type JobHandle } from "./scheduler.js";
import loggerDefault, { Logger } from "../observability/logger.js";
import metricsDefault, { MetricsRegistry } from "../observability/metrics.js";
import tracerDefault, { Tracer } from "../observability/tracing.js";

/* =========================
   Types
   ========================= */

export type TaskContext = {
  logger: Logger;
  metrics: MetricsRegistry;
  tracer: Tracer;
  // user-slot: put whatever your app needs (repos, cfg, clients, etc.)
  [k: string]: any;
};

export type TaskRunFn = (ctx: TaskContext) => Promise<void> | void;

export type BaseSchedule =
  | { kind: "once"; at: number | Date }
  | { kind: "interval"; everyMs: number; jitterPct?: number }
  | { kind: "cron"; expr: string };

export type RetryCfg = {
  retries?: number;
  timeoutMs?: number;
  kind?: "constant" | "linear" | "exponential" | "decorrelated-jitter";
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  jitter?: boolean;
};

export type TaskDef = {
  id: string;
  name?: string;
  desc?: string;
  tags?: string[];
  enabled?: boolean;        // default true
  schedule: BaseSchedule;
  retry?: RetryCfg;
  skipIfRunning?: boolean;  // default true
  run: TaskRunFn;
};

export type TaskState = {
  id: string;
  name?: string;
  status: "scheduled" | "running" | "paused" | "cancelled";
  runs: number;
  failures: number;
  lastRunAt?: number;
  lastError?: string;
  nextRunAt?: number | null;
  tags?: string[];
};

/* =========================
   Registry
   ========================= */

export class TaskRegistry {
  private tasks = new Map<string, TaskDef>();
  private handles = new Map<string, JobHandle>();
  private scheduler: Scheduler;
  private ctx: TaskContext;

  constructor(opts?: {
    scheduler?: Scheduler;
    ctx?: Partial<TaskContext>;
  }) {
    this.scheduler = opts?.scheduler ?? defaultScheduler;
    this.ctx = {
      logger: loggerDefault,
      metrics: metricsDefault,
      tracer: tracerDefault,
      ...(opts?.ctx ?? {}),
    } as TaskContext;
  }

  /** Set/extend the shared context passed to all tasks. */
  setContext(extra: Record<string, any>) {
    Object.assign(this.ctx, extra);
  }

  /** Register (or replace) a task definition. */
  register(task: TaskDef) {
    const t = { enabled: true, skipIfRunning: true, ...task };
    this.tasks.set(t.id, t);
    return this;
  }

  /** Bulk register. */
  registerAll(ts: TaskDef[]) {
    ts.forEach(t => this.register(t));
    return this;
  }

  /** Remove a task (and cancel if active). */
  remove(id: string) {
    const h = this.handles.get(id);
    if (h) {
      try { h.cancel(); } catch {}
      this.handles.delete(id);
    }
    this.tasks.delete(id);
  }

  /** Start (schedule) one task by id. If already started, it’s refreshed. */
  start(id: string) {
    const def = this.tasks.get(id);
    if (!def) throw new Error(`unknown task: ${id}`);
    if (def.enabled === false) return;

    // cancel any old handle
    const prev = this.handles.get(id);
    if (prev) try { prev.cancel(); } catch {}

    const jobCommon = {
      id: def.id,
      name: def.name ?? def.id,
      skipIfRunning: def.skipIfRunning !== false,
      retries: def.retry,
      tags: def.tags,
      meta: { desc: def.desc },
      task: async () => {
        const span = this.ctx.tracer.startSpan(`task:${def.id}`, { name: def.name ?? def.id });
        const t0 = Date.now();
        try {
          this.ctx.metrics.inc(`tasks_run_total`);
          this.ctx.metrics.inc(`tasks_run_total{task="${def.id}"}`, 1 as any); // tolerant
          await Promise.resolve(def.run(this.ctx));
          const dur = Date.now() - t0;
          this.ctx.metrics.observe(`task_duration_ms`, dur);
          this.ctx.metrics.observe(`task_duration_ms{task="${def.id}"}`, dur);
          span.setAttr("duration_ms", dur).end();
          this.ctx.logger.info(`task OK: ${def.id}`, { ms: dur });
        } catch (err: any) {
          const dur = Date.now() - t0;
          this.ctx.metrics.inc(`tasks_errors_total`);
          this.ctx.metrics.inc(`tasks_errors_total{task="${def.id}"}`, 1 as any);
          span.recordError(err).setAttr("duration_ms", dur).end();
          this.ctx.logger.error(`task FAIL: ${def.id}`, { ms: dur, err: err?.message });
          throw err; // let scheduler mark failure + retry
        }
      },
    };

    let handle: JobHandle;
    switch (def.schedule.kind) {
      case "once": {
        const at = def.schedule.at instanceof Date ? def.schedule.at : new Date(def.schedule.at);
        handle = this.scheduler.at(at, jobCommon.task, { ...jobCommon });
        break;
      }
      case "interval": {
        handle = this.scheduler.every(def.schedule.everyMs, jobCommon.task, {
          ...jobCommon,
          jitterPct: def.schedule.jitterPct,
        });
        break;
      }
      case "cron": {
        handle = this.scheduler.cron(def.schedule.expr, jobCommon.task, { ...jobCommon });
        break;
      }
      default:
        throw new Error(`invalid schedule kind for task ${def.id}`);
    }

    this.handles.set(def.id, handle);
    return handle;
  }

  /** Start all enabled tasks. */
  startAll() {
    const handles: JobHandle[] = [];
    for (const id of this.tasks.keys()) {
      const def = this.tasks.get(id)!;
     
    }
    return handles;
  }

  /** Pause a running task (keeps definition). */
  pause(id: string) {
    const h = this.handles.get(id);
    if (h) h.pause();
  }

  /** Resume a paused task. */
  resume(id: string) {
    const h = this.handles.get(id);
    if (h) h.resume();
  }

  /** Cancel and unschedule a task (keeps definition). */
  cancel(id: string) {
    const h = this.handles.get(id);
    if (h) {
      h.cancel();
      this.handles.delete(id);
    }
  }

  /** Cancel all running tasks (definitions remain). */
  cancelAll() {
    for (const id of Array.from(this.handles.keys())) this.cancel(id);
  }

  /** List runtime states (from scheduler) merged with task metadata. */
  list(): TaskState[] {
    const out: TaskState[] = [];
    for (const [id, def] of this.tasks.entries()) {
      const h = this.handles.get(id);
      const info = h?.info();
      out.push({
        id,
        name: def.name,
        status: (info?.status ?? "scheduled") as TaskState["status"],
        runs: info?.runs ?? 0,
        failures: info?.failures ?? 0,
        lastRunAt: info?.lastRunAt,
        lastError: info?.lastError,
        nextRunAt: info?.nextRunAt,
        tags: def.tags,
      });
    }
    return out;
  }

  /** Get a single task's state. */
  get(id: string): TaskState | undefined {
    return this.list().find(t => t.id === id);
  }
}

/* =========================
   Helpers to define tasks
   ========================= */

export const every = (id: string, everyMs: number, run: TaskRunFn, opts?: Omit<TaskDef, "id"|"schedule"|"run">): TaskDef =>
  ({ id, run, schedule: { kind: "interval", everyMs }, ...opts });

export const cron = (id: string, expr: string, run: TaskRunFn, opts?: Omit<TaskDef, "id"|"schedule"|"run">): TaskDef =>
  ({ id, run, schedule: { kind: "cron", expr }, ...opts });

export const once = (id: string, at: number | Date, run: TaskRunFn, opts?: Omit<TaskDef, "id"|"schedule"|"run">): TaskDef =>
  ({ id, run, schedule: { kind: "once", at }, ...opts });

/* =========================
   Optional: default registry
   ========================= */

export const tasks = new TaskRegistry();

/* =========================
   Example built-ins (you can remove)
   ========================= */

// Example: flush metrics snapshot to a file every minute
tasks.register(
  every("metrics.flush", 60_000, (ctx) => {
    const file = "./outputs/metrics.json";
    // @ts-ignore writeJSON only exists if you added it; fall back to fs via logger if not.
    if ((ctx.metrics as any).writeJSON) (ctx.metrics as any).writeJSON(file);
    else ctx.logger.info("metrics snapshot (implement writeJSON to persist)");
  }, {
    name: "Metrics Flush",
    desc: "Persist metrics to outputs/metrics.json",
    tags: ["observability"],
    retry: { retries: 2, baseMs: 200, kind: "exponential" },
  })
);

// Example: rotate simple trace file every 5 minutes (demo)
tasks.register(
  every("traces.write", 5 * 60_000, (ctx) => {
    // @ts-ignore writeJSON may exist if you used the provided tracer module
    if ((ctx.tracer as any).writeJSON) (ctx.tracer as any).writeJSON("./outputs/traces/spans.json");
  }, {
    name: "Trace Dump",
    tags: ["observability"],
  })
);

/* =========================
   CLI demo (optional)
   ========================= */

if (import.meta.url === `file://${process.argv[1]}`) {
  tasks.startAll();
    console.log("Started tasks:", tasks.list());

  // keep process alive a bit to see ticks
  setTimeout(() => {
    console.log("Task states:", tasks.list());
    process.exit(0);
  }, 65_000);
}