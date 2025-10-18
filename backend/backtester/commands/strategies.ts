// backtester/commands/sstrategies.ts
// Strategy commands: list / info / run (zero deps, ESM-friendly)

import * as fs from "fs";
import * as path from "path";

type Flags = Record<string, any>;

const asStr  = (x: any, d = "") => (typeof x === "string" ? x : d);
const asBool = (x: any, d = false) => {
  if (typeof x === "boolean") return x;
  if (typeof x === "string") return ["1","true","yes","y","on"].includes(x.toLowerCase());
  return d;
};
const need = <T>(v: T | undefined, msg: string): T => { if (v == null || v === ("" as any)) { console.error(msg); process.exit(1); } return v; };
const ensureDir = (d: string) => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); };

// dynamic imports (.js at runtime)
async function imp(rel: string) { return await import(new URL(rel, import.meta.url).href); }

async function impPlot() {
  const url = new URL("../../libs/plot.js", import.meta.url).href;
  return await import(url) as unknown as {
    asciiChart: (series: number[] | any, opts?: any) => string;
    saveEquityCSV: (curve: Array<{date:string; equity:number}>, outPath: string) => string | void;
  };
}

/* ---------------- strategies:list ---------------- */
export async function strategiesList(_flags: Flags) {
  const { StrategyRegistry } = await imp("../../engine/registry.js");
  const reg = new StrategyRegistry();
  const list = reg.list();

  if (!list.length) { console.log("(no strategies found)"); return; }

  const maxId = Math.max(...list.map((x: any) => (x.id || "").length));
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);

  console.log("Available strategies:");
  for (const s of list) {
    console.log(`  ${pad(String(s.id), maxId)}  ${s.path ?? ""}`);
  }
}

/* ---------------- strategies:info ---------------- */
export async function strategiesInfo(flags: Flags) {
  const id = need(asStr(flags.id), "--id=<strategyId> is required");
  const { StrategyRegistry } = await imp("../../engine/registry.js");
  const reg = new StrategyRegistry();
  const meta = await reg.meta(id);
  console.log(JSON.stringify(meta, null, 2));
}

/* ---------------- strategies:run ---------------- */
export async function strategiesRun(flags: Flags) {
  const id    = need(asStr(flags.id), "--id=<strategyId> is required");
  const start = asStr(flags.start, "2024-01-01");
  const end   = asStr(flags.end,   "2024-12-31");
  const mode  = asStr(flags.mode,  "backtest");
  const params = flags.params ? JSON.parse(String(flags.params)) : {};
  const showChart = asBool(flags.chart ?? "true", true);

  const { StrategyRegistry } = await imp("../../engine/registry.js");
  const { runStrategy }      = await imp("../../engine/runner.js");
  const { makeContext }      = await imp("../../engine/context.js");
  const { DemoFeed }         = await imp("../../adapters/data/demo-feed.js");
  const { PaperBroker }      = await imp("../../adapters/brokers/paper-broker.js");
  const { FSRepo }           = await imp("../../engine/persistence/fs-repo.js");
  const Plot                 = await impPlot();

  const reg = new StrategyRegistry();
  const strat = await reg.create(id);

  const ctx = makeContext({ id, mode, data: DemoFeed, broker: PaperBroker, start, end });
  const res = await runStrategy(strat, ctx, params);

  // persist run JSON
  const runsDir = path.resolve(process.cwd(), "outputs", "runs");
  ensureDir(runsDir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runFile = path.join(runsDir, `${ts}.${id.replace(/[^\w.-]+/g, "_")}.json`);
  fs.writeFileSync(runFile, JSON.stringify(res, null, 2), "utf8");
  console.log(`Saved run JSON → ${runFile}`);

  // equity CSV + ASCII chart
  const curve = Array.isArray(res.equityCurve) ? res.equityCurve : [];
  if (curve.length) {
    const curvesDir = path.resolve(process.cwd(), "outputs", "curves");
    ensureDir(curvesDir);
    const csvPath = path.join(curvesDir, `${id.replace(/[^\w.-]+/g, "_")}-${ts}.csv`);
    Plot.saveEquityCSV(curve.map(p => ({ date: String(p.date), equity: Number(p.equity) })), csvPath);
    console.log(`Saved equity curve CSV → ${csvPath}\n`);

    if (showChart) {
      const series = curve.map(p => Number(p.equity)).filter(Number.isFinite);
      console.log(
        Plot.asciiChart(series, { title: `Equity: ${id} (${start} → ${end})`, height: 12, width: 80 })
      );
    }
  } else {
    console.log("(no equityCurve returned by strategy)");
  }

  // concise tail
  const { equityCurve, ...tail } = res;
  console.log("\nResult (truncated):");
  console.log(JSON.stringify(tail, null, 2));
}

/* optional default export */
export default { strategiesList, strategiesInfo, strategiesRun };