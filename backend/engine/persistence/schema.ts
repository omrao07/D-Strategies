// persistence/schema.ts
// Single source of truth for persisted shapes (types + tiny validators).
// No external deps. Strong invariants + path-aware errors.

//////////////////////////// Basics ////////////////////////////

export type ISODate = string;
export type UUID = string;
export type PathLike = string;
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Dict<T = unknown> = Record<string, T>;

/** Result with path-aware failure */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; path?: string[] };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const bad = (msg: string, path: string[] = []): Result<never> => ({ ok: false, error: msg, path });

//////////////////////////// Tiny validator DSL ////////////////////////////

type V<T> = (x: unknown, path?: string[]) => Result<T>;
const pipe =
  <A, B>(a: V<A>, b: (v: A) => V<B>): V<B> =>
  (x, p = []) => {
    const r = a(x, p);
    return r.ok ? b(r.value)(r.value, p) : (r as any);
  };

const is = <T>(pred: (x: unknown) => boolean, name: string): V<T> =>
  (x, path = []) => (pred(x) ? ok(x as T) : bad(`Expected ${name}`, path));

export const vString: V<string> = is<string>(x => typeof x === "string", "string");
export const vNonEmptyString: V<string> = (x, path = []) => {
  const r = vString(x, path);
  if (!r.ok) return r;
  return r.value.trim().length ? r : bad("Expected non-empty string", path);
};
export const vFinite: V<number> = is<number>(x => typeof x === "number" && Number.isFinite(x), "finite number");

export const vNumberIn = (min?: number, max?: number): V<number> =>
  (x, path = []) => {
    const r = vFinite(x, path); if (!r.ok) return r;
    if (min != null && r.value < min) return bad(`Number < ${min}`, path);
    if (max != null && r.value > max) return bad(`Number > ${max}`, path);
    return r;
  };

export const vBoolean: V<boolean> = is<boolean>(x => typeof x === "boolean", "boolean");

export const vISODate: V<ISODate> = (x, path = []) => {
  const s = vString(x, path); if (!s.ok) return s;
  return Number.isFinite(Date.parse(s.value)) ? ok(s.value) : bad("Invalid ISO date", path);
};

export const vUUID: V<UUID> = (x, path = []) => {
  const s = vString(x, path); if (!s.ok) return s;
  return /^[0-9a-fA-F-]{8,}$/.test(s.value) ? ok(s.value as UUID) : bad("Expected UUID-like string", path);
};

export const vEnum = <T extends string>(...vals: readonly T[]): V<T> =>
  (x, path = []) => (typeof x === "string" && (vals as readonly string[]).includes(x))
    ? ok(x as T) : bad(`Expected one of: ${vals.join(", ")}`, path);

export const vArray = <T>(item: V<T>, { minLen = 0 }: { minLen?: number } = {}): V<T[]> =>
  (x, path = []) => {
    if (!Array.isArray(x)) return bad("Expected array", path);
    if (x.length < minLen) return bad(`Array length < ${minLen}`, path);
    const out: T[] = [];
    for (let i = 0; i < x.length; i++) {
      const r = item(x[i], path.concat(String(i)));
      if (!r.ok) return r;
      out.push(r.value);
    }
    return ok(out);
  };

export const vDict = <T>(item: V<T>): V<Record<string, T>> =>
  (x, path = []) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) return bad("Expected object", path);
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(x as Dict)) {
      const r = item(v, path.concat(k));
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return ok(out);
  };

export const vOptional = <T>(inner: V<T>): V<T | undefined> =>
  (x, path = []) => (x === undefined ? ok(undefined) : inner(x, path));

/** Very permissive JSON validator */
export const vJson: V<Json> = (x, path = []) => {
  if (x === null) return ok(null);
  const t = typeof x;
  if (t === "string" || t === "number" || t === "boolean") return ok(x as Json);
  if (Array.isArray(x)) {
    const arr: Json[] = [];
    for (let i = 0; i < x.length; i++) {
      const r = vJson(x[i], path.concat(String(i))); if (!r.ok) return r; arr.push(r.value);
    }
    return ok(arr);
  }
  if (t === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(x as Dict)) {
      const r = vJson(v, path.concat(k)); if (!r.ok) return r;
      out[k] = r.value;
    }
    return ok(out);
  }
  return bad("Invalid JSON value", path);
};

