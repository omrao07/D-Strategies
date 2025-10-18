// commands/data.ts
// Zero-dependency dataset registry + tiny CLI-style command handler.
// Sits alongside other `commands/*` modules (no imports).
//
// What it’s for
// - Register datasets with a simple schema (columns, types, primary key, optional timestamp)
// - Convert CSV/JSON rows into typed rows
// - Build cross-sections (ticker → {metric:value}) for factor scoring
// - “Latest per key” pivot for time-series fundamentals
// - Lightweight merge of multiple cross-sections
// - CRUD + export/import snapshot via a CLI-ish function
//
// Programmatic usage:
//   import { data, rowsFromCSV, latestPerKey, toCrossSection, runDataCommand } from "./commands/data";
//   data.upsert({ name: "fundamentals", schema: { pk:"symbol", ts:"date", columns:[
//       { name:"symbol", type:"string" }, { name:"date", type:"date" },
//       { name:"pe", type:"number" }, { name:"pb", type:"number" }, { name:"dy", type:"number" }
//   ]}});
//   const rows = rowsFromCSV(csvString, data.get("fundamentals")!.schema);
//   const latest = latestPerKey(rows, "symbol", "date");
//   const xsec  = toCrossSection(latest, "symbol", ["pe","pb","dy"]);
//
// CLI-ish usage (wire argv yourself):
//   runDataCommand(["list"])
//   runDataCommand(["show","fundamentals"])
//   runDataCommand(["import","--json", snapshotJSON])
//   runDataCommand(["preview","--csv", csv, "--schema", schemaJSON, "--as", "cross", "--pk", "symbol", "--metrics", "pe,pb,dy", "--latest"])

export type ColType = "number" | "string" | "boolean" | "date";

export interface Column {
  name: string;
  type: ColType;
  optional?: boolean;   // if true, missing allowed
  notes?: string;
}

export interface Schema {
  columns: Column[];
  pk?: string;          // primary key column (e.g., "symbol", optional but recommended)
  ts?: string;          // timestamp column (ISO/date or epoch)
  freq?: "tick" | "min" | "hour" | "day" | "week" | "month" | "quarter" | "year";
}

export interface Dataset {
  name: string;
  description?: string;
  schema: Schema;
  tags?: string[];
  source?: string;
  disabled?: boolean;
  notes?: string;
}

export interface DataSnapshot {
  version: 1;
  savedAt: string;
  default?: string;
  items: Dataset[];
}

class DataRegistry {
  private map = new Map<string, Dataset>();
  private _default?: string;

  add(cfg: Dataset): Dataset {
    const v = this.validate(normalizeDataset(cfg));
    if (this.map.has(v.name)) throw new Error(`Dataset "${v.name}" already exists`);
    this.map.set(v.name, v);
    if (!this._default) this._default = v.name;
    return v;
  }
  upsert(cfg: Dataset): Dataset {
    const v = this.validate(normalizeDataset(cfg));
    this.map.set(v.name, v);
    if (!this._default) this._default = v.name;
    return v;
  }
  get(name: string): Dataset | undefined { return this.map.get(name); }
  has(name: string): boolean { return this.map.has(name); }
  list(includeDisabled = true): Dataset[] {
    const arr = Array.from(this.map.values());
    return sortDatasets(includeDisabled ? arr : arr.filter(d => !d.disabled));
  }
  remove(name: string): boolean {
    const ok = this.map.delete(name);
    if (ok && this._default === name) this._default = this.list(true)[0]?.name;
    return ok;
  }
  setDefault(name: string): void {
    if (!this.map.has(name)) throw new Error(`Unknown dataset "${name}"`);
    this._default = name;
  }
  getDefault(): string | undefined {
    if (this._default && this.map.has(this._default)) return this._default;
    const first = this.list(false)[0]?.name ?? this.list(true)[0]?.name;
    this._default = first;
    return this._default;
  }
  snapshot(): DataSnapshot {
    return { version: 1, savedAt: new Date().toISOString(), default: this._default, items: this.list(true) };
  }
  exportJSON(pretty = false): string { return JSON.stringify(this.snapshot(), null, pretty ? 2 : 0); }
  restore(snap: DataSnapshot): void {
    if (!snap || snap.version !== 1) throw new Error("Unsupported snapshot version");
    this.map.clear();
    for (const it of snap.items) this.upsert(it);
    if (snap.default && this.map.has(snap.default)) this._default = snap.default;
  }
  importJSON(json: string, { replace = false } = {}): void {
    const obj = JSON.parse(json);
    if (obj && obj.version === 1 && Array.isArray(obj.items)) {
      if (replace) this.map.clear();
      this.restore(obj as DataSnapshot);
      return;
    }
    if (obj && Array.isArray(obj.items)) {
      if (replace) this.map.clear();
      for (const it of obj.items) this.upsert(it);
      return;
    }
    throw new Error("Invalid JSON payload for data import");
  }

