/**
 * src/integrations/providers/polygon.ts
 *
 * Adapter for polygon.io (U.S. equities).  
 * - Correct relative imports: ../adapter and ../httpclient
 * - Uses inherited safeNumber() from AbstractBaseAdapter (no override)
 * - Defensive parsing and typed client usage
 *
 * Docs: https://polygon.io/docs
 */

import { AbstractBaseAdapter, normalizeSymbolForProvider, type Quote } from "../adapter";
import { HttpClient } from "../httpClient";

export class PolygonAdapter extends AbstractBaseAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly clientTyped: HttpClient;

  constructor(apiKey: string, opts: { baseUrl?: string; rateLimitPerMin?: number } = {}) {
    const client = new HttpClient(opts.rateLimitPerMin ?? 300, { "User-Agent": "saturn-hedge/1.0" });
    super("polygon", client, { baseUrl: opts.baseUrl });
    if (!apiKey) throw new Error("Polygon API key required");
    this.apiKey = apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.polygon.io";
    this.clientTyped = client;
  }

  /** Lightweight health probe */
  protected async _readyProbe(): Promise<boolean> {
    try {
      // small metadata endpoint to validate key
      const url = `${this.baseUrl}/v1/meta/symbols?apiKey=${encodeURIComponent(this.apiKey)}&limit=1`;
      const r: any = await this.clientTyped.get(url);
      // polygon returns array or object depending on endpoint — accept either
      return !!r && (Array.isArray(r) || typeof r === "object");
    } catch {
      return false;
    }
  }

  /**
   * Fetch last quote for an equity symbol.
   * Uses /last_quote/stocks/:symbol if available; fallbacks attempted.
   */
  async fetchQuote(symbol: string): Promise<Quote> {
    const normalized = normalizeSymbolForProvider(symbol, "polygon");
    // polygon expects plain ticker for US equities (AAPL)
    const url = `${this.baseUrl}/v1/last_quote/stocks/${encodeURIComponent(normalized)}?apiKey=${encodeURIComponent(
      this.apiKey
    )}`;

    let r: any;
    try {
      r = await this.clientTyped.get(url);
    } catch (err) {
      // fallback: use /last/trade endpoint
      const fallback = `${this.baseUrl}/v1/last/trade/stocks/${encodeURIComponent(normalized)}?apiKey=${encodeURIComponent(
        this.apiKey
      )}`;
      r = await this.clientTyped.get(fallback);
    }

    /**
     * polygon /last_quote/stocks/:symbol returns something like:
     * { status: 'success', symbol: 'AAPL', last: { askprice, bidprice, price, ... } }
     * /last/trade returns { symbol, price, sip_timestamp, ... }
     * We'll handle both shapes defensively.
     */
    const lastObj = r?.last ?? r?.last_quote ?? r;
    const bidVal = lastObj?.bidprice ?? lastObj?.bid ?? lastObj?.bp ?? undefined;
    const askVal = lastObj?.askprice ?? lastObj?.ask ?? lastObj?.ap ?? undefined;
    const lastVal = lastObj?.price ?? lastObj?.last?.price ?? lastObj?.last_trade_price ?? r?.price ?? undefined;

    const tsCandidate =
      // polygon sometimes returns timestamps in microseconds or milliseconds; be conservative
      (r?.last?.sip_timestamp ?? r?.sip_timestamp ?? r?.timestamp ?? undefined) as unknown;

    const ts =
      typeof tsCandidate === "number"
        ? tsCandidate > 1e12
          ? Number(tsCandidate) // already ms or larger
          : Number(tsCandidate) * 1000
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