//////////////////////////// Entities ////////////////////////////

export type Rebalance = "daily" | "weekly" | "monthly";

export interface StrategySignal {
  id: string;
  description?: string;
  expr?: string;
  weights?: Dict<number>;
}

export interface StrategyDefinition {
  id: string;
  name: string;
  tags: string[];
  createdAt: ISODate;
  params: Dict<Json>;
  signals: StrategySignal[];          // non-empty
  portfolio: {
    topK?: number;
    bottomK?: number;
    longOnly?: boolean;
    rebalance: Rebalance;
  };
  metrics?: {
    icMean?: number; icIR?: number; sharpe?: number; hitRate?: number; turnover?: number;
    inSamplePeriod?: { start: ISODate; end: ISODate };
    oosPeriod?: { start: ISODate; end: ISODate };
  };
  engine: string;                     // e.g., "cross_sectional_v1"
  version: string;                    // e.g., "1.0.0"
}

export type RunStatus = "queued" | "running" | "done" | "error" | "canceled";

export interface RunRecord {
  id: UUID | string;
  strategyId: string;
  createdAt: ISODate;
  startedAt?: ISODate;
  finishedAt?: ISODate;
  status: RunStatus;
  params?: Dict<Json>;
  metrics?: Dict<number>;
  artifacts?: {
    reportHtml?: PathLike;
    reportMd?: PathLike;
    equitySvg?: PathLike;
    tradesCsv?: PathLike;
    logs?: PathLike;
    extra?: Dict<PathLike>;
  };
  error?: { message: string; stack?: string };
  notes?: string;
}

export interface Position {
  symbol: string;
  qty: number;            // signed
  price: number;          // mark
  side?: "long" | "short";
  sector?: string;
  assetClass?: string;
  currency?: string;
  beta?: number;
}

export interface PortfolioState {
  asOf: ISODate;
  cash: number;
  positions: Position[];
  prices?: Dict<number>;
}

export interface ExposureBucket {
  name: string;
  gross: number;
  net: number;
  pctGross: number;
  pctNAV: number;
}

export interface RiskMetrics {
  mean: number;
  stdev: number;
  annReturn: number;
  annVol: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  omega: number;
  maxDrawdown: number;
  maxDDStart?: number;
  maxDDEnd?: number;
  tau: number;
  hitRate: number;
  winLoss: number;
  skew: number;
  kurt: number;
  var: number;
  cvar: number;
  alpha?: number;
  beta?: number;
  infoRatio?: number;
  treynor?: number;
}

export interface PortfolioSnapshot {
  asOf: ISODate;
  nav: number;
  cash: number;
  gross: number;
  net: number;
  longExposure: number;
  shortExposure: number;
  leverage: number;
  positions: Array<{
    symbol: string;
    qty: number;
    price: number;
    value: number;
    side: "long" | "short";
    sector?: string;
    assetClass?: string;
    currency?: string;
    weight: number;
  }>;
  exposures: {
    bySector: ExposureBucket[];
    byAssetClass: ExposureBucket[];
    byCurrency: ExposureBucket[];
    betaWeighted?: { netBeta: number; absBeta: number };
  };
  pnl?: { day?: number; mtd?: number; ytd?: number };
  risk?: RiskMetrics;
}

export interface StrategySummary {
  strategyId: string;
  name: string;
  tags: string[];
  lastRunId?: string;
  lastRunAt?: ISODate;
  lastSharpe?: number;
  lastIC?: number;
  lastReturn?: number;
}

//////////////////////////// Validators ////////////////////////////

const vTags = vArray(vNonEmptyString);

