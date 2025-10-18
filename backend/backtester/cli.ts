// backtester/cli.ts
// Terminal for engine + options. ESM/NodeNext.
// Run: npx ts-node --esm backtester/cli.ts <command> [--flags]

/* ============== Node stdlib ============== */
import * as fs from "fs";
import * as path from "path";

/* ============== Options engine ============== */
/* keep explicit .js for NodeNext runtime */

/* ============== Strategy engine core (safe to keep static) ============== */
import { StrategyRegistry } from "../engine/registry.js";
import { runStrategy } from "../engine/runner.js";
import { makeContext } from "../engine/context.js";

/* ========= Dynamically load JS adapters to avoid TS2307 =========
   These were red-underlined in your editor. By importing them *at runtime*
   via string URLs, TypeScript won’t try to type-resolve them. */
async function loadDemoFeed() {
  const u = new URL("../adapters/data/demo-feed.js", import.meta.url);
  const mod = await import(u.href);
  return mod.DemoFeed ?? mod.default ?? mod;
}
async function loadPaperBroker() {
  const u = new URL("../adapters/brokers/paper-broker.js", import.meta.url);
  const mod = await import(u.href);
  return mod.PaperBroker ?? mod.default ?? mod;
}
async function loadFSRepo() {
  const u = new URL("../engine/persistence/fs-repo.js", import.meta.url);
  const mod = await import(u.href);
  return mod.FSRepo ?? mod.default?.FSRepo ?? mod;
}

/* ============== Types/Utils ============== */
type Dict<T = any> = Record<string, T>;

const asNum = (x: any, d = 0) => (x === undefined ? d : (Number.isFinite(+x) ? +x : d));
const asStr = (x: any, d = "") => (typeof x === "string" ? x : d);
function need<T>(v: T | undefined, msg: string): T {
  if (v == null || (typeof v === "number" && !Number.isFinite(v as any))) {
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
  return v as T;
}

function readJSON<T = any>(p: string): T {
  const abs = path.resolve(process.cwd(), p);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function writeCSV(rows: Array<Record<string, number | string>>, outPath?: string) {
  const data =
    rows.length > 0
      ? [Object.keys(rows[0]).join(","), ...rows.map((r) => Object.keys(rows[0]).map((h) => String((r as any)[h] ?? "")).join(","))].join(
          "\n",
        ) + "\n"
      : "";
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(process.cwd(), outPath)), { recursive: true });
    fs.writeFileSync(outPath, data, "utf8");
  } else {
    process.stdout.write(data);
  }
}

function parseArgs(argv: string[]): { cmd?: string; flags: Dict<string | boolean> } {
  const [, , ...rest] = argv;
  const flags: Dict<string | boolean> = {};
  let cmd: string | undefined;
  for (const tok of rest) {
    if (tok.startsWith("--")) {
      const [k, ...vparts] = tok.slice(2).split("=");
      flags[k] = vparts.length ? vparts.join("=") : true;
    } else if (!cmd) cmd = tok;
    else {
      const kv = tok.split("=");
      if (kv.length === 2) flags[kv[0]] = kv[1];
    }
  }
  return { cmd, flags };
}

/* ============ Equity curve helpers (no deps) ============ */
type CurvePt = { date: string; equity: number };

function ensureDir(d: string) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
function normalizeCurve(curve: Array<{ date?: any; equity?: any }>): CurvePt[] {
  return (curve || [])
    .filter((p) => p && p.date != null && p.equity != null)
    .map((p) => ({ date: String(p.date), equity: Number(p.equity) }))
    .filter((p) => Number.isFinite(p.equity));
}
function saveEquityCSV(curve: CurvePt[], outPath: string) {
  const lines = ["date,equity", ...curve.map((p) => `${p.date},${p.equity}`)];
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
}
function printAsciiChart(values: number[], opts?: { height?: number; width?: number; leftPad?: number; title?: string }) {
  if (!values.length) {
    console.log("(no equity curve)");
    return;
  }
  const height = Math.max(3, Math.floor(opts?.height ?? 12));
  const width = Math.max(10, Math.floor(opts?.width ?? 64));
  const leftPad = " ".repeat(Math.max(0, Math.floor(opts?.leftPad ?? 2)));

  // downsample to width
  const n = values.length;
  const step = Math.max(1, Math.floor(n / width));
  const sampled: number[] = [];
  for (let i = 0; i < n; i += step) sampled.push(values[i]);

  const lo = Math.min(...sampled);
  const hi = Math.max(...sampled);
  const span = hi - lo || 1;

  const rows: string[] = [];
  if (opts?.title) rows.push(`${leftPad}${opts.title}`);
  for (let r = 0; r < height; r++) {
    let line = `${leftPad}|`;
    for (let x = 0; x < sampled.length; x++) {
      const v = sampled[x];
      const bucket = Math.round((hi - v) * (height - 1) / span);
      line += bucket === r ? "●" : " ";
    }
    rows.push(line);
  }
  rows.push(`${leftPad}+${"-".repeat(sampled.length)}`);
  console.log(rows.join("\n"));
}

