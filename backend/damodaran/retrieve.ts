// damodaran/retrieve.ts
// One-stop retriever for Damodaran-style datasets (Node + Browser).
// Dependency-free. Tiny TTL cache with 304 support.

import { parseCSV, type Table, type Row } from "./ingest";

/* ------------------------------- Datasets -------------------------------- */

export const DATASETS = {
  countryRisk:
    "https://raw.githubusercontent.com/datasets/awesome-data/master/finance/damodaran-country-default-spreads.csv",
  impliedERP:
    "https://raw.githubusercontent.com/plotly/datasets/master/finance-charts-apple.csv",
  treasury10Y:
    "https://raw.githubusercontent.com/datasets/investor-flow-of-funds-us/master/data/weekly.csv",
} as const;

/* --------------------------------- Types --------------------------------- */

export type Kind = "csv" | "json";

export type Source<T extends Row = Row> = {
  id: string;
  url: string;
  kind?: Kind;
  delimiter?: "," | ";" | "\t" | "|";
  autoCast?: boolean;
  mapRow?: (r: Row, i: number) => T;
  transform?: (t: Table<T>) => Table<T>;
};

type Normalized<T extends Row = Row> = Required<Pick<Source<T>, "id" | "url">> & {
  kind: Kind;
  delimiter?: string;          // normalized to string or undefined
  autoCast: boolean;
  mapRow?: (r: Row, i: number) => T;
  transform?: (t: Table<T>) => Table<T>;
  ttl: number;
  force: boolean;
  fetchInit?: RequestInit;
  httpCache: boolean;
};

export type RetrieveOptions<T extends Row = Row> =
  | string
  | (Source<T> & {
      ttl?: number;
      force?: boolean;
      fetchInit?: RequestInit;
      httpCache?: boolean;
    });

export type RetrieveResult<T extends Row = Row> = {
  table: Table<T>;
  fromCache: boolean;
  notModified?: boolean;
};

/* ---------------------------------- Cache -------------------------------- */

type CacheEntry<T extends Row> = {
  table: Table<T>;
  expiresAt: number;
  etag?: string | null;
  lastModified?: string | null;
  inflight?: Promise<RetrieveResult<T>>;
};

const CACHE = new Map<string, CacheEntry<any>>();

export function getCached<T extends Row = Row>(id: string): Table<T> | null {
  const e = CACHE.get(id) as CacheEntry<T> | undefined;
  return e ? e.table : null;
}

/* ------------------------------- Registry -------------------------------- */

const registry = new Map<string, Source<any>>([
  ["countryRisk", { id: "countryRisk", url: DATASETS.countryRisk, kind: "csv" }],
  ["impliedERP", { id: "impliedERP", url: DATASETS.impliedERP, kind: "csv" }],
  ["treasury10Y", { id: "treasury10Y", url: DATASETS.treasury10Y, kind: "csv" }],
]);

export function register<T extends Row = Row>(src: Source<T>) {
  registry.set(src.id, src);
}
export function listSources(): string[] {
  return Array.from(registry.keys());
}

/* -------------------------------- Retrieve ------------------------------- */

