// common/validate.ts
// Tiny, typed validation/parse toolkit (no external deps).

/* ========================= Result & helpers ========================= */

export type Ok<T>  = { ok: true;  data: T };
export type Err    = { ok: false; error: string; path?: string[] };
export type Result<T> = Ok<T> | Err;

const ok = <T>(data: T): Ok<T> => ({ ok: true, data });
const err = (error: string, path: string[] = []): Err => ({ ok: false, error, path });

/* ======================== Schema base interface ===================== */

export interface Schema<T> {
  /** Parse or throw a TypeError with a friendly message */
  parse(x: unknown): T;
  /** Safe parse with Result<T> */
  safeParse(x: unknown, path?: string[]): Result<T>;
  /** User-facing type brand for inference */
  readonly _type?: T;
}

export type Infer<S extends Schema<any>> = S extends Schema<infer T> ? T : never;

/* ============================ Primitives ============================ */

type Refiner<T> = (val: T) => string | void;
type Transformer<I, O> = (val: I) => O;

abstract class BaseSchema<T> implements Schema<T> {
  protected refiners: Refiner<T>[] = [];
  protected transformer?: Transformer<any, any>;

  abstract _base(x: unknown, path: string[]): Result<any>;

  safeParse(x: unknown, path: string[] = []): Result<T> {
    const base = this._base(x, path);
    if (!base.ok) return base;
    let val: any = base.data;
    if (this.transformer) {
      try { val = this.transformer(val); }
      catch (e: any) { return err(e?.message ?? "transform failed", path); }
    }
    for (const r of this.refiners) {
      const m = r(val);
      if (m) return err(m, path);
    }
    return ok(val as T);
  }

  parse(x: unknown): T {
    const r = this.safeParse(x);
    if (!r.ok) {
      const where = r.path && r.path.length ? ` @ ${r.path.join(".")}` : "";
      throw new TypeError(`${r.error}${where}`);
    }
    return r.data;
  }

  refine(fn: Refiner<T>): this {
    this.refiners.push(fn);
    return this;
  }

  transform<U>(fn: Transformer<T, U>): Schema<U> {
    const next = this as any as BaseSchema<U>;
    next.transformer = fn as any;
    return next;
  }
}

/* --------------------------- string() --------------------------- */

