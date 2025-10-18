// data/http-feed.ts
// Pure TypeScript, no imports. Works in environments with global `fetch` and `AbortController`.
// Fully featured: retries with exponential backoff + jitter, timeouts, rate limiting,
// query serialization, ETag/Last-Modified caching, JSON/text/bytes parsing, and simple pagination.

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
type BodyInitish = string | ArrayBuffer | Uint8Array | null | undefined | Record<string, unknown>;

type ResponseKind = "auto" | "json" | "text" | "bytes";

type Dict = { [k: string]: string };

export interface HTTPFeedOptions {
  baseUrl?: string;
  headers?: Dict;
  timeoutMs?: number;                 // per-attempt timeout
  retries?: number;                   // total retry attempts on transient errors
  backoffMs?: number;                 // initial backoff
  backoffFactor?: number;             // backoff multiplier
  jitter?: boolean;                   // add +/- 20% jitter
  minIntervalMs?: number;             // simple client-side rate limit (spacing between calls)
  cacheCapacity?: number;             // in-memory response cache size (LRU-ish)
  defaultResponseKind?: ResponseKind; // default parsing strategy
}

export interface RequestOptions {
  headers?: Dict;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: BodyInitish;
  responseKind?: ResponseKind;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  backoffFactor?: number;
  jitter?: boolean;
}

export interface HTTPFeedResult<T = unknown> {
  url: string;
  status: number;
  ok: boolean;
  headers: Dict;
  data: T | null;
  fromCache: boolean;
}

/** Minimal LRU-ish map with eviction by insertion order */
class TinyCache<V> {
  private map = new Map<string, V>();
  constructor(private cap: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      // refresh recency
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.cap) {
      // evict oldest
      const firstKey = this.map.keys().next().value as string | undefined;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
  }
}

type CacheEntry = {
  etag?: string;
  lastModified?: string;
  status: number;
  headers: Dict;
  // Store raw payload and a detected kind to re-emit exactly on 304
  payloadBytes?: Uint8Array;
  payloadText?: string;
  payloadJson?: unknown;
  kind: ResponseKind;
};

export class HTTPFeed {
  private baseUrl: string;
  private defaultHeaders: Dict;
  private timeoutMs: number;
  private retries: number;
  private backoffMs: number;
  private backoffFactor: number;
  private jitter: boolean;
  private minIntervalMs: number;
  private defaultResponseKind: ResponseKind;
  private cache: TinyCache<CacheEntry>;
  private etagIndex = new Map<string, { etag?: string; lastModified?: string }>();
  private lastCallAt = 0;

  constructor(opts: HTTPFeedOptions = {}) {
    this.baseUrl = (opts.baseUrl || "").replace(/\/+$/, "");
    this.defaultHeaders = opts.headers || {};
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retries = opts.retries ?? 2;
    this.backoffMs = opts.backoffMs ?? 300;
    this.backoffFactor = opts.backoffFactor ?? 2.0;
    this.jitter = opts.jitter ?? true;
    this.minIntervalMs = opts.minIntervalMs ?? 0;
    this.defaultResponseKind = opts.defaultResponseKind ?? "auto";
    this.cache = new TinyCache<CacheEntry>(Math.max(8, opts.cacheCapacity ?? 64));
    this.ensureRuntime();
  }

  // ---------- Public convenience methods ----------
  public async get<T = unknown>(path: string, opts: RequestOptions = {}): Promise<HTTPFeedResult<T>> {
    return this.request<T>("GET", path, opts);
  }
  public async post<T = unknown>(path: string, opts: RequestOptions = {}): Promise<HTTPFeedResult<T>> {
    return this.request<T>("POST", path, opts);
  }
  public async put<T = unknown>(path: string, opts: RequestOptions = {}): Promise<HTTPFeedResult<T>> {
    return this.request<T>("PUT", path, opts);
  }
  public async patch<T = unknown>(path: string, opts: RequestOptions = {}): Promise<HTTPFeedResult<T>> {
    return this.request<T>("PATCH", path, opts);
  }
  public async delete<T = unknown>(path: string, opts: RequestOptions = {}): Promise<HTTPFeedResult<T>> {
    return this.request<T>("DELETE", path, opts);
  }
  public async head(path: string, opts: RequestOptions = {}): Promise<HTTPFeedResult<null>> {
    return this.request<null>("HEAD", path, { ...opts, responseKind: "text" });
  }

