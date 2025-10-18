// backtester/commands/config.ts
// Handlers for config:show and config:check (zero-deps validation)

import * as fs from "fs";
import * as path from "path";

type Flags = Record<string, any>;

/* ========== small IO helpers ========== */
const isFile = (p: string) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};
const readJSON = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));

/* ========== dynamic imports (runtime .js) ========== */
async function impLoader() {
  const url = new URL("../../config/loader.js", import.meta.url).href;
  return await import(url) as unknown as {
    loadConfig: (opts?: any) => Promise<any>;
    summarizeConfig: (cfg: any) => string;
    findConfigPath: (opts?: any) => string | null;
  };
}

/* ========== tiny validators (no JSON-schema lib) ========== */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function vString(v: any) { return typeof v === "string" && v.length > 0; }
function vEnum<T extends string>(v: any, vals: readonly T[]) { return vals.includes(v as T); }
function vDateISO(v: any) { return typeof v === "string" && DATE_RE.test(v); }

export type CheckIssue = { path: string; message: string; level: "error" | "warn" };
function err(path: string, message: string): CheckIssue { return { path, message, level: "error" }; }
function warn(path: string, message: string): CheckIssue { return { path, message, level: "warn" }; }

function validateConfigShape(cfg: any): CheckIssue[] {
  const issues: CheckIssue[] = [];

  // mode
  if (!vEnum(cfg?.mode, ["backtest", "paper", "live"])) {
    issues.push(err("mode", "must be one of: backtest | paper | live"));
  }

  // paths
  const p = cfg?.paths ?? {};
  if (!vString(p.outputsDir)) issues.push(err("paths.outputsDir", "required string"));
  if (!vString(p.manifestPath)) issues.push(err("paths.manifestPath", "required string"));
  // optional: ensure dirs exist (warn)
  if (vString(p.outputsDir) && !fs.existsSync(p.outputsDir)) {
    issues.push(warn("paths.outputsDir", "directory does not exist (will be created on demand)"));
  }

  // data
  const d = cfg?.data ?? {};
  if (!vString(d.feed)) issues.push(err("data.feed", "required string"));
  if (!vString(d.timeframe)) issues.push(err("data.timeframe", "required string"));
  if (!vDateISO(d.start)) issues.push(err("data.start", "must be YYYY-MM-DD"));
  if (!vDateISO(d.end)) issues.push(err("data.end", "must be YYYY-MM-DD"));
  if (vDateISO(d.start) && vDateISO(d.end) && d.end < d.start) {
    issues.push(err("data.end", "must be >= data.start"));
  }

  // broker
  const b = cfg?.broker ?? {};
  if (!vString(b.adapter)) issues.push(err("broker.adapter", "required string"));
  if (!vString(b.currency)) issues.push(err("broker.currency", "required string (e.g., USD)"));

  // risk
  const r = cfg?.risk ?? {};
  if (typeof r.daysPerYear !== "number") issues.push(err("risk.daysPerYear", "required number (e.g., 252)"));

  // exec
  const e = cfg?.exec ?? {};
  if (typeof e.concurrency !== "number" || e.concurrency < 1) {
    issues.push(err("exec.concurrency", "must be a number ≥ 1"));
  }

  return issues;
}

/* ========== pretty printers ========== */
function printIssues(issues: CheckIssue[]) {
  if (!issues.length) {
    console.log("✅ Config looks good.");
    return;
  }
  const errs = issues.filter(i => i.level === "error");
  const warns = issues.filter(i => i.level === "warn");
  for (const i of errs)  console.error(`✖ ${i.path}: ${i.message}`);
  for (const i of warns) console.warn(`⚠ ${i.path}: ${i.message}`);
  if (errs.length) console.error(`\n${errs.length} error(s), ${warns.length} warning(s).`);
  else console.log(`\n0 errors, ${warns.length} warning(s).`);
}

/* ========== public command handlers ========== */

/** config:show — resolve & print a concise summary. */
export async function configShow(flags: Flags) {
  const L = await impLoader();
  const file = flags.file ? path.resolve(process.cwd(), String(flags.file)) : L.findConfigPath() || undefined;

  const cfg = await L.loadConfig({
    file,
    ensureOutputDirs: Boolean(flags.ensureDirs ?? true),
    override: {}
  });

  console.log(L.summarizeConfig(cfg));
}

/** config:check — resolve, validate shape, optionally print file path. */
export async function configCheck(flags: Flags) {
  const L = await impLoader();
  const file = flags.file ? path.resolve(process.cwd(), String(flags.file)) : L.findConfigPath() || undefined;

  const cfg = await L.loadConfig({ file, ensureOutputDirs: false });

  if (flags.show) {
    console.log("Resolved config file:", file ?? "(auto/defaults only)");
  }

  const issues = validateConfigShape(cfg);

  // extra existence checks (non-fatal)
  const manifest = cfg?.paths?.manifestPath;
  if (vString(manifest) && !isFile(manifest)) {
    issues.push(err("paths.manifestPath", `file not found: ${manifest}`));
  }

  printIssues(issues);

  // Non-zero exit on errors when used as standalone
  if (issues.some(i => i.level === "error")) {
    process.exitCode = 1;
  }
}

/* default export (optional convenience) */
export default { configShow, configCheck };