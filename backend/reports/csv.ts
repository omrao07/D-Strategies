// reports/csv.ts
// Tiny, dependency-free CSV/TSV builder & parser with handy Node/browser helpers.
// Works well with reports/html.ts and reports/md.ts when you want a raw export.
//
// Features
// - Build CSV from arrays of rows or arrays of objects
// - RFC 4180-ish escaping (quotes doubled, fields quoted when needed)
// - Optional BOM for Excel friendliness
// - TSV (or any delimiter) via option
// - Parse CSV into rows or objects (auto-detect delimiter if not provided)
// - Node helper to save to disk; browser helper to trigger a download
//
// Usage:
//   // From rows
//   const csv = toCSV([["symbol","pe"], ["AAPL", 28.3], ["MSFT", 32]]);
//   // From objects
//   const csv2 = toCSVObjects([{symbol:"AAPL", pe:28.3}, {symbol:"MSFT", pe:32}]);
//   // Parse
//   const rows = parseCSV(csv);
//   const objs  = parseCSVObjects(csv2);
//   // Save (Node)
//   await saveCSV(csv2, "fundamentals.csv");
//   // Download (browser)
//   downloadCSV(csv2, "fundamentals.csv");

export type Cell = string | number | boolean | null | undefined | Date;
export type Row = Cell[];

export interface CSVBuildOptions {
  delimiter?: string;   // default ",", e.g. "\t" for TSV
  newline?: "\n" | "\r\n"; // default "\n" (CRLF used if input has CRLF in headers)
  quote?: string;       // default '"'
  header?: string[];    // optional header row for toCSV(rows)
  bom?: boolean;        // prepend UTF-8 BOM (useful for Excel on Windows)
}

export interface CSVObjectOptions {
  delimiter?: string;   // default ",", e.g. "\t" for TSV
  newline?: "\n" | "\r\n"; // default "\n" (CRLF used if input has CRLF in headers)
  quote?: string;       // default '"'
  header?: boolean | string[]; // include header row? (default true); or explicit header
  columns?: string[];  // optional list of columns & order (default: infer from data)
  nullAsEmpty?: boolean; // represent null/undefined as empty string (default true)
  dateISO?: boolean;    // format Date as ISO string (default true)
  bom?: boolean;        // prepend UTF-8 BOM (useful for Excel on Windows)
}

export interface CSVParseOptions {
  delimiter?: string;     // if omitted, auto-detected (comma/tsv/semicolon/pipe)
  newline?: "\n" | "\r\n" | "auto"; // default "auto"
  quote?: string;         // default '"'
  trim?: boolean;         // trim surrounding spaces for unquoted fields (default false)
  header?: boolean;       // treat first row as header for parseCSVObjects (default true there)
  skipEmptyLines?: boolean; // ignore blank lines (default true)
  // If your CSV starts with BOM, parser handles it automatically.
}

// ---------------- Builders ----------------

/** Convert a 2D array of cell values into a CSV string. */
export function toCSV(rows: Row[], opts: CSVBuildOptions = {}): string {
  const delimiter = opts.delimiter ?? ",";
  const quote = opts.quote ?? '"';
  const newline = opts.newline ?? "\n";

  const out: string[] = [];
  if (opts.header && opts.header.length) out.push(joinRow(opts.header, delimiter, quote));

  for (const r of rows) {
    const row = r.map((v) => stringifyCell(v, { dateISO: true }));
    out.push(joinRow(row, delimiter, quote));
  }

  const body = out.join(newline);
  return opts.bom ? BOM_UTF8 + body : body;
}

