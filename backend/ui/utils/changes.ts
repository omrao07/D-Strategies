// utils/changes.ts
// Zero-dependency deep change detector with array-aware diffing, numeric tolerance,
// path ignore patterns, and stable-key matching for arrays.
//
// Usage:
//   const changes = diffChanges(prev, next, {
//     numberTolerance: 1e-9,
//     ignore: ["meta.*", "timestamps.*", "items[*].debug"],
//     arrayKeys: { "rows": "id", "users": (x) => x.uid }, // path -> key or key extractor
//   });
//
// Notes:
// - Paths use dot + bracket syntax, e.g. "user.name", "items[3].price", "rows[id=ABC].qty"
// - Arrays: if arrayKeys has an entry for a path, items are matched by that key (add/remove/replace).
//           Otherwise, arrays are compared index-by-index.
// - numberTolerance applies to absolute difference of numbers.

export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | JSONObject | JSONArray;
export type JSONObject = { [k: string]: JSONValue };
export type JSONArray = JSONValue[];

export type ChangeKind = "add" | "remove" | "replace";
export type Path = string;

export interface Change {
  kind: ChangeKind;
  path: Path;
  prev?: JSONValue;
  next?: JSONValue;
}

export type KeyExtractor =
  | string // property name to use as stable key
  | ((item: any) => string | number | null | undefined);

export interface DiffOptions {
  numberTolerance?: number;            // default 0
  ignore?: string[];                   // glob-like patterns against paths
  arrayKeys?: Record<string, KeyExtractor>; // path (to array) -> key selector
  // When true, treat missing vs empty object/array as different (default true)
  strictEmptyVsMissing?: boolean;
}

// ---------- Public API ----------

export function diffChanges(prev: JSONValue, next: JSONValue, opts?: DiffOptions): Change[] {
  const ctx: Ctx = {
    tol: Math.max(0, opts?.numberTolerance ?? 0),
    ignores: (opts?.ignore ?? []).map(compilePattern),
    arrayKeys: opts?.arrayKeys ?? {},
    strictEmptyVsMissing: opts?.strictEmptyVsMissing ?? true,
    out: [],
  };
  walk(prev, next, "", ctx);
  return ctx.out;
}

// ---------- Internal machinery ----------

type Ctx = {
  tol: number;
  ignores: CompiledPattern[];
  arrayKeys: Record<string, KeyExtractor>;
  strictEmptyVsMissing: boolean;
  out: Change[];
};

function walk(a: JSONValue, b: JSONValue, path: string, ctx: Ctx): void {
  if (isIgnored(path, ctx)) return;

  // Handle undefined vs null explicitly at top-level comparisons
  const aU = a === undefined;
  const bU = b === undefined;
  if (aU && bU) return;

  // Add / remove
  if (aU && !bU) {
    ctx.out.push({ kind: "add", path, next: cloneSmall(b) });
    return;
  }
  if (!aU && bU) {
    ctx.out.push({ kind: "remove", path, prev: cloneSmall(a) });
    return;
  }

  // Primitive equality (with number tolerance)
  if (isPrimitive(a) && isPrimitive(b)) {
    if (!primEqual(a, b, ctx.tol)) {
      ctx.out.push({ kind: "replace", path, prev: a as JSONPrimitive, next: b as JSONPrimitive });
    }
    return;
  }

  // Array handling
  if (Array.isArray(a) || Array.isArray(b)) {
    arrayDiff(asArray(a), asArray(b), path, ctx);
    return;
  }

  // Object handling
  if (isObject(a) || isObject(b)) {
    objectDiff(asObject(a), asObject(b), path, ctx);
    return;
  }

  // Fallback replacement
  if (!deepEqual(a, b, ctx.tol)) {
    ctx.out.push({ kind: "replace", path, prev: cloneSmall(a), next: cloneSmall(b) });
  }
}

function objectDiff(a: JSONObject, b: JSONObject, base: string, ctx: Ctx) {
  const aKeys = Object.keys(a || {});
  const bKeys = Object.keys(b || {});
  const seen = new Set<string>();

  for (let i = 0; i < aKeys.length; i++) {
    const k = aKeys[i];
    const p = joinPath(base, k);
    seen.add(k);
    if (!(k in b)) {
      if (ctx.strictEmptyVsMissing || !isEmptyLike(a[k])) {
        ctx.out.push({ kind: "remove", path: p, prev: cloneSmall(a[k]) });
      }
      continue;
    }
    walk(a[k], (b as any)[k], p, ctx);
  }

  for (let i = 0; i < bKeys.length; i++) {
    const k = bKeys[i];
    if (seen.has(k)) continue;
    const p = joinPath(base, k);
    if (ctx.strictEmptyVsMissing || !isEmptyLike(b[k])) {
      ctx.out.push({ kind: "add", path: p, next: cloneSmall(b[k]) });
    }
  }
}

