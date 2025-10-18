// backtester/commands/reports.ts
// Generate single-run HTML and an index page (zero deps, ESM-friendly).

import * as fs from "fs";
import * as path from "path";

/* ----------------- small fs utils ----------------- */
const isFile = (p?: string) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };
const isDir  = (p?: string) => { try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; } };
const readJSON = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const ensureDir = (d: string) => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); };

type Flags = Record<string, any>;
type RunShape = {
  id: string;
  ts?: string;
  params?: Record<string, any>;
  metrics?: Record<string, number>;
  equityCurve?: Array<{ date: string; equity: number }>;
  [k: string]: any;
};

/* ----------------- dynamic imports ----------------- */
async function impPlot() {
  const url = new URL("../../libs/plot.js", import.meta.url).href;
  return await import(url) as unknown as {
    svgLineChart: (series: any, opts?: any) => string;
  };
}
async function impCurve() {
  const url = new URL("../../libs/curve.js", import.meta.url).href;
  return await import(url) as unknown as {
    metrics: (curve: Array<{date:string;equity:number}>) => any;
    sanitize: (curve: Array<{date:string;equity:number}>) => Array<{date:string;equity:number}>;
  };
}

/* ----------------- helpers ----------------- */
function safeId(id: string) { return String(id).replace(/[^\w.-]+/g, "_"); }

function findRunsDir(): string {
  const guess = path.resolve(process.cwd(), "outputs", "runs");
  return guess;
}

function listRunFiles(dir: string): string[] {
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => path.join(dir, f))
    .sort(); // lexicographic (ISO timestamps in names will sort)
}

function latestRunPathById(dir: string, id: string): string | null {
  const sid = safeId(id);
  const files = listRunFiles(dir)
    .filter(p => p.includes(`.${sid}.json`) || path.basename(p).includes(`${sid}`));
  return files.length ? files[files.length - 1] : null;
}

