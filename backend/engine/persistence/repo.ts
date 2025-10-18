// persistence/repo.ts

type Entity = {
  id: string
  [key: string]: any
}

interface Repo<T extends Entity> {
  all(): T[]
  get(id: string): T | undefined
  save(entity: T): void
  delete(id: string): boolean
}

class MemoryRepo<T extends Entity> implements Repo<T> {
  private cache: Map<string, T> = new Map()

  all(): T[] {
    return Array.from(this.cache.values())
  }

  get(id: string): T | undefined {
    return this.cache.get(id)
  }

  save(entity: T): void {
    this.cache.set(entity.id, entity)
  }

  delete(id: string): boolean {
    return this.cache.delete(id)
  }
}

export { Repo, MemoryRepo, Entity }
// pipelines/single.ts
// Run ONE strategy with optional params, save outputs, optional CSV + ASCII chart.
//
// Usage:
//   npx ts-node --esm pipelines/single.ts \
//     --id=examples.mean_reversion \
//     --start=2024-01-01 --end=2024-12-31 \
//     --params='{"symbol":"SPY","lookback":20}' \
//     --saveCsv=true --chart=true
//
// Flags:
//   --id=<strategyId>           (required)
//   --start=YYYY-MM-DD          default 2024-01-01
//   --end=YYYY-MM-DD            default 2024-12-31
//   --mode=backtest|paper|live  default backtest
//   --params='{"k":"v"}'        JSON string of params
//   --saveCsv=true|false        write outputs/curves/<id>-<ts>.csv (default true)
//   --chart=true|false          print ASCII chart to terminal (default true)

import * as fs from "fs";
import * as path from "path";

/* ---------------- small utils ---------------- */
type Dict<T = any> = Record<string, T>;
const asNum = (x: any, d = 0) => (x === undefined ? d : (Number.isFinite(+x) ? +x : d));
const asStr = (x: any, d = "") => (typeof x === "string" ? x : d);
function asBool(x: any, d = false) {
  if (typeof x === "boolean") return x;
  if (typeof x === "string") return ["1","true","yes","y","on"].includes(x.toLowerCase());
  return d;
}
function need<T>(v: T | undefined, msg: string): T { if (v == null) { console.error(msg); process.exit(1); } return v; }

function parseArgs(argv: string[]) {
  const [, , ...rest] = argv;
  const flags: Dict<string | boolean> = {};
  for (const tok of rest) {
    if (!tok.startsWith("--")) continue;
    const [k, ...v] = tok.slice(2).split("=");
    flags[k] = v.length ? v.join("=") : true;
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

function saveEquityCSV(curve: CurvePt[], outPath: string    ) {
  const lines = ["date,equity", ...curve.map(p => `${p.date},${p.equity}`)];
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
}   