function arrayDiff(a: JSONArray, b: JSONArray, base: string, ctx: Ctx) {
  const keySel = ctx.arrayKeys[base];

  // If keyed, match by stable item keys
  if (keySel !== undefined) {
    const getKey = normalizeKeyExtractor(keySel);
    const aMap: Record<string, any> = {};
    const bMap: Record<string, any> = {};
    const aOrder: string[] = [];
    const bOrder: string[] = [];

    for (let i = 0; i < a.length; i++) {
      const k = safeKey(getKey(a[i]));
      aOrder.push(k);
      aMap[k] = a[i];
    }
    for (let i = 0; i < b.length; i++) {
      const k = safeKey(getKey(b[i]));
      bOrder.push(k);
      bMap[k] = b[i];
    }

    const seen = new Set<string>();
    // Removes / replaces
    for (let i = 0; i < aOrder.length; i++) {
      const k = aOrder[i];
      const p = joinArrayPath(base, `[id=${escapeKey(k)}]`);
      if (!(k in bMap)) {
        ctx.out.push({ kind: "remove", path: p, prev: cloneSmall(aMap[k]) });
        continue;
      }
      seen.add(k);
      walk(aMap[k], bMap[k], p, ctx);
    }
    // Adds
    for (let i = 0; i < bOrder.length; i++) {
      const k = bOrder[i];
      if (seen.has(k)) continue;
      const p = joinArrayPath(base, `[id=${escapeKey(k)}]`);
      ctx.out.push({ kind: "add", path: p, next: cloneSmall(bMap[k]) });
    }
    return;
  }

  // Unkeyed: index-by-index
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const p = joinIndex(base, i);
    const av = a[i];
    const bv = b[i];
    if (i >= a.length) {
      ctx.out.push({ kind: "add", path: p, next: cloneSmall(bv) });
    } else if (i >= b.length) {
      ctx.out.push({ kind: "remove", path: p, prev: cloneSmall(av) });
    } else {
      walk(av, bv, p, ctx);
    }
  }
}

// ---------- Helpers ----------

function isPrimitive(v: any): v is JSONPrimitive {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function isObject(v: any): v is JSONObject {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function asArray(v: any): JSONArray {
  return Array.isArray(v) ? v : [];
}

function asObject(v: any): JSONObject {
  return isObject(v) ? v : {};
}

function primEqual(a: JSONPrimitive, b: JSONPrimitive, tol: number): boolean {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Math.abs(a - b) <= tol;
  }
  return a === b;
}

function deepEqual(a: any, b: any, tol: number): boolean {
  if (a === b) return true;
  if (isPrimitive(a) && isPrimitive(b)) return primEqual(a, b, tol);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i], tol)) return false;
    }
    return true;
  }
  if (isObject(a) && isObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
      const k = ak[i];
      if (!deepEqual(a[k], b[k], tol)) return false;
    }
    return true;
  }
  // NaN vs NaN
  if (typeof a === "number" && typeof b === "number") {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  return false;
}

function isEmptyLike(v: any): boolean {
  if (v == null) return true; // null or undefined
  if (Array.isArray(v)) return v.length === 0;
  if (isObject(v)) return Object.keys(v).length === 0;
  return false;
}

function cloneSmall<T extends JSONValue>(v: T): T {
  // For small patches it's fine to JSON clone primitives/objects/arrays
  if (isPrimitive(v)) return v;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return v;
  }
}

// ---------- Path building ----------

function joinPath(base: string, key: string): string {
  return base ? `${base}.${escapeDot(key)}` : escapeDot(key);
}

function joinIndex(base: string, idx: number): string {
  const b = base || "";
  return `${b}[${idx}]`;
}

function joinArrayPath(base: string, seg: string): string {
  // seg looks like [id=XYZ] already
  const b = base || "";
  return `${b}${seg}`;
}

function escapeDot(key: string): string {
  // If key contains dots or brackets, quote it
  if (/[\.\[\]]/.test(key)) return `["${key.replace(/"/g, '\\"')}"]`;
  return key;
}

function escapeKey(key: string): string {
  return String(key).replace(/([\]\[]|=)/g, "\\$1");
}

// ---------- Ignore patterns ----------

type CompiledPattern = { raw: string; re: RegExp };

function compilePattern(pat: string): CompiledPattern {
  // Very small glob: * matches any segment (no slash concept), ** matches anything,
  // [] literal brackets ok. We translate dots and brackets literally.
  // Examples:
  //   "meta.*" -> ^meta\.[^.]+$
  //   "items[*].debug" -> ^items\[[^\]]+\]\.debug$
  //   "**" -> ^.*$
  const esc = pat.replace(/[-/\\^$+?.()|{}]/g, "\\$&");
  const reStr = "^" +
    esc
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^.]+")
      .replace(/\\\[\*\\\]/g, "\\[[^\\]]+\\]") +
    "$";
  return { raw: pat, re: new RegExp(reStr) };
}

function isIgnored(path: string, ctx: Ctx): boolean {
  if (!path) return false;
  for (let i = 0; i < ctx.ignores.length; i++) {
    if (ctx.ignores[i].re.test(path)) return true;
  }
  return false;
}

// ---------- Array key helpers ----------

function normalizeKeyExtractor(k: KeyExtractor): (item: any) => string {
  if (typeof k === "function") {
    return (item: any) => {
      const v = k(item);
      return safeKey(v);
    };
  }
  const prop = String(k);
  return (item: any) => safeKey(item?.[prop]);
}

function safeKey(v: any): string {
  if (v === null || v === undefined) return "__null__";
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ---------- Convenience: classify changes ----------

export function partitionChanges(changes: Change[]) {
  const added: Change[] = [];
  const removed: Change[] = [];
  const replaced: Change[] = [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (c.kind === "add") added.push(c);
    else if (c.kind === "remove") removed.push(c);
    else replaced.push(c);
  }
  return { added, removed, replaced };
}

// ---------- Pretty-print ----------

export function formatChanges(changes: Change[]): string {
  if (!changes.length) return "No changes.";
  return changes
    .map((c) => {
      const p = c.path || "(root)";
      if (c.kind === "add") return `+ ${p} = ${preview(c.next)}`;
      if (c.kind === "remove") return `- ${p} (was ${preview(c.prev)})`;
      return `~ ${p} : ${preview(c.prev)} -> ${preview(c.next)}`;
    })
    .join("\n");
}

function preview(v: any): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean" || v == null) return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + "..." : s;
  } catch {
    return String(v);
  }
}
