// config/loader.ts

type Config = {
  env: string
  version: string
  debug: boolean
  [key: string]: any
}

const defaults: Config = {
  env: "development",
  version: "0.0.1",
  debug: false,
}

function parseEnvValue(value: string | undefined): any {
  if (value === undefined) return undefined
  if (value === "true") return true
  if (value === "false") return false
  if (!isNaN(Number(value))) return Number(value)
  return value
}

function loadConfig(overrides: Partial<Config> = {}): Config {
  const envConfig: Partial<Config> = {}
  for (const key in process.env) {
    const normalizedKey = key.toLowerCase()
    envConfig[normalizedKey] = parseEnvValue(process.env[key])
  }

  return {
    ...defaults,
    ...envConfig,
    ...overrides,
  }
}

export { loadConfig, Config }
// backtester/cli.ts
import fs from "fs";
import path from "path";

/* ============ Arg parsing (no deps) ============ */
type Dict<T = any> = Record<string, T>;
function asStr(x: any, d = "") { return typeof x === "string" ? x : d; }
function asNum(x: any, d = 0) { return x === undefined ? d : (Number.isFinite(+x) ? +x : d); }
function need<T>(v: T | undefined, msg: string): T { if (v == null) { console.error(msg); process.exit(1); } return v; }

function parseArgs(argv: string[]) {
  const [, , ...rest] = argv;
  let cmd = "";
  const flags: Dict<string | string[] | string | boolean> = {};
  for (const tok of rest) {
    if (tok.startsWith("--")) {
      const [key, ...vparts] = tok.slice(2).split("=");
      const val = vparts.length ? vparts.join("=") : "true";
      if (key === "param") {
        if (!Array.isArray(flags.params)) flags.params = [];
        (flags.params as string[]).push(val);
      } else {
        flags[key] = val;
      }
    } else if (!cmd) cmd = tok;
  }
  return { cmd, flags };
}

/* ============ File utils (no deps) ============ */
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
  if (!values.length) { console.log("(no equity curve)"); return; }
  const height = Math.max(3, Math.floor(opts?.height ?? 12));
  const width = Math.max(10, Math.floor(opts?.width ?? 80));
  const leftPad = " ".repeat(Math.max(0, Math.floor(opts?.leftPad ?? 2)));

  const n = values.length;
  const step = Math.max(1, Math.floor   (n / width));
  const s: number[] = [];
  for (let i = 0; i < n; i += step) s.push(values[i]);

  const lo = Math.min(...s);
  const hi = Math.max(...s);
  const span = hi - lo || 1;

  const rows: string[] = [];
  if (opts?.title) rows.push(`${leftPad}${opts.title}`);
  for (let r = 0; r < height; r++) {
    let line = `${leftPad}|`;
    for (let x = 0; x < s.length; x++) {
      const bucket = Math.round((hi - s[x]) * (height - 1) / span);
      line += (bucket === r) ? "●" : " ";
    }
    rows.push(line);
  }
  rows.push(`${leftPad}+${"-".repeat(s.length)}`);
  console.log(rows.join("\n"));
}