/** Convert an array of objects into CSV, inferring/stabilizing columns. */
export function toCSVObjects<T extends Record<string, any>>(objs: T[], opt: CSVObjectOptions = {}): string {
  const delimiter = opt.delimiter ?? ",";
  const quote = opt.quote ?? '"';
  const newline = opt.newline ?? "\n";
  const nullAsEmpty = opt.nullAsEmpty !== false; // default true
  const dateISO = opt.dateISO !== false;         // default true

  const cols = normalizeColumns(objs, opt.columns);
  const withHeader = opt.header === undefined ? true : !!opt.header;
  const headerLine = Array.isArray(opt.header) && opt.header.length ? opt.header : cols;

  const lines: string[] = [];
  if (withHeader) lines.push(joinRow(headerLine, delimiter, quote));

  for (const obj of objs) {
    const row = cols.map((k) => stringifyCell(
      k in obj ? obj[k] : (nullAsEmpty ? "" : undefined),
      { dateISO }
    ));
    lines.push(joinRow(row, delimiter, quote));
  }

  const body = lines.join(newline);
  return opt.bom ? BOM_UTF8 + body : body;
}

// ---------------- Parsers ----------------

/** Parse CSV text into an array of rows (array of strings). */
export function parseCSV(csv: string, opts: CSVParseOptions = {}): string[][] {
  const raw = stripBOM(csv);
  const delimiter = opts.delimiter ?? detectDelimiter(raw);
  const quote = opts.quote ?? '"';
  const newline = opts.newline === "auto" || !opts.newline ? detectNewline(raw) : opts.newline;
  const skipEmpty = opts.skipEmptyLines !== false; // default true

  const rows: string[][] = [];
  let i = 0, field = "", inQuotes = false;
  const pushField = (arr: string[]) => {
    arr.push(inQuotes ? field : (opts.trim ? field.trim() : field));
    field = ""; inQuotes = false;
  };

  let row: string[] = [];
  while (i < raw.length) {
    const ch = raw[i];

    // handle CRLF or LF newline
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      // normalize newline
      if (ch === "\r" && raw[i + 1] === "\n") i++; // consume \n
      pushField(row);
      if (!(skipEmpty && row.length === 1 && row[0] === "")) rows.push(row);
      row = [];
      i++;
      continue;
    }

    if (ch === delimiter && !inQuotes) {
      pushField(row);
      i++;
      continue;
    }

    if (ch === quote) {
      if (inQuotes) {
        // escaped quote?
        const next = raw[i + 1];
        if (next === quote) { field += quote; i += 2; continue; }
        // end quote
        inQuotes = false;
        i++;
        continue;
      } else {
        // begin quote (only if field empty or just started)
        if (field === "") { inQuotes = true; i++; continue; }
        // else, literal quote within unquoted field
      }
    }

    field += ch;
    i++;
  }
  // final field
  pushField(row);
  if (!(skipEmpty && row.length === 1 && row[0] === "")) rows.push(row);

  // If we used explicit newline CRLF but input had trailing CR, normalize: already handled above.

  return rows;
}

/** Parse CSV text into an array of objects using header row. */
export function parseCSVObjects(csv: string, opts: CSVParseOptions = {}): Array<Record<string, string>> {
  const rows = parseCSV(csv, { ...opts, header: true });
  if (!rows.length) return [];
  const header = rows[0];
  const out: Array<Record<string, string>> = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const obj: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = row[c] ?? "";
    out.push(obj);
  }
  return out;
}

// ---------------- Helpers ----------------

function joinRow(values: any[], delimiter: string, quote: string): string {
  return values.map(v => escapeCSV(String(v ?? ""), delimiter, quote)).join(delimiter);
}

function stringifyCell(v: Cell, opts?: { dateISO?: boolean }): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (v instanceof Date) return (opts?.dateISO !== false) ? v.toISOString() : v.toString();
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function escapeCSV(s: string, delimiter: string, quote: string): string {
  // Quote if field contains delimiter, quote, newline, or leading/trailing space
  const mustQuote = s.includes(delimiter) || s.includes(quote) || /[\r\n]/.test(s) || /^\s|\s$/.test(s);
  if (!mustQuote) return s;
  const doubled = s.replaceAll(quote, quote + quote);
  return quote + doubled + quote;
}

