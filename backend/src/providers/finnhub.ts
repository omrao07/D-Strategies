/**
 * src/integrations/providers/finnhub.ts
 *
 * Fixed and production-ready adapter for Finnhub (https://finnhub.io)
 * ✅ Uses correct imports
 * ✅ Uses inherited safeNumber() from AbstractBaseAdapter
 * ✅ Handles symbol normalization, timestamp, and defensive parsing
 */

import { AbstractBaseAdapter, normalizeSymbolForProvider, type Quote } from "../adapter";
import { HttpClient } from "../httpClient";

export class FinnhubAdapter extends AbstractBaseAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly clientTyped: HttpClient;

  constructor(apiKey: string, opts: { baseUrl?: string; rateLimitPerMin?: number } = {}) {
    const client = new HttpClient(opts.rateLimitPerMin ?? 120, { "User-Agent": "saturn-hedge/1.0" });
    super("finnhub", client, { baseUrl: opts.baseUrl });
    this.apiKey = apiKey;
    this.baseUrl = opts.baseUrl ?? "https://finnhub.io/api/v1";
    this.clientTyped = client;
  }

  /** Lightweight health probe — checks API key validity */
  protected async _readyProbe(): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/quote?symbol=AAPL&token=${encodeURIComponent(this.apiKey)}`;
      const r: any = await this.clientTyped.get(url);
      return !!r && (typeof r.c === "number" || typeof r.t === "number");
    } catch {
      return false;
    }
  }

  /** Fetches latest market quote for a symbol */
  async fetchQuote(symbol: string): Promise<Quote> {
    const normalized = normalizeSymbolForProvider(symbol, "finnhub");
    const url = `${this.baseUrl}/quote?symbol=${encodeURIComponent(normalized)}&token=${encodeURIComponent(this.apiKey)}`;
    const r: any = await this.clientTyped.get(url);

    // Finnhub quote schema: { c, h, l, o, pc, t }
    const ts =
      typeof r?.t === "number"
        ? (r.t > 1e12 ? r.t : r.t * 1000)
        : Date.now();

    return {
      symbol: normalized,
      bid: this.safeNumber(r?.c), // proxy for bid (Finnhub free doesn’t expose bid/ask)
      ask: this.safeNumber(r?.c),
      last: this.safeNumber(r?.c),
      ts,
      raw: r ?? null,
    };
  }
}