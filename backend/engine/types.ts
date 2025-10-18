// engine/types.ts

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

export { UUID, EngineState, Task, EngineConfig, EngineEvent }
// engine/persistence/sqlite-repo.ts
// persistence/sqlite-repo.ts