const vSignal: V<StrategySignal> = (x, path = []) => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return bad("Expected signal object", path);
  const o = x as any;
  const id = vNonEmptyString(o.id, path.concat("id")); if (!id.ok) return id;
  if (o.description !== undefined) { const r = vString(o.description, path.concat("description")); if (!r.ok) return r; }
  if (o.expr !== undefined) { const r = vString(o.expr, path.concat("expr")); if (!r.ok) return r; }
  if (o.weights !== undefined) {
    const ww = vDict(vFinite)(o.weights, path.concat("weights")); if (!ww.ok) return ww;
    // signal weights are finite numbers; do NOT force sum to 1 (ensemble may handle that)
  }
  return ok(o as StrategySignal);
};

const vRebalance = vEnum<Rebalance>("daily", "weekly", "monthly");

const vStrategy: V<StrategyDefinition> = (x, path = []) => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return bad("Expected object", path);
  const o = x as any;

  const id = vNonEmptyString(o.id, path.concat("id")); if (!id.ok) return id;
  const name = vNonEmptyString(o.name, path.concat("name")); if (!name.ok) return name;
  const tags = vTags(o.tags, path.concat("tags")); if (!tags.ok) return tags;
  const createdAt = vISODate(o.createdAt, path.concat("createdAt")); if (!createdAt.ok) return createdAt;

  const params = vDict(vJson)(o.params ?? {}, path.concat("params")); if (!params.ok) return params;

  const signals = vArray(vSignal, { minLen: 1 })(o.signals, path.concat("signals")); if (!signals.ok) return signals;

  if (!o.portfolio || typeof o.portfolio !== "object") return bad("portfolio required", path.concat("portfolio"));
  const p = o.portfolio as any;
  const reb = vRebalance(p.rebalance, path.concat("portfolio", "rebalance")); if (!reb.ok) return reb;
  if (p.topK !== undefined) { const r = vNumberIn(0)(p.topK, path.concat("portfolio","topK")); if (!r.ok) return r; }
  if (p.bottomK !== undefined) { const r = vNumberIn(0)(p.bottomK, path.concat("portfolio","bottomK")); if (!r.ok) return r; }
  if (p.longOnly !== undefined) { const r = vBoolean(p.longOnly, path.concat("portfolio","longOnly")); if (!r.ok) return r; }

  const engine = vNonEmptyString(o.engine, path.concat("engine")); if (!engine.ok) return engine;
  const version = vNonEmptyString(o.version, path.concat("version")); if (!version.ok) return version;

  if (o.metrics !== undefined) {
    const m = o.metrics as any;
    for (const k of ["icMean","icIR","sharpe","hitRate","turnover"] as const) {
      if (m[k] !== undefined) { const r = vFinite(m[k], path.concat("metrics", k)); if (!r.ok) return r; }
    }
    if (m.inSamplePeriod) {
      const a = vISODate(m.inSamplePeriod.start, path.concat("metrics","inSamplePeriod","start")); if (!a.ok) return a;
      const b = vISODate(m.inSamplePeriod.end, path.concat("metrics","inSamplePeriod","end")); if (!b.ok) return b;
    }
    if (m.oosPeriod) {
      const a = vISODate(m.oosPeriod.start, path.concat("metrics","oosPeriod","start")); if (!a.ok) return a;
      const b = vISODate(m.oosPeriod.end, path.concat("metrics","oosPeriod","end")); if (!b.ok) return b;
    }
  }

  return ok(o as StrategyDefinition);
};

const vRunStatus = vEnum<RunStatus>("queued", "running", "done", "error", "canceled");

