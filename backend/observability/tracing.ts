// observability/tracing.ts
// Tiny, import-free tracing utility inspired by OpenTelemetry.
// - Start/finish spans with timing (ms), attrs, events, status
// - Parent/child links; W3C traceparent inject/extract
// - Sampler (always/on-rate/parent-based)
// - Exporters: Console (NDJSON), RingBuffer (in-memory)
// - Manual context propagation (withSpan / runInSpan) — no async hooks
//
// Strict-TS friendly; zero deps.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Dict<T = any> = Record<string, T>;

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
}

export type SpanStatus = "unset" | "ok" | "error";

export interface SpanOptions {
  name: string;
  kind?: "internal" | "server" | "client" | "producer" | "consumer";
  attributes?: Dict;
  links?: SpanContext[];
  startTimeMs?: number;
  parent?: SpanContext | null;
}

export interface SpanEvent {
  name: string;
  ts: number; // epoch ms
  attributes?: Dict;
}

export interface ReadableSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: NonNullable<SpanOptions["kind"]>;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  status: SpanStatus;
  statusMessage?: string;
  attributes: Dict;
  events: SpanEvent[];
  links?: SpanContext[];
  sampled: boolean;
  resource?: Dict; // optional tracer resource fields
}

export interface SpanExporter {
  export(span: ReadableSpan): void;
  flush?(): void | Promise<void>;
  shutdown?(): void | Promise<void>;
}

export interface Sampler {
  shouldSample(parentSampled: boolean | undefined, name: string, kind: string, attrs?: Dict): boolean;
}

export interface TracerOptions {
  serviceName?: string;
  serviceVersion?: string;
  exporter?: SpanExporter;
  sampler?: Sampler;
  defaultAttributes?: Dict;
  timeOriginMs?: number; // override Date.now() base if needed
}

// ---------------- Ids & utilities ----------------

function randHex(bytes: number): string {
  // not crypto-strong; good enough for app traces
  let out = "";
  for (let i = 0; i < bytes; i++) {
    const n = (Math.random() * 256) | 0;
    out += (n + 0x100).toString(16).slice(1);
  }
  return out;
}
function genTraceId(): string { return randHex(16); } // 16 bytes → 32 hex
function genSpanId(): string { return randHex(8); }   // 8 bytes → 16 hex
function nowMs(): number { return Date.now(); }

function clamp<T extends number>(x: T, lo: T, hi: T): T { return Math.max(lo, Math.min(hi, x)) as T; }
function isFn(x: any): x is Function { return typeof x === "function"; }

// ---------------- W3C traceparent ----------------

/**
 * Create `traceparent` header from context.
 * Format: 00-<traceId>-<spanId>-<flags>
 */
