// reporting/md.ts
// Markdown helpers + full snapshot report builder (no deps, ESM/NodeNext safe)

import * as fs from "fs";
import * as path from "path";

/* =========================
   Structural types (loose)
   ========================= */

export type EquityPt = { date: string; equity: number };
export type DDPoint  = { date: string; dd: number };

export type Metrics = {
  points: number; totalReturn: number; cagr: number; volAnn: number;
  sharpe: number; sortino: number; maxDD: number; calmar: number;
  hitRate?: number; avgWin?: number; avgLoss?: number; skew?: number; kurt?: number;
  start?: string; end?: string;
};

export type ExposureResult = { beta: number; alphaAnn: number; r2: number; n: number };
export type MultiFactorResult = { betas: Record<string, number>; alphaAnn: number; r2: number; n: number };
export type VarEs = { var: number; es: number; mean: number; sd: number; cl: number; method?: string };
export type CorrMatrix = { keys: string[]; matrix: number[][] };

export type FullSnapshot = {
  kind: "full" | string;
  ts?: string;
  run?: { id?: string; start?: string; end?: string; points?: number };
  portfolio?: any;
  metrics?: Metrics;
  drawdownSeries?: DDPoint[];
  exposure?: { vsBenchmark?: ExposureResult & { benchmarkId?: string }; multi?: MultiFactorResult & { factorKeys?: string[] } };
  varEs?: { parametric?: VarEs; historical?: VarEs; cl?: number };
  correlations?: CorrMatrix;
  equityCurve?: EquityPt[];
};

/* =========================
   Small formatters
   ========================= */

const pct = (x?: number) => Number.isFinite(x as number) ? ((x as number) * 100).toFixed(2) + "%" : "—";
const num = (x?: number, d = 2) => Number.isFinite(x as number) ? (x as number).toFixed(d) : "—";

/* =========================
   Core Markdown helpers
   ========================= */

/** Build a GitHub-flavored Markdown table. */
export function mdTable(rows: Array<Record<string, any>>, columns?: string[]): string {
  if (!rows || rows.length === 0) return "_(no data)_";
  const cols = (columns && columns.length)
    ? columns
    : (() => { const s = new Set<string>(); rows.forEach(r => Object.keys(r).forEach(k => s.add(k))); return [...s]; })();

  const head = `| ${cols.join(" | ")} |`;
  const rule = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map(r => `| ${cols.map(c => String(r[c] ?? "")).join(" | ")} |`).join("\n");
  return [head, rule, body].join("\n");
}

/** Definition list style (key: value) block. */
export function mdKVs(rows: Array<{ key: string; value: any }>): string {
  if (!rows.length) return "_(no items)_";
  return rows.map(r => `- **${r.key}**: ${r.value}`).join("\n");
}

/* =========================
   Tiny ASCII charts (sparklines)
   ========================= */

const BARS = "▁▂▃▄▅▆▇█";
function scale01(v: number, min: number, max: number) {
  if (max === min) return 0.5;
  return (v - min) / (max - min);
}
function spark(values: number[], width = 64): string {
  if (!values.length) return "";
  // downsample if needed
  const step = Math.max(1, Math.floor(values.length / width));
  const sampled: number[] = [];
  for (let i = 0; i < values.length; i += step) sampled.push(values[i]);
  const min = Math.min(...sampled), max = Math.max(...sampled);
  return sampled.map(v => BARS[Math.min(7, Math.max(0, Math.round(scale01(v, min, max) * 7)))]).join("");
}

export function equitySpark(curve?: EquityPt[], width = 64): string {
  if (!curve?.length) return "_(no curve)_";
  return "`" + spark(curve.map(p => Number(p.equity)), width) + "`";
}
export function ddSpark(dd?: DDPoint[], width = 64): string {
  if (!dd?.length) return "_(no dd)_";
  return "`" + spark(dd.map(p => Number(p.dd)), width) + "`";
}

/* =========================
   Sections
   ========================= */

export function metricsSection(m?: Metrics): string {
  if (!m) return "### Metrics\n\n_(no metrics)_";
  const rows = [
    { metric: "Total Return", value: pct(m.totalReturn) },
    { metric: "CAGR", value: pct(m.cagr) },
    { metric: "Vol (ann.)", value: pct(m.volAnn) },
    { metric: "Sharpe", value: num(m.sharpe) },
    { metric: "Sortino", value: num(m.sortino) },
    { metric: "Max Drawdown", value: pct(m.maxDD) },
    { metric: "Calmar", value: num(m.calmar) },
    { metric: "Hit Rate", value: pct(m.hitRate) },
    { metric: "Avg Win", value: pct(m.avgWin) },
    { metric: "Avg Loss", value: pct(m.avgLoss) },
    { metric: "Skew", value: num(m.skew) },
    { metric: "Kurtosis", value: num(m.kurt) },
    { metric: "Points", value: num(m.points, 0) },
    { metric: "Start", value: m.start ?? "—" },
    { metric: "End", value: m.end ?? "—" },
  ];
  return "### Metrics\n\n" + mdTable(rows, ["metric", "value"]);
}

