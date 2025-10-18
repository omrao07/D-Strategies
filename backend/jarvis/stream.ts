// jarvis/stream.ts
// Ultra-light event stream for Jarvis (no imports, strict-TS friendly).
// - Publish/subscribe with backpressure (ring buffer)
// - Async iteration (for consumers that prefer `for await ...`)
// - Simple map/filter/pipe
// - NDJSON encoding helpers (for logs or HTTP responses)
//
// You can plug this into your Jarvis core & rules:
//   const es = new EventStream<JarvisEvent>({ bufferSize: 2048 });
//   const off = es.subscribe(ev => console.log(ev));
//   es.publish(evFinding({ findings: [...] }));
//   for await (const ev of es) { /* consume */ }

//////////////////////////////
// Types
//////////////////////////////

export type EventKind =
  | "heartbeat"
  | "price"
  | "position"
  | "portfolio"
  | "risk"
  | "finding"
  | "log"
  | "custom";

export interface EventBase<T = any> {
  id: string;         // stable-ish id for the event
  kind: EventKind;    // event category
  ts: string;         // ISO timestamp
  data: T;            // payload
  meta?: Record<string, any>; // extra tags/fields
}

export type JarvisEvent =
  | EventBase<{ msg: string; level?: "info" | "warn" | "error" }>
  | EventBase<{ symbol: string; price: number }>
  | EventBase<{ positions: Array<{ symbol: string; qty: number; price: number; value: number }> }>
  | EventBase<{ value: number; cash: number }>
  | EventBase<{ var95: number; cvar95: number; beta?: number; stdev?: number; horizonDays?: number }>
  | EventBase<{ findings: Array<Record<string, any>> }>
  | EventBase<any>;

export type Unsubscribe = () => void;

//////////////////////////////
// EventStream
//////////////////////////////

export class EventStream<E extends EventBase = EventBase> implements AsyncIterable<E> {
  private subs = new Set<(e: E) => void>();
  private buffer: E[];
  private head = 0;
  private tail = 0;
  private ended = false;
  private pendingResolvers: Array<(value: IteratorResult<E>) => void> = [];
  private _size: number;

  constructor(opts?: { bufferSize?: number }) {
    this._size = Math.max(32, Math.floor(opts?.bufferSize ?? 1024));
    this.buffer = new Array(this._size);
  }

  get bufferSize(): number { return this._size; }
  get length(): number { return (this.tail - this.head + this._size) % this._size; }
  get isEnded(): boolean { return this.ended; }

  /** Push an event into the stream. Drops oldest if buffer is full. */
  publish(e: E): void {
    if (this.ended) return;
    // deliver to subscribers immediately
    if (this.subs.size) {
      for (const fn of this.subs) {
        try { fn(e); } catch { /* subscriber error ignored */ }
      }
    }
    // fulfill pending async iterator waits first
    if (this.pendingResolvers.length) {
      const r = this.pendingResolvers.shift()!;
      r({ value: e, done: false });
      return;
    }
    // enqueue to ring buffer (drop oldest on overflow)
    const nextTail = (this.tail + 1) % this._size;
    if (nextTail === this.head) {
      // overflow → drop oldest by advancing head
      this.head = (this.head + 1) % this._size;
    }
    this.buffer[this.tail] = e;
    this.tail = nextTail;
  }

  /** Complete the stream; async iterators will return done=true. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.pendingResolvers.length) {
      const r = this.pendingResolvers.shift()!;
      r({ value: undefined as any, done: true });
    }
  }

  /** Subscribe to push-style notifications. Returns an unsubscribe fn. */
  subscribe(handler: (e: E) => void): Unsubscribe {
    this.subs.add(handler);
    return () => { this.subs.delete(handler); };
  }

  /** Clear all subscribers and buffered items; keep stream open. */
  reset(): void {
    this.subs.clear();
    this.head = 0; this.tail = 0;
  }

  /** Map into a derived stream. */
  map<F extends EventBase>(fn: (e: E) => F | null | undefined): EventStream<F> {
    const out = new EventStream<F>({ bufferSize: this._size });
    this.subscribe(e => {
      const m = fn(e);
      if (m) out.publish(m);
    });
    return out;
  }

  /** Filter events by predicate. */
  filter(pred: (e: E) => boolean): EventStream<E> {
    const out = new EventStream<E>({ bufferSize: this._size });
    this.subscribe(e => { if (pred(e)) out.publish(e); });
    return out;
  }

  /** Pipe all events to another stream. */
  pipeTo<T extends EventBase>(other: EventStream<T>, xform?: (e: E) => T | null | undefined): Unsubscribe {
    if (!xform) {
      const unsub = this.subscribe(e => other.publish(e as unknown as T));
      return unsub;
    } else {
      const unsub = this.subscribe(e => {
        const v = xform(e);
        if (v) other.publish(v);
      });
      return unsub;
    }
  }

  /** Async-iterable interface. */
  async next(): Promise<IteratorResult<E>> {
    // drain buffer first
    if (this.head !== this.tail) {
      const v = this.buffer[this.head];
      this.head = (this.head + 1) % this._size;
      return { value: v, done: false };
    }
    if (this.ended) return { value: undefined as any, done: true };
    return new Promise<IteratorResult<E>>(resolve => this.pendingResolvers.push(resolve));
  }
  [Symbol.asyncIterator](): AsyncIterator<E> { return { next: () => this.next() }; }
}