export function toTraceparent(ctx: SpanContext): string {
  const flags = ctx.sampled ? "01" : "00";
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

/** Parse W3C traceparent (returns parent context; sampled flag propagated). */
export function fromTraceparent(h?: string | null): SpanContext | null {
  if (!h) return null;
  const m = /^\s*([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})\s*$/i.exec(String(h));
  if (!m) return null;
  const sampled = (parseInt(m[4], 16) & 0x01) === 1;
  return { traceId: m[2].toLowerCase(), spanId: m[3].toLowerCase(), sampled };
}

/** Inject header into a carrier (e.g., HTTP headers object). */
export function injectTraceparent(ctx: SpanContext, carrier: Dict): void {
  carrier["traceparent"] = toTraceparent(ctx);
}

/** Extract from a carrier object (e.g., req.headers). */
export function extractTraceparent(carrier: Dict | undefined | null): SpanContext | null {
  if (!carrier) return null;
  const h = (carrier["traceparent"] ?? carrier["Traceparent"] ?? carrier["TRACEPARENT"]) as string | undefined;
  return fromTraceparent(h ?? null);
}

// ---------------- Samplers ----------------

export class AlwaysOnSampler implements Sampler {
  shouldSample(): boolean { return true; }
}
export class AlwaysOffSampler implements Sampler {
  shouldSample(): boolean { return false; }
}
export class TraceIdRatioSampler implements Sampler {
  private ratio: number;
  constructor(ratio = 1.0) { this.ratio = clamp(ratio, 0, 1); }
  shouldSample(_p: boolean | undefined, _n: string): boolean {
    // naive: use Math.random(); (alternatively, hash of traceId if available)
    return Math.random() < this.ratio;
  }
}


// ---------------- Exporters ----------------

/** Console/NDJSON exporter (one line per finished span). */
export class ConsoleExporter implements SpanExporter {
  constructor(private ndjson = true) {}
  export(span: ReadableSpan): void {
    if (this.ndjson) {;
    } else {
      // eslint-disable-next-line no-console
      console.log(`[span] ${span.name} ${span.durationMs.toFixed(1)}ms trace=${span.traceId} span=${span.spanId}${span.parentSpanId ? " parent="+span.parentSpanId : ""}`);
    }
  }
  flush() { /* no-op */ }
  shutdown() { /* no-op */ }
}

/** Ring buffer exporter you can scrape for tests or /metrics-like endpoints. */
export class RingBufferExporter implements SpanExporter {
  private buf: ReadableSpan[] = [];
  private head = 0;
  constructor(private capacity = 1024) { this.capacity = Math.max(16, capacity | 0); }
  export(span: ReadableSpan): void {
    if (this.buf.length < this.capacity) { this.buf.push(span); return; }
    this.buf[this.head] = span;
    this.head = (this.head + 1) % this.capacity;
  }
  flush() {}
  shutdown() { this.buf = []; this.head = 0; }
  /** Returns newest-first copy. */
  dump(max = 100): ReadableSpan[] {
    const out: ReadableSpan[] = [];
    for (let i = 0; i < Math.min(max, this.buf.length); i++) {
      const idx = (this.head - 1 - i + this.buf.length) % this.buf.length;
      out.push(this.buf[idx]);
    }
    return out;
  }
}

// ---------------- Span & Tracer ----------------

export class Span {
  private _endTime?: number;
  private _status: SpanStatus = "unset";
  private _statusMessage?: string;
  private _attrs: Dict;
  private _events: SpanEvent[] = [];
  private _sampled: boolean;
  private _resource?: Dict;

  constructor(
    private tracer: Tracer,
    private ctx: SpanContext,
    private name: string,
    private kind: NonNullable<SpanOptions["kind"]>,
    attrs?: Dict,
    private _links?: SpanContext[],
    private _startTime = nowMs()
  ) {
    this._attrs = { ...(tracer.defaultAttributes || {}), ...(attrs || {}) };
    this._sampled = ctx.sampled;
    this._resource = tracer.resource;
  }

  context(): SpanContext { return { ...this.ctx }; }

  setAttribute(key: string, value: any): this {
    this._attrs[key] = value;
    return this;
  }
  setAttributes(obj: Dict): this { for (const k of Object.keys(obj || {})) this._attrs[k] = obj[k]; return this; }

  addEvent(name: string, attributes?: Dict, ts?: number): this {
    this._events.push({ name, ts: ts ?? nowMs(), attributes });
    return this;
  }

  setStatus(status: SpanStatus, message?: string): this {
    this._status = status; this._statusMessage = message; return this;
  }

  end(endTimeMs?: number): void {
    if (this._endTime != null) return; // idempotent
    this._endTime = endTimeMs ?? nowMs();
    if (this._status === "unset") this._status = "ok";
    // ship to exporter if sampled
    if (this._sampled) this.tracer._export(this.readable());
  }

  private readable(): ReadableSpan {
    const end = this._endTime ?? nowMs();
    const dur = Math.max(0, end - this._startTime);
    return {
      traceId: this.ctx.traceId,
      spanId: this.ctx.spanId,
      parentSpanId: this.ctx.parentSpanId,
      name: this.name,
      kind: this.kind,
      startTimeMs: this._startTime,
      endTimeMs: end,
      durationMs: dur,
      status: this._status,
      statusMessage: this._statusMessage,
      attributes: { ...this._attrs },
      events: this._events.slice(),
      links: this._links && this._links.length ? this._links.slice() : undefined,
      sampled: this._sampled,
      resource: this._resource,
    };
  }
}

export class Tracer {
  private exporter: SpanExporter;
  private sampler: Sampler;
  private ctxStack: SpanContext[] = []; // manual context stack

  readonly resource: Dict;
  readonly defaultAttributes?: Dict;

  constructor(opts: TracerOptions = {}) {
    this.exporter = opts.exporter ?? new ConsoleExporter(true);
    this.sampler = opts.sampler ?? new AlwaysOnSampler();
    this.resource = {
      service_name: opts.serviceName ?? "app",
      service_version: opts.serviceVersion ?? "dev",
    };
    this.defaultAttributes = opts.defaultAttributes;
  }

  /** Create a new span (not ended). Use `withSpan`/`runInSpan` for convenience. */
  startSpan(opts: SpanOptions): Span {
    const name = opts.name || "span";
    const kind = opts.kind ?? "internal";
    const parent = opts.parent ?? this.currentSpanContext();
    const parentSampled = parent?.sampled;
    const sampled = this.sampler.shouldSample(parentSampled, name, kind, opts.attributes);
    const traceId = parent?.traceId ?? genTraceId();
    const spanId = genSpanId();
    const ctx: SpanContext = {
      traceId,
      spanId,
      parentSpanId: parent?.spanId,
      sampled,
    };
    const s = new Span(this, ctx, name, kind, opts.attributes, opts.links, opts.startTimeMs ?? nowMs());
    return s;
  }

  /** Push span context, run fn, ensure end(). Returns fn result. */
  withSpan<T>(span: Span, fn: () => T | Promise<T>): T | Promise<T> {
    this.push(span.context());
    const end = () => span.end();
    try {
      const r = fn();
      
      if (r && isFn((r as any).then)) return (r as Promise<T>).then(v => { end(); this.pop(); return v; }).catch(e => { span.setStatus("error", String(e?.message ?? e)); end(); this.pop(); throw e; });
      end(); this.pop(); return r as T;
    } catch (e: any) {
      span.setStatus("error", String(e?.message ?? e)); end(); this.pop(); throw e;
    }
  }

  /** Helper: creates a span by name and runs fn within it. */
  runInSpan<T>(name: string, fn: () => T | Promise<T>, attrs?: Dict, kind?: SpanOptions["kind"]): T | Promise<T> {
    const span = this.startSpan({ name, attributes: attrs, kind });
    return this.withSpan(span, fn);
  }

  /** Current active span context from manual stack. */
  currentSpanContext(): SpanContext | undefined {
    return this.ctxStack.length ? this.ctxStack[this.ctxStack.length - 1] : undefined;
  }

  /** Inject current context into a carrier (e.g., response headers). */
  inject(carrier: Dict): void {
    const ctx = this.currentSpanContext();
    if (ctx) injectTraceparent(ctx, carrier);
  }

  /** Extract context from a carrier and set as current parent (one-shot). */
  extract(carrier: Dict): SpanContext | null {
    const ctx = extractTraceparent(carrier);
    if (ctx) this.push(ctx);
    return ctx;
  }

  /** Manually push/pop context (advanced). */
  push(ctx: SpanContext): void { this.ctxStack.push(ctx); }
  pop(): void { if (this.ctxStack.length) this.ctxStack.pop(); }

  // internal
  _export(span: ReadableSpan): void { try { this.exporter.export(span); } catch { /* ignore exporter errors */ } }
}

// ---------------- Convenience & Middleware-ish helpers ----------------

/** Measure a function and record status automatically (ok/error). */
export function time<T>(tracer: Tracer, name: string, fn: () => T | Promise<T>, attrs?: Dict): T | Promise<T> {
  return tracer.runInSpan(name, fn, attrs);
}

/** Wrap a basic Node-style HTTP handler (req, res) with server span. */
export function makeHttpHandler(tracer: Tracer, handler: (req: any, res: any) => void) {
  return (req: any, res: any) => {
    // extract incoming context
    tracer.extract(req.headers || {});
    const route = (req.url || "").split("?")[0] || "/";
    const method = String(req.method || "GET").toUpperCase();
    const span = tracer.startSpan({ name: `${method} ${route}`, kind: "server", attributes: { route, method } });
    tracer.push(span.context());
    const endWith = (code: number) => {
      span.setAttribute("http.status_code", code);
      if (code >= 500) span.setStatus("error");
      span.end();
      tracer.pop();
    };
    try {
      // decorate res.end to capture status
      const origEnd = res.end;
      res.end = function patchedEnd(...args: any[]) {
        try { endWith(res.statusCode || 200); } catch {}
        return origEnd.apply(this, args);
      };
      handler(req, res);
    } catch (e: any) {
      span.setStatus("error", String(e?.message ?? e));
      endWith(500);
      throw e;
    }
  };
}

/** Client-side helper to add traceparent header on outbound request options. */
export function injectHttpRequest(tracer: Tracer, options: any): any {
  const headers = options.headers || (options.headers = {});
  tracer.inject(headers);
  return options;
}

// ---------------- Example (commented) ----------------
/*
const tracer = new Tracer({
  serviceName: "my-service",
  serviceVersion: "1.0.0",
  exporter: new ConsoleExporter(true),
  sampler: new ParentBasedSampler(new TraceIdRatioSampler(1.0)),
  defaultAttributes: { env: "dev" },
});

// Basic span
await tracer.runInSpan("load-data", async () => {
  // ... work
  await tracer.runInSpan("db.query", async () => { /* query *\/ }, { sql: "SELECT 1" }, "client");
});

// HTTP server usage:
// const http = require("http");
// const server = http.createServer(makeHttpHandler(tracer, (req,res)=>{ res.statusCode=200; res.end("ok"); }));
// server.listen(8787);

// Outbound request injection:
// const opts = injectHttpRequest(tracer, { hostname:"example.com", path:"/", method:"GET", headers:{} });
*/