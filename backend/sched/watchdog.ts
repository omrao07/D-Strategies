// sched/watchdog.ts
// Zero-dependency watchdog for runtime & job health.
// Monitors:
// - Event-loop lag (avg/p95/max) using a high-frequency probe
// - Memory (rss/heapUsed/heapTotal) vs configurable thresholds
// - Optional CPU usage (Node only) sampled between ticks
// - Component heartbeats (register/beat with TTL) and custom guards
// - Escalations with cool-down, hooks, and an optional HTTP handler
//
// Works in Node or browser (best-effort introspection in browsers).
// No imports.

type Millis = number;

export type Severity = "ok" | "warn" | "fail";
export type Gate = "runtime" | "resources" | "heartbeats" | "custom";

export interface WatchdogOptions {
  // Probes
  loopSampleMs?: Millis;         // default 100ms
  loopWindowSize?: number;       // rolling samples to keep, default 300 (≈30s @100ms)
  resourceSampleMs?: Millis;     // default 1000ms
  guardSampleMs?: Millis;        // default 1000ms

  // Thresholds
  lagWarnMs?: Millis;            // event-loop lag warn threshold (p95), default 100
  lagFailMs?: Millis;            // event-loop lag fail threshold (p95), default 250
  heapWarnRatio?: number;        // heapUsed/heapTotal, default 0.8
  heapFailRatio?: number;        // default 0.95
  rssWarnMB?: number;            // resident set size warn (Node), default 1024
  rssFailMB?: number;            // default 2048
  cpuWarnPct?: number;           // Node cpu usage %, default 85
  cpuFailPct?: number;           // default 95

  // Heartbeats
  heartbeatSkewMs?: Millis;      // allow for clock skew/jitter, default 100
  // Escalations
  coolDownMs?: Millis;           // min ms between repeated hook calls for the same gate+severity, default 10_000

  // Hooks (called on severity transitions or failures)
  onEscalate?: (e: EscalationEvent) => void;
  onChange?: (s: WatchdogSnapshot) => void;

  // Metadata
  service?: string;
  version?: string;
  env?: string;
}

export interface EscalationEvent {
  at: string;
  gate: Gate;
  severity: Severity;
  message: string;
  data?: Record<string, unknown>;
}

export interface WatchdogSnapshot {
  collectedAt: string;
  meta: { service?: string; version?: string; env?: string };
  status: Severity;
  runtime: {
    loop: { p50: number; p95: number; max: number; lastLagMs: number; samples: number };
    cpu?: { pct: number; lastPct: number };
  };
  resources: {
    heap?: { usedMB: number; totalMB: number; ratio: number };
    rss?: { mb: number };
  };
  heartbeats: Array<{ id: string; ttlMs: number; lastBeatAt: string; ageMs: number; status: Severity; note?: string }>;
  custom: Array<{ name: string; status: Severity; message?: string }>;
  gates: Record<Gate, Severity>;
}

type Heartbeat = {
  id: string;
  ttlMs: Millis;
  last: number;
  note?: string;
};

type GuardFn = () => Promise<{ status: Severity; message?: string; data?: Record<string, unknown> }> | { status: Severity; message?: string; data?: Record<string, unknown> };
type Guard = { name: string; fn: GuardFn; last?: { status: Severity; message?: string } };

export class Watchdog {
  private readonly cfg: RequiredConfig;
  private loopTimer: any = null;
  private resTimer: any = null;
  private guardTimer: any = null;

  private loopBuf: RingBuffer = new RingBuffer();
  private lastLoopTick = now();
  private lastCpuSample?: { ts: number; usage: NodeCpuSnapshot };

  private beats = new Map<string, Heartbeat>();
  private guards: Guard[] = [];

  private lastEscalationAt = new Map<string, number>(); // key `${gate}:${severity}`
  private lastSnapshot?: WatchdogSnapshot;

  constructor(opts?: WatchdogOptions) {
    this.cfg = normalizeConfig(opts);
    // seed CPU baseline if available
    if (hasNodeCpu()) {
      this.lastCpuSample = { ts: now(), usage: readNodeCpu() };
    }
  }

