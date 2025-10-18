/**
 * src/integrations/providers/eodhd.ts
 *
 * Correct imports (from ../adapter and ../httpclient), no local safeNumber override,
 * defensive parsing and typed client usage.
 */

import { AbstractBaseAdapter, normalizeSymbolForProvider, type Quote } from "../adapter";
import { HttpClient } from "../httpClient";

export class EodHdAdapter extends AbstractBaseAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly clientTyped: HttpClient;

  constructor(apiKey: string, opts: { baseUrl?: string; rateLimitPerMin?: number } = {}) {
    const client = new HttpClient(opts.rateLimitPerMin ?? 120);
    super("eodhd", client, { baseUrl: opts.baseUrl });
    this.apiKey = apiKey;
    this.baseUrl = opts.baseUrl ?? "https://eodhistoricaldata.com/api";
    this.clientTyped = client;
  }

  // readiness probe used by AbstractBaseAdapter.ready()
  protected async _readyProbe(): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/real-time/AAPL.US?api_token=${encodeURIComponent(this.apiKey)}&fmt=json`;
      const r: any = await this.clientTyped.get(url);
      return !!r && (typeof r.close === "number" || typeof r.last === "number" || typeof r.price === "number");
    } catch {
      return false;
    }
  }

  // main fetch method
  async fetchQuote(symbol: string): Promise<Quote> {
    const normalized = normalizeSymbolForProvider(symbol, "eodhd");
    const url = `${this.baseUrl}/real-time/${encodeURIComponent(normalized)}?api_token=${encodeURIComponent(
      this.apiKey
    )}&fmt=json`;

    const r: any = await this.clientTyped.get(url);

    const lastVal = r?.close ?? r?.last ?? r?.price ?? r?.last_trade_price ?? undefined;
    const ts =
      typeof r?.timestamp === "number" ? (Number(r.timestamp) > 1e12 ? Number(r.timestamp) : Number(r.timestamp) * 1000) : Date.now();

    return {
      symbol: normalized,
      bid: this.safeNumber(r?.bid ?? r?.bidprice ?? r?.best_bid),
      ask: this.safeNumber(r?.ask ?? r?.askprice ?? r?.best_ask),
      last: this.safeNumber(lastVal),
      ts,
      raw: r ?? null,
    };
  }
}