// engine/orchestrator.ts
// A small, dependency-free orchestrator that wires together:
// - price ingestion
// - portfolio snapshot/risk/findings computation
// - event streaming (pub/sub + async-iterable)
// - simple timers (heartbeat + periodic recompute)
// - hooks for rules and portfolio engines if you have them
//
// No imports. Strict-TS friendly. You can either inject your own compute
// functions, or (optionally) use `require()` in your app code to pass in
// the ones from `jarvis/portfolio-jarvis.ts`, `jarvis/rules.ts`, `jarvis/stream.ts`.
//
// Example:
//
//   const oc = new Orchestrator({
//     snapshot: () => pj.snapshotLike(),     // { positions:[...], value, cash }
//     risk: () => pj.risk(1),                // { var95, cvar95, ... }
//     findings: () => evaluateRulesLike(...),
//     onError: (e) => console.error(e),
//   });
//
//   oc.start({ heartbeatMs: 1000, recomputeMs: 5_000 });
//   oc.on(ev => console.log(ev.kind, ev.ts));
//   oc.ingestPrice("CL", 82.37);
//   // ...later: oc.stop();

//////////////////////////////
// Public types
//////////////////////////////

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Dict<T = any> = Record<string, T>;

export type EventKind =
  | "heartbeat"
  | "price"
  | "portfolio"
  | "risk"
  | "finding"
  | "log";

export interface EventBase<T = any> {
  id: string;
  kind: EventKind;
  ts: string;
  data: T;
  meta?: Dict;
}

export type OrchestratorEvent =
  | EventBase<{ msg: string; level?: "info" | "warn" | "error" }>
  | EventBase<{ symbol: string; price: number }>
  | EventBase<{ positions: Array<{ symbol: string; qty: number; price: number; value: number }>; value: number; cash: number }>
  | EventBase<{ var95: number; cvar95: number; beta?: number; stdev?: number; horizonDays?: number }>
  | EventBase<{ findings: Array<Dict> }>
  | EventBase<Dict>;

export interface SnapshotLike {
  positions: Array<{ symbol: string; qty: number; price: number; value: number }>;
  value: number;
  cash: number;
}

export interface RiskLike {
  var95: number;
  cvar95: number;
  beta?: number;
  stdev?: number;
  horizonDays?: number;
}

export interface OrchestratorOptions {
  // Providers (any of these can be omitted; orchestrator will skip that part)
  snapshot?: () => SnapshotLike;
  risk?: () => RiskLike;
  findings?: () => Array<Dict>;

  // Called on internal errors (exceptions inside timers/handlers)
  onError?: (err: unknown) => void;

  // Event buffer size for the stream (ring buffer)
  bufferSize?: number;

  // Whether to auto-emit portfolio/risk/findings right after each price tick
  recomputeOnTick?: boolean;
}

export interface ScheduleOptions {
  heartbeatMs?: number; // default 1000
  recomputeMs?: number; // default 0 (disabled)
}

export type Unsubscribe = () => void;


//////////////////////////////
// Minimal EventStream (import-free)
//////////////////////////////

class EventStream<E extends EventBase = EventBase> implements AsyncIterable<E> {
  private subs = new Set<(e: E) => void>();
  private buffer: E[];
  private head = 0;
  private tail = 0;
  private ended = false;
  private waiters: Array<(value: IteratorResult<E>) => void> = [];
  private cap: number;

  constructor(cap = 2048) {
    this.cap = Math.max(32, Math.floor(cap));
    this.buffer = new Array(this.cap);
  }

  publish(ev: E) {
    if (this.ended) return;
    // push to subscribers
    for (const fn of this.subs) { try { fn(ev); } catch { /* ignore subscriber errors */ } }
    // fulfill waiter first
    if (this.waiters.length) {
      this.waiters.shift()!({ value: ev, done: false });
      return;
    }
    // enqueue ring
    const nxt = (this.tail + 1) % this.cap;
    if (nxt === this.head) this.head = (this.head + 1) % this.cap; // drop oldest
    this.buffer[this.tail] = ev;
    this.tail = nxt;
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined as any, done: true });
  }

  subscribe(fn: (e: E) => void): Unsubscribe { this.subs.add(fn); return () => this.subs.delete(fn); }

  async next(): Promise<IteratorResult<E>> {
    if (this.head !== this.tail) {
      const v = this.buffer[this.head];
      this.head = (this.head + 1) % this.cap;
      return { value: v, done: false };
    }
    if (this.ended) return { value: undefined as any, done: true };
    return new Promise<IteratorResult<E>>(resolve => this.waiters.push(resolve));
  }
  [Symbol.asyncIterator](): AsyncIterator<E> { return { next: () => this.next() }; }
}


//////////////////////////////
// Orchestrator
//////////////////////////////

export class Orchestrator {
  private opts: Required<Pick<OrchestratorOptions, "bufferSize" | "recomputeOnTick">> & Omit<OrchestratorOptions, "bufferSize" | "recomputeOnTick">;
  private stream: EventStream<OrchestratorEvent>;
  private timers: { heartbeat?: any; recompute?: any } = {};
  private running = false;

