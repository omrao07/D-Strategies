// backtester/commands/health.ts
// Health checks for your terminal + engine (zero deps, ESM/NodeNext friendly).

import * as fs from "fs";
import * as path from "path";

type Flags = Record<string, any>;

type Check = {
  name: string;
  level: "error" | "warn" | "ok";
  detail?: string;
};

const ok = (name: string, detail?: string): Check => ({ name, level: "ok", detail });
const warn = (name: string, detail?: string): Check => ({ name, level: "warn", detail });
const err = (name: string, detail?: string): Check => ({ name, level: "error", detail });

const isFile = (p?: string) => {
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
};
const isDir = (p?: string) => {
  try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; }
};

function humanBytes(n: number) {
  const u = ["B","KB","MB","GB","TB"];
  let i = 0; let x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(1)} ${u[i]}`;
}

/* ===== dynamic import helpers (runtime .js) ===== */
async function impLoader() {
  const url = new URL("../../config/loader.js", import.meta.url).href;
  return await import(url) as unknown as {
    loadConfig: (opts?: any) => Promise<any>;
    summarizeConfig: (cfg: any) => string;
    findConfigPath: (opts?: any) => string | null;
  };
}
async function impMaybe(rel: string) {
  try { return await import(new URL(rel, import.meta.url).href); }
  catch { return null; }
}

/* ===== core health runner ===== */
async function runHealth(flags: Flags): Promise<Check[]> {
  const out: Check[] = [];

  // 1) Load resolved config
  const L = await impLoader();
  let cfg: any;
  try {
    const file = flags.file ? path.resolve(process.cwd(), String(flags.file)) : L.findConfigPath() || undefined;
    cfg = await L.loadConfig({ file, ensureOutputDirs: false });
    out.push(ok("config.load", `mode=${cfg.mode}`));
  } catch (e: any) {
    out.push(err("config.load", e?.message || String(e)));
    return out; // without config, most checks are meaningless
  }

  // 2) Paths exist / writable
  const P = cfg.paths || {};
  const dirChecks: Array<[string, string|undefined]> = [
    ["paths.outputsDir", P.outputsDir],
    ["paths.runsDir", P.runsDir],
    ["paths.curvesDir", P.curvesDir],
    ["paths.summariesDir", P.summariesDir],
    ["paths.plotsDir", P.plotsDir],
  ];
  for (const [label, p] of dirChecks) {
    if (!p) { out.push(warn(label, "missing in config")); continue; }
    if (!isDir(p)) {
      try { fs.mkdirSync(p, { recursive: true }); out.push(warn(label, "created")); }
      catch (e: any) { out.push(err(label, `cannot create: ${e?.message || e}`)); }
    } else {
      // quick write check
      try {
        const test = path.join(p, ".health.tmp");
        fs.writeFileSync(test, "ok", "utf8");
        fs.unlinkSync(test);
        out.push(ok(label));
      } catch (e: any) {
        out.push(err(label, `not writable: ${e?.message || e}`));
      }
    }
  }

  // 3) Manifest file + parse + at least one strategy
  const manifestPath = P.manifestPath;
  if (!isFile(manifestPath)) {
    out.push(err("manifest.file", `not found at ${manifestPath}`));
  } else {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const items = Array.isArray(manifest) ? manifest : (manifest?.strategies || []);
      if (!items.length) out.push(warn("manifest.content", "no strategies listed"));
      else out.push(ok("manifest.content", `strategies=${items.length}`));

      // 4) Try importing first strategy module to ensure path correctness
      const first = items[0];
      if (first?.path) {
        try {
          const mod = await import(pathToFileUrl(resolveFromRepoRoot(first.path)).href);
          if (!mod || typeof mod !== "object") throw new Error("module loaded but has no exports");
          out.push(ok("strategy.import", first.id || first.path));
        } catch (e: any) {
          out.push(err("strategy.import", `${first?.id || first?.path}: ${e?.message || e}`));
        }
      }
    } catch (e: any) {
      out.push(err("manifest.parse", e?.message || e));
    }
  }

  // 5) DemoFeed + PaperBroker sanity (adapters exist and simple call paths)
  // (optional: they may not exist yet; treat as warn if absent)
  const DemoFeed = await impMaybe("../../adapters/data/demo-feed.js");
  if (!DemoFeed) out.push(warn("adapter.demoFeed", "not found"));
  else out.push(ok("adapter.demoFeed"));

  const PaperBroker = await impMaybe("../../adapters/brokers/paper-broker.js");
  if (!PaperBroker) out.push(warn("adapter.paperBroker", "not found"));
  else out.push(ok("adapter.paperBroker"));

  // 6) Engine core presence
  const Registry = await impMaybe("../../engine/registry.js");
  const Runner   = await impMaybe("../../engine/runner.js");
  const Context  = await impMaybe("../../engine/context.js");
  out.push(Registry ? ok("engine.registry") : err("engine.registry", "missing"));
  out.push(Runner   ? ok("engine.runner")   : err("engine.runner", "missing"));
  out.push(Context  ? ok("engine.context")  : err("engine.context", "missing"));

  // 7) Disk space (best-effort)
  try {
    const stat = fs.statSync(P.outputsDir);
    if (stat && stat.dev !== undefined) {
      // Best-effort: on POSIX, read from / (not perfect but gives a heads-up)
      const free = getRoughFreeSpace();
      if (free != null) {
        const minBytes = Math.max(100 * 1024 * 1024, Number(flags.minFreeBytes || 0)); // default 100MB
        if (free < minBytes) out.push(warn("disk.free", `low free space: ${humanBytes(free)} (< ${humanBytes(minBytes)})`));
        else out.push(ok("disk.free", humanBytes(free)));
      }
    }
  } catch { /* ignore */ }

  return out;
}

/* ===== helpers ===== */
function pathToFileUrl(p: string) {
  // Node ESM file URL util
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { pathToFileURL } = require("url");
  return pathToFileURL(p);
}
function resolveFromRepoRoot(p: string) {
  if (path.isAbsolute(p)) return p;
  return path.resolve(process.cwd(), p);
}
function getRoughFreeSpace(): number | null {
  // No cross-platform builtin. Try statvfs via /proc (Linux) or fallback null.
  try {
    // Attempt Linux procfs
    const m = fs.readFileSync("/proc/meminfo", "utf8");
    const match = m.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (match) return Number(match[1]) * 1024;
  } catch {/* ignore */}
  return null;
}

/* ===== pretty print ===== */
function printChecks(checks: Check[], verbose = false) {
  const sym = { ok: "✅", warn: "⚠️ ", error: "❌" } as const;
  for (const c of checks) {
    const line = `${sym[c.level]} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`;
    if (c.level === "ok") console.log(line);
    else if (c.level === "warn") console.warn(line);
    else console.error(line);
  }
  const errs = checks.filter(c => c.level === "error").length;
  const warns = checks.filter(c => c.level === "warn").length;
  console.log(`\nSummary: ${checks.length} checks — ${errs} error(s), ${warns} warning(s).`);
}

/* ===== public handler ===== */
export async function healthCheck(flags: Flags) {
  const checks = await runHealth(flags);
  printChecks(checks, Boolean(flags.verbose));
  if (checks.some(c => c.level === "error")) {
    process.exitCode = 1;
  }
}

export default { healthCheck };