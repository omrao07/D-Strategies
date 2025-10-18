// common/normalizer.ts
// Lightweight normalization + validation utilities (no external deps).

/* ======================== Result / helpers ======================== */

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; path?: string[] };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const bad = (msg: string, path: string[] = []): Result<never> => ({ ok: false, error: msg, path });

const isNil = (v: unknown) => v === null || v === undefined;
const toStr = (v: unknown) => (v == null ? "" : String(v));

/* ============================ Primitives ============================ */

export type V<T> = (x: unknown, path?: string[]) => Result<T>;

/** Accepts string/number, returns finite number; supports % strings and scaling. */
export function vNumber(opts: {
  min?: number; max?: number; round?: number; scale?: number; allowPercent?: boolean; default?: number;
} = {}): V<number> {
  const { min, max, round, scale, allowPercent, default: dflt } = opts;
  return (x, path = []) => {
    if (isNil(x)) {
      if (dflt !== undefined) return ok(dflt);
      return bad("Expected number", path);
    }
    let n: number | undefined;
    if (typeof x === "number" && Number.isFinite(x)) n = x;
    else if (typeof x === "string") {
      const s = x.trim();
      if (!s) return dflt !== undefined ? ok(dflt) : bad("Expected number (empty)", path);
      if (allowPercent && s.endsWith("%")) {
        const p = Number(s.slice(0, -1));
        if (!Number.isFinite(p)) return bad(`Invalid percent: ${x}`, path);
        n = p / 100;
      } else {
        const k = Number(s.replace(/[_,\s]/g, ""));
        if (!Number.isFinite(k)) return bad(`Invalid number: ${x}`, path);
        n = k;
      }
    }
    if (!Number.isFinite(n as number)) return bad("Expected finite number", path);
    let v = n as number;
    if (scale !== undefined) v *= scale;
    if (round !== undefined) {
      const p = Math.pow(10, round);
      v = Math.round(v * p) / p;
    }
    if (min !== undefined && v < min) return bad(`Number < ${min}`, path);
    if (max !== undefined && v > max) return bad(`Number > ${max}`, path);
    return ok(v);
  };
}

/** String normalizer: trim/empty→default, casing, regex enforcement. */
export function vString(opts: {
  trim?: boolean; lower?: boolean; upper?: boolean; collapseWs?: boolean;
  emptyToNull?: boolean; default?: string; pattern?: RegExp; maxLen?: number; minLen?: number;
} = {}): V<string> {
  const { trim = true, lower, upper, collapseWs, emptyToNull, default: dflt, pattern, maxLen, minLen } = opts;
  return (x, path = []) => {
    if (isNil(x)) return dflt !== undefined ? ok(dflt) : bad("Expected string", path);
    let s = String(x);
    if (trim) s = s.trim();
    if (collapseWs) s = s.replace(/\s+/g, " ");
    if (lower) s = s.toLowerCase();
    if (upper) s = s.toUpperCase();
    if (!s && emptyToNull) return dflt !== undefined ? ok(dflt) : bad("Empty string", path);
    if (minLen !== undefined && s.length < minLen) return bad(`String length < ${minLen}`, path);
    if (maxLen !== undefined && s.length > maxLen) return bad(`String length > ${maxLen}`, path);
    if (pattern && !pattern.test(s)) return bad(`String does not match pattern ${pattern}`, path);
    return ok(s);
  };
}

/** Boolean coercion: supports "true/false/yes/no/1/0/y/n". */
export function vBoolean(opts: { default?: boolean } = {}): V<boolean> {
  const { default: dflt } = opts;
  return (x, path = []) => {
    if (isNil(x)) return dflt !== undefined ? ok(dflt) : bad("Expected boolean", path);
    if (typeof x === "boolean") return ok(x);
    if (typeof x === "number") return ok(Boolean(x));
    if (typeof x === "string") {
      const s = x.trim().toLowerCase();
      if (["true", "t", "1", "yes", "y"].includes(s)) return ok(true);
      if (["false", "f", "0", "no", "n"].includes(s)) return ok(false);
    }
    return bad("Expected boolean-like value", path);
  };
}

/** ISO date coercion: accepts Date/string/number; returns ISO string. */
export function vISODate(opts: { default?: string } = {}): V<string> {
  const { default: dflt } = opts;
  return (x, path = []) => {
    if (isNil(x)) return dflt !== undefined ? ok(dflt) : bad("Expected ISO date", path);
    let d: Date;
    if (x instanceof Date) d = x;
    else if (typeof x === "number") d = new Date(x);
    else d = new Date(String(x));
    if (!Number.isFinite(d.getTime())) return bad("Invalid date", path);
    return ok(d.toISOString());
  };
}

/** Enum validator for strings. */
export function vEnum<T extends string>(...vals: readonly T[]): V<T> {
  return (x, path = []) => {
    const s = String(x ?? "");
    return (vals as readonly string[]).includes(s) ? ok(s as T) : bad(`Expected one of: ${vals.join(", ")}`, path);
  };
}

/** Array validator. */
export function vArray<T>(item: V<T>, opts: { minLen?: number; maxLen?: number } = {}): V<T[]> {
  const { minLen = 0, maxLen = Infinity } = opts;
  return (x, path = []) => {
    if (!Array.isArray(x)) return bad("Expected array", path);
    if (x.length < minLen) return bad(`Array length < ${minLen}`, path);
    if (x.length > maxLen) return bad(`Array length > ${maxLen}`, path);
    const out: T[] = [];
    for (let i = 0; i < x.length; i++) {
      const r = item(x[i], path.concat(String(i)));
      if (!r.ok) return r;
      out.push(r.value);
    }
    return ok(out);
  };
}

