// reporting/csv.ts
// Lightweight CSV helpers: stringify arrays of records, print tables,
// write/read files, and a tiny streaming writer. ESM/NodeNext friendly.

import * as fs from "fs";
import * as path from "path";

/* =========================
   Types
   ========================= */

export type Row = Record<string, any>;

export type ToCSVOptions = {
  /** Explicit column order. If omitted, inferred from data (stable). */
  columns?: string[];
  /** Include header row (default true) */
  header?: boolean;
  /** Field separator (default ",") */
  sep?: string;
  /** Line separator (default "\n") */
  eol?: string;
};

export type PrintTableOptions = {
  columns?: string[];
  /** Show header (default true) */
  header?: boolean;
  /** Max column width for console (0 = unlimited). Default 0. */
  maxWidth?: number;
};

/* =========================
   Internals
   ========================= */

const DEFAULT_SEP = ",";
const DEFAULT_EOL = "\n";

function isBlank(x: any) {
  return x === undefined || x === null;
}

function stringifyCell(v: any): string {
  if (isBlank(v)) return "";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString();

  // objects/arrays → JSON
  if (typeof v === "object") {
    try { return JSON.stringify(v); } catch { return String(v); }
  }

  return String(v);
}

/** CSV escape per RFC4180-ish: quote if contains sep/quote/newline; double quotes inside. */
function csvEscape(raw: string, sep = DEFAULT_SEP): string {
  const mustQuote = raw.includes(sep) || raw.includes('"') || raw.includes("\n") || raw.includes("\r");
  if (!mustQuote) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

/** Infer stable columns from rows (in insertion order across rows). */
function inferColumns(rows: Row[]): string[] {
  const set = new Set<string>();
  for (const r of rows) Object.keys(r).forEach(k => set.add(k));
  return Array.from(set);
}

/* =========================
   Public API
   ========================= */

/** Convert array of records to CSV string. */
export function toCSV(rows: Row[], opts: ToCSVOptions = {}): string {
  if (!rows || rows.length === 0) return "";
  const sep = opts.sep ?? DEFAULT_SEP;
  const eol = opts.eol ?? DEFAULT_EOL;
  const cols = (opts.columns && opts.columns.length) ? opts.columns : inferColumns(rows);
  const withHeader = opts.header !== false;

  const out: string[] = [];

  if (withHeader) {
    out.push(cols.map(h => csvEscape(String(h), sep)).join(sep));
  }

  for (const r of rows) {
    const line = cols.map(c => csvEscape(stringifyCell((r as any)[c]), sep)).join(sep);
    out.push(line);
  }

  return out.join(eol) + eol;
}

/** Write CSV to file (creates directories). Returns absolute path. */
export function writeCSV(rows: Row[], outPath: string, opts: ToCSVOptions = {}): string {
  const abs = path.resolve(outPath);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(abs, toCSV(rows, opts), "utf8");
  return abs;
}

/** Minimal CSV reader (no quotes/newlines-in-cell support; for simple logs). */
export function readCSVSimple(filePath: string, sep = DEFAULT_SEP): Row[] {
  const txt = fs.readFileSync(filePath, "utf8");
  const lines = txt.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const headers = lines[0].split(sep).map(s => s.replace(/^"|"$/g, "").replace(/""/g, '"'));
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(sep).map(s => s.replace(/^"|"$/g, "").replace(/""/g, '"'));
    const r: Row = {};
    headers.forEach((h, j) => (r[h] = vals[j]));
    rows.push(r);
  }
  return rows;
}

/** Pretty-print rows as a console table (monospace). */
export function printTable(rows: Row[], opts: PrintTableOptions = {}): void {
  if (!rows || rows.length === 0) {
    console.log("(empty)");
    return;
  }
  const cols = (opts.columns && opts.columns.length) ? opts.columns : inferColumns(rows);
  const headerOn = opts.header !== false;
  const maxW = Math.max(0, opts.maxWidth ?? 0);

  // compute widths
  const widths = cols.map(c => {
    const wHeader = headerOn ? String(c).length : 0;
    const wCells = rows.reduce((m, r) => Math.max(m, String(isBlank(r[c]) ? "" : stringifyCell(r[c])).length), 0);
    let w = Math.max(wHeader, wCells);
    if (maxW > 0) w = Math.min(w, maxW);
    return w;
  });

  const line = (vals: string[]) =>
    vals.map((v, i) => {
      const s = v.length > widths[i] ? v.slice(0, Math.max(0, widths[i] - 1)) + "…" : v;
      return s.padEnd(widths[i], " ");
    }).join("  ");

  if (headerOn) {
    console.log(line(cols.map(String)));
    console.log(line(cols.map((_, i) => "-".repeat(widths[i]))));
  }

  for (const r of rows) {
    console.log(line(cols.map(c => stringifyCell(r[c] ?? ""))));
  }
}

/* =========================
   Streaming writer
   ========================= */

export class CSVStreamWriter {
  private stream: fs.WriteStream;
  private wroteHeader = false;
  private cols: string[] | undefined;
  private sep: string;
  private eol: string;
  private withHeader: boolean;

  constructor(outPath: string, opts: ToCSVOptions = {}) {
    const abs = path.resolve(outPath);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.stream = fs.createWriteStream(abs, { encoding: "utf8" });
    this.cols = opts.columns;
    this.sep = opts.sep ?? DEFAULT_SEP;
    this.eol = opts.eol ?? DEFAULT_EOL;
    this.withHeader = opts.header !== false;
  }

  writeRow(row: Row) {
    if (!this.wroteHeader) {
      this.cols = (this.cols && this.cols.length) ? this.cols : inferColumns([row]);
      if (this.withHeader) {
        this.stream.write(this.cols.map(h => csvEscape(String(h), this.sep)).join(this.sep) + this.eol);
      }
      this.wroteHeader = true;
    }

    const line = (this.cols as string[])
      .map(c => csvEscape(stringifyCell(row[c]), this.sep))
      .join(this.sep);
    this.stream.write(line + this.eol);
  }

  writeRows(rows: Row[]) {
    rows.forEach(r => this.writeRow(r));
  }

  end() {
    this.stream.end();
  }
}

/* =========================
   Convenience
   ========================= */

export default {
  toCSV,
  writeCSV,
  readCSVSimple,
  printTable,
  CSVStreamWriter,
};