//////////////////////////////
// Convenience event builders
//////////////////////////////

export function evHeartbeat(meta?: Record<string, any>): JarvisEvent {
  return { id: makeId(), kind: "heartbeat", ts: nowISO(), data: { msg: "tick" }, meta };
}
export function evLog(msg: string, level: "info"|"warn"|"error"="info", meta?: Record<string, any>): JarvisEvent {
  return { id: makeId(), kind: "log", ts: nowISO(), data: { msg, level }, meta };
}
export function evPrice(symbol: string, price: number, meta?: Record<string, any>): JarvisEvent {
  return { id: makeId(), kind: "price", ts: nowISO(), data: { symbol: symbol.toUpperCase(), price: num(price) }, meta };
}
export function evPosition(positions: Array<{ symbol: string; qty: number; price: number; value: number }>, meta?: Record<string, any>): JarvisEvent {
  return { id: makeId(), kind: "position", ts: nowISO(), data: { positions }, meta };
}
export function evPortfolio(value: number, cash: number, meta?: Record<string, any>): JarvisEvent {
  return { id: makeId(), kind: "portfolio", ts: nowISO(), data: { value: num(value), cash: num(cash) }, meta };
}
export function evRisk(r: { var95: number; cvar95: number; beta?: number; stdev?: number; horizonDays?: number }, meta?: Record<string, any>): JarvisEvent {
  return { id: makeId(), kind: "risk", ts: nowISO(), data: { ...r }, meta };
}
export function evFinding(findings: Array<Record<string, any>>, meta?: Record<string, any>): JarvisEvent {
  return { id: makeId(), kind: "finding", ts: nowISO(), data: { findings }, meta };
}
export function evCustom(kind: string, data: any, meta?: Record<string, any>): JarvisEvent {
  return { id: makeId(), kind: "custom" as EventKind, ts: nowISO(), data: { kind, ...data }, meta };
}

//////////////////////////////
// NDJSON utilities
//////////////////////////////

export function toNDJSON(e: EventBase): string {
  // safe JSON (no circulars assumed)
  return JSON.stringify(e) + "\n";
}

/** Stream to NDJSON by writing each event into the provided sink function. */
export function attachNDJSONWriter<E extends EventBase>(
  stream: EventStream<E>,
  write: (chunk: string) => void
): Unsubscribe {
  return stream.subscribe(ev => {
    try { write(toNDJSON(ev)); } catch { /* ignore sink errors */ }
  });
}

//////////////////////////////
// Timers / heartbeats
//////////////////////////////

/** Periodically publish heartbeat events. Returns a stop() fn. */
export function startHeartbeat(stream: EventStream<JarvisEvent>, intervalMs = 1000): () => void {
  const id = setInterval(() => stream.publish(evHeartbeat()), Math.max(50, intervalMs)) as any;
  return () => { try { clearInterval(id); } catch {} };
}

//////////////////////////////
// Wiring helpers (no imports)
// You can connect your portfolio/rules engine via callbacks here.
//////////////////////////////

export type ComputeSnapshotFn = () => {
  positions: Array<{ symbol: string; qty: number; price: number; value: number }>;
  value: number; cash: number;
};
export type ComputeRiskFn = () => { var95: number; cvar95: number; beta?: number; stdev?: number; horizonDays?: number };
export type ComputeFindingsFn = () => Array<Record<string, any>>;

/**
 * Create a Jarvis streaming façade from user-provided callbacks.
 * Call returned API to push prices & recompute; subscribers receive events.
 */
export function createJarvisStream(opts: {
  bufferSize?: number;
  snapshot: ComputeSnapshotFn;
  risk?: ComputeRiskFn;
  findings?: ComputeFindingsFn;
}) {
  const stream = new EventStream<JarvisEvent>({ bufferSize: opts.bufferSize ?? 2048 });

  function emitSnapshot() {
    const s = opts.snapshot();
    stream.publish(evPosition(s.positions));
    stream.publish(evPortfolio(s.value, s.cash));
  }
  function emitRisk() {
    if (!opts.risk) return;
    const r = opts.risk();
    stream.publish(evRisk(r));
  }
  function emitFindings() {
    if (!opts.findings) return;
    const f = opts.findings();
    if (f && f.length) stream.publish(evFinding(f));
  }

  return {
    stream,
    /** Push a price tick (symbol, price) for consumers/UI; your snapshot() should account for it separately. */
    tick(symbol: string, price: number, meta?: Record<string, any>) {
      stream.publish(evPrice(symbol, price, meta));
    },
    /** Recalculate & emit snapshot (+risk/findings if provided). */
    recompute({ includeRisk = true, includeFindings = true }: { includeRisk?: boolean; includeFindings?: boolean } = {}) {
      emitSnapshot();
      if (includeRisk) emitRisk();
      if (includeFindings) emitFindings();
    },
    /** Emit a log entry. */
    log(msg: string, level: "info"|"warn"|"error"="info", meta?: Record<string, any>) {
      stream.publish(evLog(msg, level, meta));
    },
    /** End the stream (complete async iterators & stop heartbeats if any). */
    end() { stream.end(); },
  };
}

//////////////////////////////
// Tiny utils
//////////////////////////////

function nowISO(): string { return new Date().toISOString(); }
function num(x: any): number { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function makeId(): string {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `${t}-${r}`;
}