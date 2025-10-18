// security/audit.ts
// Small, dependency-free helpers to harden apps and generate auditable
// security signals/logs. Works in Node and the browser.

type Dict<T = unknown> = Record<string, T>;

/* ───────────────────────────── Cryptography ────────────────────────────── */

const text = (s: string) =>
  typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s) : Buffer.from(s, "utf8");

export function timingSafeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const x = typeof a === "string" ? text(a) : a;
  const y = typeof b === "string" ? text(b) : b;
  if (x.length !== y.length) {
    let acc = 0;
    const len = Math.max(x.length, y.length);
    for (let i = 0; i < len; i++) {
      const xi = x[i % x.length] ?? 0;
      const yi = y[i % y.length] ?? 0;
      acc |= xi ^ yi;
    }
    return acc === 0;
  }
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function subtleDigest(algo: "SHA-256" | "SHA-1", s: string): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const buf = await crypto.subtle.digest(algo, text(s));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const c = require("crypto") as typeof import("crypto");
    return c.createHash(algo.replace("-", "").toLowerCase()).update(s, "utf8").digest("hex");
  } catch {
    // weak fallback; avoid in production
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
  }
}

export const sha256 = (s: string) => subtleDigest("SHA-256", s);
export const sha1 = (s: string) => subtleDigest("SHA-1", s);

export async function verifyHmac(
  algo: "sha256" | "sha1",
  secret: string,
  payload: string,
  signature: string
): Promise<boolean> {
  const [maybeAlgo, hex] = signature.includes("=") ? signature.split("=", 2) : ["", signature];
  if (maybeAlgo && maybeAlgo.toLowerCase() !== algo) return false;

  if (typeof crypto !== "undefined" && (crypto as any).subtle && !(crypto as any).createHmac) {
    const key = await crypto.subtle.importKey(
      "raw",
      text(secret),
      { name: "HMAC", hash: { name: algo.toUpperCase() } as any },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, text(payload));
    const calc = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
    return timingSafeEqual(calc, hex);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const c = require("crypto") as typeof import("crypto");
    const calc = c.createHmac(algo, secret).update(payload, "utf8").digest("hex");
    return timingSafeEqual(calc, hex);
  } catch {
    return false;
  }
}

/* ─────────────────────────────── Random IDs ────────────────────────────── */

export function generateNonce(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(arr);
  else for (let i = 0; i < bytes; i++) arr[i] = (Math.random() * 256) | 0;

  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);

  if (typeof btoa !== "undefined") {
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Buffer = require("buffer").Buffer as typeof import("buffer").Buffer;
    return Buffer.from(arr).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  } catch {
    return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
  }
}

export const randomId = (len = 20) => {
  const arr = new Uint8Array(len);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(arr);
  else for (let i = 0; i < len; i++) arr[i] = (Math.random() * 256) | 0;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[arr[i] & 63];
  return out;
};

/* ───────────────────────────── Content Security ─────────────────────────── */

export type CspDirectives = Partial<{
  "default-src": string[];
  "script-src": string[];
  "style-src": string[];
  "img-src": string[];
  "font-src": string[];
  "connect-src": string[];
  "frame-src": string[];
  "worker-src": string[];
  "base-uri": string[];
  "form-action": string[];
  "frame-ancestors": string[];
  "object-src": string[];
  "manifest-src": string[];
  "report-to": string[];
  "report-uri": string[];
  "upgrade-insecure-requests": boolean;
  "block-all-mixed-content": boolean;
}>;

function quote(x: string) {
  if (x.startsWith("'") || x.startsWith("nonce-") || x.startsWith("sha")) return x;
  if (x === "self" || x === "none" || x === "unsafe-inline" || x === "unsafe-eval") return `'${x}'`;
  return x;
}

/** Build a CSP header value from a directive map. */
export function buildCsp(d: CspDirectives): { header: string; policy: string } {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (v === false || v == null) continue;
    if (v === true) {
      parts.push(k);
      continue;
    }
    const arr = Array.isArray(v) ? (v as string[]) : [];
    if (!arr.length) continue;
    parts.push(`${k} ${arr.map(quote).join(" ")}`);
  }
  const policy = parts.join("; ");
  return { header: "Content-Security-Policy", policy };
}