  private validate(ds: Dataset): Dataset {
    if (!ds.name) throw new Error("dataset.name required");
    const cols = ds.schema?.columns ?? [];
    if (!Array.isArray(cols) || !cols.length) throw new Error("schema.columns[] required");
    // ensure pk/ts exist if provided
    if (ds.schema.pk && !cols.find(c => c.name === ds.schema.pk)) throw new Error(`pk "${ds.schema.pk}" not in schema.columns`);
    if (ds.schema.ts && !cols.find(c => c.name === ds.schema.ts)) throw new Error(`ts "${ds.schema.ts}" not in schema.columns`);
    // column uniqueness
    const names = new Set<string>();
    for (const c of cols) {
      if (!c.name) throw new Error("column.name required");
      if (names.has(c.name)) throw new Error(`duplicate column "${c.name}"`);
      names.add(c.name);
      if (!["number","string","boolean","date"].includes(c.type)) throw new Error(`invalid type for "${c.name}"`);
    }
    return ds;
  }
}

export const data = new DataRegistry();

// ---------- Parsing & transforms ----------

export type Row = Record<string, any>;

/** Parse CSV string into typed rows using schema. */
export function rowsFromCSV(csv: string, schema: Schema): Row[] {
  const lines = csv.replace(/\r/g, "").split("\n").filter(Boolean);
  if (!lines.length) return [];
  const header = splitCSVLine(lines[0]).map(s => s.trim());
  const idx = (name: string) => header.indexOf(name);
  for (const col of schema.columns) {
    if (idx(col.name) === -1) throw new Error(`CSV missing column "${col.name}"`);
  }
  const out: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = splitCSVLine(lines[i]);
    if (raw.length !== header.length) continue;
    const row: Row = {};
    let ok = true;
    for (const col of schema.columns) {
      const vRaw = raw[idx(col.name)];
      const v = coerceToType(vRaw, col.type);
      if (!col.optional && (v === null || v === undefined || (Number.isNaN(v) && col.type === "number"))) {
        ok = false; break;
      }
      row[col.name] = v;
    }
    if (ok) out.push(row);
  }
  return out;
}

/** Parse JSON array string (or object) into typed rows using schema. */
export function rowsFromJSON(input: string | any, schema: Schema): Row[] {
  const arr = typeof input === "string" ? JSON.parse(input) : input;
  if (!Array.isArray(arr)) throw new Error("rowsFromJSON expects JSON array");
  return arr.map((r) => {
    const row: Row = {};
    for (const col of schema.columns) {
      const v = coerceToType((r as any)[col.name], col.type);
      if (!col.optional && (v === null || v === undefined || (Number.isNaN(v) && col.type === "number"))) {
        throw new Error(`row missing/invalid "${col.name}"`);
      }
      row[col.name] = v;
    }
    return row;
  });
}

/** For time-series: keep only the latest row per key (by ts). */
export function latestPerKey(rows: Row[], pk: string, ts: string): Row[] {
  const map = new Map<any, Row>();
  for (const r of rows) {
    const k = r[pk];
    const t = toTs(r[ts]);
    const prev = map.get(k);
    if (!prev || t > toTs(prev[ts])) map.set(k, r);
  }
  return Array.from(map.values());
}

/** Build cross-section: id → { metric: value }. */
export function toCrossSection(rows: Row[], idCol: string, metrics: string[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const id = r[idCol];
    if (id == null) continue;
    const rec: Record<string, number> = {};
    for (const m of metrics) {
      const v = Number(r[m]);
      if (Number.isFinite(v)) rec[m] = v;
    }
    out[id] = rec;
  }
  return out;
}

/** Merge multiple cross-sections; later objects win on conflicts. */
export function mergeCrossSections(...xs: Array<Record<string, Record<string, number>>>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const x of xs) {
    for (const id in x) {
      out[id] = out[id] ?? {};
      const rec = x[id];
      for (const k in rec) out[id][k] = rec[k];
    }
  }
  return out;
}

/** Infer a schema from rows (best-effort). */
export function inferSchema(rows: Row[], { pk, ts }: { pk?: string; ts?: string } = {}): Schema {
  const sample = rows[0] ?? {};
  const cols: Column[] = [];
  for (const k of Object.keys(sample)) {
    const v = sample[k];
    cols.push({ name: k, type: guessType(v) });
  }
  return { columns: cols, pk, ts };
}

// ---------- CLI-ish command ----------

