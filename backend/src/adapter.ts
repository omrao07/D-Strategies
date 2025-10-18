/**
 * src/adapters.ts
 *
 * Central adapter types + small base helper for provider adapters.
 * Drop-in file: defines the ProviderAdapter interface, shared types,
 * a light AbstractBaseAdapter to reduce boilerplate in provider implementations,
 * and a small symbol-normalizer utility.
 *
 * Assumes an external HttpClient (from httpClient.ts) will be passed into adapters.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Timestamp = number;

/**
 * Standardized Quote shape used across the engine.
 * - `bid` / `ask` are optional because not all providers return both.
 * - `last` is the best-effort last traded price.
 * - `ts` is milliseconds since epoch.
 * - `raw` contains the provider's full response for debugging/analytics.
 */
export type Quote = {
  symbol: string;
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  ts: Timestamp;
  raw?: any;
};

/**
 * Standardized result from an order-like call (optional on many adapters).
 */
export type OrderResult = {
  id?: string;
  status: "ok" | "rejected" | "error";
  raw?: any;
};

/**
 * Minimal surface every provider adapter should expose.
 * Implementations should keep semantics consistent across providers.
 */
export interface ProviderAdapter {
  /** Unique name for the provider (lowercase recommended) */
  readonly name: string;

  /** Optional client instance (HttpClient) owned by adapter */
  readonly client?: unknown;

  /**
   * Health check / readiness probe.
   * Should be lightweight and stable; used by startup readiness and /health endpoints.
   * Return `true` when adapter is capable of serving requests.
   */
  ready(): Promise<boolean>;

  /**
   * Fetch a normalized Quote for a given symbol.
   * Implementations should accept plain symbols and internally normalize when needed.
   */
  fetchQuote(symbol: string): Promise<Quote>;

  /**
   * Optional: place an order or simulated order.
   * Implement only if your provider supports execution.
   */
  placeOrder?(side: "buy" | "sell", symbol: string, qty: number, params?: any): Promise<OrderResult>;

  /**
   * Optional: provide additional health information.
   * Example: { rateLimitRemaining: 123, resetAt: 1234567890 }
   */
  health?(): Promise<Record<string, any>>;
}

/**
 * Options that are commonly useful when constructing adapters.
 */
export type ProviderOptions = {
  /** per-provider rate limit override (requests per minute) */
  rateLimitPerMin?: number;
  /** optional human-friendly label for logs */
  label?: string;
  /** allow host override for testing / staging */
  baseUrl?: string;
  /** optional flag to enable verbose debug logging in adapter */
  debug?: boolean;
};

/**
 * Abstract base class to reduce boilerplate in provider adapters.
 * - stores name + opts
 * - provides a default ready() that tries a single lightweight request function (if supplied)
 * - exposes a safe `safeNumber` helper
 *
 * IMPORTANT: concrete adapters should implement fetchQuote() and, if needed, override ready().
 */
export abstract class AbstractBaseAdapter implements ProviderAdapter {
  public readonly name: string;
  public readonly opts: ProviderOptions;

  // Optional HTTP client (type unknown to avoid coupling in this file).
  // Concrete adapters should type this correctly.
  public readonly client?: unknown;

  constructor(name: string, client?: unknown, opts: ProviderOptions = {}) {
    if (!name) throw new Error("Adapter must have a name");
    this.name = name;
    this.client = client;
    this.opts = opts;
  }

  /**
   * Default readiness: adapters can override with a lightweight ping.
   * If adapter implements `_readyProbe()` protected method, it will be used.
   */
  public async ready(): Promise<boolean> {
    // If subclass implements a protected _readyProbe, call it.
    const probe = (this as any)._readyProbe;
    if (typeof probe === "function") {
      try {
        const r = await probe.call(this);
        return Boolean(r);
      } catch {
        return false;
      }
    }
    // otherwise assume ready (non-blocking default)
    return true;
  }