  /**
   * Follow Link headers (RFC 5988) with rel="next" until exhausted or limit reached.
   * Useful for APIs that paginate.
   */
  public async getAllPages<T = unknown>(
    path: string,
    opts: RequestOptions = {},
    maxPages: number = 50
  ): Promise<HTTPFeedResult<T>[]> {
    const out: HTTPFeedResult<T>[] = [];
    let nextUrl: string | null = this.buildUrl(path, opts.query);
    let pages = 0;

    while (nextUrl && pages < maxPages) {
      const res = await this.requestAbsolute<T>("GET", nextUrl, opts);
      out.push(res);
      pages++;

      // Parse Link header
      const link = res.headers["link"] || res.headers["Link"];
      nextUrl = this.parseLinkNext(link) || null;
    }
    return out;
  }

  // ---------- Core request ----------
  public async request<T = unknown>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<HTTPFeedResult<T>> {
    const url = this.buildUrl(path, opts.query);
    return this.requestAbsolute<T>(method, url, opts);
  }

  private async requestAbsolute<T = unknown>(method: HttpMethod, url: string, opts: RequestOptions = {}): Promise<HTTPFeedResult<T>> {
    await this.enforceRateLimit();

    const finalHeaders: Dict = { ...this.defaultHeaders, ...(opts.headers || {}) };
    const useKind: ResponseKind = opts.responseKind ?? this.defaultResponseKind;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    // Conditional headers from cache (etag/last-modified)
    const cacheKey = this.cacheKey(method, url);
    const tag = this.etagIndex.get(cacheKey);
    if (method === "GET" && tag) {
      if (tag.etag && !finalHeaders["If-None-Match"]) finalHeaders["If-None-Match"] = tag.etag;
      if (tag.lastModified && !finalHeaders["If-Modified-Since"]) finalHeaders["If-Modified-Since"] = tag.lastModified;
    }

    const payload = this.prepareBody(opts.body, finalHeaders);

    const maxAttempts = (opts.retries ?? this.retries) + 1;
    let attempt = 0;
    let backoff = opts.backoffMs ?? this.backoffMs;
    const factor = opts.backoffFactor ?? this.backoffFactor;
    const jitter = opts.jitter ?? this.jitter;

    while (true) {
      attempt++;
      const ac = new AbortController();
      const id = setTimeout(() => ac.abort(), timeoutMs);

      let resp: Response | null = null;
      let error: unknown = null;

      try {
        resp = await fetch(url, {
          method,
          headers: finalHeaders,
          body: payload,
          signal: ac.signal,
        } as any);
      } catch (e) {
        error = e;
      } finally {
        clearTimeout(id);
      }

      // Network error or aborted -> maybe retry
      if (!resp) {
        if (attempt < maxAttempts && this.isTransientError(error)) {
          await this.sleep(this.jittered(backoff, jitter));
          backoff *= factor;
          continue;
        }
        // terminal network failure
        throw this.enhanceError("Network error", { method, url, attempt, error });
      }

      // 304 -> serve from cache
      if (resp.status === 304 && method === "GET") {
        const cached = this.cache.get(cacheKey);
        if (cached) {
          return {
            url,
            status: cached.status,
            ok: cached.status >= 200 && cached.status < 300,
            headers: { ...cached.headers },
            data: (this.rehydrateFromCache<T>(cached) as any) ?? null,
            fromCache: true,
          };
        }
        // fallthrough if we somehow had a conditional but no cache entry
      }

      // Parse headers
      const headersDict: Dict = {};
      resp.headers.forEach((v, k) => (headersDict[k] = v));

      // Handle retryable status codes
      if (this.isRetryableStatus(resp.status) && attempt < maxAttempts) {
        await this.sleep(this.jittered(backoff, jitter));
        backoff *= factor;
        continue;
      }

      // Parse body
      const kind = this.resolveKind(useKind, headersDict);
      const parsed = await this.parseBody(resp, kind);

      // Update cache on GET success
      if (method === "GET" && resp.ok) {
        const etag = headersDict["etag"] || headersDict["ETag"];
        const lastMod = headersDict["last-modified"] || headersDict["Last-Modified"];
        const entry: CacheEntry = {
          etag,
          lastModified: lastMod,
          status: resp.status,
          headers: headersDict,
          kind,
        };
        if (kind === "json") entry.payloadJson = parsed;
        else if (kind === "text") entry.payloadText = parsed as string;
        else if (kind === "bytes") entry.payloadBytes = parsed as Uint8Array;
        this.cache.set(cacheKey, entry);
        this.etagIndex.set(cacheKey, { etag, lastModified: lastMod });
      }

      return {
        url,
        status: resp.status,
        ok: resp.ok,
        headers: headersDict,
        data: (parsed as any) ?? null,
        fromCache: false,
      };
    }
  }
    enhanceError(arg0: string, arg1: { method: HttpMethod; url: string; attempt: number; error: unknown; }) {
        throw new Error("Method not implemented.");
    }