export function exposureSection(exp?: { vsBenchmark?: ExposureResult & { benchmarkId?: string }; multi?: MultiFactorResult & { factorKeys?: string[] } }): string {
  if (!exp?.vsBenchmark && !exp?.multi) return "### Exposure\n\n_(no exposure)_";
  const blocks: string[] = ["### Exposure\n"];
  if (exp?.vsBenchmark) {
    const e = exp.vsBenchmark;
    blocks.push(
      `**CAPM vs Benchmark ${e.benchmarkId ?? ""}**\n\n` +
      mdTable([
        { metric: "Beta", value: num(e.beta) },
        { metric: "Alpha (ann.)", value: pct(e.alphaAnn) },
        { metric: "R²", value: num(e.r2) },
        { metric: "N", value: num(e.n, 0) },
      ], ["metric", "value"])
    );
  }
  if (exp?.multi) {
    const m = exp.multi;
    blocks.push(
      `\n**Multi-Factor**\n\n` +
      mdTable([
        { metric: "Alpha (ann.)", value: pct(m.alphaAnn) },
        { metric: "R²", value: num(m.r2) },
        { metric: "N", value: num(m.n, 0) },
      ], ["metric", "value"])
    );
    const betaRows = Object.entries(m.betas).map(([k, v]) => ({ factor: k, beta: num(v) }));
    if (betaRows.length) blocks.push("\n**Betas**\n\n" + mdTable(betaRows, ["factor", "beta"]));
  }
  return blocks.join("\n");
}

export function varEsSection(v?: { parametric?: VarEs; historical?: VarEs; cl?: number }): string {
  if (!v || (!v.parametric && !v.historical)) return "### VaR / ES\n\n_(no VaR/ES)_";
  const rows: Array<Record<string, any>> = [];
  if (v.parametric) rows.push({ method: "Parametric", cl: pct(v.parametric.cl), VaR: pct(v.parametric.var), ES: pct(v.parametric.es), mean: pct(v.parametric.mean), sd: pct(v.parametric.sd) });
  if (v.historical) rows.push({ method: "Historical", cl: pct(v.historical.cl), VaR: pct(v.historical.var), ES: pct(v.historical.es), mean: pct(v.historical.mean), sd: pct(v.historical.sd) });
  return "### VaR / ES\n\n" + mdTable(rows, ["method","cl","VaR","ES","mean","sd"]);
}

export function corrSection(c?: CorrMatrix): string {
  if (!c?.keys?.length) return "### Correlations\n\n_(no correlations)_";
  const cols = ["key", ...c.keys];
  const rows = c.keys.map((rowKey, i) => {
    const r: Record<string, any> = { key: rowKey };
    c.keys.forEach((colKey, j) => { r[colKey] = num(c.matrix[i][j]); });
    return r;
  });
  return "### Correlations\n\n" + mdTable(rows, cols);
}

export function curvesSection(equity?: EquityPt[], dd?: DDPoint[]): string {
  const parts: string[] = ["### Curves\n"];
  if (equity?.length) parts.push(`**Equity**  ${equitySpark(equity)}\n`);
  if (dd?.length) parts.push(`**Drawdown** ${ddSpark(dd)}\n`);
  if (parts.length === 1) parts.push("_(no curve data)_");
  return parts.join("\n");
}

/* =========================
   Report builder
   ========================= */

export function renderSnapshotMarkdown(snap: FullSnapshot): string {
  const title = `# Run Report${snap.run?.id ? ` — ${snap.run.id}` : ""}`;
  const meta = [
    snap.ts ? `ts: ${snap.ts}` : "",
    snap.run?.start && snap.run?.end ? `window: ${snap.run.start} → ${snap.run.end}` : "",
    snap.run?.points ? `points: ${snap.run.points}` : "",
  ].filter(Boolean).join(" · ");

  const equity: EquityPt[] | undefined =
    snap.equityCurve ??
    (snap.portfolio && Array.isArray((snap.portfolio as any).equityCurve)
      ? (snap.portfolio as any).equityCurve
      : undefined);

  const sections = [
    meta ? `_${meta}_\n` : "",
    curvesSection(equity, snap.drawdownSeries),
    metricsSection(snap.metrics),
    exposureSection(snap.exposure),
    varEsSection(snap.varEs),
    corrSection(snap.correlations),
  ].filter(Boolean).join("\n\n");

  return [title, "", sections, ""].join("\n");
}

/* =========================
   Persistence
   ========================= */

export function writeSnapshotMarkdown(snap: FullSnapshot, outPath: string): string {
  const abs = path.resolve(outPath.endsWith(".md") ? outPath : path.join(outPath, "report.md"));
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(abs, renderSnapshotMarkdown(snap), "utf8");
  return abs;
}

/* =========================
   Default export
   ========================= */

export default {
  mdTable,
  mdKVs,
  equitySpark,
  ddSpark,
  curvesSection,
  metricsSection,
  exposureSection,
  varEsSection,
  corrSection,
  renderSnapshotMarkdown,
  writeSnapshotMarkdown,
};