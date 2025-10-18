// reporting/html.ts
// Minimal HTML report generator with inline CSS + SVG charts.
// Zero deps, ESM/NodeNext safe.

import * as fs from "fs";
import * as path from "path";

/* =========================
   Types (loose, structural)
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
export type VarEs = { var: number; es: number; mean: number; sd: number; cl: number; method: string };
export type CorrMatrix = { keys: string[]; matrix: number[][] };

export type FullSnapshot = {
  kind: "full" | string;
  ts?: string;
  run?: { id?: string; start?: string; end?: string; points?: number };
  portfolio?: any;
  metrics?: Metrics;
  drawdownSeries?: DDPoint[];
  exposure?: {
    vsBenchmark?: ExposureResult & { benchmarkId?: string };
    multi?: MultiFactorResult & { factorKeys?: string[] };
  };
  varEs?: { parametric?: VarEs; historical?: VarEs; cl?: number };
  correlations?: CorrMatrix;
  equityCurve?: EquityPt[];                       // tolerate both shapes
  benchmark?: { id?: string; curve?: EquityPt[] } // optional
};

/* =========================
   Utilities
   ========================= */

const esc = (s: any): string =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const fmtPct = (x?: number) => (Number.isFinite(x as number) ? ((x as number) * 100).toFixed(2) + "%" : "—");
const fmtNum = (x?: number, d = 2) => (Number.isFinite(x as number) ? (x as number).toFixed(d) : "—");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/* =========================
   Table rendering
   ========================= */

