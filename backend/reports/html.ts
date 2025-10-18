// reports/html.ts
// Tiny, dependency-free HTML report generator.
// Produces a single self-contained HTML string with inline CSS/JS/SVG.
// Suited for backtests, factor scores, diagnostics snapshots, etc.
//
// Features
// - Title, subtitle, metadata (kv table)
// - Sections with prose (markdown-lite*) and tables
// - Inline charts: line (sparkline or full), area, bar (SVG-based)
// - Grid layout & dark/light auto theme
// - Optional download helpers: save to file (Node) or to Blob URL (browser)
//
// *markdown-lite supports: **bold**, *italic*, `code`, and inline links [text](url)
//
// Usage:
//   import { HtmlReport, renderReport, saveReport } from "./reports/html";
//   const rep = HtmlReport.create({ title: "Backtest", subtitle: "SMA(10/50)" })
//     .meta({ "Start": "2018-01-01", "End": "2024-12-31", "Bars": 1711 })
//     .chart("Equity", Charts.line(dates, equity, { area: true }))
//     .table("Metrics", [
//        ["Return", "24.3%"], ["CAGR", "11.1%"], ["Sharpe", "1.02"], ["MaxDD", "12.7%"]
//     ])
//     .section("Notes", "Run with fee=1bps, slippage=1bps");
//   const html = renderReport(rep);
//   await saveReport(html, "backtest.html");

export type KV = Record<string, string | number | boolean | null | undefined>;

export type Section =
  | { kind: "meta"; title?: string; kv: KV }
  | { kind: "table"; title?: string; rows: Array<Array<string | number>>; header?: string[] }
  | { kind: "chart"; title?: string; svg: string; caption?: string }
  | { kind: "text"; title?: string; md: string }
  | { kind: "raw"; html: string };

export interface Report {
  title: string;
  subtitle?: string;
  createdAt?: string;    // ISO
  author?: string;
  tags?: string[];
  sections: Section[];
  footnote?: string;
}

export const HtmlReport = {
  create(init: Partial<Report> & { title: string }): Report {
    return {
      title: init.title,
      subtitle: init.subtitle,
      createdAt: init.createdAt ?? new Date().toISOString(),
      author: init.author,
      tags: init.tags ?? [],
      sections: [],
      footnote: init.footnote,
    };
  },

  meta(rep: Report, kv: KV, title?: string): Report {
    rep.sections.push({ kind: "meta", kv, title });
    return rep;
  },

  table(rep: Report, title: string | undefined, rows: Array<Array<string|number>>, header?: string[]): Report {
    rep.sections.push({ kind: "table", title, rows, header });
    return rep;
  },

  chart(rep: Report, title: string | undefined, svg: string, caption?: string): Report {
    rep.sections.push({ kind: "chart", title, svg, caption });
    return rep;
  },

  section(rep: Report, title: string | undefined, md: string): Report {
    rep.sections.push({ kind: "text", title, md });
    return rep;
  },

  raw(rep: Report, html: string): Report {
    rep.sections.push({ kind: "raw", html });
    return rep;
  },

  // chainable helpers
  withAuthor(rep: Report, author: string): Report { rep.author = author; return rep; },
  withTags(rep: Report, tags: string[]): Report { rep.tags = tags; return rep; },
  foot(rep: Report, text: string): Report { rep.footnote = text; return rep; },
};

// ---------- Renderer ----------

