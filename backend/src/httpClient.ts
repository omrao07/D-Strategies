/**
 * src/httpClient.ts
 *
 * A resilient HTTP client for all provider integrations.
 * Features:
 *  - Automatic retries with exponential backoff + jitter
 *  - Token bucket rate limiting (per minute)
 *  - Simple circuit breaker for repeated failures
 *  - JSON parsing with fallback to raw text
 *
 * This client is dependency-free and works natively with Node ≥18 (fetch built-in).
 */

import { DEFAULTS, USER_AGENT } from "./config";

/** Simple token-bucket rate limiter */
class RateLimiter {
  private capacity: number;
  private tokens: number;
  private refillRate: number; // tokens per ms
  private lastRefill: number;

  constructor(requestsPerMinute: number) {
    this.capacity = Math.max(1, requestsPerMinute);
    this.tokens = this.capacity;
    this.refillRate = this.capacity / 60_000; // per ms
    this.lastRefill = Date.now();
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    const add = elapsed * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + add);
    this.lastRefill = now;
  }

  async removeToken(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** Simple circuit breaker to avoid hammering failing endpoints */
class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  constructor(
    private threshold = DEFAULTS.CIRCUIT_BREAKER_FAILURES,
    private resetMs = DEFAULTS.CIRCUIT_BREAKER_RESET_MS
  ) {}

  markSuccess() {
    this.failures = 0;
  }

  markFailure() {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openUntil = Date.now() + this.resetMs;
    }
  }

  isOpen(): boolean {
    return Date.now() < this.openUntil;
  }
}

export class HttpClient {
  private limiter: RateLimiter;
  private circuit: CircuitBreaker;
  private baseHeaders: Record<string, string>;

  constructor(
    rateLimitPerMin: number = DEFAULTS.RATE_LIMIT_PER_MIN,
    baseHeaders: Record<string, string> = {}
  ) {
    this.limiter = new RateLimiter(rateLimitPerMin);
    this.circuit = new CircuitBreaker();
    this.baseHeaders = { "User-Agent": USER_AGENT, ...baseHeaders };
  }

  /**
   * Core fetch function with retry, rate-limit, and circuit-breaker.
   */
  async request<T = any>(
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    url: string,
    body?: any,
    headers: Record<string, string> = {},
    maxRetries: number = DEFAULTS.RETRY_MAX_ATTEMPTS
  ): Promise<T> {
    if (this.circuit.isOpen()) {
      throw new Error(`Circuit open: skipping request to ${url}`);
    }

    let attempt = 0;
    let lastError: any;

    while (attempt < maxRetries) {
      attempt++;
      try {
        await this.limiter.removeToken();

        const response = await fetch(url, {
          method,
          headers: { ...this.baseHeaders, ...headers },
          body:
            body !== undefined
              ? typeof body === "string"
                ? body
                : JSON.stringify(body)
              : undefined,
        });

        if (!response.ok) {
          if (response.status >= 500 || response.status === 429) {
            // retryable errors
            throw new Error(`HTTP ${response.status}`);
          } else {
            // non-retryable
            this.circuit.markFailure();
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${text}`);
          }
        }

        const text = await response.text();
        this.circuit.markSuccess();

        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      } catch (err) {
        lastError = err;
        this.circuit.markFailure();

        if (attempt >= maxRetries) break;

        // exponential backoff + jitter
        const delay =
          DEFAULTS.RETRY_BASE_MS * Math.pow(2, attempt - 1) +
          Math.floor(Math.random() * 100);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw new Error(
      `Request failed after ${maxRetries} attempts: ${String(lastError)}`
    );
  }

  /**
   * Convenience GET method
   */
  async get<T = any>(
    url: string,
    headers: Record<string, string> = {},
    maxRetries?: number
  ): Promise<T> {
    return this.request<T>("GET", url, undefined, headers, maxRetries);
  }

  /**
   * Convenience POST method
   */
  async post<T = any>(
    url: string,
    body: any,
    headers: Record<string, string> = {},
    maxRetries?: number
  ): Promise<T> {
    return this.request<T>("POST", url, body, headers, maxRetries);
  }

  /**
   * Expose internal health for metrics or debugging.
   */
  health() {
    return {
      rateLimitTokens: (this as any).limiter?.tokens ?? "unknown",
      circuitOpen: this.circuit.isOpen(),
    };
  }
}