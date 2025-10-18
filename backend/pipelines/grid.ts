// pipelines/grid.ts
// Grid pipeline: run a strategy across a parameter grid.
// Usage:
//   npx ts-node --esm pipelines/grid.ts \
//     --id=examples.mean_reversion \
//     --param=lookback:5,10,20 \
//     --param=threshold:0.5,1.0 \
//     --start=2024-01-01 --end=2024-12-31 \
//     --concurrency=3 --out=outputs/summaries/grid-meanrev.csv
//
// What it does:
//  • loads strategy by id (manifest/registry)
//  • builds cartesian product of provided --param specs
//  • runs with DemoFeed + PaperBroker
//  • persists each run (FSRepo) + collects metrics
//  • writes a summary CSV (params + metrics) to --out

import * as fs from "fs";
import * as path from "path";

/* ---------------- small utils ---------------- */
type Dict<T = any> = Record<string, T>;
const asStr = (x: any, d = "") => (typeof x === "string" ? x : d);
const asNum = (x: any, d = 0) => (x === undefined ? d : (Number.isFinite(+x) ? +x : d));
function need<T>(v: T | undefined, msg: string): T { if (v == null) { console.error(msg); process.exit(1); } return v; }

function parseArgs(argv: string[]) {
  const [, , ...rest] = argv;
  const flags: Dict<string | string[] | string | boolean> = {};
  for (const tok of rest) {
    if (!tok.startsWith("--")) continue;
    const [key, ...vparts] = tok.slice(2).split("=");
    const val = vparts.length ? vparts.join("=") : "true";
    if (key === "param") {
        if (!Array.isArray(flags.params)) flags.params = [];
    } else {
      flags[key] = val;
    }
  }
  return flags;
}

function ensureDir(d: string) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function cartesian<T>(arrs: T[][]): T[][] {
  return arrs.reduce<T[][]>((a, b) => a.flatMap(d => b.map(e => [...d, e])), [[]]);
}

function parseParamGrid(specs: string[] | undefined): { names: string[]; combos: any[][] } {
  const grid: Dict<any[]> = {};
  for (const spec of specs || []) {
    // name:v1,v2,v3
    const [name, valuesStr] = spec.split(":");
    const vals = (valuesStr ?? "").split(",").filter(Boolean).map(v => {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    });
    grid[name] = vals;
  }
  const names = Object.keys(grid);
  const combos = cartesian(names.map(n => grid[n]));
  return { names, combos };
}

function toCSV(rows: Array<Record<string, any>>): string {
  if (!rows.length) return "";
    const headers = Array.from(new Set(rows.flatMap(r => Object.keys(r))));
  const lines = [
    headers.join(","),
    ...rows.map(r => headers.map(h => {
      const v = r[h];
      if (v == null) return "";
      if (typeof v === "object") return JSON.stringify(v).replace(/"/g, '""');
      return String(v);
    }).join(","))
  ];
  return lines.join("\n") + "\n";
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
  const out   = asStr(flags["out"], path.resolve(process.cwd(), "outputs", "summaries", `grid-${id.replace(/[^\w.-]+/g,"_")}.csv`));
  const conc  = Math.max(1, Math.floor(asNum(flags["concurrency"], 2)));

  const { names, combos } = parseParamGrid(flags.params as string[] | undefined);
  console.log(`Grid for ${id}: ${combos.length} combos (${names.join(", ") || "no params"})`);

  ensureDir(path.dirname(out));
  ensureDir(path.resolve(process.cwd(), "outputs", "runs"));

  // Engine + adapters
  const { StrategyRegistry } = await imp<any>("../engine/registry.js");
  const { runStrategy }      = await imp<any>("../engine/runner.js");
  const { makeContext }      = await imp<any>("../engine/context.js");
  const { DemoFeed }         = await imp<any>("../adapters/data/demo-feed.js");
  const { PaperBroker }      = await imp<any>("../adapters/brokers/paper-broker.js");
  const { FSRepo }           = await imp<any>("../engine/persistence/fs-repo.js");

  const registry = new StrategyRegistry();
  const stratFactory = await registry.create(id);
  const repo = new FSRepo(path.resolve(process.cwd(), "outputs/runs"));

  // Worker to run a single combo
  async function runOne(combo: any[]) {
    const params: Dict = {};
    names.forEach((n, i) => params[n] = combo[i]);

    const ctx = makeContext({ id, mode, data: DemoFeed, broker: PaperBroker, start, end });
    const res = await runStrategy(stratFactory, ctx, params);
    await repo.saveRun({ ...res, params });

    const metrics = res.metrics || {};
    return { params, metrics, startedAt: res.startedAt, finishedAt: res.finishedAt, durationMs: res.durationMs };
  }

  // Concurrency control
  const results: Array<Record<string, any>> = [];
  let idx = 0;

  const queue = combos.slice();
  const workers = Array.from({ length: Math.min(conc, queue.length || 1) }, async () => {
    while (queue.length) {
      const combo = queue.shift()!;
      const i = ++idx;
      console.log(`[${i}/${combos.length}] ${id} params=${JSON.stringify(combo)}`);
      try {
        const r = await runOne(combo);
        results.push({ ...Object.fromEntries(names.map((n, i2) => [n, combo[i2]])), ...r.metrics, durationMs: r.durationMs });
        console.log(`  ✔ done metrics=${JSON.stringify(r.metrics)}`);
      } catch (err: any) {
        console.error(`  ✖ failed: ${err?.message || err}`);
        results.push({ ...Object.fromEntries(names.map((n, i2) => [n, combo[i2]])), error: String(err?.message || err) });
      }
    }
  });

  await Promise.all(workers);

  // Write summary CSV
  const csv = toCSV(results);
  fs.writeFileSync(out, csv, "utf8");
  console.log(`\nSummary written → ${out}`);
})();