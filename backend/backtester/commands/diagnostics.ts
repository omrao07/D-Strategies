// commands/diagnostics.ts
// Zero-dependency diagnostics toolkit + tiny CLI-style command handler.
// Lives happily in `commands/*` (no imports).
//
// What you get
// - Register & run diagnostic checks (async/sync) with per-check timeout, tags, and severity
// - Built-in checks: process info (cpu/mem), event-loop lag, env vars, time skew,
//   HTTP GET (via global fetch if available), randomness/entropy estimate
// - Aggregate snapshot + pretty table/JSON
// - CLI-ish runner: runDiagnosticsCommand(["run","--env","API_KEY,DB_URL","--http","https://example.com"])
// - Programmatic usage:
//     import { diagnostics, runDiagnosticsCommand, Checks } from "./commands/diagnostics";
//     diagnostics.register(Checks.envVars(["API_KEY"]));
//     const out = await diagnostics.run({ tags:["net"] });
//     console.log(out);
//
// Notes
// - No imports; uses globalThis.fetch if present (Node 18+/browser) for HTTP.
// - Everything is optional: only the checks you register will run.

type Millis = number;
type Severity = "pass" | "warn" | "fail";

export interface DiagnosticResult {
  name: string;
  status: Severity;
  observedAt: string;           // ISO
  durationMs: number;
  message?: string;
  metrics?: Record<string, number | string | boolean>;
  tags?: string[];
}

export interface DiagnosticCheck {
  name: string;
  tags?: string[];
  timeoutMs?: Millis;           // default 5000
  run: () => Promise<DiagnosticResult> | DiagnosticResult;
}

export interface RunOptions {
  tags?: string[];              // run only checks matching ANY of these tags
  timeoutMs?: Millis;           // fallback timeout for checks
}

export interface Snapshot {
  collectedAt: string;
  status: Severity;             // aggregate: fail > warn > pass
  counts: { pass: number; warn: number; fail: number; total: number };
  checks: DiagnosticResult[];
}

// ---------------- Registry ----------------

class DiagnosticRegistry {
  private checks = new Map<string, DiagnosticCheck>();

  register(check: DiagnosticCheck): void {
    if (!check?.name) throw new Error("check.name required");
    if (this.checks.has(check.name)) throw new Error(`check "${check.name}" already exists`);
    this.checks.set(check.name, normalizeCheck(check));
  }

  upsert(check: DiagnosticCheck): void {
    if (!check?.name) throw new Error("check.name required");
    this.checks.set(check.name, normalizeCheck(check));
  }

  remove(name: string): boolean { return this.checks.delete(name); }
  get(name: string): DiagnosticCheck | undefined { return this.checks.get(name); }

  list(): DiagnosticCheck[] {
    return Array.from(this.checks.values()).sort((a,b) => a.name.localeCompare(b.name));
  }

  async run(opts?: RunOptions): Promise<Snapshot> {
    const selected = this.selectByTags(opts?.tags);
    const results = await Promise.all(selected.map(c => runWithTimeout(c, opts?.timeoutMs)));
    const status = aggregate(results.map(r => r.status));
    const counts = countStatuses(results.map(r => r.status));
    return {
      collectedAt: new Date().toISOString(),
      status, counts: { ...counts, total: results.length },
      checks: results,
    };
  }

  private selectByTags(tags?: string[]): DiagnosticCheck[] {
    if (!tags || tags.length === 0) return this.list();
    const want = new Set(tags.map(String));
    return this.list().filter(c => (c.tags ?? []).some(t => want.has(t)));
  }
}

export const diagnostics = new DiagnosticRegistry();

// ---------------- Built-in Checks ----------------