const vRunRecord: V<RunRecord> = (x, path = []) => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return bad("Expected object", path);
  const o = x as any;
  const id = vNonEmptyString(o.id, path.concat("id")); if (!id.ok) return id; // allow non-UUID ids too
  const sid = vNonEmptyString(o.strategyId, path.concat("strategyId")); if (!sid.ok) return sid;
  const createdAt = vISODate(o.createdAt, path.concat("createdAt")); if (!createdAt.ok) return createdAt;
  if (o.startedAt !== undefined) { const r = vISODate(o.startedAt, path.concat("startedAt")); if (!r.ok) return r; }
  if (o.finishedAt !== undefined) { const r = vISODate(o.finishedAt, path.concat("finishedAt")); if (!r.ok) return r; }
  const status = vRunStatus(o.status, path.concat("status")); if (!status.ok) return status;

  if (o.params !== undefined) { const r = vDict(vJson)(o.params, path.concat("params")); if (!r.ok) return r; }
  if (o.metrics !== undefined) { const r = vDict(vFinite)(o.metrics, path.concat("metrics")); if (!r.ok) return r; }

  if (o.artifacts !== undefined) {
    const a = o.artifacts as any;
    for (const k of ["reportHtml","reportMd","equitySvg","tradesCsv","logs"] as const) {
      if (a[k] !== undefined) { const r = vString(a[k], path.concat("artifacts", k)); if (!r.ok) return r; }
    }
    if (a.extra !== undefined) {
      const r = vDict(vString)(a.extra, path.concat("artifacts","extra")); if (!r.ok) return r;
    }
  }

  if (o.error !== undefined) {
    const e = o.error as any;
    const m = vNonEmptyString(e.message, path.concat("error","message")); if (!m.ok) return m;
    if (e.stack !== undefined) { const s = vString(e.stack, path.concat("error","stack")); if (!s.ok) return s; }
  }

  if (o.notes !== undefined) { const r = vString(o.notes, path.concat("notes")); if (!r.ok) return r; }

  return ok(o as RunRecord);
};

const vPosition: V<Position> = (x, path = []) => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return bad("Expected object", path);
  const o = x as any;
  const sym = vNonEmptyString(o.symbol, path.concat("symbol")); if (!sym.ok) return sym;
  const qty = vFinite(o.qty, path.concat("qty")); if (!qty.ok) return qty;
  const price = vNumberIn(0)(o.price, path.concat("price")); if (!price.ok) return price;
  if (o.side !== undefined) {
    const s = vEnum<"long"|"short">("long","short")(o.side, path.concat("side")); if (!s.ok) return s;
  }
  if (o.sector !== undefined) { const r = vString(o.sector, path.concat("sector")); if (!r.ok) return r; }
  if (o.assetClass !== undefined) { const r = vString(o.assetClass, path.concat("assetClass")); if (!r.ok) return r; }
  if (o.currency !== undefined) { const r = vString(o.currency, path.concat("currency")); if (!r.ok) return r; }
  if (o.beta !== undefined) { const r = vFinite(o.beta, path.concat("beta")); if (!r.ok) return r; }
  return ok(o as Position);
};

const vPortfolioState: V<PortfolioState> = (x, path = []) => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return bad("Expected object", path);
  const o = x as any;
  const asOf = vISODate(o.asOf, path.concat("asOf")); if (!asOf.ok) return asOf;
  const cash = vFinite(o.cash, path.concat("cash")); if (!cash.ok) return cash;
  const pos = vArray(vPosition)(o.positions, path.concat("positions")); if (!pos.ok) return pos;
  if (o.prices !== undefined) {
    const pr = vDict(vNumberIn(0))(o.prices, path.concat("prices")); if (!pr.ok) return pr;
  }
  return ok(o as PortfolioState);
};

const vExposureBucket: V<ExposureBucket> = (x, path = []) => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return bad("Expected object", path);
  const o = x as any;
  const name = vNonEmptyString(o.name, path.concat("name")); if (!name.ok) return name;
  for (const k of ["gross","net","pctGross","pctNAV"] as const) {
    const r = vFinite(o[k], path.concat(k)); if (!r.ok) return r;
  }
  return ok(o as ExposureBucket);
};

