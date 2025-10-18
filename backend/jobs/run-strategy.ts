// jobs/run_strategy.ts
// Run ONE strategy by id from your manifest.
//
// Usage examples:
//   npx ts-node --esm jobs/run_strategy.ts --id=examples.mean_reversion
//   npx ts-node --esm jobs/run_strategy.ts --id=alpha.momo --start=2024-01-01 --end=2024-12-31 --params='{"symbol":"AAPL"}'
//   npx ts-node --esm jobs/run_strategy.ts --id=futures.curve --mode=paper
//
// Output:
//   • Saves JSON result → outputs/runs/
//   • Saves equity curve CSV → outputs/curves/
//   • Prints ASCII equity chart to terminal

import * as fs from "fs";
import * as path from "path";

/* ---------------- small utils ---------------- */
type Dict<T = any> = Record<string, T>;
const asNum = (x: any, d = 0) => (x === undefined ? d : (Number.isFinite(+x) ? +x : d));
const asStr = (x: any, d = "") => (typeof x === "string" ? x : d);
function need<T>(v: T | undefined, msg: string): T { if (v == null) { console.error(msg); process.exit(1); } return v; }

function parseArgs(argv: string[]) {
  const [, , ...rest] = argv;
  const flags: Dict<string | boolean> = {};
  for (const tok of rest) {
    if (tok.startsWith("--")) {
      const [k, ...v] = tok.slice(2).split("=");
      flags[k] = v.length ? v.join("=") : true;
    }
  }
  return flags;
}

function ensureDir(d: string) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

/* ---------------- equity helpers ---------------- */
type CurvePt = { date: string; equity: number };

function normalizeCurve(curve: Array<{ date?: any; equity?: any }> = []): CurvePt[] {
  return curve
    .filter(p => p && p.date != null && p.equity != null)
    .map(p => ({ date: String(p.date), equity: Number(p.equity) }))
    .filter(p => Number.isFinite(p.equity));
}

function saveEquityCSV(curve: CurvePt[], outPath: string) {
  const lines = ["date,equity", ...curve.map(p => `${p.date},${p.equity}`)];
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
}

function printAsciiChart(values: number[], opts?: { height?: number; width?: number; leftPad?: number; title?: string }) {
  if (!values.length) { console.log("(no equity curve)"); return; }
  const height = Math.max(3, Math.floor(opts?.height ?? 12));
  const width  = Math.max(10, Math.floor(opts?.width  ?? 80));
  const leftPad = " ".repeat(Math.max(0, Math.floor(opts?.leftPad ?? 2)));

  const n = values.length;
  const step = Math.max(1, Math.floor(n / width));
  const s: number[] = [];
  for (let i = 0; i < n; i += step) s.push(values[i]);

  const lo = Math.min(...s);
  const hi = Math.max(...s);
  const span = hi - lo || 1;

  const rows: string[] = [];
  if (opts?.title) rows.push(`${leftPad}${opts.title}`);
  for (let r = 0; r < height; r++) {
    let line = `${leftPad}|`;
    for (let x = 0; x < s.length; x++) {
      const bucket = Math.round((hi - s[x]) * (height - 1) / span);
      line += (bucket === r) ? "●" : " ";
    }
    rows.push(line);
  }
  rows.push(`${leftPad}+${"-".repeat(s.length)}`);
  console.log(rows.join("\n"));
}

/* ---------------- dynamic import helper ---------------- */
async function imp<T = any>(rel: string): Promise<T> {
  const url = new URL(rel, import.meta.url).href;
  const mod: any = await import(url);
  return mod as T;
}

/* ---------------- main ---------------- */
(async function main() {
  const flags = parseArgs(process.argv);

  const id    = need(flags["id"] as string, "--id=<strategyId> is required");
  const start = asStr(flags["start"], "2024-01-01");
  const end   = asStr(flags["end"],   "2024-12-31");
  const mode  = (asStr(flags["mode"], "backtest") as "backtest" | "paper" | "live");
  const params = flags["params"] ? JSON.parse(String(flags["params"])) : {};

  // Load engine + adapters lazily to avoid TS/ESM hassles
  const { StrategyRegistry } = await imp<any>("../engine/registry.js");
  const { runStrategy }      = await imp<any>("../engine/runner.js");
  const { makeContext }      = await imp<any>("../engine/context.js");
  const { DemoFeed }         = await imp<any>("../adapters/data/demo-feed.js");
  const { PaperBroker }      = await imp<any>("../adapters/brokers/paper-broker.js");
  const { FSRepo }           = await imp<any>("../engine/persistence/fs-repo.js");

  const reg = new StrategyRegistry();
  const strat = await reg.create(id);

  const ctx = makeContext({ id, mode, data: DemoFeed, broker: PaperBroker, start, end });

  const res = await runStrategy(strat, ctx, params);

  // Persist JSON
  const runsDir = path.resolve(process.cwd(), "outputs/runs");
  ensureDir(runsDir);
  const runFile = path.join(runsDir, `${id.replace(/[^\w.-]+/g, "_")}-${Date.now()}.json`);
  fs.writeFileSync(runFile, JSON.stringify(res, null, 2), "utf8");
  console.log(`Saved run JSON → ${runFile}`);

  // CSV + ASCII chart
  const curve = normalizeCurve(res.equityCurve || []);
  if (curve.length) {
    const curvesDir = path.resolve(process.cwd(), "outputs/curves");
    const csvFile = path.join(curvesDir, `${id.replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
    saveEquityCSV(curve, csvFile);
    console.log(`Saved equity curve CSV → ${csvFile}\n`);
    printAsciiChart(curve.map(p => p.equity), { height: 12, width: 80, title: `Equity: ${id} (${start} → ${end})` });
  } else {
    console.log("(no equityCurve returned by strategy)");
  }

  // Print trimmed result
  const { equityCurve, ...rest } = res as any;
  console.log("\nResult (truncated, without equityCurve):");
  console.log(JSON.stringify(rest, null, 2));
})().catch(err => {
  console.error("Fatal:", err?.stack || err?.message || err);
  process.exit(1);
});