  /** Start probes */
  start(): void {
    if (!this.loopTimer) this.loopTimer = setInterval(() => this.loopProbe(), this.cfg.loopSampleMs);
    if (!this.resTimer) this.resTimer = setInterval(() => this.resourceProbe(), this.cfg.resourceSampleMs);
    if (!this.guardTimer) this.guardTimer = setInterval(() => this.guardProbe(), this.cfg.guardSampleMs);
    // initial compute to populate snapshot
    this.emitChange();
  }

  /** Stop probes */
  stop(): void {
    if (this.loopTimer) clearInterval(this.loopTimer);
    if (this.resTimer) clearInterval(this.resTimer);
    if (this.guardTimer) clearInterval(this.guardTimer);
    this.loopTimer = this.resTimer = this.guardTimer = null;
  }

  /** Register a heartbeat; returns a beat() function you should call periodically */
  registerHeartbeat(id: string, ttlMs: Millis, note?: string): (noteOrPayload?: unknown) => void {
    if (!id || ttlMs <= 0) throw new Error("heartbeat requires id and ttlMs>0");
    this.beats.set(id, { id, ttlMs, last: now(), note });
    this.emitChange();
    return (noteOrPayload?: unknown) => {
      const hb = this.beats.get(id);
      if (!hb) return;
      hb.last = now();
      if (typeof noteOrPayload === "string") hb.note = noteOrPayload;
    };
  }

  /** Remove a heartbeat */
  unregisterHeartbeat(id: string): void {
    this.beats.delete(id);
    this.emitChange();
  }

  /** Register a custom guard (check) */
  registerGuard(name: string, fn: GuardFn): void {
    this.guards.push({ name, fn });
  }

  /** Snapshot the current state */
  snapshot(): WatchdogSnapshot {
    const loopStats = this.loopBuf.stats();
    const cpu = this.computeCpu();
    const mem = readMemory();
    const heart = this.collectHeartbeats();
    const custom = this.guards.map(g => ({
      name: g.name,
      status: g.last?.status ?? "ok",
      message: g.last?.message,
    }));

    const gates: Record<Gate, Severity> = {
      runtime: severityFrom([
        compare("loop p95", loopStats.p95, this.cfg.lagWarnMs, this.cfg.lagFailMs),
        cpu?.pct != null ? compare("cpu %", cpu.pct, this.cfg.cpuWarnPct, this.cfg.cpuFailPct) : "ok",
      ]),
      resources: severityFrom([
        mem.heap ? compare("heap ratio", mem.heap.ratio * 100, this.cfg.heapWarnRatio * 100, this.cfg.heapFailRatio * 100) : "ok",
        mem.rss ? compare("rss mb", mem.rss.mb, this.cfg.rssWarnMB, this.cfg.rssFailMB) : "ok",
      ]),
      heartbeats: heart.severity,
      custom: severityFrom(custom.map(c => c.status)),
    };

    const status = severityFrom(Object.values(gates));

    const snap: WatchdogSnapshot = {
      collectedAt: new Date().toISOString(),
      meta: { service: this.cfg.service, version: this.cfg.version, env: this.cfg.env },
      status,
      runtime: {
        loop: {
          p50: loopStats.p50,
          p95: loopStats.p95,
          max: loopStats.max,
          lastLagMs: loopStats.last,
          samples: loopStats.count,
        },
        cpu: cpu ? { pct: round(cpu.pct), lastPct: round(cpu.lastPct) } : undefined,
      },
      resources: {
        heap: mem.heap ? { usedMB: round(mem.heap.usedMB), totalMB: round(mem.heap.totalMB), ratio: round(mem.heap.ratio) } : undefined,
        rss: mem.rss ? { mb: round(mem.rss.mb) } : undefined,
      },
      heartbeats: heart.rows,
      custom,
      gates,
    };
    this.lastSnapshot = snap;
    return snap;
  }

  /** Minimal HTTP handler: GET /watchdog -> snapshot, 503 if status=fail */
  httpHandler(opts?: { path?: string; pretty?: boolean }) {
    const path = opts?.path ?? "/watchdog";
    const pretty = !!opts?.pretty;
    return (_req: any, res: any) => {
      try {
        const url = String(_req?.url || "/");
        if (!url.startsWith(path)) {
          this._send(res, 404, { error: "not found" }, pretty);
          return;
        }
        const snap = this.snapshot();
        const code = snap.status === "fail" ? 503 : 200;
        this._send(res, code, snap, pretty);
      } catch (e) {
        this._send(res, 500, { error: String(e) }, pretty);
      }
    };
  }