export function renderReport(rep: Report): string {
  const head = `
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(rep.title)}${rep.subtitle ? " – " + esc(rep.subtitle) : ""}</title>
<meta name="color-scheme" content="light dark" />
<style>
:root {
  --bg: #0b0d10; --panel:#11141a; --muted:#8b96a9; --text:#e7ecf4; --accent:#5cc8ff;
  --ok:#2dd4bf; --warn:#f59e0b; --fail:#ef4444; --border:#1f2430;
  --shadow: 0 6px 24px rgba(0,0,0,.2), 0 2px 6px rgba(0,0,0,.2);
}
@media (prefers-color-scheme: light) {
  :root { --bg:#f6f7fb; --panel:#fff; --muted:#5b6472; --text:#0c1222; --accent:#0ea5e9; --border:#e9edf3; --shadow: 0 6px 24px rgba(9,12,18,.05), 0 2px 6px rgba(9,12,18,.06); }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Arial;
}
.container { max-width: 1000px; margin: 28px auto; padding: 0 16px; }
h1 { font-size: 28px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 0 0 10px; }
.small { font-size: 13px; color: var(--muted); }
.header { display:flex; justify-content:space-between; align-items:flex-end; gap:12px; margin-bottom: 16px; }
.badge { display:inline-block; padding:2px 8px; border-radius:999px; border:1px solid var(--border); margin-right:6px; }
.card {
  background: linear-gradient(180deg, color-mix(in oklab, var(--panel) 92%, transparent), var(--panel));
  border: 1px solid var(--border); border-radius: 16px; padding: 16px; margin: 12px 0; box-shadow: var(--shadow);
}
.grid { display:grid; grid-template-columns: repeat(12, 1fr); gap: 16px; }
.span-4{grid-column:span 12} .span-6{grid-column:span 12} .span-8{grid-column:span 12}
@media (min-width: 760px) { .span-4{grid-column:span 4} .span-6{grid-column:span 6} .span-8{grid-column:span 8} }
.kv { display:grid; grid-template-columns: 200px 1fr; gap: 6px 10px; }
hr.sep { border:0; border-top:1px solid var(--border); margin: 6px 0 0; }
table { width:100%; border-collapse: collapse; }
th, td { border-bottom: 1px solid var(--border); padding: 6px 8px; text-align:left; font-size: 14px; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
pre { background: color-mix(in oklab, var(--panel), black 3%); border:1px dashed var(--border); padding:12px; border-radius:12px; overflow:auto; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.figure { width: 100%; overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: color-mix(in oklab, var(--panel), black 3%); }
.figcap { margin-top: 6px; color: var(--muted); font-size: 13px; }
.footer { text-align:center; color: var(--muted); margin: 16px 0 32px; font-size: 13px; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div>
      <h1>${esc(rep.title)}</h1>
      ${rep.subtitle ? `<div class="small">${esc(rep.subtitle)}</div>` : ""}
      ${rep.tags?.length ? `<div class="small">${rep.tags.map(t => `<span class="badge">${esc(t)}</span>`).join("")}</div>` : ""}
    </div>
    <div class="small">
      ${rep.author ? `<div>Author: ${esc(rep.author)}</div>` : ""}
      <div>Created: ${esc(rep.createdAt || "")}</div>
    </div>
  </div>
  ${rep.sections.map(renderSection).join("\n")}
  ${rep.footnote ? `<div class="footer">${mdInline(rep.footnote)}</div>` : ""}
</div>
</body>
</html>`.trim();

  return head;
}

function renderSection(s: Section): string {
  if (s.kind === "meta") {
    const keys = Object.keys(s.kv || {});
    const rows = keys.map(k => `<div class="small" style="color:var(--muted)">${esc(k)}</div><div>${esc(vToStr((s.kv as any)[k]))}</div>`).join("");
    return wrapCard(`
      ${s.title ? `<h2>${esc(s.title)}</h2>` : ""}
      <div class="kv">${rows || `<div class="small">No data</div><div></div>`}</div>
    `);
  }
  if (s.kind === "table") {
    const header = s.header?.length ? `<thead><tr>${s.header.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead>` : "";
    const body = `<tbody>${(s.rows || []).map(r => `<tr>${r.map(x => `<td>${esc(String(x))}</td>`).join("")}</tr>`).join("")}</tbody>`;
    return wrapCard(`
      ${s.title ? `<h2>${esc(s.title)}</h2>` : ""}
      <div class="table-wrap">
        <table>${header}${body}</table>
      </div>
    `);
  }
  if (s.kind === "chart") {
    return wrapCard(`
      ${s.title ? `<h2>${esc(s.title)}</h2>` : ""}
      <div class="figure">${s.svg}</div>
      ${s.caption ? `<div class="figcap">${mdInline(s.caption)}</div>` : ""}
    `);
  }
  if (s.kind === "text") {
    return wrapCard(`
      ${s.title ? `<h2>${esc(s.title)}</h2>` : ""}
      ${mdBlock(s.md)}
    `);
  }
  if (s.kind === "raw") {
    return wrapCard(s.html);
  }
  return "";
}

