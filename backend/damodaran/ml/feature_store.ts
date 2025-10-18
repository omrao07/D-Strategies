// ml/feature_store.ts
// Minimal Feature Store: in-memory & filesystem backends, TTL, pagination,
// CSV import/export, and light schema validation. No external deps.

import fs from "fs";
import path from "path";

/* ============================== Types =============================== */

export type Primitive = number | string | boolean | null;
export type FeatureMap = Record<string, Primitive>;

export interface FeatureRecord {
  key: string;                 // primary key (e.g., "AAPL|2025-10-10")
  ts: number;                  // ms since epoch
  ttlMs?: number;              // optional TTL
  features: FeatureMap;        // feature kv pairs
  meta?: Record<string, Primitive>; // optional metadata
}

export interface PutOptions {
  ttlMs?: number;              // override default TTL
  noOverwrite?: boolean;       // throw if key exists
}

export interface Query {
  prefix?: string;             // key prefix
  sinceTs?: number;            // ts >= sinceTs
  untilTs?: number;            // ts <= untilTs
  limit?: number;              // page size
  cursor?: string;             // opaque pagination cursor
  includeExpired?: boolean;    // include expired rows
}

export interface ListResult {
  items: FeatureRecord[];
  nextCursor?: string;
}

export interface Stats {
  namespace: string;
  version: string;
  count: number;
  expired: number;
  minTs?: number;
  maxTs?: number;
  approxBytes?: number;
}

/* ============================== Utils =============================== */

const isObj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const isPrim = (x: unknown): x is Primitive =>
  x === null || ["string", "number", "boolean"].includes(typeof x);

function validateRecord(r: FeatureRecord): void {
  if (!r || typeof r !== "object") throw new Error("record must be an object");
  if (typeof r.key !== "string" || !r.key) throw new Error("record.key must be a non-empty string");
  if (!Number.isFinite(r.ts)) throw new Error("record.ts must be a finite number (ms epoch)");
  if (!isObj(r.features)) throw new Error("record.features must be an object");
  for (const [k, v] of Object.entries(r.features)) {
    if (typeof k !== "string" || !isPrim(v)) throw new Error(`invalid feature '${k}'`);
  }
  if (r.meta && !isObj(r.meta)) throw new Error("record.meta must be an object if provided");
  if (r.ttlMs !== undefined && (!Number.isFinite(r.ttlMs) || r.ttlMs < 0))
    throw new Error("record.ttlMs must be a non-negative number if provided");
}