  // last snapshot cache (optional)
  private lastSnap?: SnapshotLike;
  private lastRisk?: RiskLike;
  private lastFindings?: Array<Dict>;

  constructor(opts: OrchestratorOptions = {}) {
    this.opts = {
      bufferSize: opts.bufferSize ?? 2048,
      recomputeOnTick: opts.recomputeOnTick ?? false,
      snapshot: opts.snapshot,
      risk: opts.risk,
      findings: opts.findings,
      onError: opts.onError,
    };
    this.stream = new EventStream<OrchestratorEvent>(this.opts.bufferSize);
  }

  // --- lifecycle ---

  start(schedule: ScheduleOptions = {}): void {
    if (this.running) return;
    this.running = true;

    const hb = Math.max(50, Math.floor(schedule.heartbeatMs ?? 1000));
    this.timers.heartbeat = setInterval(() => this.safe(() => this.emitHeartbeat()), hb);

    const rc = Math.floor(schedule.recomputeMs ?? 0);
    if (rc > 0) {
      this.timers.recompute = setInterval(() => this.safe(() => this.recompute({ includeFindings: true })), Math.max(100, rc));
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    try { if (this.timers.heartbeat) clearInterval(this.timers.heartbeat); } catch {}
    try { if (this.timers.recompute) clearInterval(this.timers.recompute); } catch {}
    this.timers = {};
    this.stream.end();
  }

  // --- subscriptions / stream access ---

  on(handler: (e: OrchestratorEvent) => void): Unsubscribe { return this.stream.subscribe(handler); }
  async *events(): AsyncIterable<OrchestratorEvent> { for await (const ev of this.stream) yield ev; }

  // --- providers (optional setters if you initialize incrementally) ---

  setSnapshotProvider(fn: () => SnapshotLike): this { this.opts.snapshot = fn; return this; }
  setRiskProvider(fn: () => RiskLike): this { this.opts.risk = fn; return this; }
  setFindingsProvider(fn: () => Array<Dict>): this { this.opts.findings = fn; return this; }

  // --- ingestion APIs ---

  /** Ingest a price tick (symbol, price). This does NOT alter your snapshot; your snapshot provider should account for prices. */
  ingestPrice(symbol: string, price: number, meta?: Dict) {
    this.stream.publish(evPrice(symbol, price, meta));
    if (this.opts.recomputeOnTick) this.safe(() => this.recompute());
  }

  /** Push a log into the stream. */
  log(msg: string, level: "info"|"warn"|"error" = "info", meta?: Dict) {
    this.stream.publish(evLog(msg, level, meta));
  }

  // --- recompute & emit ---

  /** Recompute snapshot (+ risk & findings) via providers and emit events. */
  recompute(opts: { includeRisk?: boolean; includeFindings?: boolean } = {}): void {
    const { includeRisk = true, includeFindings = true } = opts;

    if (this.opts.snapshot) {
      const s = this.opts.snapshot();
      this.lastSnap = s;
      this.stream.publish(evPortfolio(s.value, s.cash, s.positions));
    }

    if (includeRisk && this.opts.risk) {
      const r = this.opts.risk();
      this.lastRisk = r;
      this.stream.publish(evRisk(r));
    }

    if (includeFindings && this.opts.findings) {
      const f = this.opts.findings() || [];
      this.lastFindings = f;
      if (f.length) this.stream.publish(evFindings(f));
    }
  }

  // --- last known state (for quick access) ---

  get snapshot(): SnapshotLike | undefined { return this.lastSnap; }
  get risk(): RiskLike | undefined { return this.lastRisk; }
  get findings(): Array<Dict> | undefined { return this.lastFindings; }

  // --- internals ---

  private emitHeartbeat() {
    this.stream.publish({
      id: makeId(),
      kind: "heartbeat",
      ts: nowISO(),
      data: { msg: "tick", level: "info" },
    });
  }

  private safe(fn: () => void) {
    try { fn(); }
    catch (e) { try { this.opts.onError?.(e); } catch {} }
  }
}

//////////////////////////////
// Small event builders (no imports)
//////////////////////////////

function evLog(msg: string, level: "info"|"warn"|"error", meta?: Dict): OrchestratorEvent {
  return { id: makeId(), kind: "log", ts: nowISO(), data: { msg, level }, meta };
}
function evPrice(symbol: string, price: number, meta?: Dict): OrchestratorEvent {
  return { id: makeId(), kind: "price", ts: nowISO(), data: { symbol: symbol.toUpperCase(), price: num(price) }, meta };
}
function evPortfolio(value: number, cash: number, positions: Array<{ symbol: string; qty: number; price: number; value: number }>): OrchestratorEvent {
  return { id: makeId(), kind: "portfolio", ts: nowISO(), data: { value: num(value), cash: num(cash), positions } };
}
function evRisk(r: RiskLike): OrchestratorEvent {
  return { id: makeId(), kind: "risk", ts: nowISO(), data: { ...r } };
}
function evFindings(findings: Array<Dict>): OrchestratorEvent {
  return { id: makeId(), kind: "finding", ts: nowISO(), data: { findings } };
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