/** Strict defaults; pass overrides to extend/replace. */
export function defaultCsp(nonce?: string, overrides: CspDirectives = {}): CspDirectives {
  const base: CspDirectives = {
    "default-src": ["'self'"],
    "script-src": ["'self'", nonce ? `'nonce-${nonce}'` : "'unsafe-inline'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "frame-ancestors": ["'none'"],
    "upgrade-insecure-requests": true,
  };
  // merge (replace arrays by key if provided)
  const out: CspDirectives = { ...base, ...overrides };
  for (const k of Object.keys(overrides) as (keyof CspDirectives)[]) {
    const v = overrides[k];

  }
  return out;
}

/* ─────────────────────────── Security Headers ──────────────────────────── */

export type SecurityHeadersOptions = {
  csp?: CspDirectives | false;
  nonce?: string;
  frameOptions?: "DENY" | "SAMEORIGIN" | false;
  referrerPolicy?:
  | false
  | "no-referrer"
  | "no-referrer-when-downgrade"
  | "origin"
  | "origin-when-cross-origin"
  | "same-origin"
  | "strict-origin"
  | "strict-origin-when-cross-origin"
  | "unsafe-url";
  hstsMaxAge?: number; // seconds
  hstsSubdomains?: boolean;
  hstsPreload?: boolean;
  permissionsPolicy?: Dict<string | string[]>;
  crossOriginOpener?: "same-origin" | "same-origin-allow-popups" | "unsafe-none";
  crossOriginEmbedder?: "require-corp" | "unsafe-none";
  crossOriginResource?: "same-site" | "same-origin" | "cross-origin";
};

export function buildSecurityHeaders(opts: SecurityHeadersOptions = {}): Record<string, string> {
  const {
    csp = {},
    nonce,
    frameOptions = "DENY",
    referrerPolicy = "strict-origin-when-cross-origin",
    hstsMaxAge = 15552000,
    hstsSubdomains = true,
    hstsPreload = false,
    permissionsPolicy,
    crossOriginOpener = "same-origin",
    crossOriginEmbedder,
    crossOriginResource,
  } = opts;

  // Start with optional strings; filter later to return Record<string, string>
  const headersOpt: Record<string, string | undefined> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": frameOptions || undefined,
    "Referrer-Policy": referrerPolicy || undefined,
    "X-XSS-Protection": "0",
    "Cross-Origin-Opener-Policy": crossOriginOpener || undefined,
    "Cross-Origin-Embedder-Policy": crossOriginEmbedder || undefined,
    "Cross-Origin-Resource-Policy": crossOriginResource || undefined,
  };

  // HSTS (HTTPS only)
  if (hstsMaxAge && hstsMaxAge > 0) {
    let v = `max-age=${Math.floor(hstsMaxAge)}${hstsSubdomains ? "; includeSubDomains" : ""}`;
    if (hstsPreload) v += "; preload";
    headersOpt["Strict-Transport-Security"] = v;
  }

  if (permissionsPolicy) {
    const pp = Object.entries(permissionsPolicy)
      .map(([k, v]) => `${k}=(${(Array.isArray(v) ? v : [v]).join(" ")})`)
      .join(", ");
    headersOpt["Permissions-Policy"] = pp;
  }

  if (csp !== false) {
    const cspDirectives = Object.keys(csp).length ? (csp as CspDirectives) : defaultCsp(nonce);
    const { policy } = buildCsp(cspDirectives);
    if (policy) headersOpt["Content-Security-Policy"] = policy;
  }

  // Strip undefineds and return a clean Record<string,string>
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(headersOpt)) {
    if (typeof v === "string") headers[k] = v;
  }
  return headers;
}

/* ───────────────────────────── Input Validation ────────────────────────── */

const SAFE_NAME = /^[a-zA-Z0-9._-]+$/;

export function isSafeFilename(name: string, max = 128): boolean {
  if (!name || name.length > max) return false;
  if (!SAFE_NAME.test(name)) return false;
  if (name === "." || name === "..") return false;
  return true;
}

export function isSafePath(p: string, { allowLeadingSlash = true } = {}): boolean {
  if (!p) return false;
  if (!allowLeadingSlash && p.startsWith("/")) return false;
  if (p.includes("\0")) return false;
  if (p.split("/").some(seg => seg === "..")) return false;
  return true;
}

