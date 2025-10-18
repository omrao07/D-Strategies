// data/http-feed.ts
// Minimal HTTP/HTTPS feed with retries, timeouts, compression, and TTL cache.
// NodeNext/ESM, zero external deps.

import * as http from "http";
import * as https from "https";
import * as zlib from "zlib";
import { URL } from "url";

/* =========================
   Types
   ========================= */

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
export type BackoffKind = "constant" | "linear" | "exponential" | "decorrelated-jitter";

export type RetryOptions = {
  retries?: number;           // total extra attempts (default 3)
  timeoutMs?: number;         // per-attempt timeout (socket+response)
  kind?: BackoffKind;         // default "exponential"
  baseMs?: number;            // default 200
  maxMs?: number;             // default 30_000
  factor?: number;            // default 2
  jitter?: boolean;           // default true (±10%)
  shouldRetry?: (e: any, status?: number) => boolean; // default: network OR 5xx/429
};

export type RequestOptions = {
  url: string;
  method?: Method;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: string | Buffer | Record<string, any>;          // auto-JSON if object
  gzip?: boolean;                                        // accept-encoding gzip
  retry?: RetryOptions;
};

export type ResponseData = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  url: string;
  buffer: Buffer;
  text: () => string;
  json: <T = unknown>() => T;
};

export type CacheEntry = {
  url: string;
  etag?: string;
  lastModified?: string;
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
  status: number;
  ts: number;
  ttlMs: number;
};

export type FeedOptions = {
  defaultHeaders?: Record<string, string>;
  defaultRetry?: RetryOptions;
  cacheTtlMs?: number;             // default 60_000
  userAgent?: string;              // default set
};

export type HTTPFeed = {
  request: (opts: RequestOptions) => Promise<ResponseData>;
  get: (url: string, opts?: Omit<RequestOptions, "url" | "method">) => Promise<ResponseData>;
  getJSON: <T = unknown>(url: string, opts?: Omit<RequestOptions, "url" | "method">) => Promise<T>;
  getText: (url: string, opts?: Omit<RequestOptions, "url" | "method">) => Promise<string>;
  postJSON: (url: string, body?: any, opts?: Omit<RequestOptions, "url" | "method" | "body">) => Promise<ResponseData>;
  setCacheTTL: (ms: number) => void;
  clearCache: () => void;
  cacheInfo: () => { size: number };
};

/* =========================
   Helpers
   ========================= */

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function nextDelay(
  attempt: number,
  r: Required<Omit<RetryOptions, "timeoutMs" | "retries" | "shouldRetry">>
) {
  const { kind, baseMs, maxMs, factor, jitter } = r;
  let d: number;
  switch (kind) {
    case "constant": d = baseMs; break;
    case "linear": d = baseMs + attempt * baseMs * (factor - 1); break;
    case "decorrelated-jitter": {
      const hi = Math.min(maxMs, baseMs * Math.pow(factor, attempt + 1));
      d = baseMs + Math.random() * (hi - baseMs);
      break;
    }
    case "exponential":
    default: d = baseMs * Math.pow(factor, attempt);
  }
  d = Math.min(d, maxMs);
  if (jitter) {
    const sign = Math.random() < 0.5 ? -1 : 1;
    d = clamp(d + sign * d * 0.1 * Math.random(), 0, maxMs);
  }
  return Math.round(d);
}

function buildURL(raw: string, q?: RequestOptions["query"]) {
  if (!q || Object.keys(q).length === 0) return raw;
  const u = new URL(raw);
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function shouldDefaultRetry(e: any, status?: number) {
  const msg = String(e?.message ?? e ?? "");
  if (status === 429) return true;
  if (status && status >= 500) return true;
  return /ECONN|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|timeout/i.test(msg);
}

function gunzipMaybe(buf: Buffer, headers: Record<string, string | string[] | undefined>): Buffer {
  const enc = String(headers["content-encoding"] ?? headers["Content-Encoding"] ?? "").toLowerCase();
  try {
    if (enc.includes("gzip")) return zlib.gunzipSync(buf);
    if (enc.includes("deflate")) return zlib.inflateSync(buf);
  } catch { /* ignore */ }
  return buf;
}

function toPlainHeaders(h: http.IncomingHttpHeaders): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(h)) out[k] = v as any;
  return out;
}

/* =========================
   Core request (with retries)
   ========================= */