  // ---------- Helpers ----------
  private ensureRuntime() {
    if (typeof fetch !== "function") {
      throw new Error("HTTPFeed requires a global `fetch`.");
    }
    if (typeof AbortController !== "function") {
      throw new Error("HTTPFeed requires a global `AbortController`.");
    }
  }

  private buildUrl(pathOrUrl: string, query?: Record<string, string | number | boolean | null | undefined>): string {
    const isAbs = /^https?:\/\//i.test(pathOrUrl);
    const base = isAbs ? "" : this.baseUrl;
    const path = isAbs ? pathOrUrl : `${base}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
    const qs = this.serializeQuery(query);
    return qs ? `${path}?${qs}` : path;
  }

  private serializeQuery(query?: Record<string, string | number | boolean | null | undefined>): string {
    if (!query) return "";
    const parts: string[] = [];
    for (const k in query) {
      const v = query[k];
      if (v === undefined || v === null) continue;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
    }
    return parts.join("&");
  }

  private prepareBody(body: BodyInitish, headers: Dict): any {
    if (body == null) return undefined;
    if (typeof body === "string" || body instanceof ArrayBuffer || body instanceof Uint8Array) return body;
    // treat as JSON object
    if (!headers["content-type"] && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    return JSON.stringify(body);
  }

  private resolveKind(desired: ResponseKind, headers: Dict): ResponseKind {
    if (desired !== "auto") return desired;
    const ct = (headers["content-type"] || headers["Content-Type"] || "").toLowerCase();
    if (ct.includes("application/json")) return "json";
    if (ct.includes("text/") || ct.includes("application/xml") || ct.includes("application/xhtml")) return "text";
    return "bytes";
  }

  private async parseBody(resp: Response, kind: ResponseKind): Promise<unknown> {
    if (kind === "json") {
      // Handle empty body gracefully
      const text = await resp.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        // if not valid JSON, return raw text
        return text;
      }
    } else if (kind === "text") {
      return await resp.text();
    } else if (kind === "bytes") {
      const ab = await resp.arrayBuffer();
      return new Uint8Array(ab);
    }
    // shouldn't hit when resolveKind is used; default to text
    return await resp.text();
  }

  private rehydrateFromCache<T>(entry: CacheEntry): T | string | Uint8Array | null {
    if (entry.kind === "json") return (entry.payloadJson as T) ?? null;
    if (entry.kind === "text") return (entry.payloadText as string) ?? "";
    if (entry.kind === "bytes") return (entry.payloadBytes as Uint8Array) ?? new Uint8Array();
    return null;
  }

  private isTransientError(err: unknown): boolean {
    const msg = (err && (err as any).message) ? String((err as any).message).toLowerCase() : "";
    return msg.includes("abort") || msg.includes("timeout") || msg.includes("network") || msg.includes("fetch");
  }

  private isRetryableStatus(status: number): boolean {
    // Retry on 429, and 5xx
    return status === 429 || (status >= 500 && status < 600);
  }

  private jittered(ms: number, enable: boolean): number {
    if (!enable) return ms;
    const delta = ms * 0.2;
    const rnd = (Math.random() * 2 - 1) * delta;
    return Math.max(0, Math.floor(ms + rnd));
  }

  private async enforceRateLimit(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const wait = this.lastCallAt + this.minIntervalMs - now;
    if (wait > 0) await this.sleep(wait);
    this.lastCallAt = Date.now();
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise(res => setTimeout(res, ms));
  }

  private cacheKey(method: string, url: string): string {
    return `${method.toUpperCase()} ${url}`;
  }

  private parseLinkNext(linkHeader?: string): string | null {
    if (!linkHeader) return null;
    // Example: <https://api.example.com/items?page=2>; rel="next", <...>; rel="prev"
    const parts = linkHeader.split(",");
    for (const p of parts) {
      const m = p.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
      if (m && m[1]) return m[1].trim();
    }
    return null;
  }
}

// ---------------------------
// Example (commented):
// const api = new HTTPFeed({ baseUrl: "https://api.example.com", retries: 3 });
// const res = await api.get("/v1/items", { query: { limit: 100 } });
// if (res.ok) console.log(res.data);
