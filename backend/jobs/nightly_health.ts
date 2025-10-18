// jobs/nightly health.ts
// Nightly platform health checks: data, storage, broker, strategies, risk.
// ESM/NodeNext, zero deps. Run via: node --loader ts-node/esm jobs/nightly\ health.ts

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as https from "https";

type Align = "left" | "right" | "center";
function renderTable(
  rows: (string | number | boolean | null | undefined)[][],
  opts: { headers?: string[]; align?: Align[]; maxColWidth?: number; pad?: number; border?: boolean } = {}
): string {
  const { headers, align, maxColWidth = 48, pad = 2, border = true } = opts;
  const allRows = headers ? [headers, ...rows] : rows;
  if (!allRows.length) return "";
  const sRows = allRows.map(r => r.map(x => (x == null ? "" : String(x))));
  for (let r = 0; r < sRows.length; r++) for (let c = 0; c < sRows[r].length; c++) {
    if (sRows[r][c].length > maxColWidth) sRows[r][c] = sRows[r][c].slice(0, maxColWidth - 1) + "…";
  }
  const nCols = Math.max(...sRows.map(r => r.length));
  const colW = Array(nCols).fill(0);
  for (const r of sRows) for (let c = 0; c < nCols; c++) colW[c] = Math.max(colW[c], (r[c] ?? "").length);
  const colA: Align[] = []; for (let c = 0; c < nCols; c++) colA[c] = align?.[c] ?? "left";
  const fmt = (t: string, w: number, a: Align) => {
    const k = w - t.length;
    if (a === "right") return " ".repeat(k) + t;
    if (a === "center") { const l = Math.floor(k / 2); return " ".repeat(l) + t + " ".repeat(k - l); }
    return t + " ".repeat(k);
  };
  const lines: string[] = [];
  const sep = border ? "+" + colW.map(w => "-".repeat(w + pad)).join("+") + "+" : "";
  if (border) lines.push(sep);
  for (let r = 0; r < sRows.length; r++) {
    const cells: string[] = [];
    for (let c = 0; c < nCols; c++) cells.push(fmt(sRows[r][c] ?? "", colW[c], colA[c]));
    lines.push(border ? "| " + cells.join(" ".repeat(pad) + "| ") + " |" : cells.join(" ".repeat(pad)));
    if (r === 0 && headers && border) lines.push(sep);
  }
  if (border) lines.push(sep);
  return lines.join("\n");
}

/* ========= Types ========= */

type HealthLevel = "ok" | "warn" | "fail";
type HealthRecord = {
  area: string;
  check: string;
  status: HealthLevel;
  detail?: string;
  ms?: number;
  meta?: Record<string, any>;
};

type BrokerLike = {
  getAccount?: () => Promise<any>;
  getPositions?: () => Promise<Record<string, { symbol: string; qty: number; avgPx: number }>>;
  getOpenOrders?: () => Promise<any[]>;
  submit?: (o: any) => Promise<any>;
};

type NightlyOptions = {
  // Feeds to ping (HTTP GET)
  feeds?: { name: string; url: string; timeoutMs?: number }[];
  // Files/folders that must exist (data dirs, snapshots, cfg)
  paths?: string[];
  // Strategy registry files (manifest/tags)
  strategyFiles?: string[];
  // Where to write artifacts
  outDir?: string;            // default: ./reports/nightly
  writeCsv?: boolean;         // default: true
  writeJson?: boolean;        // default: true
  // Broker factory (paper or live)
  makeBroker?: () => Promise<BrokerLike>;
  // Fail the run if any warn? default: false
  strict?: boolean;
};

/* ========= Small utils ========= */

const isFiniteNum = (x: any) => typeof x === "number" && Number.isFinite(x);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function httpPing(urlStr: string, timeoutMs = 6000): Promise<{ status: number; ms: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const url = new URL(urlStr);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        timeout: timeoutMs,
        headers: { "user-agent": "nightly-health/0.1", "accept": "*/*" }
      },
      (res) => {
        res.resume(); // discard body
        res.on("end", () => resolve({ status: res.statusCode || 0, ms: Date.now() - start }));
        res.on("close", () => resolve({ status: res.statusCode || 0, ms: Date.now() - start }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { try { req.destroy(new Error("timeout")); } catch {} });
    req.end();
  });
}