  // ---------- Internals ----------

  private loopProbe(): void {
    const nowTs = now();
    // expected period is cfg.loopSampleMs; lag is how late we fired
    const elapsed = nowTs - this.lastLoopTick;
    const lag = Math.max(0, elapsed - this.cfg.loopSampleMs);
    this.lastLoopTick = nowTs;
    this.loopBuf.push(lag);

    // Evaluate escalation on runtime loop lag p95
    const st = this.loopBuf.stats();
    const sev = compare("loop p95", st.p95, this.cfg.lagWarnMs, this.cfg.lagFailMs);
    this.maybeEscalate("runtime", sev, `loop p95=${round(st.p95)}ms, max=${round(st.max)}ms`, { p95: st.p95, max: st.max });
  }

  private resourceProbe(): void {
    // CPU (Node only)
    if (hasNodeCpu()) {
      const cpu = this.computeCpu();
      if (cpu) {
        const sev = compare("cpu %", cpu.pct, this.cfg.cpuWarnPct, this.cfg.cpuFailPct);
        this.maybeEscalate("resources", sev === "ok" ? "ok" : sev, `cpu=${round(cpu.pct)}%`, cpu as any);
      }
    }
    // Memory
    const mem = readMemory();
    if (mem.heap) {
      const sev = compare("heap ratio", mem.heap.ratio * 100, this.cfg.heapWarnRatio * 100, this.cfg.heapFailRatio * 100);
      if (sev !== "ok") this.maybeEscalate("resources", sev, `heap ${(mem.heap.ratio * 100).toFixed(1)}% used`, mem.heap as any);
    }
    if (mem.rss) {
      const sev = compare("rss mb", mem.rss.mb, this.cfg.rssWarnMB, this.cfg.rssFailMB);
      if (sev !== "ok") this.maybeEscalate("resources", sev, `rss ${round(mem.rss.mb)}MB`, mem.rss as any);
    }
    this.emitChange();
  }

  private async guardProbe(): Promise<void> {
    for (const g of this.guards) {
      try {
        const res = await Promise.resolve(g.fn());
        g.last = { status: res.status, message: res.message };
        if (res.status !== "ok") {
          this.maybeEscalate("custom", res.status, `${g.name}: ${res.message ?? res.status}`, res.data);
        }
      } catch (e) {
        g.last = { status: "fail", message: errToString(e) };
        this.maybeEscalate("custom", "fail", `${g.name}: exception`, { error: errToString(e) });
      }
    }
    // beats age is checked here to coalesce with guard cadence
    const hb = this.collectHeartbeats();
    if (hb.severity !== "ok") {
      this.maybeEscalate("heartbeats", hb.severity, hb.message!, { missing: hb.missing });
    }
    this.emitChange();
  }

  private collectHeartbeats(): { rows: WatchdogSnapshot["heartbeats"]; severity: Severity; message?: string; missing?: string[] } {
    const rows: WatchdogSnapshot["heartbeats"] = [];
    const nowTs = now();
    const missing: string[] = [];
    for (const hb of this.beats.values()) {
      const age = Math.max(0, nowTs - hb.last);
      const warnAt = hb.ttlMs + this.cfg.heartbeatSkewMs;
      const status: Severity = age <= warnAt ? "ok" : age <= warnAt * 2 ? "warn" : "fail";
      if (status !== "ok") missing.push(hb.id);
      rows.push({
        id: hb.id,
        ttlMs: hb.ttlMs,
        lastBeatAt: new Date(hb.last).toISOString(),
        ageMs: age,
        status,
        note: hb.note,
      });
    }
    const sev = severityFrom(rows.map(r => r.status));
    const msg = missing.length ? `missing beats: ${missing.join(",")}` : undefined;
    return { rows, severity: sev, message: msg, missing };
  }