export const Checks = {
  /** Process & runtime info (Node/browser best-effort). */
  processInfo(name = "process-info"): DiagnosticCheck {
    return {
      name, tags: ["sys"],
      run: () => {
        const start = now();
        const envNode = hasNode();
        const mem = readMemory();
        const cpu = envNode ? readCPUNode() : undefined;
        const info: Record<string, string | number | boolean> = {
          node: envNode,
          pid: envNode ? (globalThis as any).process?.pid ?? "" : "",
          platform: envNode ? (globalThis as any).process?.platform ?? "" : (globalThis as any).navigator?.platform ?? "",
          arch: envNode ? (globalThis as any).process?.arch ?? "" : "",
          rssMB: mem.rssMB ?? "",
          heapUsedMB: mem.heapUsedMB ?? "",
          heapTotalMB: mem.heapTotalMB ?? "",
          cpuUserMs: cpu?.userMs ?? "",
          cpuSystemMs: cpu?.systemMs ?? "",
        };
        return {
          name, status: "pass", observedAt: iso(),
          durationMs: now() - start, message: "runtime snapshot",
          metrics: info,
          tags: ["sys"],
        };
      }
    };
  },

  /** Event-loop lag p95 over a short sampling window. */
  eventLoopLag({ sampleMs = 100, samples = 200, warnMs = 100, failMs = 250, name = "event-loop-lag" } = {}): DiagnosticCheck {
    return {
      name, tags: ["sys","perf"], timeoutMs: Math.max(2000, sampleMs * samples + 250),
      run: async () => {
        const lags: number[] = [];
        let last = now();
        for (let i = 0; i < samples; i++) {
          await sleep(sampleMs);
          const t = now(); lags.push(Math.max(0, t - last - sampleMs)); last = t;
        }
        const p95 = percentile(lags, 0.95);
        const max = Math.max(0, ...lags);
        const status = threshold(p95, warnMs, failMs);
        return {
          name, status, observedAt: iso(),
          durationMs: sampleMs * samples,
          message: `p95=${round(p95)}ms max=${round(max)}ms`,
          metrics: { p50: round(percentile(lags, 0.5)), p95: round(p95), max: round(max), samples },
          tags: ["sys","perf"],
        };
      }
    };
  },

  /** Ensure required environment variables exist (and non-empty). */
  envVars(required: string[], name = "env-vars"): DiagnosticCheck {
    return {
      name, tags: ["config"],
      run: () => {
        const start = now();
        const missing: string[] = [];
        for (const key of required) {
          const v = readEnv(key);
          if (v == null || String(v).trim() === "") missing.push(key);
        }
        const status: Severity = missing.length ? (missing.length >= Math.ceil(required.length * 0.5) ? "fail" : "warn") : "pass";
        return {
          name, status, observedAt: iso(),
          durationMs: now() - start,
          message: missing.length ? `missing: ${missing.join(", ")}` : "all present",
          metrics: { required: required.length, missing: missing.length },
          tags: ["config"],
        };
      }
    };
  },

  /** Compare local time to a reference epoch (ms). */
  timeSkew(refEpochMs: number, { warnMs = 2000, failMs = 10_000, name = "time-skew" } = {}): DiagnosticCheck {
    return {
      name, tags: ["time","sys"],
      run: () => {
        const start = now();
        const skew = Math.abs(now() - refEpochMs);
        const status = threshold(skew, warnMs, failMs);
        return {
          name, status, observedAt: iso(),
          durationMs: now() - start,
          message: `skew=${skew}ms`,
          metrics: { skewMs: skew, refEpochMs },
          tags: ["time","sys"],
        };
      }
    };
  },

  /** HTTP GET using global fetch (Node 18+/browser). */
  httpGet(url: string, opts?: { expectStatus?: number | number[]; timeoutMs?: number; name?: string }): DiagnosticCheck {
    const name = opts?.name ?? `http-get:${url}`;
    const expect = Array.isArray(opts?.expectStatus) ? opts?.expectStatus : (opts?.expectStatus != null ? [opts.expectStatus] : [200,204,301,302]);
    return {
      name, tags: ["net","http"], timeoutMs: opts?.timeoutMs ?? 5000,
      run: async () => {
        const start = now();
        if (!hasFetch()) {
          return { name, status: "warn", observedAt: iso(), durationMs: 0, message: "fetch not available in this runtime", tags: ["net","http"] };
        }
        let status = 0, ok = false, bytes = 0;
        let error: any;
        try {
          const ctrl = createAbortController();
          const to = setTimeout(() => ctrl.abort(), Math.max(1, (opts?.timeoutMs ?? 5000)));
          const res = await (globalThis as any).fetch(url, { method: "GET", signal: ctrl.signal });
          clearTimeout(to);
          status = res.status;
          ok = expect.includes(res.status);
          const text = await res.text();
          bytes = text.length;
        } catch (e) { error = e; }
        const dur = now() - start;
        const severity: Severity = error ? "fail" : (ok ? "pass" : "warn");
        return {
          name, status: severity, observedAt: iso(), durationMs: dur,
          message: error ? errToString(error) : `status=${status}, bytes=${bytes}`,
          metrics: { status, bytes, durationMs: dur },
          tags: ["net","http"],
        };
      }
    };
  },

  /** Randomness quality (very rough): entropy estimate of Math.random() bytes. */
  entropy({ samples = 2048, name = "entropy" } = {}): DiagnosticCheck {
    return {
      name, tags: ["sys","entropy"],
      run: () => {
        const start = now();
        // Build a byte histogram from Math.random() (poor RNG but ubiquitous)
        const hist = new Array<number>(256).fill(0);
        for (let i = 0; i < samples; i++) {
          const b = Math.floor(Math.random() * 256) & 0xff;
          hist[b]++;
        }
        const H = entropyBits(hist, samples);
        // 8 bits = ideal; below ~7 -> warn, below ~6.5 -> fail (heuristic)
        const status: Severity = H >= 7 ? "pass" : (H >= 6.5 ? "warn" : "fail");
        return {
          name, status, observedAt: iso(), durationMs: now() - start,
          message: `H≈${H.toFixed(3)} bits/byte`,
          metrics: { entropyBitsPerByte: round(H), samples },
          tags: ["sys","entropy"],
        };
      }
    };
  },
};

