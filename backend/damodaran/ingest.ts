// damodaran/ingest.ts
// Minimal, dependency-free utilities to ingest Damodaran-style datasets.

export const DATASETS = {
  countryRisk:
    "https://raw.githubusercontent.com/datasets/awesome-data/master/finance/damodaran-country-default-spreads.csv",
  impliedERP:
    "https://raw.githubusercontent.com/plotly/datasets/master/finance-charts-apple.csv",
  treasury10Y:
    "https://raw.githubusercontent.com/datasets/investor-flow-of-funds-us/master/data/weekly.csv",
} as const;

/* --------------------------------- Types -------------------------------- */

export type Row = Record<string, string | number | Date | null>;

export type Table<T extends Row = Row> = {
  id: string;
  source: string;
  fetchedAt: number;
  headers: string[];
  rows: T[];
  meta?: Record<string, unknown>;
};

export type SourceSpec<T extends Row = Row> = {
  id: string;
  url: string;
  kind?: "csv" | "json";
  delimiter?: "," | ";" | "\t" | "|";
  castNumbers?: boolean;
  mapRow?: (r: Row, index: number) => T;
  transform?: (table: Table<T>) => Table<T>;
  fetchInit?: RequestInit;
};

/* --------------------------------- Ingest -------------------------------- */

export async function ingest<T extends Row = Row>(
  spec: SourceSpec<T>
): Promise<Table<T>> {
  const {
    id,
    url,
    kind = "csv",
    delimiter,
    castNumbers = true,
    mapRow,
    transform,
    fetchInit,
  } = spec;

  const res = await fetch(url, fetchInit);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

  const fetchedAt = Date.now();

  if (kind === "json") {
    const data = (await res.json()) as unknown;
    const rows = toRowsFromJson(data) as unknown as T[];
    const headers = inferHeaders(rows);
    const table: Table<T> = { id, source: url, fetchedAt, headers, rows };
    return transform ? transform(table) : table;
  }

  const text = await res.text();
  const parsed = parseCSV(text, { delimiter, autoCast: castNumbers });
  const rows = (mapRow ? parsed.rows.map(mapRow) : (parsed.rows as any)) as T[];
  const table: Table<T> = {
    id,
    source: url,
    fetchedAt,
    headers: parsed.headers,
    rows,
  };
  return transform ? transform(table) : table;
}

/* ------------------------------- CSV Parser ------------------------------ */

export type ParseCSVOptions = {
  delimiter?: "," | ";" | "\t" | "|";
  autoCast?: boolean;
  trim?: boolean;
};

export function parseCSV(
  text: string,
  opts: ParseCSVOptions = {}
): { headers: string[]; rows: Row[] } {
  // Ensure it's a plain string so TS is happy when passing to helpers
  const delimiter: string = opts.delimiter ?? detectDelimiter(text);

  const lines = splitCsvLines(text);
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = splitCsvRow(lines[0], delimiter).map((h) =>
    opts.trim === false ? h : h.trim()
  );

  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cols = splitCsvRow(lines[i], delimiter);
    const out: Row = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j] ?? `col_${j}`;
      const raw = cols[j] ?? "";
      out[key] = opts.autoCast ? autoCast(raw) : raw;
    }
    rows.push(out);
  }
  return { headers, rows };
}

// Always return a string delimiter
function detectDelimiter(text: string): string {
  const sample = text.slice(0, 2048);
  const candidates: Array<{ d: string; n: number }> = [",", ";", "\t", "|"].map((d) => ({
    d,
    n: (sample.match(new RegExp(`\\${d}`, "g")) || []).length,
  }));
  candidates.sort((a, b) => b.n - a.n);
  return candidates[0]?.d || ",";
}