  private computeCpu(): { pct: number; lastPct: number } | undefined {
    if (!hasNodeCpu()) return undefined;
    const nowTs = now();
    const cur = readNodeCpu();
    const last = this.lastCpuSample!;
    const dt = Math.max(1, nowTs - last.ts); // ms
    // Convert microseconds to ms; total CPU over interval per-core/overall is user+system
    const du = cur.user - last.usage.user;
    const ds = cur.system - last.usage.system;
    const totalMs = (du + ds) / 1000; // cpuUsage reports microseconds
    // pct can exceed 100% on multi-core; here we clamp to 100 for simplicity
    const pct = clamp((totalMs / dt) * 100, 0, 1000); // allow >100 if multicore
    const lastPct = this.lastSnapshot?.runtime.cpu?.pct ?? pct;
    this.lastCpuSample = { ts: nowTs, usage: cur };
    return { pct, lastPct };
  }

  private maybeEscalate(gate: Gate, sev: Severity, message: string, data?: Record<string, unknown>): void {
    const key = `${gate}:${sev}`;
    const last = this.lastEscalationAt.get(key) ?? 0;
    const n = now();
    if (sev !== "ok" && n - last >= this.cfg.coolDownMs) {
      this.lastEscalationAt.set(key, n);
      try { this.cfg.onEscalate?.({ at: new Date().toISOString(), gate, severity: sev, message, data }); } catch { /* ignore */ }
    }
  }

  private emitChange(): void {
    try { this.cfg.onChange?.(this.snapshot()); } catch { /* ignore */ }
  }

  private _send(res: any, code: number, body: unknown, pretty: boolean) {
    try {
      if (res && typeof res.setHeader === "function") {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
      }
      const payload = JSON.stringify(body, null, pretty ? 2 : 0);
      if (res && typeof res.writeHead === "function") res.writeHead(code);
      if (res && typeof res.end === "function") res.end(payload);
    } catch { /* swallow */ }
  }
}

// ---------- Helpers & Types ----------

type RequiredConfig = {
  loopSampleMs: Millis;
  loopWindowSize: number;
  resourceSampleMs: Millis;
  guardSampleMs: Millis;

  lagWarnMs: Millis;
  lagFailMs: Millis;
  heapWarnRatio: number;
  heapFailRatio: number;
  rssWarnMB: number;
  rssFailMB: number;
  cpuWarnPct: number;
  cpuFailPct: number;

  heartbeatSkewMs: Millis;
  coolDownMs: Millis;

  onEscalate?: WatchdogOptions["onEscalate"];
  onChange?: WatchdogOptions["onChange"];

  service?: string;
  version?: string;
  env?: string;
};

function normalizeConfig(o?: WatchdogOptions): RequiredConfig {
  return {
    loopSampleMs: clampInt(o?.loopSampleMs ?? 100, 10, 1000),
    loopWindowSize: clampInt(o?.loopWindowSize ?? 300, 30, 10_000),
    resourceSampleMs: clampInt(o?.resourceSampleMs ?? 1000, 100, 60_000),
    guardSampleMs: clampInt(o?.guardSampleMs ?? 1000, 100, 60_000),

    lagWarnMs: o?.lagWarnMs ?? 100,
    lagFailMs: o?.lagFailMs ?? 250,
    heapWarnRatio: clampNum(o?.heapWarnRatio ?? 0.8, 0.1, 1.0),
    heapFailRatio: clampNum(o?.heapFailRatio ?? 0.95, 0.1, 1.0),
    rssWarnMB: o?.rssWarnMB ?? 1024,
    rssFailMB: o?.rssFailMB ?? 2048,
    cpuWarnPct: o?.cpuWarnPct ?? 85,
    cpuFailPct: o?.cpuFailPct ?? 95,

    heartbeatSkewMs: o?.heartbeatSkewMs ?? 100,
    coolDownMs: o?.coolDownMs ?? 10_000,

    onEscalate: o?.onEscalate,
    onChange: o?.onChange,

    service: o?.service,
    version: o?.version,
    env: o?.env,
  };
}

