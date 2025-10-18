// engine/runner.ts

// Local re-declarations to avoid imports. Keep in sync with engine/types.ts & registry.ts if you edit them.
type UUID = string
type EngineState = "initialized" | "running" | "stopped" | "error"

type Task = {
  id: UUID
  name: string
  createdAt: string
  updatedAt: string
  status: "pending" | "in-progress" | "completed" | "failed"
  payload?: Record<string, any>
  result?: Record<string, any>
  error?: string
}

type EngineConfig = {
  concurrency: number
  retries: number
  timeoutMs: number
}

type EngineEvent =
  | { type: "task:queued"; task: Task }
  | { type: "task:started"; task: Task }
  | { type: "task:completed"; task: Task }
  | { type: "task:failed"; task: Task; error: string }
  | { type: "engine:state"; state: EngineState }

type TaskHandler = (task: Task) => Promise<Task> | Task

// Minimal surface from TaskRegistry needed by the runner
type TaskRegistry = {
  run(task: Task): Promise<Task>
  has(name: string): boolean
}

type EngineContext = {
  id: string
  state: EngineState
  config: EngineConfig
  registry: TaskRegistry
  tasks: Map<string, Task>
  createdAt: string
  updatedAt: string
}

class EngineRunner {
  private ctx: EngineContext
  private queue: Task[] = []
  private active = 0
  private stopped = true
  private listeners: Array<(e: EngineEvent) => void> = []

  constructor(ctx: EngineContext) {
    this.ctx = ctx
  }

  on(listener: (e: EngineEvent) => void): () => void {
    this.listeners.push(listener)
    return () => this.off(listener)
  }

  off(listener: (e: EngineEvent) => void): void {
    const idx = this.listeners.indexOf(listener)
    if (idx >= 0) this.listeners.splice(idx, 1)
  }

  private emit(evt: EngineEvent): void {
    for (const l of this.listeners) {
      try {
        l(evt)
      } catch {
        // swallow listener errors
      }
    }
  }

  get state(): EngineState {
    return this.ctx.state
  }

  get pending(): number {
    return this.queue.length
  }

  get running(): number {
    return this.active
  }

  /**
   * Enqueue a new task. If a plain name is provided, creates a Task shell.
   */
  enqueue(taskOrName: Task | string, payload?: Record<string, any>): Task {
    const task: Task =
      typeof taskOrName === "string"
        ? {
            id: this.generateId(),
            name: taskOrName,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: "pending",
            payload,
          }
        : { ...taskOrName }

    if (!this.ctx.registry.has(task.name)) {
      const notFound = {
        ...task,
        status: "failed" as const,
        updatedAt: new Date().toISOString(),
        error: `No handler registered for task "${task.name}"`,
      }
      this.ctx.tasks.set(notFound.id, notFound)
      this.emit({ type: "task:failed", task: notFound, error: notFound.error! })
      return notFound
    }

    this.ctx.tasks.set(task.id, task)
    this.queue.push(task)
    this.emit({ type: "task:queued", task })
    // If already started, try to pull this immediately.
    if (!this.stopped) this.pump()
    return task
  }

  /**
   * Start processing the queue with configured concurrency.
   */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.setState("running")
    this.pump()
  }

  /**
   * Stop pulling new tasks from the queue. In-flight tasks are allowed to finish.
   */
  stop(): void {
    this.stopped = true
    // When all in-flight complete, we'll flip to "stopped" in _onSettled
    if (this.active === 0) this.setState("stopped")
  }

  /**
   * Drain the queue: wait synchronously (via Promise) for current and pending tasks to finish.
   * Note: This is a utility for tests/CLIs; it's safe to call while running.
   */
  async drain(): Promise<void> {
    // Start if not started, then wait until both queue and active are empty.
    this.start()
    while (this.queue.length > 0 || this.active > 0) {
      await this.delay(5)
    }
  }

  private pump(): void {
    const { concurrency } = this.ctx.config
    while (!this.stopped && this.active < concurrency && this.queue.length > 0) {
      const next = this.queue.shift()!
      this.runOne(next)
    }
  }

  private async runOne(task: Task): Promise<void> {
    this.active++
    const started: Task = {
      ...task,
      status: "in-progress",
      updatedAt: new Date().toISOString(),
    }
    this.ctx.tasks.set(started.id, started)
    this.emit({ type: "task:started", task: started })

    const { timeoutMs, retries } = this.ctx.config
    let attempt = 0
    let lastErr: any = null
    let finalTask: Task | undefined

    while (attempt <= retries) {
      try {
        const runP = this.ctx.registry.run(started)
        const result = await this.withTimeout(runP, timeoutMs)
        // The handler can return partial updates; merge onto the task
        finalTask = {
          ...started,
          ...result,
          status: "completed",
          updatedAt: new Date().toISOString(),
        }
        break
      } catch (err: any) {
        lastErr = err
        attempt++
        if (attempt > retries) {
          finalTask = {
            ...started,
            status: "failed",
            error: err?.message ? String(err.message) : String(err),
            updatedAt: new Date().toISOString(),
          }
          break
        }
        // brief backoff before retry
        await this.delay(this.backoffMs(attempt))
      }
    }

    // settle task
    this.ctx.tasks.set(finalTask!.id, finalTask!)
    if (finalTask!.status === "completed") {
      this.emit({ type: "task:completed", task: finalTask! })
    } else {
      this.emit({
        type: "task:failed",
        task: finalTask!,
        error: finalTask!.error || (lastErr ? String(lastErr) : "Unknown error"),
      })
    }

    this.active--
    if (this.stopped && this.active === 0) {
      this.setState("stopped")
    } else {
      this.pump()
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    if (!isFinite(ms) || ms <= 0) return p
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Task timed out")), ms)
      p.then(
        v => {
          clearTimeout(t)
          resolve(v)
        },
        e => {
          clearTimeout(t)
          reject(e)
        }
      )
    })
  }

  private backoffMs(attempt: number): number {
    // Simple exponential backoff with jitter: base 50ms
    const base = 50 * Math.pow(2, attempt - 1)
    const jitter = Math.floor(Math.random() * 50)
    return base + jitter
  }

  private setState(state: EngineState): void {
    if (this.ctx.state === state) return
    this.ctx.state = state
    this.ctx.updatedAt = new Date().toISOString()
    this.emit({ type: "engine:state", state })
  }

  private delay(ms: number): Promise<void> {
    return new Promise(res => setTimeout(res, ms))
  }

  private generateId(): string {
    return Math.random().toString(36).slice(2) + "-" + Date.now().toString(36)
  }
}

export { EngineRunner, EngineEvent, EngineContext, Task, EngineConfig, EngineState }
