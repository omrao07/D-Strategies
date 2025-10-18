// damodaran/loader.ts
// Robust CSV loader + normalizer for Damodaran datasets (local file or HTTP/HTTPS).
// Zero deps. Works in Node 18+ (but also without global fetch).

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as https from "https";

/* =========================
   Types
   ========================= */

export type RowObject = Record<string, string | number | Date | null>;

export type LoadOptions = {
  /**
   * If true, the loader will try to write a copy of remote files to cacheDir
   * (filename derived from URL path). Ignored for local files.
   */
  cache?: boolean;
  /** Where to cache remote fetches (default: ".cache/damodaran") */
  cacheDir?: string;
  /**
   * If provided, trim the header cells with this function (e.g., to normalize
   * Damodaran's varying header formats). Default: normalizeHeader (below).
   */
  headerTransform?: (h: string) => string;
  /**
   * If true (default), attempt to coerce plain strings into numbers and dates.
   * Numbers with commas/percent signs are cleaned automatically.
   */
  coerce?: boolean;
  /** If true, drop completely empty rows. Default: true. */
  dropEmpty?: boolean;
};

export type CsvData = {
  headers: string[];
  rows: string[][];
};

export type Table<T extends RowObject = RowObject> = {
  name?: string;
  headers: string[];
  rows: T[];
  source: string;
};

export type Series = { ts: number; value: number }[];

export type Panel = Record<string, Series>;

/* =========================
   Small utilities
   ========================= */

const isFiniteNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function normalizeHeader(h: string) {
  return String(h || "")
    .replace(/\uFEFF/g, "")      // BOM
    .trim()
    .toLowerCase()
    .replace(/[%]/g, "pct")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function cleanNumber(s: string): number | null {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  // remove commas, spaces; convert % to fraction
  const isPercent = /%$/.test(t);
  const raw = t.replace(/,/g, "").replace(/%$/, "");
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return isPercent ? n / 100 : n;
}

function coerceCell(k: string, v: string): string | number | Date | null {
  if (v == null) return null;
  const t = v.trim();
  if (t === "" || /^na$/i.test(t) || /^n\/a$/i.test(t) || /^null$/i.test(t)) return null;

  // try date (yyyy-mm-dd / m/d/yyyy / month yyyy)
  const maybeDate =
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(t) ||
    /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(t) ||
    /^[A-Za-z]{3,9}\s+\d{4}$/.test(t);
  if (maybeDate) {
    const d = new Date(t);
    if (!isNaN(d.getTime())) return d;
  }
  // numeric (handles commas & %)
  const maybeNum = cleanNumber(t);
  if (maybeNum != null) return maybeNum;

  return t;
}

/* =========================
   HTTP/FS I/O (with timeouts)
   ========================= */

function readFileText(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.readFile(p, "utf8", (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function httpGetText(urlStr: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          method: "GET",
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + u.search,
          timeout: timeoutMs,
          headers: {
            "user-agent": "damodaran-loader/0.1",
            "accept": "text/csv, text/plain, */*",
          },
        },
        (res) => {
          if ((res.statusCode || 0) >= 300 && (res.statusCode || 0) < 400 && res.headers.location) {
            // follow one redirect
            const loc = new URL(res.headers.location, u).toString();
            res.resume();
            resolve(httpGetText(loc, timeoutMs));
            return;
          }
          if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
            reject(new Error(`HTTP ${res.statusCode} for ${urlStr}`));
            res.resume();
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        }
      );
      req.on("error", reject);
      req.on("timeout", () => { try { req.destroy(new Error("timeout")); } catch {} });
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function ensureDir(dir: string) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

/* =========================
   CSV Parser (robust enough)
   ========================= */

function parseCSV(text: string): CsvData {
  const rows: string[][] = [];
  let i = 0, field = "", row: string[] = [], inQuotes = false;

  function pushField() { row.push(field); field = ""; }
  function pushRow() { rows.push(row); row = []; }

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i++; continue; // closing quote
      }
      field += ch; i++; continue;
    }

    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { pushField(); i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { pushField(); pushRow(); i++; continue; }

    field += ch; i++;
  }
  // last field/row
  pushField();
  if (row.length > 1 || row[0] !== "") pushRow();

  // remove BOM from first cell if present
  if (rows.length && rows[0].length) {
    rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  }

  const headers = rows.shift() || [];
  return { headers, rows };
}

/* =========================
   Loader
   ========================= */

export class DamodaranLoader {
  private opts: Required<LoadOptions>;
  constructor(opts: LoadOptions = {}) {
    this.opts = {
      cache: opts.cache ?? false,
      cacheDir: opts.cacheDir ?? path.join(".cache", "damodaran"),
      headerTransform: opts.headerTransform ?? normalizeHeader,
      coerce: opts.coerce ?? true,
      dropEmpty: opts.dropEmpty ?? true,
    };
  }

  /**
   * Load CSV from local path or URL, parse it, and return a normalized table.
   */
  async loadCSV<T extends RowObject = RowObject>(source: string, name?: string): Promise<Table<T>> {
    const isUrl = /^https?:\/\//i.test(source);
    const txt = isUrl ? await this.fetchRemote(source) : await readFileText(source);
    const parsed = parseCSV(txt);

    const headers = parsed.headers.map(h => this.opts.headerTransform(h || ""));
    const rows: T[] = [];

    for (const r of parsed.rows) {
      const obj: any = {};
      let empty = true;
      for (let c = 0; c < headers.length; c++) {
        const key = headers[c] || `col_${c}`;
        const raw = r[c] ?? "";
        const val = this.opts.coerce ? coerceCell(key, raw) : raw;
        if (val !== null && String(val).trim() !== "") empty = false;
        obj[key] = val;
      }
      if (this.opts.dropEmpty && empty) continue;
      rows.push(obj as T);
    }

    return { name, headers, rows, source };
  }

  /** Fetch remote text with optional on-disk cache. */
  private async fetchRemote(url: string): Promise<string> {
    let text: string;
    const fileHint = url.split("?")[0].split("/").pop() || "remote.csv";
    const cacheFile = path.join(this.opts.cacheDir, fileHint);
    const useCache = this.opts.cache;

    if (useCache && fs.existsSync(cacheFile)) {
      try { return await readFileText(cacheFile); } catch {}
    }

    text = await httpGetText(url);

    if (useCache) {
      try {
        ensureDir(this.opts.cacheDir);
        fs.writeFileSync(cacheFile, text, "utf8");
      } catch {}
    }
    return text;
  }

  /* ---------- Helpers for common Damodaran-style transforms ---------- */

  /**
   * Convert a table with a date-like column and a numeric column into a time series.
   * dateCol can be a column key like "date", "year", "month_year", etc.
   * valueCol is the numeric column to extract.
   */
  toSeries(table: Table, dateCol: string, valueCol: string): Series {
    const out: Series = [];
    const dKey = this.opts.headerTransform(dateCol);
    const vKey = this.opts.headerTransform(valueCol);
    for (const r of table.rows) {
      const rawD = r[dKey];
      const rawV = r[vKey];
      const ts = this.asTimestamp(rawD);
      const v = typeof rawV === "number" ? rawV : cleanNumber(String(rawV ?? ""));
      if (ts != null && v != null) out.push({ ts, value: v });
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  /**
   * Convert a wide table (first column = key, rest columns = dates or categories)
   * into a panel keyed by row key (e.g., sector, country, ticker).
   */
  toPanel(table: Table, keyCol: string): Panel {
    const panel: Panel = {};
    const kKey = this.opts.headerTransform(keyCol);

    // Guess which headers are dates (skip keyCol)
    const dateCols = table.headers.filter(h => h !== kKey && this.isDateHeader(h));
    const dateTs = dateCols.map(h => ({ h, ts: this.asTimestamp(h) })).filter(x => x.ts != null);

    for (const r of table.rows) {
      const keyRaw = r[kKey];
      if (keyRaw == null) continue;
      const key = String(keyRaw).trim();
      const series: Series = [];
      for (const { h, ts } of dateTs) {
        const v = r[h];
        const num = typeof v === "number" ? v : cleanNumber(String(v ?? ""));
        if (ts != null && num != null) series.push({ ts, value: num });
      }
      if (series.length) panel[key] = series.sort((a, b) => a.ts - b.ts);
    }
    return panel;
  }

  /* ---------- Loose parsing help ---------- */

  private isDateHeader(h: string): boolean {
    // Try year-only (e.g., "1990", "2023"), yyyy-mm, yyyy-mm-dd, Mon YYYY
    const t = h.trim();
    return /^\d{4}$/.test(t) ||
           /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?$/.test(t) ||
           /^[A-Za-z]{3,9}\s+\d{4}$/.test(t);
  }

  private asTimestamp(x: unknown): number | null {
    if (x == null) return null;
    if (x instanceof Date) return x.getTime();
    const s = String(x).trim();
    if (!s) return null;

    // year-only -> Jan 1st UTC
    if (/^\d{4}$/.test(s)) {
      const ts = Date.UTC(Number(s), 0, 1);
      return Number.isFinite(ts) ? ts : null;
    }
    // try generic Date parsing
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.getTime();

    // accept Excel-like serial? (rare in Damodaran CSVs but harmless)
    const n = Number(s);
    if (Number.isFinite(n) && n > 10_000) {
      // treat as unix ms if it looks like one
      return n > 1e10 ? n : n * 1000;
    }
    return null;
  }
}

/* =========================
   Convenience presets (you can override URLs/paths)
   ========================= */

/**
 * Example presets with typical Damodaran datasets.
 * Replace the URLs with your mirrors if you prefer.
 */
export const Presets = {
  // Implied equity risk premium (historical monthly)
  impliedERP: {
    url: "http://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/implpr.html", // often an HTML table; you may scrape to CSV upstream
    // If you already have a CSV mirror, point `url` to that CSV.
    // Use loader.toSeries(table, "date", "erp") after you normalize headers.
  },
  // Country risk premiums (by rating)
  countryRiskPremiumsCSV:
    "http://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/ctryprem.csv",
  // Industry margins / multiples (US)
  usIndustryMarginsCSV:
    "http://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/margin.html", // usually HTML; mirror to CSV recommended
  // Cost of capital by sector (global/US variants)
  costOfCapitalCSV:
    "http://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/wacc.html" // HTML; mirror to CSV recommended
} as const;

/* =========================
   Minimal demo (optional)
   ========================= */

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const loader = new DamodaranLoader({ cache: true });

    // Example: load a pure CSV (works out-of-the-box)
    const src =
      process.env.DAMODARAN_CRP_CSV ??
      "http://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/ctryprem.csv";

    try {
      const table = await loader.loadCSV(src, "country_risk_premiums");
      // Heuristic: if the CSV has a column like "country" and multiple numeric columns (spreads),
      // we can build a panel keyed by country.
      const panel = loader.toPanel(table, "country");
      const example = Object.keys(panel).slice(0, 3).reduce((o, k) => (o[k] = panel[k], o), {} as Panel);
      console.log("Loaded headers:", table.headers.slice(0, 8));
      console.log("Example panel keys:", Object.keys(example));
    } catch (e: any) {
      console.error("demo load failed:", e?.message || e);
      console.error("If the URL is HTML (not CSV), mirror it to a CSV or point to a local CSV path.");
    }
  })();
}