// Seed a small sensible set
try {
  diagnostics.upsert(Checks.processInfo());
  diagnostics.upsert(Checks.eventLoopLag());
} catch { /* ignore duplicates in hot-reload */ }

// ---------------- CLI-ish command ----------------

/**
 * runDiagnosticsCommand(argv)
 * Subcommands:
 *   list
 *   add --kind env|http|loop|time|entropy [...options]
 *   rm <name>
 *   run [--tags net,sys] [--json]
 *   show <name>
 *
 * Quick examples:
 *   runDiagnosticsCommand(["add","--kind","env","--name","env","--env","API_KEY,DB_URL"])
 *   runDiagnosticsCommand(["add","--kind","http","--http","https://example.com","--expect","200,301"])
 *   await runDiagnosticsCommand(["run","--tags","net,sys","--json"])
 */
export async function runDiagnosticsCommand(argv: string[]): Promise<string> {
  const args = parseArgv(argv);
  const cmd = String(args._[0] ?? "help").toLowerCase();

  try {
    switch (cmd) {
      case "help":
        return help();
      case "list": {
        const rows = diagnostics.list().map(c => ({
          name: c.name,
          tags: (c.tags ?? []).join(","),
          timeoutMs: c.timeoutMs ?? "",
        }));
        return table(rows, ["name","tags","timeoutMs"]);
      }
      case "show": {
        const name = String(args._[1] ?? args.name ?? "");
        if (!name) return "Usage: show <name>";
        const c = diagnostics.get(name);
        if (!c) return `Check "${name}" not found.`;
        return pretty(c);
      }
      case "rm":
      case "remove": {
        const name = String(args._[1] ?? args.name ?? "");
        if (!name) return "Usage: rm <name>";
        const ok = diagnostics.remove(name);
        return ok ? `Removed "${name}".` : `Check "${name}" not found.`;
      }
      case "add": {
        const kind = String(args.kind ?? args.type ?? "");
        const name = args.name ? String(args.name) : undefined;
        switch (kind) {
          case "env": {
            const list = parseStrList(args.env);
            if (!list.length) return "add --kind env requires --env 'KEY1,KEY2,...'";
            diagnostics.upsert(Checks.envVars(list, name ?? "env-vars"));
            return `Saved check "${name ?? "env-vars"}".`;
          }
          case "http": {
            const url = String(args.http ?? args.url ?? "");
            if (!url) return "add --kind http requires --http <url>";
            const expect = parseNumList(args.expect);
            diagnostics.upsert(Checks.httpGet(url, {
              name: name ?? `http-get:${url}`,
              expectStatus: expect.length ? expect : undefined,
              timeoutMs: toInt(args.timeout, 5000),
            }));
            return `Saved check "${name ?? `http-get:${url}`}."`;
          }
          case "loop": {
            diagnostics.upsert(Checks.eventLoopLag({
              name: name ?? "event-loop-lag",
              sampleMs: toInt(args.sampleMs, 100),
              samples: toInt(args.samples, 200),
              warnMs: toInt(args.warnMs, 100),
              failMs: toInt(args.failMs, 250),
            }));
            return `Saved check "${name ?? "event-loop-lag"}".`;
          }
          case "time": {
            const ref = Number(args.ref ?? args.refMs);
            if (!Number.isFinite(ref)) return "add --kind time requires --ref <epochMs>";
            diagnostics.upsert(Checks.timeSkew(ref, {
              name: name ?? "time-skew",
              warnMs: toInt(args.warnMs, 2000),
              failMs: toInt(args.failMs, 10_000),
            }));
            return `Saved check "${name ?? "time-skew"}".`;
          }
          case "entropy": {
            diagnostics.upsert(Checks.entropy({ name: name ?? "entropy", samples: toInt(args.samples, 2048) }));
            return `Saved check "${name ?? "entropy"}".`;
          }
          default:
            return `Unknown kind "${kind}".\n` + addHelp();
        }
      }
      case "run": {
        const tags = parseStrList(args.tags);
        const snap = await diagnostics.run({ tags, timeoutMs: toInt(args.timeout, undefined as any) });
        const asJson = !!args.json;
        if (asJson) return pretty(snap);
        const rows = snap.checks.map(r => ({
          name: r.name,
          status: r.status.toUpperCase(),
          ms: Math.round(r.durationMs),
          msg: r.message ?? "",
        }));
        const header = `status=${snap.status.toUpperCase()} pass=${snap.counts.pass} warn=${snap.counts.warn} fail=${snap.counts.fail}`;
        return [header, table(rows, ["name","status","ms","msg"])].join("\n");
      }
      default:
        return `Unknown subcommand "${cmd}".\n` + help();
    }
  } catch (e) {
    return `Error: ${errToString(e)}`;
  }
}

