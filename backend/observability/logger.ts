// observability/logger.ts

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  timestamp: string;
}

class Logger {
  private levelOrder: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  private currentLevel: LogLevel;

  constructor(level: LogLevel = "info") {
    this.currentLevel = level;
  }

  setLevel(level: LogLevel): void {
    this.currentLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return (
      this.levelOrder[level] >= this.levelOrder[this.currentLevel]
    );
  }

  private format(entry: LogEntry): string {
    const ctx =
      entry.context && Object.keys(entry.context).length > 0
        ? ` ${JSON.stringify(entry.context)}`
        : "";
    return `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}${ctx}`;
  }

  private emit(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) return;

    const formatted = this.format(entry);

    switch (entry.level) {
      case "debug":
        console.debug(formatted);
        break;
      case "info":
        console.info(formatted);
        break;
      case "warn":
        console.warn(formatted);
        break;
      case "error":
        console.error(formatted);
        break;
    }
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    this.emit({
      level,
      message,
      context,
      timestamp: new Date().toISOString(),
    });
  }

  debug(msg: string, ctx?: Record<string, unknown>): void {
    this.log("debug", msg, ctx);
  }

  info(msg: string, ctx?: Record<string, unknown>): void {
    this.log("info", msg, ctx);
  }

  warn(msg: string, ctx?: Record<string, unknown>): void {
    this.log("warn", msg, ctx);
  }

  error(msg: string, ctx?: Record<string, unknown>): void {
    this.log("error", msg, ctx);
  }
}

// Export a default singleton for convenience
export const logger = new Logger("debug");
export { Logger, LogLevel, LogEntry };
