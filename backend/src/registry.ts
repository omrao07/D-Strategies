/**
 * src/registry.ts
 *
 * Central registry for all provider adapters.
 * Provides a unified interface to register, retrieve, list, and aggregate data
 * across multiple data providers (Polygon, TwelveData, Finnhub, EODHD, IndiaAPI, Weather, etc.).
 */

import type { ProviderAdapter, Quote } from "./adapter";
import { aggregateBestBidAsk } from "./adapter";

/**
 * ProviderRegistry
 * ----------------
 * Holds and manages all active provider adapters.
 * Used globally by the engine, pricing layer, and dashboards.
 */
export class ProviderRegistry {
  private readonly providers: Map<string, ProviderAdapter>;

  constructor() {
    this.providers = new Map();
  }

  /**
   * Register a provider adapter.
   * Throws if a provider with the same name already exists.
   */
  register(adapter: ProviderAdapter): void {
    const key = adapter.name.toLowerCase();
    if (this.providers.has(key)) {
      throw new Error(`Provider ${adapter.name} already registered.`);
    }
    this.providers.set(key, adapter);
  }

  /**
   * Retrieve a provider by name.
   */
  get(name: string): ProviderAdapter | undefined {
    return this.providers.get(name.toLowerCase());
  }

  /**
   * Return all registered providers as an array.
   */
  list(): ProviderAdapter[] {
    return Array.from(this.providers.values());
  }

  /**
   * Check readiness of all providers.
   * Returns an object: { providerName: true|false }
   */
  async readiness(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    await Promise.all(
      Array.from(this.providers.entries()).map(async ([name, provider]) => {
        try {
          const ok = await provider.ready();
          results[name] = ok;
        } catch {
          results[name] = false;
        }
      })
    );
    return results;
  }

  /**
   * Fetch a quote from all providers concurrently.
   * Returns an array of fulfilled Quote objects.
   */
  async fetchAll(symbol: string): Promise<Quote[]> {
    const adapters = this.list();
    if (adapters.length === 0) {
      throw new Error("No providers registered.");
    }

    const results = await Promise.allSettled(
      adapters.map((p) => p.fetchQuote(symbol))
    );

    const quotes: Quote[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") quotes.push(r.value);
    }
    return quotes;
  }

  /**
   * Fetch from all providers and return the best aggregated quote.
   */
  async getBestQuote(symbol: string): Promise<Quote> {
    const quotes = await this.fetchAll(symbol);
    if (quotes.length === 0) {
      throw new Error(`No quote data available for ${symbol}`);
    }

    const { bestBid, bestAsk } = aggregateBestBidAsk(quotes);
    const avgLast =
      quotes.reduce((acc, q) => acc + (q.last ?? 0), 0) /
      quotes.filter((q) => q.last !== undefined).length;

    return {
      symbol,
      bid: bestBid,
      ask: bestAsk,
      last: Number.isFinite(avgLast) ? avgLast : undefined,
      ts: Date.now(),
      raw: quotes,
    };
  }

  /**
   * Print a summary of all registered providers (for debugging or health endpoints).
   */
  summary(): Record<string, any> {
    return {
      count: this.providers.size,
      providers: Array.from(this.providers.keys()),
    };
  }
}