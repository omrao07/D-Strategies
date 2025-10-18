// logging/events.ts

type LogLevel = "debug" | "info" | "warn" | "error"

type LogEvent = {
  level: LogLevel
  message: string
  timestamp: string
  context?: Record<string, any>
}

class EventLogger {
  private events: LogEvent[] = []
  private maxSize: number

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize
  }

  private push(level: LogLevel, message: string, context?: Record<string, any>): void {
    const evt: LogEvent = {
      level,
      message,
      timestamp: new Date().toISOString(),
      context,
    }

    this.events.push(evt)
    if (this.events.length > this.maxSize) {
      this.events.shift()
    }
  }

  debug(message: string, context?: Record<string, any>): void {
    this.push("debug", message, context)
  }

  info(message: string, context?: Record<string, any>): void {
    this.push("info", message, context)
  }

  warn(message: string, context?: Record<string, any>): void {
    this.push("warn", message, context)
  }

  error(message: string, context?: Record<string, any>): void {
    this.push("error", message, context)
  }

  all(): LogEvent[] {
    return [...this.events]
  }

  recent(limit: number = 50): LogEvent[] {
    return this.events.slice(-limit)
  }

  clear(): void {
    this.events = []
  }
}

export { EventLogger, LogEvent, LogLevel }
// health/checks.ts 