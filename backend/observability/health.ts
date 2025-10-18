// observability/health.ts
// Import-free, strict-TS-friendly health & readiness utilities.
// - Register synchronous or async checks (liveness/readiness/custom)
// - Compute overall status with reasons + durations
// - Optional scheduler to refresh expensive checks in background
// - Tiny HTTP handler (Node's http.createServer compatible) for /health, /ready, /live
// - Event-loop lag probe + memory/uptime built-ins
//
// Usage:
//   const h = new HealthRegistry({ service: "my-app", version: "1.2.3" });
//   h.add(checkUptime());                 // builtin
//   h.add(checkEventLoopLag({ warn: 100 })); // builtin
//   h.add(checkMemory({ warnPct: 0.8 })); // builtin
//   h.add({
//     id: "redis",
//     kind: "readiness",
//     run: async () => ({ ok: await pingRedis(), reason: "pong", meta: { node: "r1" } }),
//     intervalMs: 5000 // cached in the background
//   });
//   // http.createServer(makeHealthHttpHandler(h)).listen(8787);
//
// Notes:
// - No external deps. Uses Date.now() for timing. 
// - "ok=false" on any readiness check → overall READY=false.
// - Liveness ignores external deps by default (only internal probes should affect live).

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Dict<T = any> = Record<string, T>;

export type HealthKind = "liveness" | "readiness" | "diagnostic";

export interface CheckResult {
  ok: boolean;
  reason?: string;
  meta?: Dict;
  tookMs?: number;
  at?: string; // ISO
}

export interface HealthCheck {
  id: string;                 // unique identifier
  kind: HealthKind;           // affects which endpoint it's counted in
  run: () => CheckResult | Promise<CheckResult>;
  timeoutMs?: number;         // per-run timeout (default 2500)
  intervalMs?: number;        // if set, the registry will cache results via scheduler
  tags?: string[];            // arbitrary
  weight?: number;            // for overall scoring (default 1)
  degradeOnFail?: boolean;    // if false, failure doesn't flip overall; useful for diagnostics
}

export interface HealthSnapshot {
  service?: string;
  version?: string;
  now: string;
  live: { ok: boolean; checks: Record<string, CheckResult>; score: number };
  ready: { ok: boolean; checks: Record<string, CheckResult>; score: number };
  diag:  { ok: boolean; checks: Record<string, CheckResult>; score: number };
  summary: string[];
}

export interface HealthOptions {
  service?: string;
  version?: string;
  defaultTimeoutMs?: number;  // default per-check timeout
  scheduler?: boolean;        // if true, enable background refresh for checks with intervalMs
}

export class HealthRegistry {
  private opts: Required<Pick<HealthOptions, "defaultTimeoutMs">> & Omit<HealthOptions, "defaultTimeoutMs">;
  private checks = new Map<string, HealthCheck>();
  private cache = new Map<string, CheckResult>();      // last ok/reason/meta/at/tookMs
  private timers = new Map<string, any>();             // setInterval refs

  constructor(opts: HealthOptions = {}) {
    this.opts = {
      service: opts.service,
      version: opts.version,
      defaultTimeoutMs: Math.max(1, Math.floor(opts.defaultTimeoutMs ?? 2500)),
      scheduler: opts.scheduler ?? true,
    };
  }

  add(check: HealthCheck): this {
    if (this.checks.has(check.id)) throw new Error(`health check already exists: ${check.id}`);
    this.checks.set(check.id, { ...check });
    if (this.opts.scheduler && check.intervalMs && check.intervalMs > 0) {
      const runOnce = () => this.runOne(check.id).catch(() => void 0);
      runOnce(); // warm
      const t = setInterval(runOnce, Math.max(250, Math.floor(check.intervalMs)));
      this.timers.set(check.id, t);
    }
    return this;
  }

  remove(id: string): this {
    this.checks.delete(id);
    const t = this.timers.get(id); if (t) { try { clearInterval(t); } catch {} this.timers.delete(id); }
    this.cache.delete(id);
    return this;
  }

  stop(): void {
    for (const t of this.timers.values()) { try { clearInterval(t); } catch {} }
    this.timers.clear();
  }

  // ---- Execution ----

  /** Run a single check by id (uses timeout, updates cache). */
  async runOne(id: string): Promise<CheckResult> {
    const c = this.checks.get(id);
    if (!c) throw new Error(`unknown check: ${id}`);
    const t0 = Date.now();
    const to = c.timeoutMs ?? this.opts.defaultTimeoutMs;
    const res = await withTimeout(Promise.resolve().then(() => c.run()), to)
      .catch((e: any) => ({ ok: false, reason: `error: ${String(e?.message ?? e)}` } as CheckResult));
    const took = Math.max(0, Date.now() - t0);
    const final: CheckResult = {
      ok: !!res.ok,
      reason: res.reason,
      meta: res.meta,
      tookMs: took,
      at: new Date().toISOString(),
    };
    this.cache.set(id, final);
    return final;
  }