/* ================ Help ==================== */
function printHelp() {
  const h = `
Usage:
  npx ts-node --esm backtester/cli.ts <command> [--flag=value ...]

Options engine:

  payoff
    --strategy=FILE.json [--from --to --steps --pctFrom --pctTo --out]

  strategy:summary
    --strategy=FILE.json

  price
    --model=bs|bachelier --right=C|P --S --K --T --r --q --vol

  margin:options
    --portfolio=FILE.json --underlyings=FILE.json [--greeks=FILE.json]
    --span.pricePct="-0.08,0.08" --span.volAbs="0" --span.method=bs|greeks --span.floor=NUM

Strategy engine:

  strategies:list
  strategies:info --id=<strategyId>
  strategies:run  --id=<strategyId> [--params='{"k":"v"}'] [--start=YYYY-MM-DD] [--end=YYYY-MM-DD] [--mode=backtest|paper|live]
`.trim();
  console.log(h);
}


/* ============== Strategy engine commands ============== */

const registry = new StrategyRegistry();

async function cmdStrategiesList() {
  const list = registry.list(); // [{id,modulePath}]
  console.log(JSON.stringify(list, null, 2));
}

async function cmdStrategiesInfo(flags: Dict) {
  const id = need(flags.id as string, "--id=... required");
  const meta = await registry.meta(id);
  console.log(JSON.stringify(meta, null, 2));
}

async function cmdStrategiesRun(flags: Dict) {
  const id = need(flags.id as string, "--id=... required");
  const params = flags.params ? JSON.parse(String(flags.params)) : {};
  const start = asStr(flags.start, "2024-01-01");
  const end = asStr(flags.end, "2024-12-31");
  const mode = (asStr(flags.mode, "backtest") as "backtest" | "paper" | "live");

  const strat = await registry.create(id);

  // Dynamically load adapters to avoid TS2307 path/type issues
  const DemoFeed = await loadDemoFeed();
  const PaperBroker = await loadPaperBroker();
  const FSRepo = await loadFSRepo();

  const ctx = makeContext({ id, mode, data: DemoFeed, broker: PaperBroker, start, end });

  const res = await runStrategy(strat, ctx, params);

  // Persist a copy of the run
  const repo = new FSRepo(path.resolve(process.cwd(), "outputs/runs"));
  await repo.saveRun({ ...res });

  // Graph + CSV if equityCurve present
  const curve = normalizeCurve(res.equityCurve || []);
  if (curve.length) {
    const series = curve.map((p) => p.equity);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const curvePath = path.resolve(process.cwd(), "outputs/curves", `${id.replace(/[^\w.-]+/g, "_")}-${stamp}.csv`);
    saveEquityCSV(curve, curvePath);
    console.log(`\nSaved equity curve CSV → ${curvePath}\n`);
    printAsciiChart(series, { height: 12, width: 80, title: `Equity: ${id} (${start} → ${end})` });
  } else {
    console.log("(no equityCurve returned by strategy)");
  }

  // Also print the JSON result (truncated)
  const { equityCurve, ...rest } = res as any;
  console.log("\nResult (truncated, without equityCurve):");
  console.log(JSON.stringify(rest, null, 2));
}

/* ===================== Router ===================== */
async function main() {
  const { cmd, flags } = parseArgs(process.argv);
  if (!cmd || (flags.help as boolean) || (flags.h as boolean)) return printHelp();

  try {
    switch (cmd) {
      /* options */
      case "payoff":
        await cmdPayoff(flags);
        break;
      case "strategy:summary":
        await cmdStrategySummary(flags);
        break;
      case "price":
        await cmdPrice(flags);
        break;
      case "margin:options":
        await cmdMarginOptions(flags);
        break;

      /* strategies */
      case "strategies:list":
        await cmdStrategiesList();
        break;
      case "strategies:info":
        await cmdStrategiesInfo(flags);
        break;
      case "strategies:run":
        await cmdStrategiesRun(flags);
        break;

      default:
        console.error(`Unknown command: ${cmd}\n`);
        printHelp();
        process.exit(1);
    }
  } catch (err: any) {
    console.error("Error:", err?.stack || err?.message || String(err));
    process.exit(1);
  }
}
main();
function cmdPayoff(flags: Dict<string | boolean>) {
  throw new Error("Function not implemented.");
}

function cmdStrategySummary(flags: Dict<string | boolean>) {
  throw new Error("Function not implemented.");
}

function cmdPrice(flags: Dict<string | boolean>) {
  throw new Error("Function not implemented.");
}

function cmdMarginOptions(flags: Dict<string | boolean>) {
  throw new Error("Function not implemented.");
}

