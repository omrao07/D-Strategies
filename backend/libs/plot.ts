// libs/plot.ts
// Minimal plotting helpers for CLIs and jobs, no external deps.
// Works with NodeNext/ESM. Import with: import * as Plot from "../libs/plot.js"

import * as fs from "fs";
import * as path from "path";

/* ========================= Types ========================= */

export type XY = { x: number | string; y: number };
export type CurvePt = { date: string; equity: number };
export type Series = number[] | XY[];

export type AsciiOpts = {
  height?: number;         // rows (default 12)
  width?: number;          // target columns (downsample to fit; default 80)
  leftPad?: number;        // spaces at left (default 2)
  title?: string;          // optional title line
  legend?: string[];       // names for multiple series
  compact?: boolean;       // if true, no axes baseline
  symbols?: string[];      // e.g. ["●","×","∙","•"] for multi-series
};

export type SvgOpts = {
  width?: number;          // px (default 800)
  height?: number;         // px (default 300)
  margin?: { top:number; right:number; bottom:number; left:number };
  strokeWidth?: number;    // line width
  palette?: string[];      // CSS colors for multi-series
  title?: string;
  grid?: boolean;
  yTicks?: number;         // approx # of y ticks (default 5)
};

export type CsvRow = Record<string, string | number | null | undefined>;

/* ====================== Helpers ======================= */

export function isXY(s: Series): s is XY[] {
  return Array.isArray(s) && s.length > 0 && typeof (s as any)[0] === "object" && "y" in (s as any)[0];
}

export function autoscale(values: number[]) {
  if (!values.length) return { lo: 0, hi: 1, span: 1 };
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  return { lo, hi, span };
}

/** Evenly take ~width points */
export function downsample<T>(arr: T[], target: number): T[] {
  if (!Array.isArray(arr) || arr.length <= target) return arr.slice();
  const step = arr.length / target;
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += step) {
    out.push(arr[Math.floor(i)]);
  }
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

/* ============== ASCII charts (terminal) ============== */

export function sparkline(series: number[] | CurvePt[], maxChars = 40): string {
  const vals = Array.isArray(series) && series.length && typeof (series as any)[0] === "object"
    ? (series as CurvePt[]).map(p => p.equity)
    : (series as number[]);
  const s = downsample(vals, maxChars);
  const { lo, hi, span } = autoscale(s);
  const blocks = "▁▂▃▄▅▆▇█";
  return s.map(v => {
    const idx = Math.max(0, Math.min(7, Math.round(((v - lo) / span) * 7)));
    return blocks[idx];
  }).join("");
}

/**
 * Draw a single or multi-series ASCII chart.
 * Accepts:
 *  - number[] (y only)
 *  - XY[]      (x,y)
 *  - Series[]  (multiple series)
 */
export function asciiChart(input: Series | Series[], opts: AsciiOpts = {}): string {
  const height = Math.max(3, Math.floor(opts.height ?? 12));
  const width  = Math.max(10, Math.floor(opts.width  ?? 80));
  const left   = " ".repeat(Math.max(0, Math.floor(opts.leftPad ?? 2)));
  const symbols = (opts.symbols && opts.symbols.length ? opts.symbols : ["●", "×", "∙", "•", "■", "▲", "◆", "○"]);

  const seriesArr: Series[] = Array.isArray(input) && Array.isArray((input as any)[0])
    ? (input as Series[])
    : [input as Series];

  // Convert to arrays of numbers (y only) with downsampling
  const ySeries = seriesArr.map((s) => {
    const ys = isXY(s) ? (s as XY[]).map(p => p.y) : (s as number[]);
    return downsample(ys, width);
  });

  // Global scale across all series
  const allVals = ([] as number[]).concat(...ySeries);
  const { lo, hi, span } = autoscale(allVals);

  const rows: string[] = [];
  if (opts.title) rows.push(left + opts.title);

  for (let r = 0; r < height; r++) {
    let line = left + "|";
    const level = hi - (r * span) / (height - 1); // (for ref; not printed)
    // For each column x, place symbol if any series hits this row bucket
    for (let x = 0; x < width; x++) {
      let mark = " ";
      for (let sIdx = 0; sIdx < ySeries.length; sIdx++) {
        const ys = ySeries[sIdx];
        if (x >= ys.length) continue;
        const bucket = Math.round((hi - ys[x]) * (height - 1) / span);
        if (bucket === r) { mark = symbols[sIdx % symbols.length]; break; }
      }
      line += mark;
    }
    rows.push(line);
  }
  if (!opts.compact) rows.push(left + "+" + "-".repeat(width));

  // Legend
  if (ySeries.length > 1) {
    const legend = (opts.legend && opts.legend.length === ySeries.length)
      ? opts.legend
      : ySeries.map((_, i) => `S${i + 1}`);
    rows.push(left + " " + legend.map((name, i) => `${symbols[i % symbols.length]} ${name}`).join("   "));
  }

  return rows.join("\n");
}

/* ===================== CSV helpers ===================== */