export function table(
  rows: Array<Record<string, any>>,
  columns?: string[]
): string {
  if (!rows || rows.length === 0) return `<div class="empty">No data</div>`;

  const cols: string[] = (columns && columns.length)
    ? columns
    : (() => {
        const set = new Set<string>();
        for (const r of rows) for (const k of Object.keys(r)) set.add(k);
        return Array.from(set);
      })();

  const th = cols.map(c => `<th>${esc(c)}</th>`).join("");
  const body = rows
    .map(r => `<tr>${cols.map(c => `<td>${esc(r[c] ?? "")}</td>`).join("")}</tr>`)
    .join("");

  return `<table class="grid"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

/* =========================
   SVG charts (inline)
   ========================= */

type XY = { x: number; y: number };

function linePath(points: XY[]): string {
  if (points.length === 0) return "";
  const p0 = points[0];
  let d = `M${p0.x},${p0.y}`;
  for (let i = 1; i < points.length; i++) d += `L${points[i].x},${points[i].y}`;
  return d;
}

function scale(domainMin: number, domainMax: number, rangeMin: number, rangeMax: number) {
  const d = domainMax - domainMin || 1;
  const r = rangeMax - rangeMin;
  return (v: number) => rangeMin + ((v - domainMin) / d) * r;
}

export function equitySVG(curve: EquityPt[] | undefined, w = 720, h = 240, pad = 16): string {
  if (!curve || curve.length === 0) return `<svg width="${w}" height="${h}"></svg>`;
  const xs = curve.map((_, i) => i);
  const ys = curve.map(p => Number(p.equity));
  const sx = scale(Math.min(...xs), Math.max(...xs), pad, w - pad);
  const sy = scale(Math.min(...ys), Math.max(...ys), h - pad, pad);
  const pts: XY[] = xs.map((i, k) => ({ x: +sx(i).toFixed(2), y: +sy(ys[k]).toFixed(2) }));
  const path = linePath(pts);
  return `
<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Equity curve">
  <rect x="0" y="0" width="${w}" height="${h}" class="bg"/>
  <path d="${path}" class="line"/>
</svg>`;
}

export function ddSVG(dd: DDPoint[] | undefined, w = 720, h = 160, pad = 16): string {
  if (!dd || dd.length === 0) return `<svg width="${w}" height="${h}"></svg>`;
  const xs = dd.map((_, i) => i);
  const ys = dd.map(p => Number(p.dd)); // negative numbers
  const sx = scale(Math.min(...xs), Math.max(...xs), pad, w - pad);
  const sy = scale(Math.min(...ys), 0, h - pad, pad);
  const pts: XY[] = xs.map((i, k) => ({ x: +sx(i).toFixed(2), y: +sy(ys[k]).toFixed(2) }));
  const path = linePath(pts);
  return `
<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Drawdown">
  <rect x="0" y="0" width="${w}" height="${h}" class="bg"/>
  <path d="${path}" class="line dd"/>
</svg>`;
}

/* =========================
   Sections
   ========================= */

function section(title: string, html: string) {
  return `<section><h2>${esc(title)}</h2>${html}</section>`;
}

function metricsSection(m?: Metrics) {
  if (!m) return section("Metrics", `<div class="empty">No metrics</div>`);
  const rows = [
    { metric: "Total Return", value: fmtPct(m.totalReturn) },
    { metric: "CAGR", value: fmtPct(m.cagr) },
    { metric: "Vol (ann.)", value: fmtPct(m.volAnn) },
    { metric: "Sharpe", value: fmtNum(m.sharpe) },
    { metric: "Sortino", value: fmtNum(m.sortino) },
    { metric: "Max Drawdown", value: fmtPct(m.maxDD) },
    { metric: "Calmar", value: fmtNum(m.calmar) },
    { metric: "Hit Rate", value: fmtPct(m.hitRate) },
    { metric: "Avg Win", value: fmtPct(m.avgWin) },
    { metric: "Avg Loss", value: fmtPct(m.avgLoss) },
    { metric: "Skew", value: fmtNum(m.skew) },
    { metric: "Kurtosis", value: fmtNum(m.kurt) },
    { metric: "Points", value: fmtNum(m.points, 0) },
    { metric: "Start", value: esc(m.start ?? "—") },
    { metric: "End", value: esc(m.end ?? "—") },
  ];
  return section("Metrics", table(rows, ["metric", "value"]));
}

function exposureSection(exp?: {
  vsBenchmark?: ExposureResult & { benchmarkId?: string };
  multi?: MultiFactorResult & { factorKeys?: string[] };
}) {
  const blocks: string[] = [];

  if (exp?.vsBenchmark) {
    const e = exp.vsBenchmark;
    blocks.push(
      `<h3>CAPM vs Benchmark ${esc(e.benchmarkId ?? "")}</h3>` +
        table(
          [
            { metric: "Beta", value: fmtNum(e.beta) },
            { metric: "Alpha (ann.)", value: fmtPct(e.alphaAnn) },
            { metric: "R²", value: fmtNum(e.r2) },
            { metric: "N", value: fmtNum(e.n, 0) },
          ],
          ["metric", "value"]
        )
    );
  }

  if (exp?.multi) {
    const m = exp.multi;
    const betas = Object.entries(m.betas).map(([k, v]) => ({ factor: k, beta: fmtNum(v) }));
    blocks.push(
      `<h3>Multi-Factor</h3>` +
        table(
          [
            { metric: "Alpha (ann.)", value: fmtPct(m.alphaAnn) },
            { metric: "R²", value: fmtNum(m.r2) },
            { metric: "N", value: fmtNum(m.n, 0) },
          ],
          ["metric", "value"]
        ) +
        (betas.length ? `<h4>Betas</h4>${table(betas, ["factor", "beta"])}` : "")
    );
  }

  return section("Exposure", blocks.length ? blocks.join("") : `<div class="empty">No exposure data</div>`);
}

function varEsSection(v?: { parametric?: VarEs; historical?: VarEs; cl?: number }) {
  if (!v || (!v.parametric && !v.historical)) return section("VaR / ES", `<div class="empty">No VaR/ES</div>`);
  const rows: Array<Record<string, any>> = [];
  if (v.parametric)
    rows.push({
      method: "Parametric",
      cl: fmtPct(v.parametric.cl),
      VaR: fmtPct(v.parametric.var),
      ES: fmtPct(v.parametric.es),
      mean: fmtPct(v.parametric.mean),
      sd: fmtPct(v.parametric.sd),
    });
  if (v.historical)
    rows.push({
      method: "Historical",
      cl: fmtPct(v.historical.cl),
      VaR: fmtPct(v.historical.var),
      ES: fmtPct(v.historical.es),
      mean: fmtPct(v.historical.mean),
      sd: fmtPct(v.historical.sd),
    });
  return section("VaR / ES", table(rows, ["method", "cl", "VaR", "ES", "mean", "sd"]));
}

function corrSection(c?: CorrMatrix) {
  if (!c || !c.keys || c.keys.length === 0) return section("Correlations", `<div class="empty">No correlation matrix</div>`);
  const cols = ["key", ...c.keys];
  const rows = c.keys.map((rowKey, i) => {
    const r: Record<string, any> = { key: rowKey };
    c.keys.forEach((colKey, j) => (r[colKey] = fmtNum(c.matrix[i][j])));
    return r;
  });
  return section("Correlations", table(rows, cols));
}

function curvesSection(equity?: EquityPt[], dd?: DDPoint[]) {
  const parts: string[] = [];
  if (equity && equity.length) parts.push(`<h3>Equity Curve</h3>${equitySVG(equity)}`);
  if (dd && dd.length) parts.push(`<h3>Drawdown</h3>${ddSVG(dd)}`);
  return section("Curves", parts.length ? parts.join("") : `<div class="empty">No curve data</div>`);
}

/* =========================
   Page frame
   ========================= */

const BASE_CSS = `
:root{
  --bg:#0b0f14; --panel:#111820; --muted:#9fb2c8; --ink:#e6eef8; --line:#6ab0ff; --line-dd:#ff6a6a;
  --accent:#7cd992; --warn:#ffb84d; --grid:#1b2733;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Apple Color Emoji', 'Segoe UI Emoji';
}
*{box-sizing:border-box}
body{margin:0; background:var(--bg); color:var(--ink)}
main{max-width:1080px; margin:24px auto; padding:0 16px}
header{display:flex; align-items:baseline; gap:12px; margin:16px 0 8px}
h1{font-size:28px; margin:0}
h2{font-size:20px; margin:28px 0 12px}
h3{font-size:16px; margin:18px 0 8px}
h4{font-size:14px; margin:14px 0 6px}
.badge{font-size:12px; color:var(--muted)}
section{background:var(--panel); border-radius:12px; padding:16px; margin:16px 0; box-shadow: 0 6px 18px rgba(0,0,0,0.25)}
.empty{color:var(--muted); font-style:italic}
table.grid{width:100%; border-collapse:collapse; font-size:13px}
table.grid th, table.grid td{padding:8px 10px; border-bottom:1px solid #203040}
table.grid th{text-align:left; color:var(--muted); font-weight:600}
table.grid tr:hover{background:#0f1620}
.chart{display:block; width:100%; height:auto}
.chart .bg{fill:#0f1620}
.chart .line{fill:none; stroke:var(--line); stroke-width:2}
.chart .line.dd{stroke:var(--line-dd)}
.footer{color:var(--muted); font-size:12px; text-align:center; margin:24px 0}
`;

/** Wrap body HTML into a full self-contained page. */
export function pageHTML(title: string, bodyHTML: string, subtitle?: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>${BASE_CSS}</style>
<body>
  <main>
    <header>
      <h1>${esc(title)}</h1>
      ${subtitle ? `<span class="badge">${esc(subtitle)}</span>` : ""}
    </header>
    ${bodyHTML}
    <div class="footer">Generated ${esc(new Date().toLocaleString())}</div>
  </main>
</body>
</html>`;
}

/* =========================
   Report builders
   ========================= */

export function renderSnapshotReport(snap: FullSnapshot): string {
  const title = `Run Report${snap.run?.id ? ` — ${snap.run.id}` : ""}`;
  const sub = [
    snap.ts ? `ts ${snap.ts}` : "",
    snap.run?.start && snap.run?.end ? `${snap.run.start} → ${snap.run.end}` : "",
    snap.run?.points ? `${snap.run.points} pts` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  // Accept curve from several shapes (your snapshots vary)
  const equity: EquityPt[] | undefined =
    snap.equityCurve ??
    (snap.portfolio && Array.isArray((snap.portfolio as any).equityCurve)
      ? (snap.portfolio as any).equityCurve
      : undefined);

  const sections =
    curvesSection(equity, snap.drawdownSeries) +
    metricsSection(snap.metrics) +
    exposureSection(snap.exposure) +
    varEsSection(snap.varEs) +
    corrSection(snap.correlations);

  return pageHTML(title, sections, sub);
}

export function writeSnapshotReport(snap: FullSnapshot, outPath: string): string {
  const abs = path.resolve(outPath.endsWith(".html") ? outPath : path.join(outPath, "report.html"));
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, renderSnapshotReport(snap), "utf8");
  return abs;
}

/* =========================
   Convenience default
   ========================= */

export default {
  renderSnapshotReport,
  writeSnapshotReport,
  pageHTML,
  table,
  equitySVG,
  ddSVG,
};