// jobs/run_all_strategies.ts
// Batch job: run all strategies listed in strategies/_manifest.json

import fs from "fs";
import path from "path";

// dynamic imports (avoids TS2307 headaches)
async function imp(rel: string) {
  const url = new URL(rel, import.meta.url).href;
  return await import(url);
}

async function main() {
  const { StrategyRegistry } = await imp("../engine/registry.js");
  const { runStrategy }      = await imp("../engine/runner.js");
  const { makeContext }      = await imp("../engine/context.js");
  const { DemoFeed }         = await imp("../adapters/data/demo-feed.js");
  const { PaperBroker }      = await imp("../adapters/brokers/paper-broker.js");
  const { FSRepo }           = await imp("../engine/persistence/fs-repo.js");

  const registry = new StrategyRegistry();
  const repo = new FSRepo(path.resolve(process.cwd(), "outputs/runs"));

  const strategies = registry.list();
  console.log(`Found ${strategies.length} strategies in manifest`);

  for (const { id } of strategies) {
    console.log(`\n=== Running ${id} ===`);
    try {
      const strat = await registry.create(id);

      const ctx = makeContext({
        id,
        mode: "backtest",
        data: DemoFeed,
        broker: PaperBroker,
        start: "2024-01-01",
        end: "2024-12-31"
      });

      const res = await runStrategy(strat, ctx, {});
      await repo.saveRun(res);

      const curveLen = res.equityCurve?.length ?? 0;
      const metrics = res.metrics || {};

      console.log(`✔ Done ${id}: curve points=${curveLen}, metrics=${JSON.stringify(metrics)}`);

    } catch (err: any) {
      console.error(`✖ Error running ${id}:`, err?.message || err);
    }
  }

  console.log("\nAll strategies processed.");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});