async function doRequest(
  opts: RequestOptions,
  defaults: FeedOptions,
  cache: Map<string, CacheEntry>,
  cacheTtlMs: number
): Promise<ResponseData> {
  const url = buildURL(opts.url, opts.query);
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;

  const retry = {
    retries: opts.retry?.retries ?? defaults.defaultRetry?.retries ?? 3,
    timeoutMs: opts.retry?.timeoutMs ?? defaults.defaultRetry?.timeoutMs ?? 15_000,
    kind: opts.retry?.kind ?? defaults.defaultRetry?.kind ?? "exponential",
    baseMs: opts.retry?.baseMs ?? defaults.defaultRetry?.baseMs ?? 200,
    maxMs: opts.retry?.maxMs ?? defaults.defaultRetry?.maxMs ?? 30_000,
    factor: opts.retry?.factor ?? defaults.defaultRetry?.factor ?? 2,
    jitter: opts.retry?.jitter ?? defaults.defaultRetry?.jitter ?? true,
    shouldRetry: opts.retry?.shouldRetry ?? defaults.defaultRetry?.shouldRetry ?? shouldDefaultRetry,
  };

  const method = (opts.method ?? "GET").toUpperCase() as Method;

  // headers
  const headers: Record<string, string> = {
    "user-agent": defaults.userAgent ?? "hf-engine/1.0 (+http-feed)",
    "accept": "*/*",
    ...(opts.gzip ? { "accept-encoding": "gzip, deflate" } : {}),
    ...(defaults.defaultHeaders ?? {}),
    ...(opts.headers ?? {}),
  };

  // Cache validators (GET only)
  const cacheKey = method === "GET" ? url : undefined;
  if (cacheKey && cache.has(cacheKey)) {
    const entry = cache.get(cacheKey)!;
    if (entry.etag) headers["if-none-match"] = entry.etag;
    if (entry.lastModified) headers["if-modified-since"] = entry.lastModified;
  }

  // Body
  let bodyBuf: Buffer | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    if (Buffer.isBuffer(opts.body)) bodyBuf = opts.body;
    else if (typeof opts.body === "string") bodyBuf = Buffer.from(opts.body, "utf8");
    else {
      bodyBuf = Buffer.from(JSON.stringify(opts.body), "utf8");
      if (!headers["content-type"]) headers["content-type"] = "application/json";
    }
    if (!headers["content-length"]) headers["content-length"] = String(bodyBuf.length);
  }

  const attemptOnce = () =>
    new Promise<ResponseData>((resolve, reject) => {
      const req = lib.request(
        {
          method,
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + u.search,
          headers,
          timeout: retry.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on("end", () => {
            const status = res.statusCode || 0;
            const hdrs = toPlainHeaders(res.headers);

            // 304 Not Modified => serve cache
            if (status === 304 && cacheKey && cache.has(cacheKey)) {
              const cached = cache.get(cacheKey)!;
              resolve({
                status: cached.status,
                headers: cached.headers,
                url,
                buffer: cached.body,
                text: () => cached.body.toString("utf8"),
                json: <T = unknown>() => JSON.parse(cached.body.toString("utf8")) as T,
              });
              return;
            }

            let buf = Buffer.concat(chunks);
            buf = gunzipMaybe(buf, hdrs);

            const resp: ResponseData = {
              status,
              headers: hdrs,
              url,
              buffer: buf,
              text: () => buf.toString("utf8"),
              // NOTE: to avoid generic method call issues in callers, we also allow
              // returning unknown and let caller assert: res.json() as T
              json: <T = unknown>() => JSON.parse(buf.toString("utf8")) as T,
            };

            if (cacheKey && status >= 200 && status < 300) {
              const entry: CacheEntry = {
                url,
                etag: (hdrs["etag"] as string | undefined) ?? undefined,
                lastModified: (hdrs["last-modified"] as string | undefined) ?? undefined,
                body: buf,
                headers: hdrs,
                status,
                ts: Date.now(),
                ttlMs: cacheTtlMs,
              };
              cache.set(cacheKey, entry);
            }

            resolve(resp);
          });
        }
      );

      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("request timeout")));
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });

  // Retry loop
  let lastErr: any;
  for (let attempt = 0; attempt <= retry.retries; attempt++) {
    try {
      const res = await attemptOnce();

      // Retry on 429/5xx if policy says so
      if (retry.shouldRetry(undefined, res.status) && (res.status === 429 || res.status >= 500)) {
        if (attempt < retry.retries) {
          const delay = nextDelay(attempt, {
            kind: retry.kind!,
            baseMs: retry.baseMs!,
            maxMs: retry.maxMs!,
            factor: retry.factor!,
            jitter: retry.jitter!,
          });
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }

      return res;
    } catch (e) {
      lastErr = e;
      const doRetry = retry.shouldRetry(e, undefined);
      if (attempt >= retry.retries || !doRetry) break;
      const delay = nextDelay(attempt, {
        kind: retry.kind!,
        baseMs: retry.baseMs!,
        maxMs: retry.maxMs!,
        factor: retry.factor!,
        jitter: retry.jitter!,
      });
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastErr;
}

/* =========================
   Feed factory
   ========================= */

export function createHTTPFeed(options: FeedOptions = {}): HTTPFeed {
  const cache = new Map<string, CacheEntry>();
  let ttl = Math.max(0, options.cacheTtlMs ?? 60_000);

  return {
    async request(opts: RequestOptions) {
      return doRequest(opts, options, cache, ttl);
    },

    async get(url: string, opts: Omit<RequestOptions, "url" | "method"> = {}) {
      return doRequest({ url, method: "GET", ...opts, gzip: opts.gzip ?? true }, options, cache, ttl);
    },

    async getJSON<T = unknown>(url: string, opts: Omit<RequestOptions, "url" | "method"> = {}) {
      const res = await this.get(url, opts);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      // Avoid generic method call issues: cast result
      return res.json() as T;
    },

    async getText(url: string, opts: Omit<RequestOptions, "url" | "method"> = {}) {
      const res = await this.get(url, opts);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return res.text();
    },

    async postJSON(url: string, body?: any, opts: Omit<RequestOptions, "url" | "method" | "body"> = {}) {
      const headers = { "content-type": "application/json", ...(opts.headers ?? {}) };
      return doRequest({ url, method: "POST", body, headers, ...opts, gzip: opts.gzip ?? true }, options, cache, ttl);
    },

    setCacheTTL(ms: number) { ttl = Math.max(0, ms); },
    clearCache() { cache.clear(); },
    cacheInfo() { return { size: cache.size }; },
  };
}

/* =========================
   Demo (optional)
   ========================= */

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const httpFeed = createHTTPFeed({
      cacheTtlMs: 10_000,
      defaultRetry: { retries: 3, timeoutMs: 8000 },
      userAgent: "engine-http-feed/0.1",
    });

    try {
      const data = await httpFeed.getJSON<any>("https://api.github.com/rate_limit", {
        headers: { "user-agent": "engine-http-feed/0.1" },
      });
      console.log("OK:", Object.keys(data));
    } catch (e) {
      console.error("HTTP error:", e);
    }
  })();
}