const vRiskMetrics: V<RiskMetrics> = (x, path = []) => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return bad("Expected object", path);
  const o = x as any;
  const req = ["mean","stdev","annReturn","annVol","sharpe","sortino","calmar","omega",
               "maxDrawdown","tau","hitRate","winLoss","skew","kurt","var","cvar"] as const;
  for (const k of req) { const r = vFinite(o[k], path.concat(k)); if (!r.ok) return r; }
  if (o.maxDDStart !== undefined) { const r = vFinite(o.maxDDStart, path.concat("maxDDStart")); if (!r.ok) return r; }
  if (o.maxDDEnd !== undefined) { const r = vFinite(o.maxDDEnd, path.concat("maxDDEnd")); if (!r.ok) return r; }
  for (const k of ["alpha","beta","infoRatio","treynor"] as const) {
    if (o[k] !== undefined) { const r = vFinite(o[k], path.concat(k)); if (!r.ok) return r; }
  }
  return ok(o as RiskMetrics);
};

const vPortfolioSnapshot: V<PortfolioSnapshot> = (x, path = []) => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return bad("Expected object", path);
  const o = x as any;
  const asOf = vISODate(o.asOf, path.concat("asOf")); if (!asOf.ok) return asOf;
  for (const k of ["nav","cash","gross","net","longExposure","shortExposure","leverage"] as const) {
    const r = vFinite(o[k], path.concat(k)); if (!r.ok) return r;
  }
  // positions
  const posArr = vArray((p, pp) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) return bad("Expected position object", pp);
    const P = p as any;
    const sym = vNonEmptyString(P.symbol, pp!.concat("symbol")); if (!sym.ok) return sym;
    for (const k of ["qty","price","value","weight"] as const) {
      const r = vFinite(P[k], pp!.concat(k)); if (!r.ok) return r;
    }
    const side = vEnum<"long"|"short">("long","short")(P.side, pp!.concat("side")); if (!side.ok) return side;
    if (P.sector !== undefined) { const r = vString(P.sector, pp!.concat("sector")); if (!r.ok) return r; }
    if (P.assetClass !== undefined) { const r = vString(P.assetClass, pp!.concat("assetClass")); if (!r.ok) return r; }
    if (P.currency !== undefined) { const r = vString(P.currency, pp!.concat("currency")); if (!r.ok) return r; }
    return ok(P);
  }, { minLen: 0 })(o.positions, path.concat("positions"));
  if (!posArr.ok) return posArr;

  // exposures
  if (!o.exposures || typeof o.exposures !== "object") return bad("exposures required", path.concat("exposures"));
  const ex = o.exposures as any;
  const bySec = vArray(vExposureBucket)(ex.bySector, path.concat("exposures","bySector")); if (!bySec.ok) return bySec;
  const byCls = vArray(vExposureBucket)(ex.byAssetClass, path.concat("exposures","byAssetClass")); if (!byCls.ok) return byCls;
  const byCur = vArray(vExposureBucket)(ex.byCurrency, path.concat("exposures","byCurrency")); if (!byCur.ok) return byCur;
  if (ex.betaWeighted !== undefined) {
    const nb = vFinite(ex.betaWeighted.netBeta, path.concat("exposures","betaWeighted","netBeta")); if (!nb.ok) return nb;
    const ab = vFinite(ex.betaWeighted.absBeta, path.concat("exposures","betaWeighted","absBeta")); if (!ab.ok) return ab;
  }

  // pnl (optional)
  if (o.pnl !== undefined) {
    const p = o.pnl as any;
    for (const k of ["day","mtd","ytd"] as const) {
      if (p[k] !== undefined) { const r = vFinite(p[k], path.concat("pnl", k)); if (!r.ok) return r; }
    }
  }

  // risk (optional)
  if (o.risk !== undefined) {
    const r = vRiskMetrics(o.risk, path.concat("risk")); if (!r.ok) return r;
  }

  return ok(o as PortfolioSnapshot);
};