function normalizeColumns<T extends Record<string, any>>(objs: T[], columns?: string[]): string[] {
  if (columns && columns.length) return columns.slice();
  const keys = new Set<string>();
  for (const o of objs) for (const k in o) keys.add(k);
  return Array.from(keys);
}

const BOM_UTF8 = "\uFEFF";

function stripBOM(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function detectNewline(s: string): "\n" | "\r\n" {
  const idx = s.indexOf("\r\n");
  if (idx !== -1 && (idx < s.indexOf("\n") || s.indexOf("\n") === -1)) return "\r\n";
  return "\n";
}

function detectDelimiter(s: string): string {
  // Consider first non-empty line (or two) and count candidates
  const firstLines = s.split(/\r?\n/).filter(Boolean).slice(0, 3);
  const cands = [",", "\t", ";", "|"];
  let best = ",", bestScore = -1;
  for (const cand of cands) {
    let total = 0, variance = 0;
    const counts = firstLines.map((ln) => countTopLevel(ln, cand, '"'));
    if (!counts.length) continue;
    total = counts.reduce((a,b)=>a+b,0);
    const mean = total / counts.length;
    variance = counts.reduce((a,b)=>a + Math.abs(b - mean), 0);
    const score = total - variance; // prefer more separators and consistent counts
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  return best;
}

function countTopLevel(line: string, delimiter: string, quote: string): number {
  let count = 0, inQ = false;
  for (let i=0;i<line.length;i++) {
    const ch = line[i];
    if (ch === quote) {
      if (inQ && line[i+1] === quote) { i++; continue; } // escaped
      inQ = !inQ;
    } else if (ch === delimiter && !inQ) count++;
  }
  return count;
}

// ---------------- Convenience ----------------

/** Merge multiple CSV strings with identical headers (best-effort). */
export function concatCSV(csvs: string[], opts: { newline?: "\n" | "\r\n" } = {}): string {
  const cleaned = csvs.map(stripBOM).filter(Boolean);
  if (!cleaned.length) return "";
  const nl = opts.newline ?? detectNewline(cleaned[0]);
  const [head, ...rest] = cleaned;
  const header = head.split(/\r?\n/)[0] ?? "";
  const bodies = [head, ...rest].map((c, i) => {
    const lines = c.split(/\r?\n/);
    return i === 0 ? lines.join(nl) : lines.slice(1).join(nl);
  }).filter(Boolean);
  return BOM_UTF8 + [header, ...bodies.filter(x => x.trim() !== "")].join(nl);
}

/** Node-only: save CSV text to a file (UTF-8). */
export async function saveCSV(csv: string, path: string): Promise<void> {
  if (!isNode()) throw new Error("saveCSV: not in Node environment");
  const fs = await import("node:fs/promises");
  await fs.writeFile(path, csv, "utf8");
}

/** Browser: trigger a download; also returns the Blob URL (remember to revoke later). */
export function downloadCSV(csv: string, filename = "data.csv"): string {
  if (typeof window === "undefined") return "";
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  return url;
}

function isNode(): boolean {
  try { return typeof (globalThis as any).process?.versions?.node === "string"; } catch { return false; }
}

// ---------------- Small utilities ----------------

/** Convert an array of records into a 2D array with specified columns (header included). */
export function objectsToRows<T extends Record<string, any>>(objs: T[], columns?: string[], includeHeader = true): string[][] {
  const cols = normalizeColumns(objs, columns);
  const rows: string[][] = [];
  if (includeHeader) rows.push(cols.slice());
  for (const o of objs) rows.push(cols.map(k => stringifyCell(o[k])));
  return rows;
}

/** Quick TSV helper. */
export function toTSV(rows: Row[], opts: Omit<CSVBuildOptions, "delimiter"> = {}): string {
  return toCSV(rows, { ...opts, delimiter: "\t" });
}

/** Quick TSV-from-objects helper. */
export function toTSVObjects<T extends Record<string, any>>(objs: T[], opts: Omit<CSVObjectOptions, "delimiter"> = {}): string {
  return toCSVObjects(objs, { ...opts, delimiter: "\t" });
}
