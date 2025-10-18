// run/index.ts
// Self-contained runner (no external engine imports)

import * as fs from "fs";
import * as path from "path";

/* ========= Local lightweight repo ========= */
function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJSON(file: string, obj: any) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function readJSON(file: string, fallback: any = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function FSRepo(baseDir: string) {
  ensureDir(baseDir);
  return {
    save: (key: string, obj: any) => writeJSON(path.join(baseDir, key + ".json"), obj),
    load: (key: string) => readJSON(path.join(baseDir, key + ".json")),
    list: () =>
      fs.readdirSync(baseDir).filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, "")),
  };
}

/* ========= Stub strategy registry ========= */
// In real system, this would scan compiled strategies directory
const StrategyRegistry = {
  list: () => ["mean-reversion", "momentum", "carry"], // demo IDs
};

/* ========= Stub runStrategy ========= */
async function runStrategy(id: string, ctx: any) {
  // In real system: backtest logic, feed simulation, execution, PnL.
  console.log(`Simulating run for ${id}...`);
  const equityCurve = Array.from({ length: 20 }).map((_, i) => ({
    date: `2025-01-${i + 1}`,
    equity: 1000 + Math.random() * 50 - 25,
  }));
  return {
    strategy: id,
    equityCurve,
    benchmark: { id: "SPY", curve: equityCurve },
    factors: {},
    start: equityCurve[0].date,
    end: equityCurve[equityCurve.length - 1].date,
  };
}

/* ========= Stub makeContext ========= */
function makeContext(opts: any) {
  return { repo: opts.repo, portfolio: { cash: 1000, positions: [] } };
}

/* ========= Build Snapshot ========= */
function buildFullSnapshot(portfolio: any, opts: any) {
  return {
    kind: "full",
    ts: new Date().toISOString(),
    run: opts.runMeta,
    portfolio,
    equityCurve: opts.equityCurve,
    benchmark: opts.benchmark,
    factors: opts.factors,
    rfDaily: opts.rfDaily,
    daysPerYear: opts.daysPerYear,
  };
}

/* ========= Main ========= */
const outputsDir = path.resolve("./outputs/runs");
const repo = FSRepo(outputsDir);

async function main() {
  const strategies = StrategyRegistry.list();
  console.log(`Loaded ${strategies.length} strategies.`);

  for (const stratId of strategies) {
    console.log(`\n>>> Running strategy: ${stratId}`);

    const ctx = makeContext({ repo });
    const result = await runStrategy(stratId, ctx);

    const snapshot = buildFullSnapshot(ctx.portfolio, {
      equityCurve: result.equityCurve,
      benchmark: result.benchmark,
      factors: result.factors,
      rfDaily: 0.0001,
      daysPerYear: 252,
      runMeta: { id: stratId, start: result.start, end: result.end },
    });

    const outKey = `${stratId}-${Date.now()}`;
    repo.save(outKey, snapshot);
    console.log(`✅ Saved snapshot: ${outKey}`);
  }

  console.log("\nRepo contents:", repo.list());
}

/* ========= Entrypoint ========= */
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error("Fatal run error:", err);
    process.exit(1);
  });
}