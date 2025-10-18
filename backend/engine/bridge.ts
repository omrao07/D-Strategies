// engine/bridge.ts
// Zero-import glue between your data adapters, portfolio core, rules, and the orchestrator.
// Strict-TS friendly, drop-in file. You can use it in two modes:
//
// 1) Injected mode (preferred): pass ready-made providers (snapshot/risk/findings).
// 2) Lazy require mode: point to modules (relative paths) to `require` at runtime.
//
// Features
// - One place to wire price ticks/books/bars into portfolio valuation
// - Keeps a latest price map; exposes helpers to mark-to-market your portfolio
// - Boots an internal Orchestrator (heartbeat + recompute timers)
// - Emits NDJSON to any sink (e.g., HTTP response) without extra deps
// - Convenience helpers to adapt loose ticks to normalized events
//
// This file intentionally re-implements tiny bits used by the orchestrator to stay import-free.

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- Ambient for optional runtime require when you choose lazy mode
declare const require: any;

// ----------------------------- Public types -----------------------------

export type Dict<T = any> = Record<string, T>;

export interface Position {
  symbol: string;
  qty: number;
  price: number;
  cost?: number;
}

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

export interface Finding extends Dict {}

export interface BridgeProviders {
  // Provide one or more. If omitted, the bridge can still stream prices/heartbeats.
  snapshot?: () => SnapshotLike;
  risk?: () => RiskLike;
  findings?: () => Finding[];
}

export interface BridgeOptions {
  // How big the event ring buffer should be
  bufferSize?: number;

  // Auto recompute after each tick?
  recomputeOnTick?: boolean;

  // Schedule config
  heartbeatMs?: number;
  recomputeMs?: number;

  // Optional module paths for lazy require (CommonJS). If provided, bridge will derive providers.
  // Expected shapes:
  //   portfolioModule.createPortfolioJarvis(...) -> has .snapshot(), .risk(), etc. (you pass the instance below)
  //   rulesModule.evaluateRules(...) -> (portfolioLike, marketLike, rules?, opts?) => findings[]
  portfolioModulePath?: string;
  rulesModulePath?: string;

  // If you pass an existing portfolio instance from your core, the bridge can use it.
  // The instance should have methods analogous to those in jarvis/portfolio-jarvis.ts:
  //   snapshot(): { value, cash, positions:[...] }, risk(1): RiskLike
  portfolioInstance?: {
    snapshot: () => SnapshotLike;
    risk: (horizonDays?: number) => RiskLike;
  };

  // Optional hook for internal errors
  onError?: (e: unknown) => void;
}

// ----------------------------- Orchestrator (embedded) -----------------------------
// Minimal version embedded to avoid imports (compatible with engine/orchestrator.ts surface)

type EventKind = "heartbeat" | "price" | "portfolio" | "risk" | "finding" | "log";
type Unsubscribe = () => void;

interface EventBase<T = any> { id: string; kind: EventKind; ts: string; data: T; meta?: Dict; }
type OrchestratorEvent =
  | EventBase<{ msg: string; level?: "info"|"warn"|"error" }>
  | EventBase<{ symbol: string; price: number }>
  | EventBase<{ positions: Array<{ symbol: string; qty: number; price: number; value: number }>; value: number; cash: number }>
  | EventBase<{ var95: number; cvar95: number; beta?: number; stdev?: number; horizonDays?: number }>
  | EventBase<{ findings: Array<Dict> }>
  | EventBase<Dict>;

class EventStream<E extends EventBase = EventBase> implements AsyncIterable<E> {
  private subs = new Set<(e: E) => void>();
  private buf: E[]; private head = 0; private tail = 0; private done = false;
  private waiters: Array<(v: IteratorResult<E>) => void> = [];
  constructor(private cap = 2048) { this.buf = new Array(Math.max(32, cap)); }
  publish(ev: E) {
    if (this.done) return;
    for (const fn of this.subs) { try { fn(ev); } catch {} }
    if (this.waiters.length) { this.waiters.shift()!({ value: ev, done: false }); return; }
    const nxt = (this.tail + 1) % this.buf.length;
    if (nxt === this.head) this.head = (this.head + 1) % this.buf.length;
    this.buf[this.tail] = ev; this.tail = nxt;
  }
  end() { if (this.done) return; this.done = true; while (this.waiters.length) this.waiters.shift()!({ value: undefined as any, done: true }); }
  subscribe(fn: (e: E) => void): Unsubscribe { this.subs.add(fn); return () => this.subs.delete(fn); }
  async next(): Promise<IteratorResult<E>> {
    if (this.head !== this.tail) { const v = this.buf[this.head]; this.head = (this.head + 1) % this.buf.length; return { value: v, done: false }; }
    if (this.done) return { value: undefined as any, done: true };
    return new Promise<IteratorResult<E>>(res => this.waiters.push(res));
  }
  [Symbol.asyncIterator](): AsyncIterator<E> { return { next: () => this.next() }; }
}