function renderMetricsTable(m: Record<string, number> | undefined) {
  if (!m) return "<p><em>No metrics available.</em></p>";
  const entries = Object.entries(m)
    .filter(([_, v]) => typeof v === "number" && Number.isFinite(v));
  if (!entries.length) return "<p><em>No metrics available.</em></p>";
  const fmt = (k: string, v: number) => {
    const pctKeys = ["totalReturn","cagr","maxDD","calmar"];
    if (k === "maxDD") return (v * 100).toFixed(2) + "%";
    if (k === "totalReturn" || k === "cagr") return (v * 100).toFixed(2) + "%";
    if (k === "calmar" || k === "sharpe" || k === "sortino") return v.toFixed(2);
    if (k === "volAnn") return (v * 100).toFixed(2) + "%";
    return String(v);
  };
  const rows = entries.map(([k, v]) => `<tr><th>${k}</th><td>${fmt(k, v)}</td></tr>`).join("\n");
  return `<table class="kv">
  <thead><tr><th>Metric</th><th>Value</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function baseHtml({ title, css, body }: { title: string; css?: string; body: string }) {
  const style = css ?? `
:root { --bg:#ffffff; --fg:#0f172a; --muted:#64748b; --grid:#e5e7eb; --accent:#0ea5e9; }
*{box-sizing:border-box} body{margin:24px;font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial; color:var(--fg); background:var(--bg)}
h1{font-size:20px;margin:0 0 12px 0}
h2{font-size:16px;margin:24px 0 8px 0}
header{display:flex;align-items:baseline;gap:12px;margin-bottom:8px}
.meta{color:var(--muted);font-size:12px}
hr{border:none;border-top:1px solid var(--grid);margin:16px 0}
.kv{border-collapse:collapse;width:100%;max-width:520px}
.kv th,.kv td{border:1px solid var(--grid);padding:6px 8px;font-size:13px;text-align:left}
.kv thead th{background:#f8fafc}
.grid{display:grid;grid-template-columns:1fr;gap:16px}
svg{max-width:100%;height:auto;border:1px solid var(--grid)}
code{background:#f1f5f9;padding:2px 4px;border-radius:4px}
.small{font-size:12px;color:var(--muted)}
table.index{border-collapse:collapse;width:100%}
table.index th, table.index td{border:1px solid var(--grid);padding:6px 8px;font-size:13px}
table.index thead th{background:#f8fafc}
`;
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>${style}</style>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(s: string) {
  return String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]!));
}

/* ----------------- reports:run ----------------- */
export async function reportsRun(flags: Flags) {
  const runsDir = flags.runsDir ? path.resolve(String(flags.runsDir)) : findRunsDir();
  const outPath = flags.out ? path.resolve(String(flags.out)) : undefined;

  const id = flags.id ? String(flags.id) : undefined;
  const runPath = flags.run
    ? path.resolve(String(flags.run))
    : (id ? latestRunPathById(runsDir, id) : null);

  if (!runPath || !isFile(runPath)) {
    console.error("Run file not found. Provide --run=PATH or --id=<strategyId> (with runs present).");
    process.exit(1);
  }

  const run: RunShape = readJSON(runPath);
  const { svgLineChart } = await impPlot();
  const Curve = await impCurve();

  const eq = (run.equityCurve || []).map(p => ({ date: String(p.date), equity: Number(p.equity) }));
  const clean = Curve.sanitize(eq);
  const metrics = run.metrics ?? Curve.metrics(clean);

  // X as index to avoid date parsing in SVG scaling
  const series = clean.map((p, i) => ({ x: i, y: p.equity }));
  const svg = svgLineChart(series, { title: `${run.id} Equity`, width: 960, height: 320, grid: true });

  const title = `Run Report — ${run.id}`;
  const meta = [
    run.ts ? `timestamp: <code>${escapeHtml(run.ts)}</code>` : "",
    `points: <code>${clean.length}</code>`,
  ].filter(Boolean).join(" · ");

  const body = `
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">${meta}</div>
</header>
<hr/>
<div class="grid">
  <section>
    <h2>Equity</h2>
    ${svg}
  </section>
  <section>
    <h2>Metrics</h2>
    ${renderMetricsTable(metrics)}
  </section>
  <section>
    <h2>Parameters</h2>
    <pre><code>${escapeHtml(JSON.stringify(run.params ?? {}, null, 2))}</code></pre>
  </section>
</div>
<p class="small">source: ${escapeHtml(path.relative(process.cwd(), runPath))}</p>
`;

  const html = baseHtml({ title, body });

  const out = outPath ?? path.resolve(process.cwd(), "outputs", "reports", `${safeId(run.id)}.html`);
  ensureDir(path.dirname(out));
  fs.writeFileSync(out, html, "utf8");
  console.log(`Report written → ${out}`);
}

/* ----------------- reports:index ----------------- */
export async function reportsIndex(flags: Flags) {
  const runsDir = flags.runsDir ? path.resolve(String(flags.runsDir)) : findRunsDir();
  const out = flags.out ? path.resolve(String(flags.out)) : path.resolve(process.cwd(), "outputs", "reports", "index.html");

  if (!isDir(runsDir)) {
    console.error(`Runs directory not found: ${runsDir}`);
    process.exit(1);
  }

  const files = listRunFiles(runsDir);
  const Curve = await impCurve();

  const rows: Array<{ id: string; ts: string; sharpe?: number; cagr?: number; maxDD?: number; file: string }> = [];
  for (const f of files) {
    try {
      const run: RunShape = readJSON(f);
      const eq = (run.equityCurve || []).map(p => ({ date: String(p.date), equity: Number(p.equity) }));
      let m = run.metrics;
      if (!m && eq.length) m = Curve.metrics(Curve.sanitize(eq));
      rows.push({
        id: run.id || "(unknown)",
        ts: run.ts || path.basename(f).slice(0, 20),
        sharpe: m?.sharpe,
        cagr: m?.cagr,
        maxDD: m?.maxDD,
        file: path.relative(path.dirname(out), f).replace(/\\/g, "/"),
      });
    } catch {
      // skip bad file
    }
  }

  const header = `
<header>
  <h1>Run Index</h1>
  <div class="meta">${rows.length} run(s) found · ${escapeHtml(path.relative(process.cwd(), runsDir))}</div>
</header>`;

  const table = `
<table class="index">
  <thead>
    <tr>
      <th>Strategy</th>
      <th>Timestamp</th>
      <th>Sharpe</th>
      <th>CAGR</th>
      <th>MaxDD</th>
      <th>Run JSON</th>
    </tr>
  </thead>
  <tbody>
    ${rows.map(r => `
      <tr>
        <td>${escapeHtml(r.id)}</td>
        <td>${escapeHtml(r.ts)}</td>
        <td>${r.sharpe != null ? r.sharpe.toFixed(2) : ""}</td>
        <td>${r.cagr != null ? (r.cagr*100).toFixed(2) + "%" : ""}</td>
        <td>${r.maxDD != null ? (r.maxDD*100).toFixed(2) + "%" : ""}</td>
        <td><a href="${encodeURI(r.file)}">${escapeHtml(path.basename(r.file))}</a></td>
      </tr>
    `).join("\n")}
  </tbody>
</table>`;

  const html = baseHtml({ title: "Run Index", body: `${header}<hr/>${table}` });
  ensureDir(path.dirname(out));
  fs.writeFileSync(out, html, "utf8");
  console.log(`Index written → ${out}`);
}

/* ----------------- default export ----------------- */
export default { reportsRun, reportsIndex };