class StringSchema extends BaseSchema<string> {
  private _coerce = false;
  _base(x: unknown, path: string[]): Result<string> {
    if (typeof x === "string") return ok(x);
    if (this._coerce && x != null) return ok(String(x));
    return err("Expected string", path);
  }
  min(n: number) { return this.refine(v => v.length < n ? `String length < ${n}` : undefined); }
  max(n: number) { return this.refine(v => v.length > n ? `String length > ${n}` : undefined); }
  nonempty()     { return this.min(1); }
  regex(rx: RegExp, msg = `String does not match ${rx}`) {
    return this.refine(v => rx.test(v) ? undefined : msg);
  }
  email() { return this.regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid email"); }
  url()   { return this.refine(v => { try { new URL(v); return; } catch { return "Invalid URL"; } }); }
  trim()  { return this.transform(v => v.trim()); }
  lower() { return this.transform(v => v.toLowerCase()); }
  upper() { return this.transform(v => v.toUpperCase()); }
  coerce() { this._coerce = true; return this; }
}

/* --------------------------- number() --------------------------- */

class NumberSchema extends BaseSchema<number> {
  private _coerce = false;
  _base(x: unknown, path: string[]): Result<number> {
    if (typeof x === "number" && Number.isFinite(x)) return ok(x);
    if (this._coerce && x != null) {
      const n = typeof x === "string" ? Number(x.replace(/[_,\s]/g, "")) : Number(x);
      if (Number.isFinite(n)) return ok(n);
    }
    return err("Expected finite number", path);
  }
  min(n: number)  { return this.refine(v => v < n ? `Number < ${n}` : undefined); }
  max(n: number)  { return this.refine(v => v > n ? `Number > ${n}` : undefined); }
  int()           { return this.refine(v => Number.isInteger(v) ? undefined : "Expected integer"); }
  finite()        { return this.refine(v => Number.isFinite(v) ? undefined : "Expected finite"); }
  positive()      { return this.min(0).refine(v => v > 0 ? undefined : "Expected > 0"); }
  nonnegative()   { return this.refine(v => v >= 0 ? undefined : "Expected >= 0"); }
  percent()       { return this.refine(v => v >= 0 && v <= 1 ? undefined : "Expected [0,1]"); }
  coerce()        { this._coerce = true; return this; }
}

/* -------------------------- boolean() -------------------------- */

class BooleanSchema extends BaseSchema<boolean> {
  private _coerce = false;
  _base(x: unknown, path: string[]): Result<boolean> {
    if (typeof x === "boolean") return ok(x);
    if (this._coerce && x != null) {
      if (typeof x === "number") return ok(Boolean(x));
      if (typeof x === "string") {
        const s = x.trim().toLowerCase();
        if (["true","t","1","yes","y"].includes(s)) return ok(true);
        if (["false","f","0","no","n"].includes(s)) return ok(false);
      }
    }
    return err("Expected boolean", path);
  }
  coerce() { this._coerce = true; return this; }
}

/* ---------------------------- date() --------------------------- */

class DateSchema extends BaseSchema<Date> {
  private _coerce = false;
  _base(x: unknown, path: string[]): Result<Date> {
    if (x instanceof Date && Number.isFinite(x.getTime())) return ok(x);
    if (this._coerce && x != null) {
      const d = new Date(typeof x === "string" || typeof x === "number" ? x : String(x));
      if (Number.isFinite(d.getTime())) return ok(d);
    }
    return err("Expected Date", path);
  }
  coerce() { this._coerce = true; return this; }
  toISO()  { return this.transform(d => d.toISOString()); }
}

/* -------------------------- literal() / enum() -------------------------- */

class LiteralSchema<T extends string | number | boolean | null> extends BaseSchema<T> {
  constructor(private value: T) { super(); }
  _base(x: unknown, path: string[]): Result<T> {
    return Object.is(x, this.value) ? ok(this.value) : err(`Expected literal ${String(this.value)}`, path);
  }
}

class EnumSchema<T extends string> extends BaseSchema<T> {
  constructor(private values: readonly T[]) { super(); }
  _base(x: unknown, path: string[]): Result<T> {
    return typeof x === "string" && (this.values as readonly string[]).includes(x)
      ? ok(x as T) : err(`Expected one of: ${this.values.join(", ")}`, path);
  }
}

/* --------------------------- array() / record() --------------------------- */

class ArraySchema<T> extends BaseSchema<T[]> {
  constructor(private item: Schema<T>) { super(); }
  _base(x: unknown, path: string[]): Result<T[]> {
    if (!Array.isArray(x)) return err("Expected array", path);
    const out: T[] = [];
    for (let i = 0; i < x.length; i++) {
      const r = this.item.safeParse(x[i], path.concat(String(i)));
      if (!r.ok) return r;
      out.push(r.data);
    }
    return ok(out);
  }
  min(n: number) { return this.refine(v => v.length < n ? `Array length < ${n}` : undefined); }
  max(n: number) { return this.refine(v => v.length > n ? `Array length > ${n}` : undefined); }
  nonempty() { return this.min(1); }
}

class RecordSchema<V> extends BaseSchema<Record<string, V>> {
  constructor(private val: Schema<V>) { super(); }
  _base(x: unknown, path: string[]): Result<Record<string, V>> {
    if (!x || typeof x !== "object" || Array.isArray(x)) return err("Expected object", path);
    const out: Record<string, V> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      const r = this.val.safeParse(v, path.concat(k)); if (!r.ok) return r;
      out[k] = r.data;
    }
    return ok(out);
  }
}

/* ------------------------------- object() ------------------------------- */

type Shape = Record<string, Schema<any>>;

class ObjectSchema<S extends Shape> extends BaseSchema<{ [K in keyof S]: Infer<S[K]> }> {
  private _stripUnknown = true;
  private _partialKeys: Set<string> | null = null;
  constructor(private shape: S) { super(); }

  _base(x: unknown, path: string[]): Result<any> {
    if (!x || typeof x !== "object" || Array.isArray(x)) return err("Expected object", path);
    const out: any = {};
    for (const k of Object.keys(this.shape) as (keyof S)[]) {
      const schema = this.shape[k];
      const present = Object.prototype.hasOwnProperty.call(x, k as string);
      const optional = this._partialKeys?.has(k as string) ?? false;
      if (!present && optional) continue;
      const r = schema.safeParse((x as any)[k], path.concat(String(k)));
      if (!r.ok) return r;
      if (r.data !== undefined) out[k] = r.data;
    }
    if (!this._stripUnknown) {
      for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
        if (!(k in this.shape)) out[k] = v;
      }
    }
    return ok(out);
  }

  stripUnknown(v = true) { this._stripUnknown = v; return this; }

  /** Mark keys optional; pass none to make *all* optional */
  partial<K extends keyof S>(...keys: K[]) {
    if (!keys.length) this._partialKeys = new Set(Object.keys(this.shape));
    else this._partialKeys = new Set(keys.map(String));
    return this;
  }
}