function wrapCard(inner: string): string {
  return `<section class="card">${inner}</section>`;
}

function vToStr(v: any): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return prettyNum(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function prettyNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n/1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n/1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n/1e3).toFixed(2) + "K";
  if (abs === 0) return "0";
  if (abs < 0.001) return n.toExponential(2);
  return (Math.round(n*1000)/1000).toString();
}

// ---------- Charts (SVG) ----------

export const Charts = {
  /** Line/area chart (dates optional). */
  line(x: Array<number | string | Date>, y: number[], opts?: Partial<LineOpts>): string {
    const cfg = normalizeLineOpts(opts);
    const xs = x && x.length ? x.map(toTs) : y.map((_v, i) => i);
    const { w, h, pad, area, spark, stroke, fill } = cfg;
    const plotW = w - pad*2, plotH = h - pad*2;

    const xsNorm = scale(xs, [min(xs), max(xs)], [0, plotW]);
    const ysNorm = scale(y, [min(y), max(y)], [plotH, 0]);

    const d = pathLine(xsNorm, ysNorm, pad);
    const dArea = area ? `${d} L ${pad + xsNorm[xsNorm.length-1]},${pad + plotH} L ${pad},${pad + plotH} Z` : "";

    const grid = spark ? "" : gridLines(plotW, plotH, pad);
    const axis = spark ? "" : axes(plotW, plotH, pad, xs, y);

    return `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">
  <defs>
    <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-opacity="0.6" />
      <stop offset="100%" stop-opacity="0" />
    </linearGradient>
  </defs>
  ${grid}
  ${area ? `<path d="${dArea}" fill="${fill || 'url(#g1)'}" />` : ""}
  <path d="${d}" fill="none" stroke="${stroke}" stroke-width="${spark ? 1.5 : 2}" stroke-linecap="round" stroke-linejoin="round" />
  ${axis}
</svg>`.trim();
  },

  /** Simple bar chart. */
  bars(labels: (string|number|Date)[], values: number[], opts?: Partial<BarOpts>): string {
    const cfg = normalizeBarOpts(opts);
    const { w, h, pad, stroke, fill } = cfg;
    const plotW = w - pad*2, plotH = h - pad*2;

    const xs = values.map((_v, i) => i);
    const xsNorm = scale(xs, [0, xs.length], [0, plotW]);
    const ysNorm = scale(values, [0, Math.max(0, max(values)) || 1], [plotH, 0]);

    const bw = Math.max(1, Math.floor(plotW / values.length * 0.8));
    const bars = values.map((v, i) => {
      const x = pad + Math.round(xsNorm[i] - bw/2);
      const y = pad + Math.round(ysNorm[i]);
      const hh = Math.max(0, plotH - Math.round(ysNorm[i]));
      return `<rect x="${x}" y="${y}" width="${bw}" height="${hh}" fill="${fill}" />`;
    }).join("");

    const axisX = labels.length ? labelAxisX(labels, pad, plotW, h - pad + 14) : "";
    const axisY = tickAxisY(values, pad, plotH);

    const grid = gridLines(plotW, plotH, pad);
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">
  ${grid}
  ${bars}
  ${axisY}
  ${axisX}
</svg>`.trim();
  },

  /** Tiny sparkline (no axes). */
  spark(y: number[], w=180, h=40): string {
    return Charts.line([], y, { w, h, pad: 4, spark: true, area: true });
  },
};

type LineOpts = {
  w: number; h: number; pad: number;
  area: boolean; spark: boolean;
  stroke: string; fill?: string;
};
function normalizeLineOpts(o?: Partial<LineOpts>): LineOpts {
  return {
    w: clampInt(o?.w ?? 840, 120, 2400),
    h: clampInt(o?.h ?? 260, 60, 1200),
    pad: clampInt(o?.pad ?? 32, 2, 120),
    area: !!o?.area,
    spark: !!o?.spark,
    stroke: o?.stroke ?? "currentColor",
    fill: o?.fill,
  };
}

type BarOpts = { w: number; h: number; pad: number; stroke: string; fill: string; };
function normalizeBarOpts(o?: Partial<BarOpts>): BarOpts {
  return {
    w: clampInt(o?.w ?? 840, 120, 2400),
    h: clampInt(o?.h ?? 260, 60, 1200),
    pad: clampInt(o?.pad ?? 32, 2, 120),
    stroke: o?.stroke ?? "currentColor",
    fill: o?.fill ?? "currentColor",
  };
}

// ---- SVG helpers ----
function gridLines(plotW: number, plotH: number, pad: number): string {
  const stepY = Math.max(20, Math.floor(plotH / 4));
  const ys = range(0, plotH + 1, stepY);
  const lines = ys.map(y => `<line x1="${pad}" y1="${pad + y}" x2="${pad + plotW}" y2="${pad + y}" stroke="var(--border)" stroke-width="1" />`).join("");
  return `<g>${lines}<rect x="${pad}" y="${pad}" width="${plotW}" height="${plotH}" fill="none" stroke="var(--border)" stroke-width="1"/></g>`;
}
function axes(plotW: number, plotH: number, pad: number, xsRaw: any[], ysRaw: number[]): string {
  const minY = min(ysRaw), maxY = max(ysRaw);
  const ticks = 4;
  const yvals = range(0, ticks + 1).map(i => minY + (i*(maxY - minY)/ticks));
  const labels = yvals.map(v => `<text x="${pad - 6}" y="${pad + (plotH - (plotH*(v - minY)/(maxY - minY || 1)))}" font-size="11" text-anchor="end" alignment-baseline="middle" fill="var(--muted)">${esc(numLabel(v))}</text>`).join("");
  const xlab = xsRaw && xsRaw.length ? labelAxisX(xsRaw, pad, plotW, pad + plotH + 16) : "";
  return `<g>${labels}${xlab}</g>`;
}
function labelAxisX(xs: any[], pad: number, plotW: number, y: number): string {
  const n = xs.length;
  if (!n) return "";
  const every = Math.max(1, Math.floor(n / 6));
  const xsNorm = scale(xs.map(toTs), [min(xs.map(toTs)), max(xs.map(toTs))], [0, plotW]);
  const labels = xs.map((v, i) => (i % every === 0 ? [i, v] : null)).filter(Boolean) as Array<[number, any]>;
  return labels.map(([i, v]) => {
    const xv = pad + xsNorm[i];
    const text = typeof v === "number" ? String(v) : (v instanceof Date ? v.toISOString().slice(0,10) : String(v).slice(0,10));
    return `<text x="${xv}" y="${y}" font-size="11" text-anchor="middle" fill="var(--muted)">${esc(text)}</text>`;
  }).join("");
}
function tickAxisY(values: number[], pad: number, plotH: number): string {
  const minY = 0;
  const maxY = Math.max(1, max(values));
  const ticks = 4;
  const yvals = range(0, ticks + 1).map(i => minY + (i*(maxY - minY)/ticks));
  const labels = yvals.map(v => {
    const yy = pad + (plotH - (plotH*(v - minY)/(maxY - minY || 1)));
    return `<text x="${pad - 6}" y="${yy}" font-size="11" text-anchor="end" alignment-baseline="middle" fill="var(--muted)">${esc(numLabel(v))}</text>`;
  }).join("");
  return labels;
}
function pathLine(xsNorm: number[], ysNorm: number[], pad: number): string {
  if (!xsNorm.length) return "";
  let d = `M ${pad + xsNorm[0]},${pad + ysNorm[0]}`;
  for (let i = 1; i < xsNorm.length; i++) d += ` L ${pad + xsNorm[i]},${pad + ysNorm[i]}`;
  return d;
}
function scale(a: number[], [lo, hi]: [number, number], [plo, phi]: [number, number]): number[] {
  const span = (hi - lo) || 1;
  const out: number[] = new Array(a.length);
  for (let i=0;i<a.length;i++) out[i] = plo + ((a[i] - lo) / span) * (phi - plo);
  return out;
}
function min(a: number[]): number { return a.length ? Math.min(...a) : 0; }
function max(a: number[]): number { return a.length ? Math.max(...a) : 0; }
function range(start: number, end: number, step = 1): number[] { const out: number[] = []; for (let x=start; x<=end; x+=step) out.push(x); return out; }
function numLabel(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v/1e9).toFixed(1) + "B";
  if (abs >= 1e6) return (v/1e6).toFixed(1) + "M";
  if (abs >= 1e3) return (v/1e3).toFixed(1) + "K";
  if (abs >= 1) return v.toFixed(0);
  if (abs >= 0.01) return v.toFixed(2);
  return v.toExponential(1);
}
function toTs(x: any): number {
  if (x instanceof Date) return x.getTime();
  if (typeof x === "number") return x;
  const s = String(x);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{13}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}
function clampInt(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, Math.floor(x))); }

// ---------- Markdown-lite ----------

function mdBlock(src: string): string {
  const lines = String(src || "").split(/\r?\n/);
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) { out.push(`<p>${mdInline(para.join(" "))}</p>`); para = []; }
  };
  for (const ln of lines) {
    if (!ln.trim()) { flush(); continue; }
    para.push(ln.trim());
  }
  flush();
  return out.join("\n");
}
function mdInline(s: string): string {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_m, g1) => `<code>${esc(g1)}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, (_m, g1) => `<strong>${esc(g1)}</strong>`);
  t = t.replace(/\*([^*]+)\*/g, (_m, g1) => `<em>${esc(g1)}</em>`);
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => `<a href="${esc(url)}">${esc(text)}</a>`);
  return t;
}