export function runDataCommand(argv: string[]): string {
  const args = parseArgv(argv);
  const cmd = String(args._[0] ?? "help").toLowerCase();

  try {
    switch (cmd) {
      case "help":
        return help();
      case "list": {
        const rows = data.list(true).map(d => ({
          name: d.name + (data.getDefault() === d.name ? " *" : ""),
          cols: d.schema.columns.length,
          pk: d.schema.pk ?? "",
          ts: d.schema.ts ?? "",
          freq: d.schema.freq ?? "",
          disabled: d.disabled ? "✓" : "",
        }));
        return table(rows, ["name","cols","pk","ts","freq","disabled"]);
      }
      case "show": {
        const name = String(args._[1] ?? args.name ?? "");
        if (!name) return "Usage: show <name>";
        const ds = data.get(name);
        if (!ds) return `Dataset "${name}" not found.`;
        return pretty(ds);
      }
      case "add":
      case "upsert": {
        const name = String(args.name ?? args._[1] ?? "");
        if (!name) return "add/upsert requires --name";
        const schema = parseSchema(args.schema);
        const ds: Dataset = {
          name,
          description: args.description ? String(args.description) : undefined,
          schema,
          tags: parseStrList(args.tags),
          source: args.source ? String(args.source) : undefined,
          disabled: !!args.disabled,
          notes: args.notes ? String(args.notes) : undefined,
        };
        (cmd === "add" ? data.add(ds) : data.upsert(ds));
        return `Saved dataset "${name}".`;
      }
      case "rm":
      case "remove": {
        const name = String(args._[1] ?? args.name ?? "");
        if (!name) return "Usage: rm <name>";
        const ok = data.remove(name);
        return ok ? `Removed "${name}".` : `Dataset "${name}" not found.`;
      }
      case "set-default": {
        const name = String(args._[1] ?? args.name ?? "");
        if (!name) return "Usage: set-default <name>";
        data.setDefault(name);
        return `Default dataset set to "${name}".`;
      }
      case "export": {
        const prettyOut = !!args.pretty || !!args.p;
        return data.exportJSON(prettyOut);
      }
      case "import": {
        const payload = String(args.json ?? args._[1] ?? "");
        if (!payload) return `Usage: import --json '<snapshot|{items:[]}> ' [--replace]`;
        data.importJSON(payload, { replace: !!args.replace });
        return `Imported ${data.list(true).length} datasets.`;
      }
      case "preview": {
        // Transform CSV/JSON with an ad-hoc schema into rows/cross-section
        const schema = parseSchema(args.schema);
        const as = String(args.as ?? "rows") as "rows" | "cross";
        const useLatest = !!args.latest;
        const pk = String(args.pk ?? schema.pk ?? "");
        const ts = String(args.ts ?? schema.ts ?? "");
        const metrics = parseStrList(args.metrics);
        const hasCSV = args.csv != null;
        const rows = hasCSV ? rowsFromCSV(String(args.csv), schema) : rowsFromJSON(args.jsonRows ?? "[]", schema);
        const prepped = useLatest && pk && ts ? latestPerKey(rows, pk, ts) : rows;
        if (as === "cross") {
          if (!pk) return "preview --as cross requires --pk (or schema.pk)";
          if (!metrics.length) return "preview --as cross requires --metrics 'm1,m2,...'";
          const x = toCrossSection(prepped, pk, metrics);
          return pretty(x);
        }
        return pretty(prepped.slice(0, toInt(args.limit, 100)));
      }
      default:
        return `Unknown subcommand "${cmd}".\n` + help();
    }
  } catch (e) {
    return `Error: ${errToString(e)}`;
  }
}

// ---------- Helpers ----------

function normalizeDataset(d: Dataset): Dataset {
  const cpy: Dataset = { ...d, schema: { ...(d.schema || {}), columns: (d.schema?.columns || []).map(c => ({ ...c })) } };
  cpy.name = cpy.name.trim();
  cpy.schema.columns = cpy.schema.columns.map(c => ({ name: c.name.trim(), type: c.type, optional: !!c.optional, notes: c.notes }));
  return cpy;
}

function sortDatasets(arr: Dataset[]): Dataset[] {
  return arr.slice().sort((a,b) => a.name.localeCompare(b.name));
}

function parseSchema(src: any): Schema {
  if (!src) throw new Error("--schema JSON required");
  const obj = typeof src === "string" ? JSON.parse(src) : src;
  if (!obj || !Array.isArray(obj.columns)) throw new Error("schema must have columns[]");
  const schema: Schema = {
    columns: obj.columns.map((c: any) => ({ name: String(c.name), type: String(c.type) as ColType, optional: !!c.optional, notes: c.notes })),
    pk: obj.pk ? String(obj.pk) : undefined,
    ts: obj.ts ? String(obj.ts) : undefined,
    freq: obj.freq,
  };
  return schema;
}

