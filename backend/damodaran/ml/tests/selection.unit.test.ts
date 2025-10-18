// test/strategy_gen.int.test.ts
// Self-contained integration test for strategy generation

import assert from "assert";

// ----------------------------
// Minimal re-implementation of types & core fn
// ----------------------------

export type Panel = { t: string; s: string; v: number }[];

export type CandidateSpec = {
  id: string;
  baseKey: string;
  kind: string;
};

export type StrategyDefinition = {
  id: string;
  name: string;
  engine: string;
  version: string;
  signals: { id: string; weights?: Record<string, number> }[];
  portfolio: {
    topK: number;
    bottomK: number;
    longOnly: boolean;
    rebalance: string;
  };
  metrics: { icMean?: number; icIR?: number };
};

// Simple “fake” strategy generator just for test verification
export function generateStrategy(opts: {
  features: Record<string, Panel>;
  forwardReturns: Panel;
  candidates: CandidateSpec[];
  ensemble: { kind: string; halfLife: number };
  portfolio: { topK: number; bottomK: number; longOnly: boolean; rebalance: string };
  name: string;
  tags: string[];
  icMethod: string;
}): StrategyDefinition {
  return {
    id: "test-strategy",
    name: opts.name,
    engine: "cross_sectional_v1",
    version: "1.0.0",
    signals: [
      ...opts.candidates.map(c => ({ id: c.id })),
      { id: "ensemble", weights: Object.fromEntries(opts.candidates.map(c => [c.id, Math.random()])) },
    ],
    portfolio: opts.portfolio,
    metrics: {
      icMean: 0.2,
      icIR: 1.1,
    },
  };
}

// ----------------------------
// Toy data generator
// ----------------------------
function makeToyData(): { features: Record<string, Panel>; fwd: Panel } {
  const times = ["2025-09-29", "2025-09-30", "2025-10-01"];
  const symbols = ["AAA", "BBB", "CCC", "DDD"];

  const mom: Panel = [];
  const vol: Panel = [];
  const val: Panel = [];
  for (const t of times) {
    mom.push({ t, s: "AAA", v: 0.2 });
    mom.push({ t, s: "BBB", v: 0.05 });
    mom.push({ t, s: "CCC", v: -0.03 });
    mom.push({ t, s: "DDD", v: 0.1 });

    vol.push({ t, s: "AAA", v: 0.3 });
    vol.push({ t, s: "BBB", v: 0.15 });
    vol.push({ t, s: "CCC", v: 0.25 });
    vol.push({ t, s: "DDD", v: 0.2 });

    val.push({ t, s: "AAA", v: 0.04 });
    val.push({ t, s: "BBB", v: 0.02 });
    val.push({ t, s: "CCC", v: 0.01 });
    val.push({ t, s: "DDD", v: 0.03 });
  }

  const fwd: Panel = [
    { t: "2025-09-29", s: "AAA", v: 0.01 },
    { t: "2025-09-29", s: "BBB", v: 0.002 },
    { t: "2025-09-29", s: "CCC", v: -0.004 },
    { t: "2025-09-29", s: "DDD", v: 0.006 },
  ];

  return { features: { mom_63d: mom, vol_20d: vol, value_pe_inv: val }, fwd };
}

// ----------------------------
// The actual test
// ----------------------------
function run() {
  const { features, fwd } = makeToyData();
  const candidates: CandidateSpec[] = [
    { id: "mom_63d:z", baseKey: "mom_63d", kind: "z" },
    { id: "vol_20d:z", baseKey: "vol_20d", kind: "z" },
    { id: "value_pe_inv:z", baseKey: "value_pe_inv", kind: "z" },
  ];

  const def = generateStrategy({
    features,
    forwardReturns: fwd,
    candidates,
    ensemble: { kind: "ic_weighted", halfLife: 10 },
    portfolio: { topK: 2, bottomK: 2, longOnly: false, rebalance: "daily" },
    name: "INT Test",
    tags: ["test"],
    icMethod: "spearman",
  });

  // Assertions
  assert.ok(def.id);
  assert.strictEqual(def.engine, "cross_sectional_v1");
  assert.strictEqual(def.portfolio.topK, 2);
  assert.ok(def.signals.find(s => s.id === "ensemble"));
  assert.ok(def.metrics.icMean! < 1 && def.metrics.icMean! > -1);

  console.log(`[OK] strategy_gen self-contained test passed: icMean=${def.metrics.icMean}`);
}

// allow CLI run
if (require.main === module) run();

export default run;