// ---------- Save helpers ----------

/** Save the HTML string to a file. Node-only, uses dynamic import of fs/promises. */
export async function saveReport(html: string, path: string): Promise<void> {
  if (!isNode()) throw new Error("saveReport: not in Node environment");
  const fs = await import("node:fs/promises");
  await fs.writeFile(path, html, "utf8");
}

/** Create a Blob URL in browsers; caller should revokeObjectURL later. */
export function blobUrl(html: string): string {
  if (typeof window === "undefined" || !("Blob" in window)) return "";
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  return URL.createObjectURL(blob);
}

function isNode(): boolean { return typeof (globalThis as any).process?.versions?.node === "string"; }

// ---------- Convenience builders ----------

/** Build a standard report in a single call. */
export function buildReport(opts: {
  title: string;
  subtitle?: string;
  meta?: KV;
  sections?: Array<Section | { kind: "table"|"chart"|"text"|"meta"|"raw"; [k: string]: any }>;
  metricsTable?: Array<[string, string|number]>;
  equity?: { x: Array<number|Date|string>; y: number[]; caption?: string; spark?: boolean };
  bars?: { labels: (string|number|Date)[]; values: number[]; title?: string };
  footnote?: string;
  author?: string;
  tags?: string[];
}): string {
  const rep = HtmlReport.create({ title: opts.title, subtitle: opts.subtitle, author: opts.author, footnote: opts.footnote, tags: opts.tags });
  if (opts.meta) HtmlReport.meta(rep, opts.meta, "Summary");
  if (opts.metricsTable?.length) HtmlReport.table(rep, "Metrics", opts.metricsTable.map(([k,v]) => [k, String(v)]), ["Metric","Value"]);
  if (opts.equity) {
    const svg = Charts.line(opts.equity.x, opts.equity.y, { area: true, spark: !!opts.equity.spark });
    HtmlReport.chart(rep, "Equity Curve", svg, opts.equity.caption);
  }
  if (opts.bars) {
    const svg = Charts.bars(opts.bars.labels, opts.bars.values);
    HtmlReport.chart(rep, opts.bars.title || "Bars", svg);
  }
  for (const s of opts.sections ?? []) {
    if (s.kind === "table") HtmlReport.table(rep, (s as any).title, (s as any).rows, (s as any).header);
    else if (s.kind === "chart") HtmlReport.chart(rep, (s as any).title, (s as any).svg, (s as any).caption);
    else if (s.kind === "text") HtmlReport.section(rep, (s as any).title, (s as any).md);
    else if (s.kind === "meta") HtmlReport.meta(rep, (s as any).kv, (s as any).title);
    else if (s.kind === "raw") HtmlReport.raw(rep, (s as any).html);
  }
  return renderReport(rep);
}

// ---------- Tiny utils ----------

function esc(s: any): string {
  const str = String(s ?? "");
  return str.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!));
}
// ========== END html.ts ==========