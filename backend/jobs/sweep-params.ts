// jobs/sweep_params.ts
// Sweep over parameter ranges for one strategy.
// Usage:
//   npx ts-node --esm jobs/sweep_params.ts --id=examples.mean_reversion --param=lookback:5,10,20 --param=threshold:0.5,1.0
//
// This will run the strategy with all combinations of lookback × threshold.

import fs from "fs";
import path from "path";

type Dict<T = any> = Record<string, T>;
function asStr(x: any, d = "") { return typeof x === "string" ? x : d; }
function need<T>(v: T | undefined, msg: string): T { if (v == null) { console.error(msg); process.exit(1); } return v; }

function parseArgs(argv: string[]) {
  const [, , ...rest] = argv;
  const flags: Dict<string | string[]> = {};
  for (const tok of rest) {
    if (tok.startsWith("--")) {
      const [k, ...v] = tok.slice(2).split("=");
      if (k === "param") {
        const [name, values] = v.join("=").split(":");
        if (!flags.params) flags.params = [];
        (flags.params as string[]).push(`${name}:${values}`);
      } else {
        flags[k] = v.length ? v.join("=") : "true";
      }
    }
  }
  return flags;
}

function ensureDir(d: string) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function cartesian<T>(arrs: T[][]): T[][] {
  return arrs.reduce((a, b) => a.flatMap(d => b.map(e => [...d, e])), [[]] as T[][]);
}

/* ---------------- dynamic import helper ---------------- */
async function imp<T = any>(rel: string): Promise<T> {
  const url = new URL(rel, import.meta.url).href;
  return await import(url);
}

/* ---------------- main ---------------- */
(async function main() {
  const flags = parseArgs(process.argv);
  const id    = need(flags["id"] as string, "--id=<strategyId> required");
  const start = asStr(flags["start"], "2024-01-01");
  const end   = asStr(flags["end"],   "2024-12-31");
  const mode  = (asStr(flags["mode"], "backtest") as "backtest" | "paper" | "live");

  // Parse param sweeps
  const sweepDefs = (flags.params as string[] | undefined) || [];
  const paramGrid: Dict<any[]> = {};
  for (const def of sweepDefs) {
    const [name, values] = def.split(":");
    paramGrid[name] = values.split(",").map(v => {
      const num = Number(v);
      return isNaN(num) ? v : num;
    });
  }

  const names = Object.keys(paramGrid);
  const combos = cartesian(names.map(n => paramGrid[n]));
  console.log(`Sweeping ${combos.length} parameter combos for ${id}`);

  // Load engine + adapters
  const { StrategyRegistry } = await imp<any>("../engine/registry.js");
  const { runStrategy }      = await imp<any>("../engine/runner.js");
  const { makeContext }      = await imp<any>("../engine/context.js");
  const { DemoFeed }         = await imp<any>("../adapters/data/demo-feed.js");
  const { PaperBroker }      = await imp<any>("../adapters/brokers/paper-broker.js");
  const { FSRepo }           = await imp<any>("../engine/persistence/fs-repo.js");

  const reg = new StrategyRegistry();
  const strat = await reg.create(id);
  const repo = new FSRepo(path.resolve(process.cwd(), "outputs/runs"));

  let idx = 0;
  for (const combo of combos) {
    const params: Dict = {};
    names.forEach((n, i) => params[n] = combo[i]);

    console.log(`\n[${++idx}/${combos.length}] Running ${id} with ${JSON.stringify(params)}`);

    const ctx = makeContext({ id, mode, data: DemoFeed, broker: PaperBroker, start, end });

    try {
      const res = await runStrategy(strat, ctx, params);
      await repo.saveRun({ ...res, params });

      console.log(`✔ Done: metrics = ${JSON.stringify(res.metrics || {})}`);
    } catch (err: any) {
      console.error(`✖ Error with params ${JSON.stringify(params)}: ${err?.message || err}`);
    }
  }

  console.log("\nSweep finished.");
})();