// observability/health.ts
// Lightweight health-check framework + common checks.
// ESM/NodeNext friendly, no external deps.

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as https from "https";

/* =========================
   Types
   ========================= */

export type Status = "OK" | "WARN" | "CRIT";

export type CheckResult = {
  id: string;
  status: Status;
  msg?: string;
  meta?: Record<string, any>;
  ms: number;                 // duration
  ts: string;                 // ISO timestamp
};

export type Check = {
  id: string;
  desc?: string;
  /** Perform the check. Throw to signal CRIT, or return a WARN via result.status. */
  run: () => Promise<Omit<Partial<CheckResult>, "id" | "ts" | "ms"> | void> | Omit<Partial<CheckResult>, "id" | "ts" | "ms"> | void;
  /** Max time in ms before we treat as CRIT timeout (default 5000). */
  timeoutMs?: number;
};

export type HealthReport = {
  service?: string;
  ts: string;
  overall: Status;
  ok: number;
  warn: number;
  crit: number;
  results: CheckResult[];
};

export type RunOptions = {
  /** Optional label for the report/service name. */
  service?: string;
  /** Parallel or sequential execution. Default: parallel. */
  parallel?: boolean;
};

/* =========================
   Small helpers
   ========================= */

const clampStatus = (s?: any): Status => (s === "WARN" || s === "CRIT") ? s : "OK";

function statusOrder(s: Status): number {
  return s === "CRIT" ? 2 : s === "WARN" ? 1 : 0;
}

/** Wrap a promise with a timeout that rejects. */
function withTimeout<T>(p: Promise<T>, ms: number, message = "timeout"): Promise<T> {
  let t: NodeJS.Timeout;
  const to = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(message)), ms); });
  return Promise.race([p, to]).finally(() => clearTimeout(t!));
}

/* =========================
   Core registry
   ========================= */

const REGISTRY: Map<string, Check> = new Map();

export function registerCheck(check: Check) {
  if (REGISTRY.has(check.id)) throw new Error(`health check already registered: ${check.id}`);
  REGISTRY.set(check.id, check);
}

export function listChecks(): Check[] {
  return Array.from(REGISTRY.values());
}

/** Run all registered checks and build a report. */
export async function runAll(opts: RunOptions = {}): Promise<HealthReport> {
  const checks = listChecks();
  const parallel = opts.parallel !== false;

  const runOne = async (c: Check): Promise<CheckResult> => {
    const start = Date.now();
    const timeout = c.timeoutMs ?? 5000;
    try {
      const out = await withTimeout(Promise.resolve(c.run()), timeout, `check ${c.id} timed out`);
      const ms = Date.now() - start;
      const partial = (out ?? {}) as Partial<CheckResult>;
      const status = clampStatus(partial.status);
      return {
        id: c.id,
        status,
        msg: partial.msg,
        meta: partial.meta,
        ms,
        ts: new Date().toISOString(),
      };
    } catch (err: any) {
      const ms = Date.now() - start;
      return {
        id: c.id,
        status: "CRIT",
        msg: err?.message ?? String(err),
        ms,
        ts: new Date().toISOString(),
      };
    }
  };

  const results = parallel
    ? await Promise.all(checks.map(runOne))
    : await checks.reduce<Promise<CheckResult[]>>(async (accP, c) => {
        const acc = await accP;
        acc.push(await runOne(c));
        return acc;
      }, Promise.resolve([]));

  const ok = results.filter(r => r.status === "OK").length;
  const warn = results.filter(r => r.status === "WARN").length;
  const crit = results.filter(r => r.status === "CRIT").length;
  const overall: Status = crit > 0 ? "CRIT" : warn > 0 ? "WARN" : "OK";

  return {
    service: opts.service,
    ts: new Date().toISOString(),
    overall,
    ok,
    warn,
    crit,
    results: results.sort((a, b) => statusOrder(b.status) - statusOrder(a.status) || a.id.localeCompare(b.id)),
  };
}

/* =========================
   Built-in checks
   ========================= */

