// observability/logger.ts
// Minimal structured logger with levels + optional file sink.
// ESM/NodeNext friendly, no external deps.

import * as fs from "fs";
import * as path from "path";

/* =========================
   Types
   ========================= */

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export type LogEntry = {
  ts: string;                 // ISO timestamp
  level: LogLevel;
  msg: string;
  meta?: Record<string, any>;
};

export type LoggerOpts = {
  service?: string;
  level?: LogLevel;
  json?: boolean;             // log in JSON instead of pretty text
  filePath?: string;          // optional file sink
};

/* =========================
   Helpers
   ========================= */

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

function shouldLog(level: LogLevel, minLevel: LogLevel) {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function pad(n: number) {
  return n < 10 ? "0" + n : String(n);
}

function fmtTS(d = new Date()): string {
  return (
    d.getUTCFullYear() +
    "-" +
    pad(d.getUTCMonth() + 1) +
    "-" +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    ":" +
    pad(d.getUTCMinutes()) +
    ":" +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

/* =========================
   Logger class
   ========================= */

export class Logger {
  private service: string;
  private minLevel: LogLevel;
  private jsonMode: boolean;
  private fileStream?: fs.WriteStream;

  constructor(opts: LoggerOpts = {}) {
    this.service = opts.service ?? "app";
    this.minLevel = opts.level ?? "INFO";
    this.jsonMode = opts.json ?? false;

    if (opts.filePath) {
      const abs = path.resolve(opts.filePath);
      const dir = path.dirname(abs);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.fileStream = fs.createWriteStream(abs, { flags: "a" });
    }
  }

  private emit(level: LogLevel, msg: string, meta?: Record<string, any>) {
    if (!shouldLog(level, this.minLevel)) return;

    const entry: LogEntry = {
      ts: fmtTS(),
      level,
      msg,
      meta,
    };

    // Console output
    if (this.jsonMode) {
      console.log(JSON.stringify({ service: this.service, ...entry }));
    } else {
      const base = `[${entry.ts}] [${this.service}] ${level} — ${msg}`;
      if (meta) console.log(base, meta);
      else console.log(base);
    }

    // File sink (always JSON for machine parsing)
    if (this.fileStream) {
      this.fileStream.write(JSON.stringify({ service: this.service, ...entry }) + "\n");
    }
  }

  debug(msg: string, meta?: Record<string, any>) { this.emit("DEBUG", msg, meta); }
  info(msg: string, meta?: Record<string, any>) { this.emit("INFO", msg, meta); }
  warn(msg: string, meta?: Record<string, any>) { this.emit("WARN", msg, meta); }
  error(msg: string, meta?: Record<string, any>) { this.emit("ERROR", msg, meta); }

  close() {
    this.fileStream?.end();
  }
}

/* =========================
   Default singleton logger
   ========================= */

export const logger = new Logger({ service: "engine" });

export default logger;