function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }

function writeCSV(file: string, rows: (string | number)[][], headers?: string[]) {
  const esc = (s: any) => {
    const t = String(s ?? "");
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
  const lines = [];
  
  fs.writeFileSync(file, lines.join("\n"), "utf8");
}

function writeJSON(file: string, obj: any) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}

/* ========= Checks ========= */

async function checkFeeds(feeds: NightlyOptions["feeds"]): Promise<HealthRecord[]> {
  const out: HealthRecord[] = [];
  for (const f of feeds || []) {
    try {
      const { status, ms } = await httpPing(f.url, f.timeoutMs ?? 6000);
      const ok = status >= 200 && status < 400;
      out.push({
        area: "feeds",
        check: f.name,
        status: ok ? "ok" : "warn",
        detail: `HTTP ${status}`,
        ms
      });
    } catch (e: any) {
      out.push({ area: "feeds", check: f.name, status: "fail", detail: e?.message || "error" });
    }
  }
  return out;
}

async function checkPaths(pathsList: string[]): Promise<HealthRecord[]> {
  const out: HealthRecord[] = [];
  for (const p of pathsList || []) {
    try {
      const exists = fs.existsSync(p);
      let stat: fs.Stats | undefined;
      if (exists) stat = fs.statSync(p);
      out.push({
        area: "storage",
        check: p,
        status: exists ? "ok" : "fail",
        detail: exists ? (stat?.isDirectory() ? "dir" : "file") : "missing"
      });
    } catch (e: any) {
      out.push({ area: "storage", check: p, status: "fail", detail: e?.message || "error" });
    }
  }
  return out;
}

async function checkStrategies(files: string[]): Promise<HealthRecord[]> {
  const out: HealthRecord[] = [];
  for (const f of files || []) {
    try {
      const raw = fs.readFileSync(f, "utf8");
      // naive validation: JSON parse if .json; otherwise ensure not empty
      if (f.endsWith(".json")) {
        JSON.parse(raw);
        out.push({ area: "strategies", check: path.basename(f), status: "ok", detail: "json-parse-ok" });
      } else {
        out.push({ area: "strategies", check: path.basename(f), status: raw.trim() ? "ok" : "warn", detail: raw.trim() ? "present" : "empty" });
      }
    } catch (e: any) {
      out.push({ area: "strategies", check: path.basename(f), status: "fail", detail: e?.message || "read-error" });
    }
  }
  return out;
}

async function checkBroker(makeBroker?: () => Promise<BrokerLike>): Promise<HealthRecord[]> {
  const out: HealthRecord[] = [];
  if (!makeBroker) return out;
  let broker: BrokerLike | undefined;
  try {
    broker = await makeBroker();
  } catch (e: any) {
    out.push({ area: "broker", check: "init", status: "fail", detail: e?.message || "init-error" });
    return out;
  }
  // account
  try {
    const t0 = Date.now();
    const acct = await broker.getAccount?.();
    out.push({ area: "broker", check: "account", status: acct ? "ok" : "warn", ms: Date.now() - t0, detail: acct ? "ok" : "empty" });
  } catch (e: any) {
    out.push({ area: "broker", check: "account", status: "fail", detail: e?.message || "error" });
  }
  // positions
  try {
    const t0 = Date.now();
    const pos = await broker.getPositions?.();
    const n = pos ? Object.keys(pos).length : 0;
    out.push({ area: "broker", check: "positions", status: pos ? "ok" : "warn", ms: Date.now() - t0, detail: `${n} symbols` });
  } catch (e: any) {
    out.push({ area: "broker", check: "positions", status: "fail", detail: e?.message || "error" });
  }
  // orders list
  try {
    const t0 = Date.now();
    const orders = await broker.getOpenOrders?.();
    out.push({ area: "broker", check: "openOrders", status: orders ? "ok" : "warn", ms: Date.now() - t0, detail: `${orders?.length ?? 0} open` });
  } catch (e: any) {
    out.push({ area: "broker", check: "openOrders", status: "fail", detail: e?.message || "error" });
  }
  return out;
}

