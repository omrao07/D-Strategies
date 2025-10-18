// data/csv feed.ts
// Robust CSV feed (parse + load + stream + map) with zero deps.
// Handles quotes, escaped quotes, newlines-in-fields, header inference,
// optional gzip, file watching, and typed casting.

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

/* =========================
   Types
   ========================= */

export type Row = Record<string, any>;

export type CastHint = "string" | "number" | "boolean" | "date" | "json";

export type Schema = {
  /** Column order to use; if omitted, inferred from header line. */
  columns?: string[];
  /** Per-column cast hints. */
  cast?: Record<string, CastHint>;
  /** Optional renames: source -> target column name. */
  rename?: Record<string, string>;
  /** Drop unknown columns (default false). */
  dropUnknown?: boolean;
  /** Trim header names (default true). */
  trimHeaders?: boolean;
};

export type ParseOptions = {
  sep?: string;     // default ","
  eol?: "\n" | "\r\n" | "\r"; // autodetect by default
  quote?: string;   // default '"'
  header?: boolean; // default true
  schema?: Schema;
  /** Skip empty lines (default true) */
  skipEmpty?: boolean;
};

export type LoadOptions = ParseOptions & {
  /** If true, treat input as gzipped (or autodetect by .gz extension). */
  gzip?: boolean;
  /** Limit rows (for previews). */
  limit?: number;
};

export type WatchHandle = { close: () => void };

export type Mapper<T> = (row: Row, idx: number) => T | undefined;

export type Feed<T = Row> = {
  /** Load all rows into memory (obeys opts.limit). */
  loadAll: (opts?: LoadOptions) => Promise<T[]>;
  /** Async iterator streaming rows (line-by-line, handles quoted rows). */
  stream: (opts?: LoadOptions) => AsyncGenerator<T, void, unknown>;
  /** Return cached rows if already loaded. */
  cache: () => T[] | null;
  /** Clear in-memory cache. */
  clearCache: () => void;
  /** Watch underlying file; callback gets called on change (debounced). */
  watch: (onChange: () => void, debounceMs?: number) => WatchHandle;
};

/* =========================
   Utilities
   ========================= */

const DEFAULT_SEP = ",";
const DEFAULT_QUOTE = '"';

const isBlank = (v: any) => v === null || v === undefined || v === "";

function detectGzipByExt(p: string) {
  return /\.gz$/i.test(p);
}

function ensureString(input: Buffer | string): string {
  return Buffer.isBuffer(input) ? input.toString("utf8") : input;
}

function autoEOL(sample: string): "\n" | "\r\n" | "\r" {
  if (sample.includes("\r\n")) return "\r\n";
  if (sample.includes("\n")) return "\n";
  return "\r";
}

function castValue(v: string, hint?: CastHint) {
  if (v === "" || v === undefined || v === null) return undefined;

  switch (hint) {
    case "number": {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    case "boolean": {
      const s = String(v).trim().toLowerCase();
      if (s === "true" || s === "1" || s === "yes") return true;
      if (s === "false" || s === "0" || s === "no") return false;
      return undefined;
    }
    case "date": {
      const t = Date.parse(v);
      return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
    }
    case "json": {
      try { return JSON.parse(v); } catch { return undefined; }
    }
    case "string":
    default:
      return String(v);
  }
}

function renameRow(row: Row, rename?: Record<string, string>): Row {
  if (!rename) return row;
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    const to = rename[k] ?? k;
    out[to] = v;
  }
  return out;
}

function filterColumns(row: Row, allowed?: string[], dropUnknown?: boolean): Row {
  if (!allowed || !dropUnknown) return row;
  const out: Row = {};
  for (const k of allowed) if (k in row) out[k] = row[k];
  return out;
}

/* =========================
   Core CSV parser (RFC-ish)
   ========================= */