/* ------------------------------- union() ------------------------------- */

class UnionSchema<T> extends BaseSchema<T> {
  constructor(private members: Schema<any>[]) { super(); }
  _base(x: unknown, path: string[]): Result<T> {
    const errors: string[] = [];
    for (const m of this.members) {
      const r = m.safeParse(x, path);
      if (r.ok) return r as any;
      errors.push(r.error);
    }
    return err(`No union member matched: ${errors.join(" | ")}`, path);
  }
}

/* ------------------------- optional / nullable / default ------------------------- */

class OptionalSchema<T> extends BaseSchema<T | undefined> {
  constructor(private inner: Schema<T>) { super(); }
  _base(x: unknown, path: string[]): Result<T | undefined> {
    if (x === undefined) return ok(undefined);
    return this.inner.safeParse(x, path);
  }
}

class NullableSchema<T> extends BaseSchema<T | null> {
  constructor(private inner: Schema<T>) { super(); }
  _base(x: unknown, path: string[]): Result<T | null> {
    if (x === null) return ok(null);
    return this.inner.safeParse(x, path);
  }
}

class DefaultSchema<T> extends BaseSchema<T> {
  constructor(private inner: Schema<T>, private def: T | (() => T)) { super(); }
  _base(x: unknown, path: string[]): Result<T> {
    if (x === undefined) {
      const v = typeof this.def === "function" ? (this.def as any)() : this.def;
      return ok(v);
    }
    return this.inner.safeParse(x, path);
  }
}

/* ============================== Factory fns ============================== */

export const string = () => new StringSchema();
export const number = () => new NumberSchema();
export const boolean = () => new BooleanSchema();
export const date = () => new DateSchema();
export const literal = <T extends string | number | boolean | null>(v: T) => new LiteralSchema<T>(v);
export const enumeration = <T extends string>(vals: readonly T[]) => new EnumSchema<T>(vals);
export const array = <T>(item: Schema<T>) => new ArraySchema(item);
export const record = <V>(val: Schema<V>) => new RecordSchema(val);
export const object = <S extends Shape>(shape: S) => new ObjectSchema(shape);
export const union = <A extends Schema<any>[]>(...members: A) => new UnionSchema<Infer<A[number]>>(members);

export const optional = <T>(s: Schema<T>) => new OptionalSchema(s);
export const nullable = <T>(s: Schema<T>) => new NullableSchema(s);
export const withDefault = <T>(s: Schema<T>, def: T | (() => T)) => new DefaultSchema(s, def);

/* ============================== Coercion API ============================== */

export const coerce = {
  string: () => string().coerce(),
  number: () => number().coerce(),
  boolean: () => boolean().coerce(),
  date: () => date().coerce(),
};

/* ============================== Runtime helpers ============================== */

export function isValid<T>(schema: Schema<T>, value: unknown): value is T {
  return schema.safeParse(value).ok;
}

export function assertValid<T>(schema: Schema<T>, value: unknown, label = "value"): asserts value is T {
  schema.parse(value); // throws TypeError on failure
}

export function safeParse<T>(schema: Schema<T>, value: unknown): Result<T> {
  return schema.safeParse(value);
}

export function parse<T>(schema: Schema<T>, value: unknown): T {
  return schema.parse(value);
}

/* ============================== Examples (comment) ==============================

import * as V from "./common/validate";

// Define a schema
const Quote = V.object({
  date: V.coerce.date().toISO(),
  symbol: V.string().trim().upper().regex(/^[A-Z0-9._-]+$/),
  price: V.coerce.number().nonnegative(),
  flags: V.optional(V.array(V.string().lower()))
});

// Inference:
type Quote = V.Infer<typeof Quote>;

// Usage:
const q = V.parse(Quote, { date: "2025-10-14", symbol: " aapl ", price: "123.45", flags: ["IOC"] });
// q is strongly typed

const bad = V.safeParse(Quote, { symbol: "?" });
if (!bad.ok) console.error(bad.error, bad.path);

================================================================================= */