class MiniOrchestrator {
  private stream: EventStream<OrchestratorEvent>;
  private timers: { hb?: any; rc?: any } = {};
  private running = false;
  private lastSnap?: SnapshotLike; private lastRisk?: RiskLike; private lastFindings?: Finding[];

  constructor(
    private providers: BridgeProviders,
    private cfg: { bufferSize: number; recomputeOnTick: boolean; onError?: (e:unknown)=>void }
  ) {
    this.stream = new EventStream<OrchestratorEvent>(cfg.bufferSize);
  }

  start(heartbeatMs = 1000, recomputeMs = 0) {
    if (this.running) return; this.running = true;
    this.timers.hb = setInterval(() => this.safe(() => this.publish({ kind: "heartbeat", data: { msg: "tick", level: "info" } })), Math.max(50, heartbeatMs));
    if (recomputeMs > 0) {
      this.timers.rc = setInterval(() => this.safe(() => this.recompute({ includeFindings: true })), Math.max(100, recomputeMs));
    }
  }
  stop() { if (!this.running) return; this.running = false; try{clearInterval(this.timers.hb);}catch{} try{clearInterval(this.timers.rc);}catch{} this.timers={}; this.stream.end(); }

  on(fn: (e: OrchestratorEvent)=>void): Unsubscribe { return this.stream.subscribe(fn); }
  get events(): EventStream<OrchestratorEvent> { return this.stream; }

  tick(symbol: string, price: number, meta?: Dict) {
    this.publish({ kind: "price", data: { symbol: symbol.toUpperCase(), price: num(price) }, meta });
    if (this.cfg.recomputeOnTick) this.safe(() => this.recompute());
  }

  log(msg: string, level: "info"|"warn"|"error"="info", meta?: Dict) {
    this.publish({ kind: "log", data: { msg, level }, meta });
  }

  recompute(opts: { includeRisk?: boolean; includeFindings?: boolean } = {}) {
    const { includeRisk = true, includeFindings = true } = opts;

    if (this.providers.snapshot) {
      const s = this.providers.snapshot();
      this.lastSnap = s;
      this.publish({ kind: "portfolio", data: { positions: s.positions, value: s.value, cash: s.cash } });
    }
    if (includeRisk && this.providers.risk) {
      const r = this.providers.risk();
      this.lastRisk = r;
      this.publish({ kind: "risk", data: { ...r } });
    }
    if (includeFindings && this.providers.findings) {
      const f = this.providers.findings() || [];
      this.lastFindings = f;
      if (f.length) this.publish({ kind: "finding", data: { findings: f } });
    }
  }

  get snapshot(): SnapshotLike | undefined { return this.lastSnap; }
  get risk(): RiskLike | undefined { return this.lastRisk; }
  get findings(): Finding[] | undefined { return this.lastFindings; }

  private publish<T extends Dict>(ev: { kind: EventKind; data: T; meta?: Dict }) {
    this.stream.publish({ id: makeId(), kind: ev.kind, ts: nowISO(), data: ev.data, meta: ev.meta });
  }
  private safe(fn: () => void) { try { fn(); } catch (e) { try { this.cfg.onError?.(e); } catch {} } }
}

// ----------------------------- Bridge -----------------------------

export class EngineBridge {
  // latest prices (upper-cased symbol → price)
  private Px: Record<string, number> = {};
  private orchestrator: MiniOrchestrator;
  private ndjsonUnsub?: Unsubscribe;

