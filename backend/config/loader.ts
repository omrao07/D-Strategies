// config/loader.ts
// Minimal config loader: defaults → files (.json/.yaml/.yml/.env) → env (with prefix) → interpolation → required checks.
// Zero deps. Non-generic to avoid editor squiggles.

import * as fs from "fs";
import * as path from "path";

/* =========================
   Types
   ========================= */

export type Dict = Record<string, any>;

export type LoaderOptions = {
  defaults?: Dict;
  files?: string[];
  envPrefix?: string;          // e.g., "APP_"
  useEnv?: boolean;            // default true
  expandEnv?: boolean;         // default true
  required?: string[];         // deep keys e.g. "broker.apiKey"
  cwd?: string;
};

export type LoadedConfig = Dict & {
  __meta: {
    sources: string[];
    envPrefix?: string;
    expanded: boolean;
    loadedAt: string;
  };
};

/* =========================
   Helpers
   ========================= */

const isObj = (x: unknown): x is Dict => x != null && typeof x === "object" && !Array.isArray(x);

function deepMerge(a: Dict, b: Dict): Dict {
  const out: Dict = { ...a };
  for (const k of Object.keys(b || {})) {
    const v = b[k];
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function deepSet(obj: Dict, pathStr: string, value: any, sep = ".") {
  const parts = pathStr.split(sep).filter(Boolean);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!isObj(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function deepGet(obj: Dict, pathStr: string, sep = "."): any {
  const parts = pathStr.split(sep).filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
    if (cur === undefined) return undefined;
  }
  return cur;
}

function castScalar(s: string): any {
  const t = s.trim();
  if (/^(true|false)$/i.test(t)) return /^true$/i.test(t);
  if (t === "null" || t === "NULL") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

/* =========================
   Parsers
   ========================= */

function parseJSON(text: string): Dict {
  try { return JSON.parse(text); } catch { return {}; }
}

function parseDotEnv(text: string): Dict {
  const out: Dict = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*?)\s*=\s*(.*)$/);
    if (!m) continue;
    let [, key, val] = m;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = castScalar(val);
  }
  return out;
}

/** Tiny YAML subset (key: value, 2-space nesting, arrays with "- item") */
function parseYAML(text: string): Dict {
  const lines = text.replace(/\t/g, "  ").split(/\r?\n/);
  type Node = { indent: number; value: any };
  const root: Node = { indent: -1, value: {} };
  const stack: Node[] = [root];

  function parentAt(indent: number): Node {
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    return stack[stack.length - 1];
  }

  for (let raw of lines) {
    const line = raw.replace(/\#.*$/, "");
    if (!line.trim()) continue;
    const indent = (line.match(/^(\s*)/)?.[1]?.length ?? 0);
    const body = line.trim();

    const arr = body.match(/^- (.*)$/);
    if (arr) {
      const p = parentAt(indent);
      if (!Array.isArray(p.value)) p.value = [];
      (p.value as any[]).push(castYamlScalar(arr[1]));
      continue;
    }

    const kv = body.match(/^([^:]+):\s*(.*)$/);
    if (kv) {
      const key = String(kv[1]).trim();
      const rhs = kv[2];
      const p = parentAt(indent);
      if (!isObj(p.value)) p.value = {};
      if (rhs === "") {
        const obj: Dict = {};
        (p.value as Dict)[key] = obj;
        stack.push({ indent, value: obj });
      } else {
        (p.value as Dict)[key] = castYamlScalar(rhs);
      }
    }
  }
  return root.value;

  function castYamlScalar(s: string): any {
    const t = s.trim();
    const m = t.match(/^([^:]+):\s*(.*)$/); // inline obj "k: v"
    if (m) return { [m[1].trim()]: castScalar(m[2]) };
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return castScalar(t);
  }
}

/* =========================
   File loading
   ========================= */

function readIfExists(file: string): string | null {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

function loadFileToObject(file: string): Dict {
  const txt = readIfExists(file);
  if (txt == null) return {};
  const ext = path.extname(file).toLowerCase();
  if (ext === ".json") return parseJSON(txt);
  if (ext === ".yaml" || ext === ".yml") return parseYAML(txt);
  if (ext === ".env") return parseDotEnv(txt);
  return parseJSON(txt) || {};
}

/* =========================
   ENV → deep object
   ========================= */

function readEnv(prefix?: string): Dict {
  const out: Dict = {};
  const env: Dict = (typeof process !== "undefined" && (process as any)?.env) || {};
  for (const key of Object.keys(env)) {
    if (prefix && !key.startsWith(prefix)) continue;
    const bare = prefix ? key.slice(prefix.length) : key;
    if (!bare) continue;
    const pathParts = bare
      .split("__")
      .map(s => s.toLowerCase())
      .map(s => s.replace(/[^a-z0-9]+/g, "_"))
      .filter(Boolean);
    if (!pathParts.length) continue;
    deepSet(out, pathParts.join("."), castScalar(String(env[key] ?? "")));
  }
  return out;
}

/* =========================
   Interpolation
   ========================= */

function expandInterpolations(cfg: Dict): Dict {
  const env: Dict = (typeof process !== "undefined" && (process as any)?.env) || {};

  function expandValue(v: any, root: Dict): any {
    if (typeof v !== "string") return v;
    return v.replace(/\$\{([^}]+)\}/g, (_m, expr: string) => {
      const key = String(expr).trim();
      if (env[key] !== undefined) return String(env[key]);
      const got = deepGet(root, key);
      return got !== undefined ? String(got) : "";
    });
  }

  function walk(node: any, root: Dict): any {
    if (Array.isArray(node)) return node.map(n => walk(n, root));
    if (isObj(node)) {
      const out: Dict = {};
      for (const k of Object.keys(node)) out[k] = walk(node[k], root);
      return out;
    }
    return expandValue(node, cfg);
  }

  return walk(cfg, cfg);
}

/* =========================
   Validation
   ========================= */

function ensureRequired(cfg: Dict, req: string[]) {
  const missing: string[] = [];
  for (const key of req) {
    const v = deepGet(cfg, key);
    const empty =
      v === undefined || v === null || v === "" ||
      (Array.isArray(v) && v.length === 0) ||
      (isObj(v) && Object.keys(v).length === 0);
    if (empty) missing.push(key);
  }
  if (missing.length) {
    const err = new Error(`Missing required config keys: ${missing.join(", ")}`);
    (err as any).missing = missing;
    throw err;
  }
}

/* =========================
   Public API (non-generic)
   ========================= */

export function loadConfig(opts?: LoaderOptions): LoadedConfig {
  const _opts: LoaderOptions = opts ?? {};

  const hasProcess = typeof process !== "undefined";
  const cwd =
    _opts.cwd ||
    (hasProcess && typeof (process as any).cwd === "function" ? (process as any).cwd() : ".") ||
    ".";

  const files = (_opts.files || []).map(f => (path.isAbsolute(f) ? f : path.join(cwd, f)));

  let cfg: Dict = {};
  const sources: string[] = [];

  // 1) defaults
  if (_opts.defaults) {
    cfg = deepMerge(cfg, _opts.defaults);
    sources.push("defaults");
  }

  // 2) files (in order)
  for (const f of files) {
    const obj = loadFileToObject(f);
    if (Object.keys(obj).length) {
      cfg = deepMerge(cfg, obj);
      sources.push(path.relative(cwd, f));
    }
  }

  // 3) env (prefix)
  if (_opts.useEnv !== false) {
    const envObj = readEnv(_opts.envPrefix);
    if (Object.keys(envObj).length) {
      cfg = deepMerge(cfg, envObj);
      sources.push(_opts.envPrefix ? `env:${_opts.envPrefix}*` : "env:*");
    }
  }

  // 4) interpolation
  const expanded = _opts.expandEnv !== false;
  if (expanded) cfg = expandInterpolations(cfg);

  // 5) validation
  if (_opts.required?.length) ensureRequired(cfg, _opts.required);

  const out = Object.assign({}, cfg) as LoadedConfig;
  out.__meta = {
    sources,
    envPrefix: _opts.envPrefix,
    expanded,
    loadedAt: new Date().toISOString(),
  };
  return out;
}

/* =========================
   CLI demo (optional)
   ========================= */

// satisfy TS without @types/node
declare const process: any;

if (typeof import.meta !== "undefined" && (import.meta as any).url === `file://${process.argv?.[1]}`) {
  (async () => {
    const arg = (k: string) => {
      const m = (process.argv || []).find((a: string) => a.startsWith(`--${k}=`));
      return m ? m.split("=")[1] : undefined;
    };
    const file = arg("file");
    const prefix = arg("prefix");
    const required = (arg("required") || "").split(",").filter(Boolean);

    const cfg = loadConfig({
      files: file ? file.split(",") : [],
      envPrefix: prefix,
      required,
      defaults: {
        engine: { host: "127.0.0.1", port: 3000 },
        broker: { baseUrl: "", apiKey: "" },
        storage: { dir: "./data" }
      }
    });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(cfg, null, 2));
  })().catch((e) => {
    // eslint-disable-next-line no-console
    console.error("[config/loader] error:", (e as any)?.message || e);
    if (typeof process !== "undefined" && process?.exit) process.exit(1);
  });
}