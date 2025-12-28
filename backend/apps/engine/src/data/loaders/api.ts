// engine/src/data/loaders/api.ts
// Generic HTTP API client with retries, backoff, and rate limiting
// No external dependencies

/* =========================
   Types
   ========================= */

export interface ApiOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  retryOn?: (status: number | null, error: Error | null) => boolean;
  rateLimit?: {
    rate: number;
    perMs: number;
    burst?: number;
  };
}

export interface ApiResponse<T> {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  data?: T;
  error?: string;
}

interface RequestOptions {
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  retryOn?: (status: number | null, error: Error | null) => boolean;
}

/* =========================
   Utilities
   ========================= */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(baseMs: number, attempt: number, jitter: number): number {
  return baseMs * Math.pow(2, attempt - 1) + Math.random() * jitter;
}

/* =========================
   Rate Limiter (Token Bucket)
   ========================= */

function createBucket(rate: number, perMs: number, burst = rate) {
  let tokens = burst;
  let last = Date.now();
  const capacity = burst;

  function refill() {
    const now = Date.now();
    const elapsed = now - last;
    if (elapsed <= 0) return;

    const add = (elapsed / perMs) * rate;
    tokens = Math.min(capacity, tokens + add);
    last = now;
  }

  async function take(): Promise<void> {
    refill();

    while (tokens < 1) {
      const waitMs = Math.max(
        5,
        Math.ceil(((1 - tokens) / rate) * perMs)
      );
      await delay(waitMs);
      refill();
    }

    tokens -= 1;
  }

  return { take };
}

/* =========================
   Low-level Fetch Wrapper
   ========================= */

async function doRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/* =========================
   API Client
   ========================= */

export function createApiClient(opts: ApiOptions = {}) {
  const baseUrl = opts.baseUrl ?? "";
  const defaultHeaders = opts.headers ?? {};
  const defaultTimeout = opts.timeoutMs ?? 10_000;
  const defaultRetries = opts.retries ?? 0;

  const defaultRetryOn =
    opts.retryOn ??
    ((status, error) =>
      status === 429 || status === 500 || error !== null);

  const bucket = opts.rateLimit
    ? createBucket(
      opts.rateLimit.rate,
      opts.rateLimit.perMs,
      opts.rateLimit.burst
    )
    : null;

  async function request<T>(
    method: string,
    path: string,
    opt: RequestOptions = {}
  ): Promise<ApiResponse<T>> {
    const url = `${baseUrl}${path}`;
    const timeoutMs = opt.timeoutMs ?? defaultTimeout;
    const retries = opt.retries ?? defaultRetries;
    const retryOn = opt.retryOn ?? defaultRetryOn;

    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= retries) {
      attempt++;

      try {
        if (bucket) {
          await bucket.take();
        }

        const res = await doRequest(
          method,
          url,
          defaultHeaders,
          opt.body,
          timeoutMs
        );

        if (retryOn(res.status, null) && attempt <= retries) {
          await delay(backoffDelay(200, attempt, 100));
          continue;
        }

        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          headers[key] = value;
        });

        const text = await res.text();
        const data = text ? (JSON.parse(text) as T) : undefined;

        return {
          ok: res.ok,
          status: res.status,
          headers,
          data,
        };
      } catch (err: unknown) {
        const error =
          err instanceof Error ? err : new Error("Network error");

        lastError = error;

        if (retryOn(null, error) && attempt <= retries) {
          await delay(backoffDelay(200, attempt, 100));
          continue;
        }

        return {
          ok: false,
          status: 0,
          headers: {},
          error: error.message,
        };
      }
    }

    return {
      ok: false,
      status: 0,
      headers: {},
      error: lastError?.message ?? "Request failed",
    };
  }

  return { request };
}