export function toCSV(rows: CsvRow[]): string {
  if (!rows?.length) return "";
  const headers = Array.from(rows.reduce((set, r) => {
    Object.keys(r).forEach(k => set.add(k));
    return set;
  }, new Set<string>()));
  const lines = [
    headers.join(","),
    ...rows.map(r => headers.map(h => {
      const v = r[h];
      if (v == null) return "";
      if (typeof v === "string" && (v.includes(",") || v.includes('"') || v.includes("\n"))) {
        return `"${v.replace(/"/g, '""')}"`;
      }
      if (typeof v === "object") return `"${JSON.stringify(v).replace(/"/g, '""')}"`;
      return String(v);
    }).join(","))
  ];
  return lines.join("\n") + "\n";
}

export function writeCSV(rows: CsvRow[], outPath: string) {
  const csv = toCSV(rows);
  if (!outPath) return csv;
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, csv, "utf8");
  return outPath;
}

/* ===================== SVG helpers ===================== */

/**
 * Minimal SVG line chart (single or multiple series).
 * Returns SVG markup string (no DOM, no canvas).
 */
export function svgLineChart(input: Series | Series[], opts: SvgOpts = {}): string {
  const width  = Math.max(200, Math.floor(opts.width  ?? 800));
  const height = Math.max(120, Math.floor(opts.height ?? 300));
  const m = { top: 24, right: 20, bottom: 28, left: 48, ...(opts.margin || {}) };
  const innerW = Math.max(10, width - m.left - m.right);
  const innerH = Math.max(10, height - m.top - m.bottom);
  const palette = opts.palette && opts.palette.length
    ? opts.palette
    : ["#0ea5e9","#22c55e","#ef4444","#a855f7","#f59e0b","#14b8a6","#e11d48","#64748b"];

  const seriesArr: Series[] = Array.isArray(input) && Array.isArray((input as any)[0])
    ? (input as Series[])
    : [input as Series];

  // Normalize to XY[] and find Y domain
  const norm: XY[][] = seriesArr.map((s) => {
    if (isXY(s)) return (s as XY[]).map(p => ({ x: p.x, y: Number(p.y) }));
    const ys = s as number[];
    return ys.map((y, i) => ({ x: i, y: Number(y) }));
  });

  const allY = norm.flat().map(p => p.y).filter(n => Number.isFinite(n));
  const { lo, hi, span } = autoscale(allY);

  // X domain per series → scale to [0, innerW]
  const xVal = (x: number | string, i: number) =>
    typeof x === "number" ? x : i; // if categorical/date string, index it

  const paths: string[] = [];
  norm.forEach((points, si) => {
    if (!points.length) return;
    const x0 = xVal(points[0].x as any, 0);
    const x1 = xVal(points[points.length - 1].x as any, points.length - 1);
    const xSpan = (Number(x1) - Number(x0)) || (points.length - 1) || 1;

    const d = points.map((p, i) => {
      const xx = m.left + ((xVal(p.x as any, i) - Number(x0)) / xSpan) * innerW;
      const yy = m.top + (1 - (p.y - lo) / span) * innerH;
      return `${i === 0 ? "M" : "L"}${xx.toFixed(2)},${yy.toFixed(2)}`;
    }).join(" ");

    paths.push(`<path d="${d}" fill="none" stroke="${palette[si % palette.length]}" stroke-width="${opts.strokeWidth ?? 2}" />`);
  });

  // Optional grid + simple Y ticks
  const ticks = Math.max(2, Math.min(10, Math.floor(opts.yTicks ?? 5)));
  const yTicks: string[] = [];
  for (let t = 0; t <= ticks; t++) {
    const v = lo + (span * t) / ticks;
    const yy = m.top + (1 - (v - lo) / span) * innerH;
    yTicks.push(`
      ${opts.grid ? `<line x1="${m.left}" y1="${yy.toFixed(2)}" x2="${m.left + innerW}" y2="${yy.toFixed(2)}" stroke="#e5e7eb" />` : ""}
      <text x="${m.left - 6}" y="${(yy + 4).toFixed(2)}" text-anchor="end" font-size="10" fill="#64748b">${formatTick(v)}</text>
    `.trim());
  }

  const titleEl = opts.title
    ? `<text x="${width / 2}" y="${Math.max(16, m.top - 8)}" text-anchor="middle" font-size="14" font-weight="600" fill="#111827">${escapeXml(opts.title)}</text>`
    : "";

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>
  ${titleEl}
  <g>
    ${yTicks.join("\n")}
    ${paths.join("\n")}
  </g>
</svg>`.trim();
}

export function writeSVG(svg: string, outPath: string) {
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, svg, "utf8");
  return outPath;
}

/* ====================== Internals ====================== */

function escapeXml(s: string) {
  return s.replace(/[<&>"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
}

function formatTick(v: number) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(2) + "k";
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/* ===================== Convenience ===================== */

/** Quick helper: print chart to console */
export function printAscii(series: Series | Series[], opts?: AsciiOpts) {
  console.log(asciiChart(series, opts));
}

/** Quick helper: save equity curve (date,equity) CSV */
export function saveEquityCSV(curve: CurvePt[], outPath: string) {
  const rows: CsvRow[] = curve.map(p => ({ date: p.date, equity: p.equity }));
  return writeCSV(rows, outPath);
}

export default {
  sparkline,
  asciiChart,
  printAscii,
  toCSV,
  writeCSV,
  svgLineChart,
  writeSVG,
  saveEquityCSV,
  downsample,
  autoscale,
};