// logging/logger.ts

type LogLevel = "debug" | "info" | "warn" | "error"

class Logger {
  private levelPriority: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  }

  private minLevel: LogLevel

  constructor(minLevel: LogLevel = "info") {
    this.minLevel = minLevel
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levelPriority[level] >= this.levelPriority[this.minLevel]
  }

  private format(level: LogLevel, message: string, context?: Record<string, any>): string {
    const ts = new Date().toISOString()
    let base = `[${ts}] [${level.toUpperCase()}] ${message}`
    if (context && Object.keys(context).length > 0) {
      base += ` | ${JSON.stringify(context)}`
    }
    return base
  }

  debug(message: string, context?: Record<string, any>): void {
    if (this.shouldLog("debug")) {
      console.debug(this.format("debug", message, context))
    }
  }

  info(message: string, context?: Record<string, any>): void {
    if (this.shouldLog("info")) {
      console.info(this.format("info", message, context))
    }
  }

  warn(message: string, context?: Record<string, any>): void {
    if (this.shouldLog("warn")) {
      console.warn(this.format("warn", message, context))
    }
  }

  error(message: string, context?: Record<string, any>): void {
    if (this.shouldLog("error")) {
      console.error(this.format("error", message, context))
    }
  }
}

export { Logger, LogLevel }
    