/** Check: repo directory exists & is writable (creates and deletes a temp file). */
export function repoWritableCheck(dir: string): Check {
  return {
    id: "repo.writable",
    desc: `Writable: ${dir}`,
    timeoutMs: 3000,
    async run() {
      try {
        const abs = path.resolve(dir);
        if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
        const test = path.join(abs, `.health-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
        fs.writeFileSync(test, "ok", "utf8");
        fs.unlinkSync(test);
        return { status: "OK", meta: { dir: abs } };
      } catch (e: any) {
        throw new Error(`repo not writable: ${e?.message ?? e}`);
      }
    },
  };
}

/** Check: environment variables present (warn if missing any). */
export function envVarsCheck(required: string[]): Check {
  return {
    id: "env.required",
    timeoutMs: 1000,
    async run() {
      const missing = required.filter(k => !process.env[k]);
      return missing.length
        ? { status: "WARN", msg: `missing env: ${missing.join(", ")}`, meta: { missing } }
        : { status: "OK", meta: { count: required.length } };
    },
  };
}

/** Check: config file exists & is valid JSON (optional schema keys to require). */
export function configFileCheck(filePath: string, requireKeys: string[] = []): Check {
  return {
    id: "config.json",
    timeoutMs: 1500,
    async run() {
      const abs = path.resolve(filePath);
      if (!fs.existsSync(abs)) throw new Error(`missing config: ${abs}`);
      let obj: any;
      try {
        obj = JSON.parse(fs.readFileSync(abs, "utf8"));
      } catch (e: any) {
        throw new Error(`invalid json: ${e?.message ?? e}`);
      }
      const missing = requireKeys.filter(k => !(k in obj));
      return missing.length
        ? { status: "WARN", msg: `config missing keys: ${missing.join(", ")}`, meta: { file: abs, missing } }
        : { status: "OK", meta: { file: abs } };
    },
  };
}

/** Check: HTTP/HTTPS ping to an external service (HEAD request). */
export function httpPingCheck(url: string, timeoutMs = 2500): Check {
  return {
    id: `net.ping:${new URL(url).hostname}`,
    timeoutMs,
    async run() {
      const t0 = Date.now();
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;

      const res = await new Promise<{ statusCode: number; ms: number }>((resolve, reject) => {
        const req = lib.request(
          { method: "HEAD", hostname: u.hostname, path: u.pathname + u.search, port: u.port || (u.protocol === "https:" ? 443 : 80), timeout: timeoutMs - 50 },
          (r) => {
            r.resume(); // drain
            resolve({ statusCode: r.statusCode || 0, ms: Date.now() - t0 });
          }
        );
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(new Error("socket timeout")); });
        req.end();
      });

      if (res.statusCode >= 200 && res.statusCode < 400) {
        return { status: "OK", meta: { url, code: res.statusCode, ms: res.ms } };
      }
      return { status: "WARN", msg: `bad status ${res.statusCode}`, meta: { url, code: res.statusCode, ms: res.ms } };
    },
  };
}

/* =========================
   Presentation helpers
   ========================= */

/** Produce rows for console/CSV. */
export function toRows(report: HealthReport): Array<Record<string, any>> {
  return report.results.map(r => ({
    id: r.id,
    status: r.status,
    ms: r.ms,
    msg: r.msg ?? "",
    ...(r.meta ?? {}),
  }));
}

export function printReport(report: HealthReport) {
  const head = `Health: ${report.service ?? "(service)"} — ${report.overall}  (ok=${report.ok} warn=${report.warn} crit=${report.crit})`;
  console.log(head);
  const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
  console.log(pad("ID", 22), pad("STATUS", 7), pad("ms", 6), "msg");
  console.log("-".repeat(60));
  for (const r of report.results) {
    console.log(pad(r.id, 22), pad(r.status, 7), pad(String(r.ms), 6), r.msg ?? "");
  }
}

/* =========================
   Default suite (optional)
   ========================= */

/**
 * Create a handy default suite:
 * - repo.writable (outputs/runs)
 * - env.required (if provided)
 * - config.json (if provided)
 * - net.ping (if provided)
 */
export function defaultSuite(opts?: {
  repoDir?: string;
  envRequired?: string[];
  configPath?: string;
  configRequireKeys?: string[];
  pingUrl?: string;
}) {
  const checks: Check[] = [];
  checks.push(repoWritableCheck(opts?.repoDir ?? "./outputs/runs"));
  if (opts?.envRequired?.length) checks.push(envVarsCheck(opts.envRequired));
  if (opts?.configPath) checks.push(configFileCheck(opts.configPath, opts.configRequireKeys ?? []));
  if (opts?.pingUrl) checks.push(httpPingCheck(opts.pingUrl));
  for (const c of checks) registerCheck(c);
  return checks;
}

/* =========================
   Example CLI entry (optional)
   ========================= */

if (import.meta.url === `file://${process.argv[1]}`) {
  // Quick demo: run default suite
  defaultSuite({
    repoDir: "./outputs/runs",
    envRequired: ["NODE_ENV"],
  });
  runAll({ service: "engine", parallel: true })
    .then(r => {
      printReport(r);
      process.exit(r.overall === "CRIT" ? 2 : r.overall === "WARN" ? 1 : 0);
    })
    .catch(e => {
      console.error("health run failed:", e);
      process.exit(3);
    });
}

/* =========================
   Default export
   ========================= */

export default {
  registerCheck,
  listChecks,
  runAll,
  repoWritableCheck,
  envVarsCheck,
  configFileCheck,
  httpPingCheck,
  toRows,
  printReport,
  defaultSuite,
};