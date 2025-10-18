// engine/registry.ts

import { Task } from "./types"

type TaskHandler = (task: Task) => Promise<Task> | Task

class TaskRegistry {
  private handlers: Map<string, TaskHandler> = new Map()

  register(name: string, handler: TaskHandler): void {
    if (this.handlers.has(name)) {
      throw new Error(`Handler for task "${name}" already registered`)
    }
    this.handlers.set(name, handler)
  }

  get(name: string): TaskHandler | undefined {
    return this.handlers.get(name)
  }

  has(name: string): boolean {
    return this.handlers.has(name)
  }

  list(): string[] {
    return Array.from(this.handlers.keys())
  }

  async run(task: Task): Promise<Task> {
    const handler = this.get(task.name)
    if (!handler) {
      return {
        ...task,
        status: "failed",
        error: `No handler registered for task "${task.name}"`,
        updatedAt: new Date().toISOString(),
      }
    }

    try {
      const result = await handler(task)
      return {
        ...task,
        ...result,
        status: "completed",
        updatedAt: new Date().toISOString(),
      }
    } catch (err: any) {
      return {
        ...task,
        status: "failed",
        error: err?.message || String(err),
        updatedAt: new Date().toISOString(),
      }
    }
  }
}

export { TaskRegistry, TaskHandler }
// health/checks.ts --- IGNORE ---  