// ---------------- Internals ----------------

async function runWithTimeout(c: DiagnosticCheck, fallback?: number): Promise<DiagnosticResult> {
  const to = isPosInt(c.timeoutMs) ? c.timeoutMs! : (isPosInt(fallback) ? fallback! : 5000);
  const start = now();
  try {
    const res = await withTimeout(Promise.resolve().then(() => c.run()), to);
    // ensure shape
    return {
      name: res.name ?? c.name,
      status: res.status ?? "fail",
      observedAt: res.observedAt ?? iso(),
      durationMs: res.durationMs ?? (now() - start),
      message: res.message,
      metrics: res.metrics,
      tags: c.tags ?? res.tags,
    };
  } catch (e) {
    return {
      name: c.name,
      status: "fail",
      observedAt: iso(),
      durationMs: now() - start,
      message: errToString(e),
      tags: c.tags,
    };
  }
}

function normalizeCheck(c: DiagnosticCheck): DiagnosticCheck {
  return {
    name: String(c.name).trim(),
    tags: (c.tags ?? []).map(String),
    timeoutMs: isPosInt(c.timeoutMs) ? c.timeoutMs : 5000,
    run: c.run,
  };
}

// ---------------- Utilities ----------------

const now = () => Date.now();
const iso = () => new Date().toISOString();
const round = (x: number) => Math.round(x * 100) / 100;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let id: any;
  return new Promise<T>((resolve, reject) => {
    id = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(id); resolve(v); }, e => { clearTimeout(id); reject(e); });
  });
}