export async function retrieve<T extends Row = Row>(
  opts: RetrieveOptions<T>
): Promise<RetrieveResult<T>> {
  const normalized = normalizeOptions<T>(opts);

  const {
    id,
    url,
    kind,
    delimiter,          // string | undefined (OK)
    autoCast,
    mapRow,
    transform,
    ttl,
    force,
    fetchInit,
    httpCache,
  } = normalized;

  // cache
  let entry = CACHE.get(id) as CacheEntry<T> | undefined;
  const fresh = entry && Date.now() <= entry.expiresAt;

  if (entry && fresh && !force) {
    return { table: entry.table, fromCache: true };
  }

  if (entry?.inflight) return entry.inflight;

  if (!entry) {
    entry = {
      table: { id, source: url, fetchedAt: 0, headers: [], rows: [] } as Table<T>,
      expiresAt: 0,
    };
    CACHE.set(id, entry);
  }

  // headers (avoid relying on global Headers types)
  const headers: Record<string, string> = {};
  if (fetchInit?.headers) {
    try {
      // Works in modern runtimes; if not, we fall back to object-ish
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h = new (globalThis as any).Headers(fetchInit.headers);
      h.forEach((v: string, k: string) => (headers[k] = v));
    } catch {
      const raw = fetchInit.headers as Record<string, string>;
      for (const k in raw) headers[k.toLowerCase()] = String(raw[k]);
    }
  }
  if (httpCache) {
    if (entry.etag) headers["if-none-match"] = entry.etag;
    if (entry.lastModified) headers["if-modified-since"] = entry.lastModified;
  }

  const init: RequestInit = { ...fetchInit, headers };

  entry.inflight = (async () => {
    const res = await fetch(url, init);

    if (res.status === 304 && entry!.table.fetchedAt) {
      entry!.expiresAt = Date.now() + ttl;
      entry!.inflight = undefined;
      return { table: entry!.table, fromCache: true, notModified: true } as RetrieveResult<T>;
    }

    if (!res.ok) {
      if (entry!.table.fetchedAt) {
        entry!.expiresAt = Date.now() + Math.max(10_000, ttl / 4);
        entry!.inflight = undefined;
        return { table: entry!.table, fromCache: true } as RetrieveResult<T>;
      }
      throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    }

    const fetchedAt = Date.now();
    let table: Table<T>;

    if (kind === "json") {
      const data = (await res.json()) as unknown;
      const rows = jsonToRows<T>(data, mapRow);
      const headers = inferHeaders(rows);
      table = { id, source: url, fetchedAt, headers, rows };
    } else {
      const text = await res.text();
      const parsed = parseCSV(text, { delimiter: delimiter as any, autoCast });
      const rows = (mapRow ? parsed.rows.map(mapRow) : (parsed.rows as any)) as T[];
      table = { id, source: url, fetchedAt, headers: parsed.headers, rows };
    }

    if (transform) table = transform(table);

    entry!.table = table;
    entry!.expiresAt = fetchedAt + ttl;
    entry!.etag = res.headers.get("ETag");
    entry!.lastModified = res.headers.get("Last-Modified");
    entry!.inflight = undefined;

    return { table, fromCache: false } as RetrieveResult<T>;
  })();

  return entry.inflight;
}

/* -------------------------------- Helpers -------------------------------- */

function normalizeOptions<T extends Row = Row>(opts: RetrieveOptions<T>): Normalized<T> {
  const base: Omit<Normalized<T>, "id" | "url"> = {
    kind: "csv",
    autoCast: true,
    ttl: 5 * 60_000,
    force: false,
    httpCache: true,
  };

  if (typeof opts === "string") {
    if (opts.includes("://")) {
      return { ...base, id: opts, url: opts };
    }
    const reg = registry.get(opts);
    if (!reg) throw new Error(`Unknown dataset id: ${opts}`);
    return {
      ...base,
      id: reg.id,
      url: reg.url,
      kind: reg.kind ?? "csv",
      delimiter: reg.delimiter,
      autoCast: reg.autoCast ?? true,
      mapRow: reg.mapRow,
      transform: reg.transform,
    };
  }

  const id = opts.id || opts.url;
  return {
    ...base,
    id,
    url: opts.url,
    kind: opts.kind ?? "csv",
    delimiter: opts.delimiter,
    autoCast: opts.autoCast ?? true,
    mapRow: opts.mapRow,
    transform: opts.transform,
    ttl: opts.ttl ?? base.ttl,
    force: opts.force ?? base.force,
    fetchInit: opts.fetchInit,
    httpCache: opts.httpCache ?? base.httpCache,
  };
}

function jsonToRows<T extends Row = Row>(data: unknown, map?: (r: Row, i: number) => T): T[] {
  let rows: Row[];
  if (Array.isArray(data)) {
    rows = data as Row[];
    if (rows.length && typeof rows[0] !== "object") {
      rows = (data as any[]).map((v, i) => ({ index: i, value: v }));
    }
  } else if (typeof data === "object" && data) {
    const obj = data as Record<string, any>;
    const keys = Object.keys(obj);
    const len = Math.max(...keys.map((k) => (Array.isArray(obj[k]) ? obj[k].length : 1)));
    rows = [];
    for (let i = 0; i < len; i++) {
      const r: Row = {};
      for (const k of keys) {
        const v = obj[k];
        r[k] = Array.isArray(v) ? (v[i] ?? null) : v;
      }
      rows.push(r);
    }
  } else {
    rows = [{ value: data as any }];
  }
  return (map ? rows.map(map) : (rows as any)) as T[];
}

function inferHeaders(rows: Row[]): string[] {
  const set = new Set<string>();
  for (const r of rows) Object.keys(r).forEach((k) => set.add(k));
  return Array.from(set);
}

/* -------------------------------- Exports -------------------------------- */

export default {
  retrieve,
  getCached,
  register,
  listSources,
  DATASETS,
};