  public abstract fetchQuote(symbol: string): Promise<Quote>;

  public async placeOrder?(_side: "buy" | "sell", _symbol: string, _qty: number, _params?: any): Promise<OrderResult> {
    throw new Error("placeOrder not implemented for " + this.name);
  }

  public async health?(): Promise<Record<string, any>> {
    return { name: this.name, ready: await this.ready() };
  }

  /** Safe numeric coercion helper */
  protected safeNumber(v: unknown): number | undefined {
    if (v === null || v === undefined) return undefined;
    if (typeof v === "number") {
      if (Number.isFinite(v)) return v;
      return undefined;
    }
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}

/**
 * Symbol normalization utilities.
 * Some providers require exchange suffixes (e.g. EODHD: 'AAPL.US', EODHD Japan conventions),
 * while others accept plain tickers. Use `normalizeSymbolForProvider` before calling provider endpoints
 * unless the adapter already normalizes internally.
 */

/** Supported provider canonical names for normalization rules */
export type KnownProvider =
  | "polygon"
  | "twelvedata"
  | "finnhub"
  | "eodhd"
  | "indiaapi"
  | "weather"
  | string; // allow custom unknowns

/**
 * Normalize symbol for a given provider.
 * - Keeps plain tickers unchanged for providers that accept them (polygon, finnhub, twelvedata).
 * - Adds common exchange suffixes for EODHD (default to .US if unknown).
 * - For India providers, append `.NS` (NSE) or `.BO` (BSE) heuristics if user passed lowercase or `:`
 *
 * This function is intentionally conservative: adapters should still validate and adapt as needed.
 */
export function normalizeSymbolForProvider(symbol: string, provider: KnownProvider): string {
  if (!symbol || typeof symbol !== "string") throw new TypeError("symbol must be a non-empty string");

  // quick sanitize
  const raw = symbol.trim();

  // if already contains a dot or slash (exchange included), return as-is
  if (raw.includes(".") || raw.includes("/")) {
    return raw;
  }

  switch (provider) {
    case "polygon":
    case "finnhub":
    case "twelvedata":
      // these accept plain tickers like AAPL, GOOG, BTC/USD (for twelvedata)
      return raw.toUpperCase();

    case "eodhd":
      // EOD Historical Data typically expects SYMBOL.EXCHANGE, e.g., AAPL.US, 7203.T (Toyota)
      // Heuristic: if symbol is all letters and length <= 5 -> assume US
      if (/^[A-Za-z]{1,5}$/.test(raw)) return `${raw.toUpperCase()}.US`;
      // if numeric tickers (e.g., JP markets) or already include exchange, return as-is
      return raw.toUpperCase();

    case "indiaapi":
      // Many Indian APIs expect BSE or NSE suffix; prefer NSE (.NS)
      // If user provided suffix like `:NS` or `.NS`, normalize it.
      if (/[:.](NS|BSE|BO)$/i.test(raw)) {
        return raw.replace(":", ".").toUpperCase();
      }
      // default to NSE
      return `${raw.toUpperCase()}.NS`;

    case "weather":
      // For weather provider, symbol semantics vary — treat input as location key
      return raw;

    default:
      // Unknown provider: return uppercase token (safe default)
      return raw.toUpperCase();
  }
}

/**
 * Lightweight helper: pick numeric best bid / ask from an array of quotes (some may be missing).
 */
export function aggregateBestBidAsk(quotes: ReadonlyArray<Quote>) {
  let bestBid: number | undefined = undefined;
  let bestAsk: number | undefined = undefined;

  for (const q of quotes) {
    if (typeof q.bid === "number") {
      if (bestBid === undefined || q.bid > bestBid) bestBid = q.bid;
    }
    if (typeof q.ask === "number") {
      if (bestAsk === undefined || q.ask < bestAsk) bestAsk = q.ask;
    }
  }

  return { bestBid, bestAsk };
}