function hasNode(): boolean {
  return typeof (globalThis as any).process !== "undefined" &&
         !!((globalThis as any).process?.versions?.node);
}
function hasFetch(): boolean {
  return typeof (globalThis as any).fetch === "function";
}
function createAbortController(): { signal?: AbortSignal; abort: () => void } {
  if (typeof AbortController !== "undefined") return new AbortController();
  // tiny shim
  let aborted = false;
  const listeners: Function[] = [];
  const signal: any = {
    aborted,
    addEventListener: (_: any, fn: any) => listeners.push(fn),
    removeEventListener: (_: any, fn: any) => {
      const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1);
    },
  };
  return {
    signal: signal as AbortSignal,
    abort: () => { if (!aborted) { aborted = true; signal.aborted = true; listeners.forEach(fn => fn()); } },
  };
}

function readEnv(key: string): any {
  if (hasNode()) return (globalThis as any).process?.env?.[key];
  try { return (globalThis as any)[key]; } catch { return undefined; }
}

function readMemory(): { rssMB?: number; heapUsedMB?: number; heapTotalMB?: number } {
  if (hasNode()) {
    try {
      const m = (globalThis as any).process.memoryUsage();
      return {
        rssMB: Math.round((m.rss ?? 0) / (1024*1024)),
        heapUsedMB: Math.round((m.heapUsed ?? 0) / (1024*1024)),
        heapTotalMB: Math.round((m.heapTotal ?? 0) / (1024*1024)),
      };
    } catch { /* ignore */ }
  }
  const perf: any = (globalThis as any).performance;
  if (perf && perf.memory) {
    const used = perf.memory.usedJSHeapSize ?? 0;
    const total = perf.memory.totalJSHeapSize ?? 0;
    return { heapUsedMB: Math.round(used / (1024*1024)), heapTotalMB: Math.round(total / (1024*1024)) };
  }
  return {};
}

function readCPUNode(): { userMs: number; systemMs: number } | undefined {
  try {
    const u = (globalThis as any).process.cpuUsage(); // microseconds
    return { userMs: Math.round((u.user ?? 0) / 1000), systemMs: Math.round((u.system ?? 0) / 1000) };
  } catch { return undefined; }
}