  /** Run all checks now; return categorized snapshot. */
  async snapshot(): Promise<HealthSnapshot> {
    const live: Record<string, CheckResult> = {};
    const ready: Record<string, CheckResult> = {};
    const diag:  Record<string, CheckResult> = {};

    // Run all checks that don't have a recent cached value or that have no scheduler
    const promises: Array<Promise<void>> = [];
    for (const [id, c] of this.checks) {
      const p = (async () => {
        // Use cache if scheduler active for this check (assumes background freshness)
        const useCache = this.opts.scheduler && c.intervalMs && c.intervalMs > 0 && this.cache.has(id);
        const r = useCache ? this.cache.get(id)! : await this.runOne(id);
        if (c.kind === "liveness") live[id] = r;
        else if (c.kind === "readiness") ready[id] = r;
        else diag[id] = r;
      })();
      promises.push(p);
    }
    await Promise.all(promises);

    const liveScore = scoreGroup(live, this.checks, "liveness");
    const readyScore = scoreGroup(ready, this.checks, "readiness");
    const diagScore  = scoreGroup(diag,  this.checks, "diagnostic");

    const summary = summarize(live, ready, diag, this.opts.service, this.opts.version);

    return {
      service: this.opts.service,
      version: this.opts.version,
      now: new Date().toISOString(),
      live: { ok: liveScore.ok, checks: live, score: liveScore.score },
      ready: { ok: readyScore.ok, checks: ready, score: readyScore.score },
      diag:  { ok: diagScore.ok,  checks: diag,  score: diagScore.score  },
      summary,
    };
  }

  // ---- Quick helpers for endpoints ----

  /** Convenience: true if all liveness checks are ok (ignores readiness/diagnostics). */
  async isLive(): Promise<boolean> { const s = await this.snapshot(); return s.live.ok; }
  /** Convenience: true if all readiness checks with degradeOnFail!==false are ok. */
  async isReady(): Promise<boolean> { const s = await this.snapshot(); return s.ready.ok; }

  /** Serialize minimal JSON for /health. */
  async toJSON(minimal = false): Promise<string> {
    const s = await this.snapshot();
    const payload = minimal ? {
      service: s.service, version: s.version, now: s.now,
      live: s.live.ok, ready: s.ready.ok, summary: s.summary
    } : s;
    return JSON.stringify(payload);
  }
}

// ---------------- Built-in checks ----------------

/** Always-on uptime gauge (liveness). */
export function checkUptime(id = "uptime"): HealthCheck {
  const started = Date.now();
  return {
    id, kind: "liveness",
    run: () => {
      const ms = Date.now() - started;
      return { ok: true, reason: "up", meta: { ms, seconds: Math.floor(ms / 1000) } };
    },
    intervalMs: 1000,
  };
}

/** Event loop lag measurement using setTimeout drift. warn/error in ms. */
export function checkEventLoopLag(opts?: { id?: string; warn?: number; error?: number; sampleMs?: number }): HealthCheck {
  const id = opts?.id ?? "event_loop_lag";
  const warn = Math.max(0, Math.floor(opts?.warn ?? 100));  // 100ms
  const error = Math.max(warn, Math.floor(opts?.error ?? 500));
  const sample = Math.max(10, Math.floor(opts?.sampleMs ?? 250));
  return {
    id, kind: "liveness",
    run: async () => {
      const t0 = Date.now();
      await delay(sample);
      const lag = Date.now() - t0 - sample;
      const ok = lag <= error;
      const reason = lag > error ? `lag>${error}ms` : lag > warn ? `lag>${warn}ms` : "ok";
      return { ok, reason, meta: { lagMs: lag, warn, error } };
    },
    intervalMs: 1000,
  };
}

/** Memory usage check; thresholds can be absolute (bytes) or percentage of heapTotal. */
export function checkMemory(opts?: { id?: string; warnPct?: number; errorPct?: number; warnBytes?: number; errorBytes?: number }): HealthCheck {
  const id = opts?.id ?? "memory";
  const warnPct = clamp01(opts?.warnPct ?? 0.8);
  const errorPct = Math.max(warnPct, clamp01(opts?.errorPct ?? 0.95));
  const warnBytes = Math.max(0, Math.floor(opts?.warnBytes ?? 0));
  const errorBytes = Math.max(warnBytes, Math.floor(opts?.errorBytes ?? 0));
  return {
    id, kind: "liveness",
    run: () => {
      const m = process.memoryUsage?.() ?? ({} as any);
      const heapUsed = toNum(m.heapUsed), heapTotal = Math.max(1, toNum(m.heapTotal));
      const rss = toNum(m.rss);
      const pct = heapUsed / heapTotal;
      const overBytes = (errorBytes && heapUsed > errorBytes) || (warnBytes && heapUsed > warnBytes);
      const ok = pct <= errorPct && !overBytes;
      const reason = !ok ? "heap pressure" : "ok";
      return { ok, reason, meta: { heapUsed, heapTotal, rss, pct } };
    },
    intervalMs: 2000,
  };
}