export function parseCSV(
  text: string,
  opts: ParseOptions = {}
): { rows: Row[]; columns: string[] } {
  const sep = opts.sep ?? DEFAULT_SEP;
  const quote = opts.quote ?? DEFAULT_QUOTE;
  const skipEmpty = opts.skipEmpty !== false; // default true
  const schema = opts.schema ?? {};
  const trimHeaders = schema.trimHeaders !== false; // default true
  const eol = opts.eol ?? autoEOL(text);

  let i = 0;
  const N = text.length;

  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => {
    // If the row is entirely empty and skipping enabled, ignore it
    if (skipEmpty && row.every(c => c === "")) { row = []; return; }
    records.push(row);
    row = [];
  };

  while (i < N) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === quote) {
        // lookahead for escaped quote
        if (i + 1 < N && text[i + 1] === quote) {
          field += quote;
          i += 2;
          continue;
        }
        // end quote
        inQuotes = false;
        i++;
        continue;
      } else {
        field += ch;
        i++;
        continue;
      }
    } else {
      if (ch === quote) {
        inQuotes = true;
        i++;
        continue;
      }
      if (ch === sep) {
        pushField();
        i++;
        continue;
      }
      // EOL handling (support \n or \r\n or \r)
      if (ch === "\n" || ch === "\r") {
        // Normalize any of \n | \r | \r\n
        if (ch === "\r" && i + 1 < N && text[i + 1] === "\n") i++;
        pushField();
        pushRow();
        i++;
        continue;
      }

      field += ch;
      i++;
    }
  }
  // last field/row
  pushField();
  pushRow();

  if (!records.length) return { rows: [], columns: schema.columns ?? [] };

  // Headers
  let headers: string[];
  if (opts.header !== false) {
    headers = records.shift()!.map(h => (trimHeaders ? h.trim() : h));
  } else {
    const width = records[0]?.length ?? 0;
    headers = schema.columns ?? Array.from({ length: width }, (_, k) => `col${k}`);
  }

  const columns = schema.columns ?? headers;

  const castHints = schema.cast ?? {};
  const rename = schema.rename;
  const dropUnknown = schema.dropUnknown === true;

  const rows: Row[] = [];
  for (const rec of records) {
    const r: Row = {};
    for (let c = 0; c < columns.length; c++) {
      const srcName = headers[c] ?? `col${c}`;
      const dstName = columns[c] ?? srcName;
      const raw = rec[c] ?? "";
      const hint = castHints[dstName] ?? castHints[srcName];
      r[dstName] = castValue(raw, hint);
    }

    // If schema.columns shorter than the row, grab extras unless dropUnknown
    if (!dropUnknown && records.length && headers.length > columns.length) {
      for (let extra = columns.length; extra < headers.length; extra++) {
        const n = headers[extra];
        r[n] = castValue(rec[extra], castHints[n]);
      }
    }

    rows.push(filterColumns(renameRow(r, rename), columns, dropUnknown));
  }

  return { rows, columns };
}

/* =========================
   Stream parser (generator)
   ========================= */

export async function* streamCSV(
  input: AsyncIterable<Buffer> | NodeJS.ReadableStream,
  opts: ParseOptions = {}
): AsyncGenerator<Row, void, unknown> {
  const sep = opts.sep ?? DEFAULT_SEP;
  const quote = opts.quote ?? DEFAULT_QUOTE;
  const skipEmpty = opts.skipEmpty !== false;
  const schema = opts.schema ?? {};
  const trimHeaders = schema.trimHeaders !== false;

  let buf = "";
  let headers: string[] | null = null;

  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const emitRow = (rec: string[]) => {
    if (skipEmpty && rec.every(c => c === "")) return;
    if (!headers) {
      headers = (opts.header !== false)
        ? rec.map(h => (trimHeaders ? h.trim() : h))
        : (schema.columns ?? rec.map((_, i) => `col${i}`));
      return;
    }
    // Map to object
    const cols = schema.columns ?? headers;
    const castHints = schema.cast ?? {};
    const rename = schema.rename;
    const dropUnknown = schema.dropUnknown === true;

    const out: Row = {};
    for (let c = 0; c < cols.length; c++) {
      const src = headers[c] ?? `col${c}`;
      const dst = cols[c] ?? src;
      const raw = rec[c] ?? "";
      const hint = castHints[dst] ?? castHints[src];
      out[dst] = castValue(raw, hint);
    }
    if (!dropUnknown && headers.length > cols.length) {
      for (let extra = cols.length; extra < headers.length; extra++) {
        const n = headers[extra];
        out[n] = castValue(rec[extra], castHints[n]);
      }
    }
    yieldObj(filterColumns(renameRow(out, rename), cols, dropUnknown));
  };

  function yieldObj(obj: Row) {
    q.push(obj);
  }
  const q: Row[] = [];

  const feedChunk = (chunk: string) => {
    buf += chunk;

    let i = 0;
    while (i < buf.length) {
      const ch = buf[i];

      if (inQuotes) {
        if (ch === quote) {
          if (i + 1 < buf.length && buf[i + 1] === quote) {
            field += quote; i += 2; continue;
          }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      } else {
        if (ch === quote) { inQuotes = true; i++; continue; }
        if (ch === sep) { row.push(field); field = ""; i++; continue; }
        if (ch === "\n" || ch === "\r") {
          if (ch === "\r" && i + 1 < buf.length && buf[i + 1] === "\n") i++;
          row.push(field); field = "";
          emitRow(row);
          row = [];
          i++; continue;
        }
        i++;
        field += ch;
      }
    }
    // Keep any partial field in `field`, partial row in `row`
    buf = "";
  };

  // Consume chunks
  for await (const chunk of input as any) {
    feedChunk(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    while (q.length) yield q.shift()!;
  }

  // Flush final row if present
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    emitRow(row);
    while (q.length) yield q.shift()!;
  }
}

/* =========================
   Feed factory
   ========================= */

export function createCSVFeed<T = Row>(
  source: { file?: string; buffer?: Buffer; text?: string },
  map?: Mapper<T>
): Feed<T> {
  let _cache: T[] | null = null;

  const applyMap = (r: Row, i: number): T | undefined => (map ? map(r, i) : (r as any as T));

  async function loadAll(opts: LoadOptions = {}): Promise<T[]> {
    if (_cache) return _cache;
    const { rows } = await readAll(source, opts);
    const out: T[] = [];
    for (let i = 0; i < rows.length; i++) {
      const v = applyMap(rows[i], i);
      if (v !== undefined) out.push(v);
      if (opts.limit && out.length >= opts.limit) break;
    }
    _cache = out;
    return out;
  }

  async function* stream(opts: LoadOptions = {}): AsyncGenerator<T, void, unknown> {
    let idx = 0;
    for await (const r of streamAll(source, opts)) {
      const v = applyMap(r, idx++);
      if (v !== undefined) {
        yield v;
        if (opts.limit && idx >= opts.limit) break;
      }
    }
  }

  function cache() { return _cache; }
  function clearCache() { _cache = null; }

  function watch(onChange: () => void, debounceMs = 200): WatchHandle {
    if (!source.file) return { close: () => {} };
    const abs = path.resolve(source.file);
    let t: NodeJS.Timeout | null = null;
    const w = fs.watch(abs, () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { clearCache(); onChange(); }, debounceMs);
    });
    return { close: () => w.close() };
  }

  return { loadAll, stream, cache, clearCache, watch };
}

