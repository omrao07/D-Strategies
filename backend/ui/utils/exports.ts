// utils/exports.ts
// Zero-dependency data export helpers (CSV/TSV/JSON/JSONL/Markdown).
// Works in both browser and Node-like environments (download/save best-effort).
// No imports. Fully typed, small and fast.
//
// Quick start:
//   const rows = [{ id: 1, name: "Om", score: 98.2 }, { id: 2, name: "Rao", score: 91 }];
//   const csv = toCSV(rows, { bom: true });           // string
//   exportFile(csv, { filename: "scores.csv", mime: "text/csv" });
//
//   const json = toJSON(rows, { pretty: 2 });         // string
//   exportFile(json, { filename: "scores.json", mime: "application/json" });
//
//   const tsv = toTSV(rows);                          // string
//   const md  = toMarkdownTable(rows);                // string

export type Row = Record<string, any>;

export type Column =
  | string                                 // property key (header inferred from key)
  | { key: string; header?: string; map?: (v: any, row?: Row, i?: number) => any };

export interface TabularOptions {
  columns?: Column[];                      // order + transforms
  includeHeader?: boolean;                 // default true
  bom?: boolean;                           // prepend UTF-8 BOM (good for Excel) default false
  // formatting
  dateFormatter?: (d: Date) => string;     // default ISO 8601
  numberFormatter?: (n: number) => string; // default String(n)
  nullValue?: string;                      // default ""
  // value stringifier fallback
  valueStringifier?: (v: any) => string;
}

export interface JSONOptions {
  pretty?: number | boolean;               // 2 | true means 2-space
  bom?: boolean;                           // prepend BOM
}

export interface ExportFileOptions {
  filename?: string;                       // default "export.txt"
  mime?: string;                           // default "text/plain;charset=utf-8"
  // Node-like fallback (if available). If not present, we just return false.
  nodeWriteFileSync?: (path: string, data: string | Uint8Array) => void;
}

/* ------------------------------ Column utils ------------------------------ */

function normalizeColumns(rows: Row[], cols?: Column[]): { key: string; header: string; map?: Column extends { map: any } ? any : ((v: any, r?: Row, i?: number) => any) }[] {
  if (cols && cols.length) {
    return cols.map((c) =>
      typeof c === "string" ? { key: c, header: humanizeHeader(c) } : { key: c.key, header: c.header ?? humanizeHeader(c.key), map: c.map }
    );
  }
  // infer columns from first row keys (stable order)
  const first = rows.find(r => r && typeof r === "object");
  const keys = first ? Object.keys(first) : [];
  return keys.map(k => ({ key: k, header: humanizeHeader(k) }));
}