const vStrategySummary: V<StrategySummary> = (x, path = []) => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return bad("Expected object", path);
  const o = x as any;
  const sid = vNonEmptyString(o.strategyId, path.concat("strategyId")); if (!sid.ok) return sid;
  const name = vNonEmptyString(o.name, path.concat("name")); if (!name.ok) return name;
  const tags = vTags(o.tags, path.concat("tags")); if (!tags.ok) return tags;
  if (o.lastRunId !== undefined) { const r = vNonEmptyString(o.lastRunId, path.concat("lastRunId")); if (!r.ok) return r; }
  if (o.lastRunAt !== undefined) { const r = vISODate(o.lastRunAt, path.concat("lastRunAt")); if (!r.ok) return r; }
  for (const k of ["lastSharpe","lastIC","lastReturn"] as const) {
    if (o[k] !== undefined) { const r = vFinite(o[k], path.concat(k)); if (!r.ok) return r; }
  }
  return ok(o as StrategySummary);
};

//////////////////////////// Registry ////////////////////////////

export const Schemas = {
  strategy: vStrategy,
  run: vRunRecord,
  position: vPosition,
  portfolioState: vPortfolioState,
  portfolioSnapshot: vPortfolioSnapshot,
  strategySummary: vStrategySummary,
};

export type SchemaName = keyof typeof Schemas;

export function validate<N extends SchemaName>(
  name: N,
  value: unknown
): Result<ReturnType<typeof Schemas[N]> extends (x: any, p?: any) => Result<infer T> ? T : never> {
  return Schemas[name](value) as any;
}

//////////////////////////// IO helpers ////////////////////////////

export function writeJSON(
  fileWrite: (s: string) => void,
  value: unknown
): Result<true> {
  try {
    fileWrite(JSON.stringify(value, null, 2));
    return ok(true);
  } catch (e: any) {
    return bad(`writeJSON failed: ${e?.message ?? String(e)}`);
  }
}

export function readJSON<N extends SchemaName>(
  fileRead: () => string,
  schema: N
): Result<ReturnType<typeof Schemas[N]> extends (x: any, p?: any) => Result<infer T> ? T : never> {
  let raw: string;
  try { raw = fileRead(); }
  catch (e: any) { return bad(`readJSON failed: ${e?.message ?? String(e)}`); }

  let obj: unknown;
  try { obj = JSON.parse(raw); }
  catch (e: any) { return bad(`Invalid JSON: ${e?.message ?? String(e)}`); }

  return validate(schema, obj) as any;
}

//////////////////////////// Versioning ////////////////////////////

export interface StoreHeader {
  schema: SchemaName;
  version: string;     // bump on breaking change
  savedAt: ISODate;
  meta?: Dict<Json>;
}

export interface Versioned<T> {
  header: StoreHeader;
  data: T;
}

export function wrapVersioned<T>(
  schema: SchemaName,
  version: string,
  data: T,
  meta?: Dict<Json>
): Versioned<T> {
  return {
    header: { schema, version, savedAt: new Date().toISOString(), meta },
    data,
  };
}

export function unwrapVersioned<N extends SchemaName, T>(
  v: Versioned<T>,
  expectedSchema: N,
  expectedVersion?: string
): Result<T> {
  if (!v || typeof v !== "object") return bad("Versioned wrapper expected");
  const h = (v as any).header;
  if (!h || typeof h !== "object") return bad("Missing header");
  if (h.schema !== expectedSchema) return bad(`Schema mismatch: got ${h.schema}, expected ${expectedSchema}`);
  if (expectedVersion && h.version !== expectedVersion) return bad(`Version mismatch: got ${h.version}, expected ${expectedVersion}`);
  return ok((v as any).data as T);
}

//////////////////////////// Constructors (optional) ////////////////////////////

export const makeStrategy = (p: Omit<StrategyDefinition, "createdAt"> & { createdAt?: ISODate }): StrategyDefinition => ({
  ...p,
  createdAt: p.createdAt ?? new Date().toISOString(),
});

export const makeRun = (p: Omit<RunRecord, "createdAt"> & { createdAt?: ISODate }): RunRecord => ({
  ...p,
  createdAt: p.createdAt ?? new Date().toISOString(),
});