function coerceToType(v: any, t: ColType): any {
  if (v == null || v === "") return undefined;
  if (t === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  if (t === "boolean") {
    if (v === true || v === false) return v;
    const s = String(v).toLowerCase().trim();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
    return undefined;
  }
  if (t === "date") return toTs(v);
  return String(v);
}

function splitCSVLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i=0;i<line.length;i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function toTs(x: any): number {
  if (typeof x === "number" && Number.isFinite(x)) {
    // accept seconds or ms
    return x < 10_000_000_000 ? x * 1000 : x;
  }
  const s = String(x);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{13}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

function guessType(v: any): ColType {
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") {
    const t = toTs(v);
    if (t && Number.isFinite(t) && t > 0) return "date";
    const n = Number(v);
    if (Number.isFinite(n) && String(n) === v.trim()) return "number";
    return "string";
  }
  if (v instanceof Date) return "date";
  return "string";
}

// --- tiny argv & formatting ---

type Argv = { _: string[]; [k: string]: any };

function parseArgv(argv: string[]): Argv {
  const out: Argv = { _: [] };
  let k: string | null = null;
  for (const raw of argv) {
    const a = String(raw);
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) { out[a.slice(2,eq)] = coerce(a.slice(eq+1)); k = null; }
      else { k = a.slice(2); out[k] = true; }
    } else if (a.startsWith("-") && a.length > 2) {
      for (let i=1;i<a.length;i++) out[a[i]] = true;
      k = null;
    } else if (a.startsWith("-")) {
      k = a.slice(1); out[k] = true;
    } else {
      if (k && out[k] === true) { out[k] = coerce(a); k = null; }
      else out._.push(a);
    }
  }
  return out;
}
function coerce(x: string) {
  if (x === "true") return true;
  if (x === "false") return false;
  if (!Number.isNaN(Number(x)) && x.trim() !== "") return Number(x);
  try { return JSON.parse(x); } catch { /* not JSON */ }
  return x;
}
function parseStrList(x: any): string[] {
  if (x == null) return [];
  if (Array.isArray(x)) return x.map(String);
  return String(x).split(",").map(s => s.trim()).filter(Boolean);
}
function table(rows: Array<Record<string, any>>, headers: string[]): string {
  if (!rows.length) return "(empty)";
  const cols = headers;
  const widths = cols.map((h,i)=>Math.max(h.length, ...rows.map(r => String(r[cols[i]] ?? "").length)));
  const line = (cells: string[]) => cells.map((c,i)=>String(c).padEnd(widths[i]," ")).join("  ");
  const out: string[] = [];
  out.push(line(cols));
  out.push(line(widths.map(w=>"─".repeat(w))));
  for (const r of rows) out.push(line(cols.map(h=>String(r[h] ?? ""))));
  return out.join("\n");
}
function pretty(x: unknown): string { try { return JSON.stringify(x, null, 2); } catch { return String(x); } }
function help(): string {
  return [
    "data <subcommand>",
    "",
    "Subcommands:",
    "  list                                         List datasets",
    "  show <name>                                  Show dataset",
    "  add|upsert --name n --schema '<JSON>'        Save dataset schema",
    "      [--description '...'] [--tags a,b] [--source '...'] [--disabled] [--notes '...']",
    "  rm|remove <name>                             Remove dataset",
    "  set-default <name>                           Set default dataset",
    "  export [--pretty|-p]                         Export snapshot JSON",
    "  import --json '<payload>' [--replace]        Import snapshot JSON",
    "  preview --schema '<JSON>' (--csv str | --jsonRows '<JSON>')",
    "      [--as rows|cross] [--pk col] [--ts col] [--latest] [--metrics 'm1,m2,...'] [--limit N]",
  ].join("\n");
}
function errToString(e: unknown): string { if (e instanceof Error) return `${e.name}: ${e.message}`; try { return JSON.stringify(e); } catch { return String(e); } }
function toInt(v: any, d: number): number { const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : d; }

// ------------- Expose minimal API -------------

export type { DataRegistry as Datasets };
export function addDataset(cfg: Dataset): Dataset { return data.add(cfg); }
export function upsertDataset(cfg: Dataset): Dataset { return data.upsert(cfg); }
export function getDataset(name: string): Dataset | undefined { return data.get(name); }
export function listDatasets(includeDisabled = true): Dataset[] { return data.list(includeDisabled); }
export function setDefaultDataset(name: string): void { data.setDefault(name); }
export function exportDatasets(pretty = false): string { return data.exportJSON(pretty); }
export function importDatasets(json: string, opts?: { replace?: boolean }) { data.importJSON(json, opts); }