/* =========================
   I/O helpers
   ========================= */

async function readAll(
  source: { file?: string; buffer?: Buffer; text?: string },
  opts: LoadOptions
): Promise<{ rows: Row[]; columns: string[] }> {
  const text = await readText(source, opts);
  const out = parseCSV(text, opts);
  if (opts.limit && out.rows.length > opts.limit) {
    out.rows = out.rows.slice(0, opts.limit);
  }
  return out;
}

async function* streamAll(
  source: { file?: string; buffer?: Buffer; text?: string },
  opts: LoadOptions
): AsyncGenerator<Row, void, unknown> {
  const iter = await makeStream(source, opts);
  for await (const row of streamCSV(iter, opts)) {
    yield row;
  }
}

async function readText(source: { file?: string; buffer?: Buffer; text?: string }, opts: LoadOptions): Promise<string> {
  if (source.text) return source.text;
  if (source.buffer) {
    const buf = opts.gzip ? zlib.gunzipSync(source.buffer) : source.buffer;
    return buf.toString("utf8");
  }
  if (source.file) {
    const abs = path.resolve(source.file);
    const gz = opts.gzip ?? detectGzipByExt(abs);
    const data = fs.readFileSync(abs);
    return gz ? zlib.gunzipSync(data).toString("utf8") : data.toString("utf8");
  }
  throw new Error("csv feed: no source provided");
}

async function makeStream(
  source: { file?: string; buffer?: Buffer; text?: string },
  opts: LoadOptions
): Promise<NodeJS.ReadableStream> {
  if (source.text) {
    // Make a tiny readable from string
    const { Readable } = await import("stream");
    return Readable.from([source.text]);
  }
  if (source.buffer) {
    const { Readable } = await import("stream");
    const buf = opts.gzip ? zlib.gunzipSync(source.buffer) : source.buffer;
    return Readable.from([buf]);
  }
  if (source.file) {
    const abs = path.resolve(source.file);
    const gz = opts.gzip ?? detectGzipByExt(abs);
    const rs = fs.createReadStream(abs);
    return gz ? rs.pipe(zlib.createGunzip()) : rs;
  }
  throw new Error("csv feed: no source provided");
}

/* =========================
   Common mappers (optional)
   ========================= */

/** Map a row to OHLCV candle (common market data). */
export type OHLCV = {
  ts: string; o: number; h: number; l: number; c: number; v?: number; symbol?: string;
};

export function mapToOHLCV(row: Row): OHLCV | undefined {
  // Try common header variants
  const ts = row.ts ?? row.time ?? row.date ?? row.datetime ?? row.timestamp;
  const o = row.o ?? row.open;
  const h = row.h ?? row.high;
  const l = row.l ?? row.low;
  const c = row.c ?? row.close;
  const v = row.v ?? row.volume;

  const tsISO = typeof ts === "string" ? (Number.isFinite(Date.parse(ts)) ? new Date(ts).toISOString() : ts)
              : typeof ts === "number" ? new Date(ts).toISOString()
              : undefined;

  if (tsISO && Number.isFinite(o) && Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(c)) {
    return { ts: tsISO, o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v ?? 0) || undefined, symbol: row.symbol ?? row.ticker };
  }
  return undefined;
}

/** Utility: create a feed directly for OHLCV CSV files. */
export function createOHLCVFeed(source: { file?: string; buffer?: Buffer; text?: string }, schema?: Schema) {
  return createCSVFeed<OHLCV>(source, (r) => mapToOHLCV(r), /* map */);
}

/* =========================
   Demo (optional)
   ========================= */

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    // demo: load a CSV string
    const csv = `date,open,high,low,close,volume
2025-01-02,100,105,99,103,12345
2025-01-03,103,106,101,104,9876`;
    const feed = createCSVFeed({ text: csv }, r => r);
    console.log(await feed.loadAll());
    for await (const r of feed.stream()) console.log("row:", r);
  })().catch(e => console.error(e));
}