export function isSafeOrigin(origin: string, allowlist: string[] = []): boolean {
  try {
    const u = new URL(origin);
    return allowlist.some(o => {
      try {
        const a = new URL(o);
        return a.protocol === u.protocol && a.hostname === u.hostname && (a.port || "80") === (u.port || "80");
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/* ───────────────────────────── Secret Redaction ────────────────────────── */

export function redactSecrets<T extends Dict>(obj: T, keys: string[] = ["password", "token", "secret", "apiKey"]): T {
  const lower = new Set(keys.map(k => k.toLowerCase()));
  const out: any = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    const isSecret = lower.has(k.toLowerCase()) || /pass|secret|token|key/i.test(k);
    if (v && typeof v === "object") out[k] = redactSecrets(v as any, keys);
    else out[k] = isSecret ? mask(String(v)) : v;
  }
  return out as T;
}

const mask = (s: string) => (s.length <= 4 ? "***" : s.slice(0, 2) + "***" + s.slice(-2));

/* ─────────────────────────────── Audit Events ───────────────────────────── */

export type AuditEvent = {
  id: string;
  at: number;
  who?: { userId?: string; ip?: string; agent?: string;[k: string]: unknown };
  what: string;
  result: "OK" | "DENY" | "ERROR";
  target?: string;
  meta?: Dict;
};

export function makeAuditEvent(
  partial: Partial<AuditEvent> & Pick<AuditEvent, "what" | "result">
): AuditEvent {
  return {
    id: partial.id ?? randomId(16),
    at: partial.at ?? Date.now(),
    who: partial.who,
    what: partial.what,
    result: partial.result,
    target: partial.target,
    meta: partial.meta ? redactSecrets(partial.meta) : undefined,
  };
}

/** Framework-agnostic request summary. */
export function summarizeRequest(req: any): {
  ip?: string; method?: string; path?: string; origin?: string; agent?: string;
} {
  try {
    const headers = (req?.headers ?? req?.rawHeaders ?? {}) as Dict<string>;
    const h = (k: string) => (headers[k] ?? headers[k.toLowerCase()]);
    const ip =
      req?.ip ||
      req?.clientIp ||
      h("x-forwarded-for")?.toString().split(",")[0]?.trim() ||
      req?.socket?.remoteAddress ||
      req?.connection?.remoteAddress;
    return {
      ip: typeof ip === "string" ? ip : undefined,
      method: req?.method,
      path: req?.url || req?.path,
      origin: h("origin") || h("referer"),
      agent: h("user-agent"),
    };
  } catch {
    return {};
  }
}

/* ───────────────────────────── Allow/Deny helpers ───────────────────────── */

export function ipAllowed(ip: string | undefined, allow: string[] = [], deny: string[] = []): boolean {
  if (!ip) return false;
  if (deny.some(d => matchCidr(ip, d))) return false;
  if (allow.length === 0) return true;
  return allow.some(a => matchCidr(ip, a));
}

export function originAllowed(origin: string | undefined, allow: string[] = []): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return allow.some(rule => {
      try {
        const r = new URL(rule);
        return r.protocol === u.protocol && r.hostname === u.hostname && (r.port || "") === (u.port || "");
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function matchCidr(ip: string, rule: string): boolean {
  if (rule === "*" || rule === "0.0.0.0/0") return true;
  if (!rule.includes("/")) return ip === rule;
  const [base, bitsStr] = rule.split("/");
  const bits = Number(bitsStr);
  const ipNum = ipv4ToInt(ip);
  const baseNum = ipv4ToInt(base);
  if (ipNum == null || baseNum == null || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

function ipv4ToInt(addr: string): number | null {
  const m = addr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const n = m.slice(1).map(x => Number(x));
  if (n.some(v => v < 0 || v > 255)) return null;
  return ((n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3]) >>> 0;
}

/* ───────────────────────────── Convenience API ─────────────────────────── */

export function hardenResponse(opts: SecurityHeadersOptions = {}): { headers: Record<string, string>; nonce?: string } {
  const nonce = opts.nonce ?? generateNonce();
  const headers = buildSecurityHeaders({ ...opts, nonce });
  return { headers, nonce };
}

export default {
  timingSafeEqual,
  sha256,
  sha1,
  verifyHmac,
  generateNonce,
  randomId,
  buildCsp,
  defaultCsp,
  buildSecurityHeaders,
  hardenResponse,
  isSafeFilename,
  isSafePath,
  isSafeOrigin,
  redactSecrets,
  makeAuditEvent,
  summarizeRequest,
  ipAllowed,
  originAllowed,
};