/** Dictionary validator (string keys). */
export function vDict<T>(item: V<T>): V<Record<string, T>> {
  return (x, path = []) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) return bad("Expected object", path);
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      const r = item(v, path.concat(k)); if (!r.ok) return r;
      out[k] = r.value;
    }
    return ok(out);
  };
}

/** Optional wrapper. */
export const vOptional = <T>(inner: V<T>): V<T | undefined> =>
  (x, path = []) => (isNil(x) ? ok(undefined) : inner(x, path));

/* ============================ Format helpers ============================ */

export function normSymbol(x: unknown): Result<string> {
  const s = vString({ trim: true, upper: true, pattern: /^[A-Z0-9._-]+$/, minLen: 1 })(x);
  return s.ok ? s : bad("Invalid symbol", s.path);
}
export function normCurrency(x: unknown): Result<string> {
  const s = vString({ trim: true, upper: true, pattern: /^[A-Z]{3}$/ })(x);
  return s.ok ? s : bad("Invalid currency code", s.path);
}
export function normId(x: unknown): Result<string> {
  // url/filename-safe id
  const s = vString({ trim: true, lower: true })(x);
  if (!s.ok) return s;
  const id = s.value.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return id ? ok(id) : bad("Invalid id");
}

/* ============================ Record Normalizer ============================ */

/**
 * Build a per-record normalizer from a spec object.
 * Each field gets a validator V<…>. Unknown fields are dropped unless keepUnknown = true.
 */
export function makeRecordNormalizer<T extends Record<string, any>>(
  spec: { [K in keyof T]: V<T[K]> },
  opts: { keepUnknown?: boolean } = {}
): V<T> {
  const { keepUnknown = false } = opts;
  return (x, path = []) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) return bad("Expected object", path);
    const out: any = {};
    // validate declared fields
    for (const k of Object.keys(spec) as Array<keyof T>) {
      const r = spec[k]((x as any)[k], path.concat(String(k)));
      if (!r.ok) return r;
      if (!isNil(r.value)) out[k] = r.value; // omit undefined
    }
    // optionally keep unknown keys raw
    if (keepUnknown) {
      for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
        if (!(k in spec)) out[k] = v;
      }
    }
    return ok(out as T);
  };
}

/** Normalize an array of rows with a record normalizer. */
export function normalizeRows<T>(rows: unknown[], norm: V<T>): Result<T[]> {
  if (!Array.isArray(rows)) return bad("Expected rows array");
  const out: T[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = norm(rows[i], [String(i)]);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return ok(out);
}

/* ============================ CSV helpers ============================ */

/** Safe split for simple CSV (no nested quotes). */
export function simpleCsvParse(text: string, { hasHeader = true, sep = "," } = {}): Result<Record<string, string>[]> {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return ok([]);
  const head = hasHeader ? lines.shift()! : undefined;
    const headers = head ? head.split(sep).map(h => h.trim()) : lines[0].split(sep).map((_, i) => `col${i + 1}`);
  const out: Record<string, string>[] = [];
  for (const ln of lines) {
    const cols = ln.split(sep);
    const rec: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) rec[headers[i]] = toStr(cols[i]).trim();
    out.push(rec);
  }
  return ok(out);
}



/* ============================ Utilities ============================ */

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "NaN%");

export function mapValues<T extends object, U>(obj: T, fn: (v: T[keyof T], k: keyof T) => U): { [K in keyof T]: U } {
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v as any, k as any);
  return out;
}

export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (k in obj) (out as any)[k] = obj[k];
  return out;
}

export function omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const set = new Set(keys as string[]);
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) if (!set.has(k)) out[k] = v;
  return out;
}

export const uniq = <T>(arr: T[]) => Array.from(new Set(arr));

export function stableSort<T>(arr: T[], by: (x: T) => number | string): T[] {
  return arr
    .map((v, i) => ({ v, i }))
    .sort((a, b) => {
      const da = by(a.v), db = by(b.v);
      return da < db ? -1 : da > db ? 1 : a.i - b.i;
    })
    .map(x => x.v);
}

/* ============================ Examples ============================
import {
  vString, vNumber, vEnum, vArray, makeRecordNormalizer, normalizeCsv,
  normSymbol, normCurrency, vISODate
} from "./common/normalizer";

// Define a row shape:
type QuoteRow = {
  date: string;
  symbol: string;
  price: number;
  currency?: string;
  flags?: string[];
};

// Spec for the row:
const quoteSpec = {
  date: vISODate(),
  symbol: (x) => normSymbol(x),
  price: vNumber({ min: 0 }),
  currency: vOptional(normCurrency),
  flags: vOptional(vArray(vString({ lower: true })))
};

// Build a normalizer and use it:
const normalizeQuote = makeRecordNormalizer<QuoteRow>(quoteSpec);

const r = normalizeQuote({ date: "2025-10-01", symbol: " aapl ", price: "123.45", currency: "usd", flags: ["LMT ", "IOC"] });
// r.ok === true -> r.value is QuoteRow

// Or normalize CSV:
const csv = `date,symbol,price
2025-10-01,AAPL,123.45
2025-10-02,MSFT,400`;

const rows = normalizeCsv<QuoteRow>(csv, quoteSpec);
================================================================= */

const Normalizer = {
  ok, bad,
  vNumber, vString, vBoolean, vISODate, vEnum, vArray, vDict, vOptional,
  normSymbol, normCurrency, normId,
    makeRecordNormalizer, normalizeRows,
  clamp, pct, mapValues, pick, omit, uniq, stableSort
};

export default Normalizer;