async function checkRiskHooks(): Promise<HealthRecord[]> {
  // Very light sanity: ensure module loads (if present) and compose a no-op manager.
  const out: HealthRecord[] = [];
  try {
    // path may vary; adjust if needed or skip silently
    const p = path.resolve(process.cwd(), "engine/risk-hooks.js");
    if (!fs.existsSync(p)) {
      out.push({ area: "risk", check: "risk-hooks.js", status: "warn", detail: "not-found (optional)" });
      return out;
    }
    const mod: any = await import(pathToFileUrl(p));
    if (mod && mod.composeRiskHooks && mod.makeRiskCtx) {
      const manager = mod.composeRiskHooks([], mod.makeRiskCtx({}));
      out.push({ area: "risk", check: "compose", status: manager?.guardSubmit ? "ok" : "warn", detail: "loaded" });
    } else {
      out.push({ area: "risk", check: "exports", status: "warn", detail: "unexpected-exports" });
    }
  } catch (e: any) {
    out.push({ area: "risk", check: "load", status: "fail", detail: e?.message || "import-error" });
  }
  return out;
}

function pathToFileUrl(p: string) {
  let f = path.resolve(p).replace(/\\/g, "/");
  if (!f.startsWith("/")) f = "/" + f;
  return `file://${f}`;
}

/* ========= Runner ========= */

export async function runNightlyHealth(options: NightlyOptions = {}) {
  const startedAt = new Date();
  const records: HealthRecord[] = [];

  // Defaults
  const feeds = options.feeds ?? [
    { name: "GitHub", url: "https://api.github.com/rate_limit" },
    { name: "Cloudflare", url: "https://cloudflare.com" },
  ];
  const pathsList = options.paths ?? [
    "config",
    "engine",
    "strategies",
    "reports",
  ];
  const stratFiles = options.strategyFiles ?? [
    "strategies/tags.json",
    "strategies/manifest.json",
  ];
  const outDir = options.outDir ?? path.join("reports", "nightly");

  // 1) Feeds
  records.push(...await checkFeeds(feeds));

  // 2) Storage/paths
  records.push(...await checkPaths(pathsList));

  // 3) Strategies manifest/tags
  records.push(...await checkStrategies(stratFiles));

  // 4) Broker
  records.push(...await checkBroker(options.makeBroker));

  // 5) Risk hooks (optional)
  records.push(...await checkRiskHooks());

  // Summaries
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const r of records) (counts as any)[r.status]++;

  // Console table
  const rows = records.map(r => [
    r.area,
    r.check,
    r.status.toUpperCase(),
    r.detail ?? "",
    isFiniteNum(r.ms) ? `${r.ms}ms` : ""
  ]);
  console.log(renderTable(rows, {
    headers: ["Area", "Check", "Status", "Detail", "Latency"],
    align: ["left", "left", "left", "left", "right"],
    border: true
  }));
  console.log(
    `\nStarted: ${startedAt.toISOString()}   Ended: ${new Date().toISOString()}   ` +
    `OK: ${counts.ok}   WARN: ${counts.warn}   FAIL: ${counts.fail}`
  );

  // Artifacts
  ensureDir(outDir);
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  if (options.writeJson !== false) writeJSON(path.join(outDir, `nightly-${stamp}.json`), { startedAt, records, counts });
  if (options.writeCsv !== false) writeCSV(
    path.join(outDir, `nightly-${stamp}.csv`),
    records.map(r => [r.area, r.check, r.status, r.detail ?? "", r.ms ?? ""]),
    ["area", "check", "status", "detail", "ms"]
  );

  const hardFail = options.strict ? (counts.warn + counts.fail > 0) : (counts.fail > 0);
  if (hardFail) process.exitCode = 1;
  return { records, counts, outDir };
}

/* ========= CLI ========= */

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (const a of argv.slice(2)) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      out[k] = v === undefined ? true : v;
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const args = parseArgs(process.argv);
    const strict = !!args.strict;

    await runNightlyHealth({ strict });
  })();
}
   