  constructor(private opts: BridgeOptions = {}, providers?: BridgeProviders) {
    const injected: BridgeProviders = { ...(providers || {}) };

    // Lazy require mode (optional)
    if (!injected.snapshot && this.opts.portfolioInstance) {
      injected.snapshot = () => this.opts.portfolioInstance!.snapshot();
      injected.risk = () => this.opts.portfolioInstance!.risk(1);
    } else if (!injected.snapshot && this.opts.portfolioModulePath) {
      try {
        const mod = require(this.opts.portfolioModulePath);
        // Expect something like createPortfolioJarvis(); but since we don't know ctor shape,
        // we only expose pass-through if the module already provides snapshot/risk.
        if (typeof mod?.snapshot === "function") injected.snapshot = () => mod.snapshot();
        if (typeof mod?.risk === "function") injected.risk = () => mod.risk(1);
      } catch (e) {
        // swallow; user can still inject later
        this.opts.onError?.(e);
      }
    }

    if (!injected.findings && this.opts.rulesModulePath && injected.snapshot) {
      // Provide a thin wrapper that calls evaluateRules(snapshot→portfolioLike)
      try {
        const rulesMod = require(this.opts.rulesModulePath);
        if (typeof rulesMod?.evaluateRules === "function") {
          injected.findings = () => {
            const snap = injected.snapshot!();
            const portfolioLike = { cash: snap.cash, positions: snap.positions.map(p => ({ symbol: p.symbol, qty: p.qty, price: p.price })), value: snap.value };
            const market = injected.risk ? { risk: injected.risk() } : undefined;
            try {
              const res = rulesMod.evaluateRules(portfolioLike, market);
              return Array.isArray(res) ? res : (res?.then ? [] : []); // if async, caller should wire separately
            } catch { return []; }
          };
        }
      } catch (e) { this.opts.onError?.(e); }
    }

    this.orchestrator = new MiniOrchestrator(
      injected,
      {
        bufferSize: this.opts.bufferSize ?? 2048,
        recomputeOnTick: this.opts.recomputeOnTick ?? false,
        onError: this.opts.onError,
      }
    );
  }

  // ---- lifecycle ----

  start(): void {
    this.orchestrator.start(this.opts.heartbeatMs ?? 1000, this.opts.recomputeMs ?? 0);
  }
  stop(): void {
    this.orchestrator.stop();
    if (this.ndjsonUnsub) { try { this.ndjsonUnsub(); } catch {} this.ndjsonUnsub = undefined; }
  }

  // ---- subscriptions / stream ----

  on(fn: (e: OrchestratorEvent) => void): Unsubscribe {
    return this.orchestrator.on(fn);
  }
  async *events(): AsyncIterable<OrchestratorEvent> {
    for await (const ev of this.orchestrator.events) yield ev;
  }

  // ---- NDJSON output (e.g., plug into HTTP res.write) ----

  attachNDJSON(write: (chunk: string) => void): Unsubscribe {
    const unsub = this.on(ev => {
      try { write(JSON.stringify(ev) + "\n"); } catch {}
    });
    this.ndjsonUnsub = unsub;
    return unsub;
  }

  // ---- price ingestion ----

  /** Ingest a simple tick: updates latest price map and emits a price event. */
  tick(symbol: string, price: number, meta?: Dict) {
    const sym = symbol.toUpperCase();
    this.Px[sym] = num(price);
    this.orchestrator.tick(sym, price, meta);
  }

  /** Merge a partial book or tick; computes mid/micro and emits price using mid if available. */
  tickFromBookOrTop(input: { symbol: string; bid?: number; ask?: number; bidSize?: number; askSize?: number; last?: number; ts?: number|string|Date; meta?: Dict }) {
    const sym = String(input.symbol || "").toUpperCase();
    const bid = toNum(input.bid), ask = toNum(input.ask);
    const last = toNum(input.last);
    let px: number | undefined;
    if (isFiniteNum(bid) && isFiniteNum(ask)) {
      px = (bid + ask) / 2;
    } else if (isFiniteNum(last)) {
      px = last;
    }
    if (px != null) this.tick(sym, px, input.meta);
  }

  // ---- recompute / logs ----

  recompute(opts?: { includeRisk?: boolean; includeFindings?: boolean }) { this.orchestrator.recompute(opts); }
  log(msg: string, level: "info"|"warn"|"error"="info", meta?: Dict) { this.orchestrator.log(msg, level, meta); }

  // ---- quick accessors ----

  get prices(): Readonly<Record<string, number>> { return this.Px; }
  get snapshot(): SnapshotLike | undefined { return this.orchestrator.snapshot; }
  get risk(): RiskLike | undefined { return this.orchestrator.risk; }
  get findings(): Finding[] | undefined { return this.orchestrator.findings; }
}

// ----------------------------- Tiny utils -----------------------------

function nowISO(): string { return new Date().toISOString(); } // kept for future use
function num(x: any): number { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function toNum(x: any): number | undefined { const n = Number(x); return Number.isFinite(n) ? n : undefined; }
function isFiniteNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }
function makeId(): string { const t = Date.now().toString(36); const r = Math.floor(Math.random()*0xffffffff).toString(36); return `${t}-${r}`; }

// ----------------------------- Minimal factory -----------------------------

/**
 * Quick factory with inline providers.
 * Example:
 *   const br = createBridge({
 *     portfolioInstance: pj, // from portfolio-jarvis
 *     rulesModulePath: "./jarvis/rules", // optional
 *     recomputeOnTick: true, heartbeatMs: 1000, recomputeMs: 5000,
 *   });
 *   br.start();
 */
export function createBridge(opts: BridgeOptions = {}, providers?: BridgeProviders): EngineBridge {
  return new EngineBridge(opts, providers);
}