function isExpired(r: FeatureRecord, now = Date.now()): boolean {
  return !!r.ttlMs && now > r.ts + r.ttlMs;
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function toCursor(index: number): string {
  return Buffer.from(String(index), "utf8").toString("base64url");
}
function fromCursor(c?: string): number {
  if (!c) return 0;
  const s = Buffer.from(c, "base64url").toString("utf8");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function approxSizeOfRecord(r: FeatureRecord): number {
  try { return Buffer.byteLength(JSON.stringify(r)); } catch { return 0; }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/* ============================== CSV ================================ */

function csvEscape(s: string): string {
  if (s == null) return "";
  const needs = /[",\n]/.test(s);
  const esc = s.replace(/"/g, '""');
  return needs ? `"${esc}"` : esc;
}
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}
function safeJson(s?: string): any {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

/* ============================ Interface ============================= */

export interface FeatureStore {
  put(rec: FeatureRecord, opts?: PutOptions): Promise<void>;
  upsert(rec: FeatureRecord, merge?: boolean): Promise<void>;
  putBatch(recs: FeatureRecord[], opts?: PutOptions): Promise<void>;
  get(key: string): Promise<FeatureRecord | undefined>;
  delete(key: string): Promise<boolean>;
  list(q?: Query): Promise<ListResult>;
  stats(): Promise<Stats>;
  exportCSV(outFile: string, q?: Query): Promise<void>;
  importCSV(inFile: string, opts?: { ttlMsDefault?: number; merge?: boolean }): Promise<number>;
  gc(): Promise<{ removed: number }>;
  close(): Promise<void>;
}

/* ============================ In-Memory ============================== */

export class MemoryFeatureStore implements FeatureStore {
  private map = new Map<string, FeatureRecord>();
  constructor(
    private readonly namespace: string,
    private readonly version: string = "v1",
    private readonly ttlDefaultMs?: number
  ) {}

  async put(rec: FeatureRecord, opts?: PutOptions): Promise<void> {
    validateRecord(rec);
    if (opts?.noOverwrite && this.map.has(rec.key)) throw new Error(`key exists: ${rec.key}`);
    const copy = { ...rec, ttlMs: rec.ttlMs ?? opts?.ttlMs ?? this.ttlDefaultMs };
    this.map.set(copy.key, copy);
  }

  async upsert(rec: FeatureRecord, merge = true): Promise<void> {
    validateRecord(rec);
    const prev = this.map.get(rec.key);
    if (!prev || !merge) {
      const copy = { ...rec, ttlMs: rec.ttlMs ?? this.ttlDefaultMs };
      this.map.set(rec.key, copy);
      return;
    }
    const merged: FeatureRecord = {
      key: rec.key,
      ts: Math.max(prev.ts, rec.ts),
      ttlMs: rec.ttlMs ?? prev.ttlMs ?? this.ttlDefaultMs,
      features: { ...prev.features, ...rec.features },
      meta: { ...(prev.meta ?? {}), ...(rec.meta ?? {}) },
    };
    this.map.set(rec.key, merged);
  }

  async putBatch(recs: FeatureRecord[], opts?: PutOptions): Promise<void> {
    for (const r of recs) await this.put(r, opts);
  }

  async get(key: string): Promise<FeatureRecord | undefined> {
    const r = this.map.get(key);
    if (!r) return undefined;
    if (isExpired(r)) return undefined;
    return { ...r };
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }

  async list(q: Query = {}): Promise<ListResult> {
    const now = Date.now();
    const start = fromCursor(q.cursor);
    const items: FeatureRecord[] = [];
    const keys = Array.from(this.map.keys()).sort();
    let i = start;
    for (; i < keys.length; i++) {
      const k = keys[i];
      if (q.prefix && !k.startsWith(q.prefix)) continue;
      const r = this.map.get(k)!;
      if (!q.includeExpired && isExpired(r, now)) continue;
      if (q.sinceTs && r.ts < q.sinceTs) continue;
      if (q.untilTs && r.ts > q.untilTs) continue;
      items.push({ ...r });
      if (q.limit && items.length >= q.limit) { i++; break; }
    }
    return { items, nextCursor: i < keys.length ? toCursor(i) : undefined };
  }

  async stats(): Promise<Stats> {
    const now = Date.now();
    let count = 0, expired = 0, minTs = Infinity, maxTs = -Infinity, bytes = 0;
    for (const r of this.map.values()) {
      bytes += approxSizeOfRecord(r);
      if (isExpired(r, now)) { expired++; continue; }
      count++;
      if (r.ts < minTs) minTs = r.ts;
      if (r.ts > maxTs) maxTs = r.ts;
    }
    return {
      namespace: this.namespace,
      version: this.version,
      count,
      expired,
      minTs: isFinite(minTs) ? minTs : undefined,
      maxTs: isFinite(maxTs) ? maxTs : undefined,
      approxBytes: bytes,
    };
  }

  async exportCSV(outFile: string, q: Query = {}): Promise<void> {
    const { items } = await this.list({ ...q, includeExpired: true });
    const headers = ["key","ts","ttlMs","features","meta"];
    const lines = [headers.join(",")];
    for (const r of items) {
      lines.push([
        csvEscape(r.key),
        String(r.ts),
        r.ttlMs != null ? String(r.ttlMs) : "",
        csvEscape(JSON.stringify(r.features ?? {})),
        csvEscape(JSON.stringify(r.meta ?? {})),
      ].join(","));
    }
    ensureDir(path.dirname(outFile));
    fs.writeFileSync(outFile, lines.join("\n"), "utf8");
  }

  async importCSV(inFile: string, opts?: { ttlMsDefault?: number; merge?: boolean }): Promise<number> {
    const txt = fs.readFileSync(inFile, "utf8");
    const lines = txt.trim().split(/\r?\n/);
    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      const [key, tsStr, ttlStr, featuresStr, metaStr] = parseCsvLine(lines[i]);
      if (!key) continue;
      const ts = Number(tsStr);
      const ttl = ttlStr ? Number(ttlStr) : opts?.ttlMsDefault;
      const features = (safeJson(featuresStr) as FeatureMap) ?? {};
      const meta = safeJson(metaStr) as Record<string, Primitive> | undefined;
      const rec: FeatureRecord = { key, ts, ttlMs: ttl, features, meta };
      await this.upsert(rec, opts?.merge ?? true);
      count++;
    }
    return count;
  }

  async gc(): Promise<{ removed: number }> {
    const now = Date.now();
    let removed = 0;
    for (const [k, r] of this.map.entries()) {
      if (isExpired(r, now)) { this.map.delete(k); removed++; }
    }
    return { removed };
  }

  async close(): Promise<void> { /* noop */ }
}

/* =========================== Filesystem ============================== */

export class FSFeatureStore implements FeatureStore {
  private readonly dir: string;
  private readonly dataFile: string;
  private readonly index = new Map<string, FeatureRecord>();
  private initialized = false;

  constructor(
    rootDir: string,
    private readonly namespace: string,
    private readonly version: string = "v1",
    private readonly ttlDefaultMs?: number
  ) {
    this.dir = path.join(rootDir, sanitize(namespace), sanitize(version));
    this.dataFile = path.join(this.dir, "data.jsonl");
    ensureDir(this.dir);
  }

  private init(): void {
    if (this.initialized) return;
    if (!fs.existsSync(this.dataFile)) {
      fs.writeFileSync(this.dataFile, "", "utf8");
      this.initialized = true;
      return;
    }
    const lines = fs.readFileSync(this.dataFile, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as FeatureRecord;
        validateRecord(obj);
        this.index.set(obj.key, obj);
      } catch { /* ignore bad lines */ }
    }
    this.initialized = true;
  }

  private append(rec: FeatureRecord) {
    fs.appendFileSync(this.dataFile, JSON.stringify(rec) + "\n", "utf8");
  }

  async put(rec: FeatureRecord, opts?: PutOptions): Promise<void> {
    this.init();
    validateRecord(rec);
    if (opts?.noOverwrite && this.index.has(rec.key)) throw new Error(`key exists: ${rec.key}`);
    const copy = { ...rec, ttlMs: rec.ttlMs ?? opts?.ttlMs ?? this.ttlDefaultMs };
    this.index.set(copy.key, copy);
    this.append(copy);
  }

  async upsert(rec: FeatureRecord, merge = true): Promise<void> {
    this.init();
    validateRecord(rec);
    const prev = this.index.get(rec.key);
    if (!prev || !merge) {
      const copy = { ...rec, ttlMs: rec.ttlMs ?? this.ttlDefaultMs };
      this.index.set(copy.key, copy);
      this.append(copy);
      return;
    }
    const merged: FeatureRecord = {
      key: rec.key,
      ts: Math.max(prev.ts, rec.ts),
      ttlMs: rec.ttlMs ?? prev.ttlMs ?? this.ttlDefaultMs,
      features: { ...prev.features, ...rec.features },
      meta: { ...(prev.meta ?? {}), ...(rec.meta ?? {}) },
    };
    this.index.set(rec.key, merged);
    this.append(merged);
  }

  async putBatch(recs: FeatureRecord[], opts?: PutOptions): Promise<void> {
    for (const r of recs) await this.put(r, opts);
  }

  async get(key: string): Promise<FeatureRecord | undefined> {
    this.init();
    const r = this.index.get(key);
    if (!r) return undefined;
    if (isExpired(r)) return undefined;
    return { ...r };
  }

  async delete(key: string): Promise<boolean> {
    this.init();
    const existed = this.index.delete(key);
    if (existed) {
      // tombstone line
      const tomb: FeatureRecord = { key, ts: Date.now(), ttlMs: 1, features: {}, meta: { tombstone: true } };
      this.append(tomb);
    }
    return existed;
  }

  async list(q: Query = {}): Promise<ListResult> {
    this.init();
    const now = Date.now();
    const keys = Array.from(this.index.keys()).sort();
    const start = fromCursor(q.cursor);
    const items: FeatureRecord[] = [];
    let i = start;
    for (; i < keys.length; i++) {
      const k = keys[i];
      if (q.prefix && !k.startsWith(q.prefix)) continue;
      const r = this.index.get(k)!;
      if (!q.includeExpired && isExpired(r, now)) continue;
      if (q.sinceTs && r.ts < q.sinceTs) continue;
      if (q.untilTs && r.ts > q.untilTs) continue;
      items.push({ ...r });
      if (q.limit && items.length >= q.limit) { i++; break; }
    }
    return { items, nextCursor: i < keys.length ? toCursor(i) : undefined };
  }

  async stats(): Promise<Stats> {
    this.init();
    const now = Date.now();
    let count = 0, expired = 0, minTs = Infinity, maxTs = -Infinity, bytes = 0;
    for (const r of this.index.values()) {
      bytes += approxSizeOfRecord(r);
      if (isExpired(r, now)) { expired++; continue; }
      count++;
      if (r.ts < minTs) minTs = r.ts;
      if (r.ts > maxTs) maxTs = r.ts;
    }
    return {
      namespace: this.namespace,
      version: this.version,
      count,
      expired,
      minTs: isFinite(minTs) ? minTs : undefined,
      maxTs: isFinite(maxTs) ? maxTs : undefined,
      approxBytes: bytes,
    };
  }

  async exportCSV(outFile: string, q: Query = {}): Promise<void> {
    const { items } = await this.list({ ...q, includeExpired: true });
    const headers = ["key","ts","ttlMs","features","meta"];
    const lines = [headers.join(",")];
    for (const r of items) {
      lines.push([
        csvEscape(r.key),
        String(r.ts),
        r.ttlMs != null ? String(r.ttlMs) : "",
        csvEscape(JSON.stringify(r.features ?? {})),
        csvEscape(JSON.stringify(r.meta ?? {})),
      ].join(","));
    }
    ensureDir(path.dirname(outFile));
    fs.writeFileSync(outFile, lines.join("\n"), "utf8");
  }

  async importCSV(inFile: string, opts?: { ttlMsDefault?: number; merge?: boolean }): Promise<number> {
    const txt = fs.readFileSync(inFile, "utf8");
    const lines = txt.trim().split(/\r?\n/);
    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      const [key, tsStr, ttlStr, featuresStr, metaStr] = [
        cols[0] ?? "", cols[1] ?? "", cols[2] ?? "", cols[3] ?? "", cols[4] ?? ""
      ];
      if (!key) continue;
      const ts = Number(tsStr);
      const ttl = ttlStr ? Number(ttlStr) : opts?.ttlMsDefault;
      const features = (safeJson(featuresStr) as FeatureMap) ?? {};
      const meta = safeJson(metaStr) as Record<string, Primitive> | undefined;
      const rec: FeatureRecord = { key, ts, ttlMs: ttl, features, meta };
      await this.upsert(rec, opts?.merge ?? true);
      count++;
    }
    return count;
  }

  async gc(): Promise<{ removed: number }> {
    this.init();
    const now = Date.now();
    let removed = 0;
    for (const [k, r] of this.index.entries()) {
      if (isExpired(r, now)) { this.index.delete(k); removed++; }
    }
    // optional marker line; compacting would rewrite file, omitted here
    const mark: FeatureRecord = { key: `__gc__/${Date.now()}`, ts: Date.now(), ttlMs: 1, features: {} };
    this.append(mark);
    return { removed };
  }

  async close(): Promise<void> { /* noop; append is sync */ }
}

/* ============================ Factory =============================== */

export type BackendKind = "memory" | "fs";

export function createFeatureStore(kind: BackendKind, params: {
  namespace: string;
  version?: string;
  ttlDefaultMs?: number;
  rootDir?: string; // required for fs
}): FeatureStore {
  if (kind === "memory") {
    return new MemoryFeatureStore(params.namespace, params.version ?? "v1", params.ttlDefaultMs);
  }
  if (!params.rootDir) throw new Error("FSFeatureStore requires rootDir");
  return new FSFeatureStore(params.rootDir, params.namespace, params.version ?? "v1", params.ttlDefaultMs);
}

/* ============================== Example ============================== */
/*
(async () => {
  const store = createFeatureStore("fs", {
    namespace: "equities",
    rootDir: "./.feature-store",
    ttlDefaultMs: 7 * 24 * 3600 * 1000,
  });

  await store.put({
    key: "AAPL|2025-10-10",
    ts: Date.now(),
    features: { ret1d: 0.012, vol20d: 0.22, sector: "Tech" },
  });

  console.log(await store.get("AAPL|2025-10-10"));
  console.log(await store.stats());

  await store.exportCSV("./exports/equities_v1.csv");
  await store.importCSV("./exports/equities_v1.csv", { merge: true });

  await store.close();
})();
*/