/** Simple custom ping check builder (wraps an async boolean function). */
export function makePingCheck(id: string, kind: HealthKind, fn: () => Promise<boolean>, reason = "pong", intervalMs = 5000): HealthCheck {
  return {
    id, kind,
    run: async () => ({ ok: !!(await fn()), reason }),
    intervalMs,
  };
}

// ---------------- HTTP helpers ----------------

/**
 * Returns a Node-compatible handler for http.createServer.
 * Routes:
 *   GET /health  -> overall JSON (live/ready + checks)
 *   GET /live    -> 200 if live ok, else 503
 *   GET /ready   -> 200 if ready ok, else 503
 */
export function makeHealthHttpHandler(reg: HealthRegistry) {
  return async (req: any, res: any) => {
    const url = String(req.url || "/").split("?")[0];
    try {
      if (req.method !== "GET") { res.statusCode = 405; res.end("method not allowed"); return; }
      if (url === "/live") {
        const ok = await reg.isLive();
        res.statusCode = ok ? 200 : 503;
        res.setHeader?.("Content-Type", "application/json");
        res.end(JSON.stringify({ live: ok }));
        return;
      }
      if (url === "/ready") {
        const ok = await reg.isReady();
        res.statusCode = ok ? 200 : 503;
        res.setHeader?.("Content-Type", "application/json");
        res.end(JSON.stringify({ ready: ok }));
        return;
      }
      if (url === "/health" || url === "/") {
        const json = await reg.toJSON(true);
        const ok = JSON.parse(json).ready && JSON.parse(json).live;
        res.statusCode = ok ? 200 : 503;
        res.setHeader?.("Content-Type", "application/json");
        res.end(json);
        return;
      }
      res.statusCode = 404; res.end("not found");
    } catch (e: any) {
      res.statusCode = 500;
      res.setHeader?.("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
    }
  };
}

// ---------------- Internals ----------------

function summarize(live: Record<string, CheckResult>, ready: Record<string, CheckResult>, diag: Record<string, CheckResult>, svc?: string, ver?: string): string[] {
  const out: string[] = [];
  const sections: Array<["live"|"ready"|"diag", Record<string, CheckResult>]> = [["live", live], ["ready", ready], ["diag", diag]];
  for (const [name, group] of sections) {
    const bad = Object.entries(group).filter(([, r]) => !r.ok);
    if (bad.length) out.push(`${name}: ${bad.map(([id, r]) => `${id}(${r.reason || "fail"})`).join(", ")}`);
  }
  if (!out.length) out.push(`${svc ?? "service"} ${ver ?? ""}`.trim() + " healthy");
  return out;
}

function scoreGroup(group: Record<string, CheckResult>, all: Map<string, HealthCheck>, kind: HealthKind): { ok: boolean; score: number } {
  let score = 0, weight = 0, ok = true;
  for (const [id, r] of Object.entries(group)) {
    const c = all.get(id)!;
    const w = Math.max(0, c?.weight ?? 1);
    weight += w;
    const contribution = r.ok ? w : 0;
    score += contribution;
    if (c?.degradeOnFail !== false) {
      if (kind === "liveness") ok = ok && r.ok;
      else if (kind === "readiness") ok = ok && r.ok;
      else ok = ok && r.ok; // diagnostics typically not gating, but allow override with degradeOnFail
    }
  }
  const norm = weight > 0 ? score / weight : 1;
  return { ok, score: round2(norm) };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function clamp01(x?: number): number { const n = Number(x ?? 0); return Math.max(0, Math.min(1, n)); }
function toNum(x: any): number { const n = Number(x); return Number.isFinite(n) ? n : 0; }

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: any;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const onDone = (f: (v?: any) => void) => (v: any) => {
      if (done) return; done = true; clearTimeout(t); f(v);
    };
    t = setTimeout(() => onDone(reject)(new Error(`health check timeout ${ms}ms`)), Math.max(1, ms));
    p.then(onDone(resolve), onDone(reject));
  });
}
function delay(ms: number): Promise<void> { return new Promise(r => setTimeout(r, Math.max(0, ms))); }

// ---------------- Example (commented) ----------------
/*
const hr = new HealthRegistry({ service: "demo", version: "1.0.0" });
hr.add(checkUptime());
hr.add(checkEventLoopLag({ warn: 100, error: 500 }));
hr.add(checkMemory({ warnPct: 0.8, errorPct: 0.95 }));
hr.add(makePingCheck("db", "readiness", async () => true, "ok", 3000));

const http = require("http");
http.createServer(makeHealthHttpHandler(hr)).listen(8787, ()=>console.log("health @ http://127.0.0.1:8787/health"));
*/