function humanizeHeader(key: string): string {
  // "user_name" -> "User Name", "userName" -> "User Name"
  const spaced = key
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* ------------------------------ Value format ------------------------------ */

function defaultStringifier(v: any, opts: TabularOptions, row?: Row, i?: number): string {
  const nf = opts.numberFormatter ?? ((n: number) => String(n));
  const df = opts.dateFormatter ?? ((d: Date) => d.toISOString());
  const nulls = opts.nullValue ?? "";

  if (v === null || v === undefined) return nulls;
  const t = typeof v;

  if (t === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (!Number.isFinite(v)) return String(v);
    return nf(v);
  }
  if (t === "boolean") return v ? "true" : "false";
  if (t === "string") return v;
  if (v instanceof Date) return df(v as Date);
  if (typeof (v as any).toISOString === "function" && String(v).includes("T")) {
    // e.g., dayjs-like objects
    try { return (v as any).toISOString(); } catch {}
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function applyMap(val: any, col: { map?: (v: any, r?: Row, i?: number) => any }, row: Row, i: number) {
  return col.map ? col.map(val, row, i) : val;
}

/* --------------------------------- CSV/TSV -------------------------------- */

function escapeForCSV(s: string, sep: string): string {
  // Quote if contains sep, quote, newline, or leading/trailing spaces
  const needsQuote = s.includes(sep) || s.includes('"') || s.includes("\n") || s.includes("\r") || /^[ \t]|[ \t]$/.test(s);
  if (!needsQuote) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function toDelimited(rows: Row[], sep: string, options?: TabularOptions): string {
  const opts: TabularOptions = options || {};
  const cols = normalizeColumns(rows, opts.columns);
  const str = opts.valueStringifier ?? ((v: any, r?: Row, i?: number) => defaultStringifier(v, opts, r, i));
  const includeHeader = opts.includeHeader !== false; // default true
  const bom = opts.bom === true;

  const out: string[] = [];
  if (includeHeader) {
    out.push(cols.map(c => escapeForCSV(c.header, sep)).join(sep));
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const line = cols.map(c => {
      const raw = applyMap((r as any)[c.key], c as any, r, i);
      const s = str(raw, r, i);
      return escapeForCSV(s, sep);
    }).join(sep);
    out.push(line);
  }

  const body = out.join("\n");
  return bom ? `\uFEFF${body}` : body;
}

export function toCSV(rows: Row[], options?: TabularOptions): string {
  return toDelimited(rows, ",", options);
}

export function toTSV(rows: Row[], options?: TabularOptions): string {
  // For TSV, we still use CSV escaping rules but with tab as separator
  return toDelimited(rows, "\t", options);
}

/* ---------------------------------- JSON ---------------------------------- */

export function toJSON(rows: any, options?: JSONOptions): string {
  const pretty = options?.pretty === true ? 2 : (typeof options?.pretty === "number" ? options!.pretty : 0);
  const bom = options?.bom === true;
  let s: string;
  try {
    s = JSON.stringify(rows, null, pretty);
  } catch {
    // Last resort stringify
    s = String(rows);
  }
  return bom ? `\uFEFF${s}` : s;
}

export function toJSONL(rows: Row[], options?: JSONOptions): string {
  const bom = options?.bom === true;
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      lines.push(JSON.stringify(rows[i] ?? {}));
    } catch {
      lines.push("{}");
    }
  }
  const body = lines.join("\n");
  return bom ? `\uFEFF${body}` : body;
}

/* ------------------------------ Markdown table ---------------------------- */

export function toMarkdownTable(rows: Row[], options?: TabularOptions): string {
  const opts: TabularOptions = options || {};
  const cols = normalizeColumns(rows, opts.columns);
  const str = opts.valueStringifier ?? ((v: any, r?: Row, i?: number) => defaultStringifier(v, opts, r, i));

  if (cols.length === 0) return "";

  const header = `| ${cols.map(c => c.header).join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const lines: string[] = [header, sep];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const row = cols.map(c => {
      const raw = applyMap((r as any)[c.key], c as any, r, i);
      const v = str(raw, r, i).replace(/\n/g, " "); // avoid row breaks
      return v;
    });
    lines.push(`| ${row.join(" | ")} |`);
  }
  return lines.join("\n");
}

/* --------------------------------- Export --------------------------------- */

export function exportFile(
  data: string | Uint8Array | ArrayBuffer,
  opts?: ExportFileOptions
): boolean {
  const filename = opts?.filename ?? "export.txt";
  const mime = opts?.mime ?? "text/plain;charset=utf-8";

  // Browser path
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    try {
      const blob = toBlob(data, mime);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    } catch {
      // fallthrough to Node-like
    }
  }

  // Node-like path (if write function provided)
  if (opts?.nodeWriteFileSync) {
    try {
      const buf = toBuffer(data);
      opts.nodeWriteFileSync(filename, buf);
      return true;
    } catch {
      return false;
    }
  }

  // No export mechanism
  return false;
}

function toBlob(data: string | Uint8Array | ArrayBuffer, mime: string): Blob {
  if (typeof Blob !== "undefined") {
    if (typeof data === "string") return new Blob([data], { type: mime });
    if (data instanceof Uint8Array) return new Blob([data], { type: mime });
    return new Blob([new Uint8Array(data)], { type: mime });
  }
  // Minimal fallback
  const anyBlob: any = function (parts: any[], opts?: any) { return { parts, opts }; };
  return anyBlob([data], { type: mime });
}

function toBuffer(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === "string") {
    // UTF-8 encode
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(data);
    }
    // simple encoder (ASCII-only fallback)
    const arr = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) arr[i] = data.charCodeAt(i) & 0xff;
    return arr;
  }
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

/* ------------------------------ Convenience ------------------------------- */

// Try to copy text to clipboard (browser only). Returns true on success.
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && (navigator as any).clipboard?.writeText) {
    try { await (navigator as any).clipboard.writeText(text); return true; } catch {}
  }
  // Legacy fallback
  if (typeof document !== "undefined") {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {}
  }
  return false;
}

// Quick pipelines
export function exportCSV(rows: Row[], filename = "export.csv", options?: TabularOptions): boolean {
  const csv = toCSV(rows, options);
  return exportFile(csv, { filename, mime: "text/csv;charset=utf-8" });
}

export function exportTSV(rows: Row[], filename = "export.tsv", options?: TabularOptions): boolean {
  const tsv = toTSV(rows, options);
  return exportFile(tsv, { filename, mime: "text/tab-separated-values;charset=utf-8" });
}

export function exportJSON(rows: any, filename = "export.json", options?: JSONOptions): boolean {
  const json = toJSON(rows, options);
  return exportFile(json, { filename, mime: "application/json;charset=utf-8" });
}

export function exportJSONL(rows: Row[], filename = "export.jsonl", options?: JSONOptions): boolean {
  const jsonl = toJSONL(rows, options);
  return exportFile(jsonl, { filename, mime: "application/json;charset=utf-8" });
}