function percentile(a: number[], q: number): number {
  if (!a.length) return 0;
  const s = a.slice().sort((x,y)=>x-y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  const w = pos - lo;
  return s[lo] * (1 - w) + s[hi] * w;
}

function threshold(value: number, warn: number, fail: number): Severity {
  if (value >= fail) return "fail";
  if (value >= warn) return "warn";
  return "pass";
}

function entropyBits(hist: number[], total: number): number {
  let H = 0;
  for (let i = 0; i < hist.length; i++) {
    const p = hist[i] / total;
    if (p > 0) H += -p * Math.log2(p);
  }
  return H;
}

function countStatuses(xs: Severity[]) {
  let pass = 0, warn = 0, fail = 0;
  for (const s of xs) { if (s === "pass") pass++; else if (s === "warn") warn++; else fail++; }
  return { pass, warn, fail };
}
function aggregate(xs: Severity[]): Severity {
  if (xs.includes("fail")) return "fail";
  if (xs.includes("warn")) return "warn";
  return "pass";
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function errToString(e: unknown): string { if (e instanceof Error) return `${e.name}: ${e.message}`; try { return JSON.stringify(e); } catch { return String(e); } }

// ---------------- Tiny CLI helpers ----------------

type Argv = { _: string[]; [k: string]: any };

function parseArgv(argv: string[]): Argv {
  const out: Argv = { _: [] }; let k: string | null = null;
  for (const raw of argv) {
    const a = String(raw);
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) { out[a.slice(2,eq)] = coerce(a.slice(eq+1)); k = null; }
      else { k = a.slice(2); out[k] = true; }
    } else if (a.startsWith("-") && a.length > 2) {
      for (let i = 1; i < a.length; i++) out[a[i]] = true; k = null;
    } else if (a.startsWith("-")) { k = a.slice(1); out[k] = true; }
    else { if (k && out[k] === true) { out[k] = coerce(a); k = null; } else out._.push(a); }
  }
  return out;
}
function coerce(x: string) {
  if (x === "true") return true;
  if (x === "false") return false;
  if (!Number.isNaN(Number(x)) && x.trim() !== "") return Number(x);
  try { return JSON.parse(x); } catch { /* not JSON */ }
  return x;
}
function parseStrList(x: any): string[] {
  if (x == null) return [];
  if (Array.isArray(x)) return x.map(String);
  return String(x).split(",").map(s => s.trim()).filter(Boolean);
}
function parseNumList(x: any): number[] {
  return parseStrList(x).map(n => Number(n)).filter(n => Number.isFinite(n));
}
function toInt(v: any, d: any): number { const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : d; }
function isPosInt(v: any): v is number { return Number.isInteger(v) && v > 0; }

function table(rows: Array<Record<string, any>>, headers: string[]): string {
  if (!rows.length) return "(empty)";
  const cols = headers;
  const widths = cols.map((h,i)=>Math.max(h.length, ...rows.map(r => String(r[cols[i]] ?? "").length)));
  const line = (cells: string[]) => cells.map((c,i)=>String(c).padEnd(widths[i]," ")).join("  ");
  const out: string[] = [];
  out.push(line(cols));
  out.push(line(widths.map(w=>"─".repeat(w))));
  for (const r of rows) out.push(line(cols.map(h=>String(r[h] ?? ""))));
  return out.join("\n");
}
function pretty(x: unknown): string { try { return JSON.stringify(x, null, 2); } catch { return String(x); } }

function help(): string {
  return [
    "diagnostics <subcommand>",
    "",
    "Subcommands:",
    "  list                                       List registered checks",
    "  show <name>                                Show a check",
    "  add --kind env|http|loop|time|entropy      Add (or upsert) a built-in check",
    "     env:   --name n --env 'KEY1,KEY2,...'",
    "     http:  --name n --http <url> [--expect '200,301'] [--timeout 5000]",
    "     loop:  --name n [--sampleMs 100] [--samples 200] [--warnMs 100] [--failMs 250]",
    "     time:  --name n --ref <epochMs> [--warnMs 2000] [--failMs 10000]",
    "     entropy: --name n [--samples 2048]",
    "  rm|remove <name>                           Remove a check",
    "  run [--tags t1,t2] [--json] [--timeout N]  Run checks (optionally filtered by tags)",
    "",
    "Examples:",
    "  diagnostics add --kind env --name env --env 'API_KEY,DB_URL'",
    "  diagnostics add --kind http --http https://example.com --expect 200,301",
    "  diagnostics run --tags net,sys",
  ].join("\n");
}
function addHelp(): string {
  return [
    "add --kind env|http|loop|time|entropy",
    "Examples:",
    "  add --kind env --name env --env 'API_KEY,DB_URL'",
    "  add --kind http --http https://example.com --expect 200,301",
  ].join("\n");
}

// ------------- Exports for programmatic use -------------

export type { DiagnosticRegistry as Diagnostics };
export function registerDiag(check: DiagnosticCheck): void { diagnostics.register(check); }
export function upsertDiag(check: DiagnosticCheck): void { diagnostics.upsert(check); }
export function listDiag(): DiagnosticCheck[] { return diagnostics.list(); }
export async function runDiag(opts?: RunOptions): Promise<Snapshot> { return diagnostics.run(opts); }
