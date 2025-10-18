// persistence/fs/repo.ts

type Entity = {
  id: string
  [key: string]: any
}

class FileRepo<T extends Entity> {
  private path: string
  private cache: Map<string, T>

  constructor(path: string) {
    this.path = path
    this.cache = new Map()
    this.load()
  }

  private load(): void {
    try {
      const data = require("fs").readFileSync(this.path, "utf-8")
      const parsed: T[] = JSON.parse(data)
      parsed.forEach(item => this.cache.set(item.id, item))
    } catch {
      this.cache.clear()
    }
  }

  private persist(): void {
    const data = JSON.stringify(Array.from(this.cache.values()), null, 2)
    require("fs").writeFileSync(this.path, data, "utf-8")
  }

  all(): T[] {
    return Array.from(this.cache.values())
  }

  get(id: string): T | undefined {
    return this.cache.get(id)
  }

  save(entity: T): void {
    this.cache.set(entity.id, entity)
    this.persist()
  }

  delete(id: string): boolean {
    const removed = this.cache.delete(id)
    if (removed) this.persist()
    return removed
  }
}

export { FileRepo, Entity }
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

function saveEquityCSV(curve: CurvePt[], outPath: string) {
  const lines = ["date,equity", ...curve.map(p => `${p.date},${p.equity}`)];
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
}       