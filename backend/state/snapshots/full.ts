// snapshots/full.ts
// Full portfolio snapshot generator (positions + metrics + metadata).
// Zero external deps, pure TypeScript.

export type Position = {
  symbol: string;
  quantity: number;
  price: number;
  value: number;
  sector?: string;
  assetClass?: string;
};

export type SnapshotMeta = {
  ts: number;             // epoch ms
  asOf: string;           // ISO date
  strategy: string;
  runId?: string;
};

export type RiskStats = {
  grossExposure: number;
  netExposure: number;
  leverage: number;
  concentration: number;     // max single position weight
  longCount: number;
  shortCount: number;
};

export type Snapshot = {
  meta: SnapshotMeta;
  positions: Position[];
  totalValue: number;
  cash: number;
  pnl: number;
  weights: Record<string, number>;
  risk: RiskStats;
};

//////////////////////// Helpers ////////////////////////

const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
const abs = (x: number) => (x < 0 ? -x : x);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function calcWeights(positions: Position[], total: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (total === 0) return out;
  for (const p of positions) out[p.symbol] = p.value / total;
  return out;
}

function calcRisk(positions: Position[], total: number): RiskStats {
  const gross = sum(positions.map(p => abs(p.value)));
  const net = sum(positions.map(p => p.value));
  const leverage = total ? gross / total : 0;
  const weights = positions.map(p => (total ? abs(p.value / total) : 0));
  const concentration = weights.length ? Math.max(...weights) : 0;
  const longCount = positions.filter(p => p.quantity > 0).length;
  const shortCount = positions.filter(p => p.quantity < 0).length;
  return { grossExposure: gross, netExposure: net, leverage, concentration, longCount, shortCount };
}

//////////////////////// Main API ////////////////////////

/**
 * Build a full portfolio snapshot.
 * @param opts.positions list of positions (symbol, qty, price)
 * @param opts.cash cash balance
 * @param opts.prevValue portfolio value at last snapshot
 * @param opts.strategy strategy identifier
 * @param opts.runId optional run/session id
 */
export function buildFullSnapshot(opts: {
  positions: { symbol: string; quantity: number; price: number; sector?: string; assetClass?: string }[];
  cash: number;
  prevValue?: number;
  strategy: string;
  runId?: string;
}): Snapshot {
  const { positions: raw, cash, prevValue = 0, strategy, runId } = opts;
  const ts = Date.now();
  const asOf = new Date(ts).toISOString();

  // compute position values
  const positions: Position[] = raw.map(r => ({
    ...r,
    value: (r.quantity ?? 0) * (r.price ?? 0)
  }));

  const totalValue = cash + sum(positions.map(p => p.value));
  const weights = calcWeights(positions, totalValue);
  const risk = calcRisk(positions, totalValue);

  const pnl = prevValue ? totalValue - prevValue : 0;

  return {
    meta: { ts, asOf, strategy, runId },
    positions,
    totalValue,
    cash,
    pnl,
    weights,
    risk
  };
}

//////////////////////// Example (run directly) ////////////////////////

// Node/ts-node direct-run demo
declare const process: any;
if (typeof process !== "undefined" && process?.argv?.[1] && import.meta.url === `file://${process.argv[1]}`) {
  const snap = buildFullSnapshot({
    positions: [
      { symbol: "AAPL", quantity: 50, price: 180, sector: "Tech" },
      { symbol: "TSLA", quantity: -20, price: 250, sector: "Auto" },
      { symbol: "GLD", quantity: 10, price: 190, assetClass: "Commodities" }
    ],
    cash: 5000,
    prevValue: 20000,
    strategy: "demo_strat",
    runId: "test-run-1"
  });
  console.log(JSON.stringify(snap, null, 2));
}