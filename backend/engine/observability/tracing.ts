// observability/tracing.ts
// Minimal tracing (spans, nested timing, attrs, events, errors) + exporters.
// ESM/NodeNext friendly. Zero external deps.

import * as fs from "fs";

/* =========================
   Types
   ========================= */

export type SpanStatus = "OK" | "ERROR";

export type SpanEvent = {
  ts: number;                   // epoch ms
  name: string;
  attrs?: Record<string, any>;
};

export type SpanRecord = {
  traceId: string;
  spanId: string;
  parentId?: string;
  name: string;

  tsStart: number;              // epoch ms
  tsEnd?: number;               // epoch ms
  durMs?: number;

  status: SpanStatus;
  error?: { message: string; stack?: string };

  attrs?: Record<string, any>;
  events?: SpanEvent[];
};

/* =========================
   Helpers
   ========================= */

function nowMs(): number {
  return Date.now();
}

function randHex(bytes = 8): string {
  // Simple, fast hex id (not crypto)
  let out = "";
  for (let i = 0; i < bytes; i++) {
    out += ((Math.random() * 256) | 0).toString(16).padStart(2, "0");
  }
  return out;
}

/* =========================
   Span object
   ========================= */

export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentId?: string;
  name: string;

  tsStart: number;
  tsEnd?: number;
  durMs?: number;

  status: SpanStatus = "OK";
  error?: { message: string; stack?: string };

  attrs: Record<string, any> = {};
  events: SpanEvent[] = [];

  /** INTERNAL: let tracer set finished flag */
  private _finished = false;

  constructor(name: string, traceId: string, parentId?: string) {
    this.name = name;
    this.traceId = traceId || randHex(16);
    this.spanId = randHex(8);
    this.parentId = parentId;
    this.tsStart = nowMs();
  }

  setAttr(key: string, value: any) {
    this.attrs[key] = value;
    return this;
  }

  addEvent(name: string, attrs?: Record<string, any>) {
    this.events.push({ ts: nowMs(), name, attrs });
    return this;
  }

  recordError(err: any) {
    const message = err?.message ?? String(err);
    const stack = err?.stack;
    this.error = { message, stack };
    this.status = "ERROR";
    this.addEvent("error", { message });
    return this;
  }

  end() {
    if (this._finished) return this;
    this.tsEnd = nowMs();
    this.durMs = Math.max(0, (this.tsEnd ?? this.tsStart) - this.tsStart);
    this._finished = true;
    return this;
  }

  toJSON(): SpanRecord {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      parentId: this.parentId,
      name: this.name,
      tsStart: this.tsStart,
      tsEnd: this.tsEnd,
      durMs: this.durMs,
      status: this.status,
      error: this.error,
      attrs: Object.keys(this.attrs).length ? this.attrs : undefined,
      events: this.events.length ? this.events : undefined,
    };
  }
}

/* =========================
   Tracer
   ========================= */

export class Tracer {
  private spans: Span[] = [];          // finished spans (buffer)
  private stack: Span[] = [];          // active span stack for nesting
  private maxBuffer: number;

  constructor(opts?: { maxBuffer?: number }) {
    this.maxBuffer = Math.max(1000, opts?.maxBuffer ?? 5000);
  }

  /** Start a root span (new trace) or a child if one is active on the stack. */
  startSpan(name: string, attrs?: Record<string, any>): Span {
    const parent = this.stack[this.stack.length - 1];
    const traceId = parent?.traceId ?? randHex(16);
    const span = new Span(name, traceId, parent?.spanId);
    if (attrs) for (const [k, v] of Object.entries(attrs)) span.setAttr(k, v);
    this.stack.push(span);
    return span;
  }

  /** End the given span (defaults to top-of-stack). */
  endSpan(span?: Span): Span | undefined {
    const target = span ?? this.stack[this.stack.length - 1];
    if (!target) return undefined;

    target.end();

    // pop if it's the top
    if (this.stack[this.stack.length - 1] === target) this.stack.pop();
    else {
      // remove from stack if still inside (defensive)
      const idx = this.stack.findIndex(s => s.spanId === target.spanId);
      if (idx >= 0) this.stack.splice(idx, 1);
    }

    this.spans.push(target);
    if (this.spans.length > this.maxBuffer) this.spans.shift();
    return target;
  }

  /** Run a function within a span (sync or async), auto-ending span. */
  async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T> | T,
    attrs?: Record<string, any>
  ): Promise<T> {
    const s = this.startSpan(name, attrs);
    try {
      const out = await fn(s);
      this.endSpan(s);
      return out;
    } catch (err) {
      s.recordError(err);
      this.endSpan(s);
      throw err;
    }
  }

  /** Current active span (top of stack), if any. */
  currentSpan(): Span | undefined {
    return this.stack[this.stack.length - 1];
  }

  /** Add event/attr/error to the current span if present. */
  addEvent(name: string, attrs?: Record<string, any>) {
    this.currentSpan()?.addEvent(name, attrs);
  }
  setAttr(key: string, value: any) {
    this.currentSpan()?.setAttr(key, value);
  }
  recordError(err: any) {
    this.currentSpan()?.recordError(err);
  }

  /** Get finished spans (copy). */
  getFinished(): SpanRecord[] {
    return this.spans.map(s => s.toJSON());
  }

  /** Clear finished buffer. Active spans remain. */
  clearFinished() {
    this.spans = [];
  }

  /* ===== Exporters ===== */

  toJSON(): SpanRecord[] {
    return this.getFinished();
  }

  /** Chrome Trace Event format (.json) — load via chrome://tracing or Perfetto. */
  toChromeTrace(): string {
    // Convert each span into B/E events and optional instant events for span.events
    const events: any[] = [];
    for (const s of this.spans) {
      const pid = 1; // single process
      const tid = s.traceId.slice(0, 8); // group by trace
      const tsUs = (s.tsStart) * 1000;
      const durUs = (s.durMs ?? 0) * 1000;

      events.push({
        name: s.name,
        cat: "app",
        ph: "X",                // complete event
        ts: tsUs,
        dur: durUs,
        pid,
        tid,
        args: { status: s.status, ...(s.attrs ?? {}) },
      });

      if (s.events && s.events.length) {
        for (const e of s.events) {
          events.push({
            name: e.name,
            cat: "event",
            ph: "i",            // instant event
            s: "t",             // scope: thread
            ts: e.ts * 1000,
            pid,
            tid,
            args: e.attrs ?? {},
          });
        }
      }

      if (s.error) {
        events.push({
          name: "error",
          cat: "error",
          ph: "i",
          s: "t",
          ts: (s.tsEnd ?? s.tsStart) * 1000,
          pid,
          tid,
          args: s.error,
        });
      }
    }
    return JSON.stringify({ traceEvents: events }, null, 2);
  }

  writeJSON(filePath: string) {
    fs.writeFileSync(filePath, JSON.stringify(this.toJSON(), null, 2) + "\n", "utf8");
  }

  writeChromeTrace(filePath: string) {
    fs.writeFileSync(filePath, this.toChromeTrace() + "\n", "utf8");
  }
}

/* =========================
   Global tracer (optional)
   ========================= */

export const tracer = new Tracer();

export default tracer;