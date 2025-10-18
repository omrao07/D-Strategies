/**
 * src/integrations/providers/indiaapi.ts
 *
 * Adapter for an Indian market data provider (generic "India API").
 * - Normalizes symbols for Indian exchanges (uses adapters.normalizeSymbolForProvider)
 * - Defensive parsing and numeric coercion via inherited safeNumber()
 * - Uses ../adapter and ../httpclient imports (relative to providers/)
 *
 * Replace endpoint paths and response mapping to match your specific India provider.
 */

import { AbstractBaseAdapter, normalizeSymbolForProvider, type Quote } from "../adapter";
import { HttpClient } from "../httpClient";

export class IndiaApiAdapter extends AbstractBaseAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly clientTyped: HttpClient;

  /**
   * @param apiKey - Provider API key for India provider
   * @param opts.baseUrl - optional host override for staging/testing
   * @param opts.rateLimitPerMin - optional per-provider rate limit override
   */
  constructor(
    apiKey: string,
    opts: { baseUrl?: string; rateLimitPerMin?: number } = {}
  ) {
    const client = new HttpClient(opts.rateLimitPerMin ?? 120, { "User-Agent": "saturn-hedge/1.0" });
    super("indiaapi", client, { baseUrl: opts.baseUrl });
    this.apiKey = apiKey;
    // Default base URL — change to match your vendor (example placeholder)
    this.baseUrl = opts.baseUrl ?? "https://api.india-provider.example.com/v1";
    this.clientTyped = client;
  }

  /**
   * Readiness probe for startup checks.
   * Calls a lightweight endpoint (adjust path to your provider).
   */
  protected async _readyProbe(): Promise<boolean> {
    try {
      // Example lightweight endpoint — replace with a valid test endpoint
      const url = `${this.baseUrl}/status?apikey=${encodeURIComponent(this.apiKey)}`;
      const r: any = await this.clientTyped.get(url);
      // Provider may return { ok: true } or a numeric quota; adapt accordingly
      return !!r && (r.ok === true || typeof r.service === "string" || typeof r.status !== "undefined");
    } catch {
      return false;
    }
  }

  /**
   * Fetch a normalized quote for Indian symbols.
   * Accepts plain tickers (e.g., RELIANCE) and normalizes to .NS/.BO via normalizeSymbolForProvider.
   */
  async fetchQuote(symbol: string): Promise<Quote> {
    const normalized = normalizeSymbolForProvider(symbol, "indiaapi");
    // Example endpoint — replace with your provider's quote endpoint
    // Many Indian providers expect exchange-suffixed symbols, e.g. RELIANCE.NS
    const url = `${this.baseUrl}/quote/${encodeURIComponent(normalized)}?apikey=${encodeURIComponent(this.apiKey)}`;

    const r: any = await this.clientTyped.get(url);

    // Example provider response shapes vary. Try common fields and fallbacks.
    // - lastPrice / last / close
    // - bidPrice / bid / best_bid
    // - askPrice / ask / best_ask
    const lastVal = r?.lastPrice ?? r?.last ?? r?.close ?? r?.price;
    const bidVal = r?.bidPrice ?? r?.bid ?? r?.best_bid;
    const askVal = r?.askPrice ?? r?.ask ?? r?.best_ask;
    const ts =
      typeof r?.timestamp === "number"
        ? (r.timestamp > 1e12 ? Number(r.timestamp) : Number(r.timestamp) * 1000)
        : Date.now();

    return {
      symbol: normalized,
      bid: this.safeNumber(bidVal),
      ask: this.safeNumber(askVal),
      last: this.safeNumber(lastVal),
      ts,
      raw: r ?? null,
    };
  }
}