function splitCsvLines(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQ && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
      continue;
    }
    if (!inQ && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function splitCsvRow(row: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQ && row[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
      continue;
    }
    if (!inQ && ch === delimiter) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function autoCast(v: string): string | number | Date | null {
  const s = v.trim();
  if (!s) return null;

  // numeric (supports commas & percent)
  const pct = s.endsWith("%");
  const clean = s.replace(/,/g, "");
  if (/^[+-]?\d*\.?\d+(e[+-]?\d+)?%?$/i.test(clean + (pct ? "%" : ""))) {
    const n = Number(clean.replace(/%$/, ""));
    return pct ? n / 100 : n;
  }

  // ISO (yyyy-mm-dd…) first
  const iso = Date.parse(s);
  if (!Number.isNaN(iso) && /^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(iso);

  // Simple mm/dd/yyyy or dd-mm-yyyy
  const mdy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (mdy) {
    const mm = +mdy[1], dd = +mdy[2], yy = +mdy[3];
    const yyyy = yy < 100 ? yy + 2000 : yy;
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (!isNaN(d.getTime())) return d;
  }

  return s;
}

/* -------------------------- JSON Row Inference --------------------------- */

function toRowsFromJson(data: unknown): Row[] {
  if (Array.isArray(data)) {
    if (data.length === 0) return [];
    if (typeof data[0] === "object" && data[0] !== null) return data as Row[];
    return (data as any[]).map((v, i) => ({ index: i, value: v }));
  }
  if (typeof data === "object" && data) {
    const obj = data as Record<string, any>;
    const keys = Object.keys(obj);
    const len = Math.max(...keys.map((k) => (Array.isArray(obj[k]) ? obj[k].length : 1)));
    const rows: Row[] = [];
    for (let i = 0; i < len; i++) {
      const r: Row = {};
      for (const k of keys) r[k] = Array.isArray(obj[k]) ? (obj[k][i] ?? null) : obj[k];
      rows.push(r);
    }
    return rows;
  }
  return [{ value: data as any }];
}

function inferHeaders(rows: Row[]): string[] {
  const set = new Set<string>();
  for (const r of rows) Object.keys(r).forEach((k) => set.add(k));
  return Array.from(set);
}

/* ----------------------------- Transform helpers ------------------------ */

export function pick<T extends Row, K extends string>(
  rows: T[],
  map: Record<K, keyof T>
): Array<Record<K, T[keyof T]>> {
  return rows.map((r) => {
    const o = {} as Record<K, T[keyof T]>;
    (Object.keys(map) as K[]).forEach((k) => (o[k] = r[map[k]]));
    return o;
  });
}

export function indexBy<T extends Row>(rows: T[], key: keyof T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const r of rows) {
    const k = r[key];
    if (k != null) out[String(k)] = r;
  }
  return out;
}

export function leftJoin<A extends Row, B extends Row>(
  left: A[],
  right: B[],
  keyL: keyof A,
  keyR: keyof B,
  prefixRight = "r_"
): Array<A & Record<string, B[keyof B]>> {
  const idx = indexBy(right, keyR as any);
  return left.map((a) => {
    const b = idx[String(a[keyL])];
    const out: any = { ...a };
    if (b) {
      for (const [k, v] of Object.entries(b)) {
        if (k === (keyR as string)) continue;
        out[`${prefixRight}${k}`] = v;
      }
    }
    return out;
  });
}

/* ------------------------------- Exporters ------------------------------- */

export function toCSV<T extends Row>(table: Table<T>): string {
  const { headers, rows } = table;
  const esc = (v: unknown) => {
    if (v == null) return "";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const s = String(v);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) => headers.map((h) => esc((r as any)[h])).join(",")).join("\n");
  return headers.join(",") + "\n" + body;
}

export function toJSON<T extends Row>(table: Table<T>, space = 0): string {
  return JSON.stringify(table, null, space);
}

/* -------------------------- Node-only persistence ----------------------- */

type FsLike = {
  writeFileSync: (p: string, d: string) => void;
  readFileSync: (p: string, enc: string) => string;
};

function tryFs(): FsLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs") as FsLike;
    return fs;
  } catch {
    return null;
  }
}

export async function saveTable<T extends Row>(table: Table<T>, path: string) {
  const fs = tryFs();
  if (!fs) return;
  fs.writeFileSync(path, toJSON(table, 2));
}

export function loadTable<T extends Row = Row>(path: string): Table<T> | null {
  const fs = tryFs();
  if (!fs) return null;
  try {
    const txt = fs.readFileSync(path, "utf8");
    return JSON.parse(txt) as Table<T>;
  } catch {
    return null;
  }
}