class RingBuffer {
  private arr: number[];
  private idx = 0;
  private filled = false;
  constructor(private cap: number = 300) { this.arr = new Array(this.cap).fill(0); }
  setCapacity(n: number) {
    if (n === this.cap) return;
    const cur = this.values();
    this.cap = Math.max(1, n);
    this.arr = new Array(this.cap).fill(0);
    this.idx = 0; this.filled = false;
    for (const v of cur.slice(-this.cap)) this.push(v);
  }
  push(v: number) {
    if (this.arr.length !== this.cap) this.setCapacity(this.cap);
    this.arr[this.idx] = v;
    this.idx = (this.idx + 1) % this.cap;
    if (this.idx === 0) this.filled = true;
  }
  values(): number[] {
    const len = this.filled ? this.cap : this.idx;
    const out = new Array<number>(len);
    for (let i = 0; i < len; i++) {
      const j = (this.filled ? this.idx : 0) + i;
      out[i] = this.arr[j % this.cap];
    }
    return out;
  }
  stats() {
    const vals = this.values();
    const sorted = vals.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const quant = (q: number) => (n ? percentile(sorted, q) : 0);
    return {
      count: n,
      last: n ? vals[n - 1] : 0,
      p50: quant(0.5),
      p95: quant(0.95),
      max: n ? sorted[n - 1] : 0,
    };
  }
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  if (q <= 0) return sorted[0];
  if (q >= 1) return sorted[sorted.length - 1];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const w = pos - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function severityFrom(items: Array<Severity>): Severity {
  if (items.includes("fail")) return "fail";
  if (items.includes("warn")) return "warn";
  return "ok";
}

function compare(_label: string, val: number | undefined, warn: number, fail: number): Severity {
  if (val == null || !isFinite(val)) return "ok";
  if (val >= fail) return "fail";
  if (val >= warn) return "warn";
  return "ok";
}

// ---- Environment readers (Node/Browser safe) ----

type NodeCpuSnapshot = { user: number; system: number };

function hasNode(): boolean {
  return typeof (globalThis as any).process !== "undefined" && !!(globalThis as any).process?.versions?.node;
}

function hasNodeCpu(): boolean {
  const p: any = (globalThis as any).process;
  return hasNode() && typeof p?.cpuUsage === "function";
}

function readNodeCpu(): NodeCpuSnapshot {
  const p: any = (globalThis as any).process;
  const u = p.cpuUsage(); // { user, system } in microseconds
  return { user: u.user ?? 0, system: u.system ?? 0 };
}

function readMemory(): {
  heap?: { usedMB: number; totalMB: number; ratio: number };
  rss?: { mb: number };
} {
  // Node
  if (hasNode()) {
    try {
      const p: any = (globalThis as any).process;
      const m = p.memoryUsage();
      const heapUsed = m.heapUsed ?? 0;
      const heapTotal = m.heapTotal ?? 0;
      const rss = m.rss ?? 0;
      return {
        heap: heapTotal > 0 ? { usedMB: heapUsed / MB, totalMB: heapTotal / MB, ratio: heapUsed / heapTotal } : undefined,
        rss: rss > 0 ? { mb: rss / MB } : undefined,
      };
    } catch { /* ignore */ }
  }
  // Browser (best effort)
  const perf: any = (globalThis as any).performance;
  if (perf && perf.memory) {
    const heapUsed = perf.memory.usedJSHeapSize ?? 0;
    const heapTotal = perf.memory.totalJSHeapSize ?? 0;
    return {
      heap: heapTotal > 0 ? { usedMB: heapUsed / MB, totalMB: heapTotal / MB, ratio: heapUsed / heapTotal } : undefined,
      rss: undefined,
    };
  }
  return { heap: undefined, rss: undefined };
}

// ---- Utils ----

const MB = 1024 * 1024;
const now = () => Date.now();
const round = (x: number) => Math.round(x * 100) / 100;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const clampInt = (x: number, lo: number, hi: number) => Math.floor(clamp(x, lo, hi));
function clampNum(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}
function errToString(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  try { return JSON.stringify(e); } catch { return String(e); }
}

// ---------- Example usage (commented) ----------
/*
const wd = new Watchdog({
  service: "trade-engine",
  version: "1.0.0",
  onEscalate: (e) => console.warn(`[watchdog] ${e.gate} ${e.severity}: ${e.message}`),
});
wd.start();

// Heartbeats
const beatIngest = wd.registerHeartbeat("ingest-loop", 2000);
setInterval(() => beatIngest(), 1000);

// Custom guard: ensure a feature flag is loaded
wd.registerGuard("featureFlagLoaded", () => ({
  status: Math.random() < 0.95 ? "ok" : "warn",
  message: "flag delayed",
}));

// HTTP
// const http = require("http");
// http.createServer(wd.httpHandler({ pretty: true })).listen(8081);

// Read snapshot anytime
setInterval(() => console.log(wd.snapshot()), 5000);
*/
