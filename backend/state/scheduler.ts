// state/scheduler.ts
// Lightweight job scheduler (no external deps).
// Features:
// - Schedule recurring or one-shot jobs
// - Supports intervals (ms) or cron-like arrays
// - Provides pause/resume/cancel
// - Deterministic tick-based mode (for backtests) or real-time mode

export type JobFn = () => void | Promise<void>

export type JobConfig = {
  id?: string
  everyMs?: number                   // run every interval (ms)
  at?: Date                           // run once at this date
  cron?: CronSpec                     // run matching cron spec
  repeat?: number                     // max times to run (Infinity default)
  immediate?: boolean                 // run immediately on schedule add
}

export type CronSpec = {
  minutes?: number[] | "*"
  hours?: number[] | "*"
  dom?: number[] | "*"               // day of month
  months?: number[] | "*"
  dow?: number[] | "*"               // day of week 0=Sun
}

export type Job = {
  id: string
  fn: JobFn
  config: JobConfig
  runs: number
  lastRun?: Date
  nextRun?: Date
  active: boolean
}

export class Scheduler {
  private jobs: Map<string, Job> = new Map()
  private timers: Map<string, any> = new Map()

  constructor(private opts: { tickMs?: number } = {}) {}

  add(fn: JobFn, cfg: JobConfig): string {
    const id = cfg.id ?? uid()
    const job: Job = { id, fn, config: cfg, runs: 0, active: true }
    this.jobs.set(id, job)

    if (cfg.immediate) this.runJob(job)
    this.schedule(job)
    return id
  }

  remove(id: string): void {
    this.cancelTimer(id)
    this.jobs.delete(id)
  }

  pause(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    job.active = false
    this.cancelTimer(id)
  }

  resume(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    if (job.active) return
    job.active = true
    this.schedule(job)
  }

  clear(): void {
    for (const id of this.jobs.keys()) this.cancelTimer(id)
    this.jobs.clear()
  }

  list(): Job[] {
    return Array.from(this.jobs.values())
  }

  // ---- Internals ----

  private schedule(job: Job): void {
    if (!job.active) return
    if (job.config.repeat !== undefined && job.runs >= job.config.repeat) return

    let delay: number | undefined

    if (job.config.everyMs) {
      delay = job.config.everyMs
    } else if (job.config.at) {
      delay = job.config.at.getTime() - Date.now()
    } else if (job.config.cron) {
      const next = nextCron(job.config.cron, new Date())
      if (next) {
        delay = next.getTime() - Date.now()
        job.nextRun = next
      }
    }

    if (delay !== undefined && delay >= 0) {
      const t = setTimeout(() => this.runJob(job), delay)
      this.cancelTimer(job.id)
      this.timers.set(job.id, t)
    }
  }

  private async runJob(job: Job): Promise<void> {
    try {
      await job.fn()
    } catch (err) {
      console.error(`[Scheduler] Job ${job.id} error:`, err)
    }
    job.runs++
    job.lastRun = new Date()
    if (job.config.repeat !== undefined && job.runs >= job.config.repeat) {
      this.remove(job.id)
    } else {
      this.schedule(job)
    }
  }

  private cancelTimer(id: string): void {
    const t = this.timers.get(id)
    if (t) clearTimeout(t)
    this.timers.delete(id)
  }
}

// ---- Cron helpers ----

function nextCron(spec: CronSpec, from: Date): Date | null {
  let t = new Date(from.getTime() + 60 * 1000) // next minute
  for (let i = 0; i < 525600; i++) { // search up to 1 year
    if (matchCron(spec, t)) return t
    t = new Date(t.getTime() + 60 * 1000)
  }
  return null
}

function matchCron(spec: CronSpec, d: Date): boolean {
  return (
    matchField(spec.minutes, d.getUTCMinutes()) &&
    matchField(spec.hours, d.getUTCHours()) &&
    matchField(spec.dom, d.getUTCDate()) &&
    matchField(spec.months, d.getUTCMonth() + 1) &&
    matchField(spec.dow, d.getUTCDay())
  )
}

function matchField(field: number[] | "*" | undefined, v: number): boolean {
  if (!field) return true
  if (field === "*") return true
  return field.includes(v)
}

// ---- Utils ----

function uid(): string {
  return Math.random().toString(36).slice(2, 9)
}
// engine/registry.ts --- IGNORE ---
// engine/context.ts --- IGNORE ---

//   --saveCsv=true|false        write outputs/curves/<id>-<ts>.csv (default true)
//   --chart=true|false          print ASCII chart to terminal (default true)

import * as fs from "fs";
import * as path from "path";

