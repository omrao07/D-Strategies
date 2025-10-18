/**
 * src/integrations/providers/twelvedata.ts
 *
 * Adapter for Twelve Data (global equities, FX, crypto).
 * - Correct relative imports: ../adapter and ../httpclient
 * - Uses inherited safeNumber() from AbstractBaseAdapter (no override)
 * - Defensive parsing, typed HttpClient usage, and readiness probe
 *
 * Docs: https://twelvedata.com/docs
 */

import { AbstractBaseAdapter, normalizeSymbolForProvider, type Quote } from "../adapter";
import { HttpClient } from "../httpClient";

export class TwelveDataAdapter extends AbstractBaseAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly clientTyped: HttpClient;

  constructor(apiKey: string, opts: { baseUrl?: string; rateLimitPerMin?: number } = {}) {
    const client = new HttpClient(opts.rateLimitPerMin ?? 120, { "User-Agent": "saturn-hedge/1.0" });
    super("twelvedata", client, { baseUrl: opts.baseUrl });
    if (!apiKey) throw new Error("Twelve Data API key required");
    this.apiKey = apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.twelvedata.com";
    this.clientTyped = client;
  }

  /** Lightweight readiness probe */
  protected async _readyProbe(): Promise<boolean> {
    try {
      // price endpoint for a common symbol (AAPL) — returns { price: "123.45" } on success
      const url = `${this.baseUrl}/price?symbol=AAPL&apikey=${encodeURIComponent(this.apiKey)}`;
      const r: any = await this.clientTyped.get(url);
      return !!r && (typeof r.price === "string" || typeof r.price === "number");
    } catch {
      return false;
    }
  }

  /**
   * Fetch latest price for the given symbol.
   * Prefers the lightweight `price` endpoint, falls back to `time_series` if needed.
   */
  async fetchQuote(symbol: string): Promise<Quote> {
    const normalized = normalizeSymbolForProvider(symbol, "twelvedata");
    const priceUrl = `${this.baseUrl}/price?symbol=${encodeURIComponent(normalized)}&apikey=${encodeURIComponent(
      this.apiKey
    )}`;

    let r: any;
    try {
      r = await this.clientTyped.get(priceUrl);
    } catch (err) {
      // fallback to time_series (1min interval, latest point)
      const tsUrl = `${this.baseUrl}/time_series?symbol=${encodeURIComponent(
        normalized
      )}&interval=1min&outputsize=1&apikey=${encodeURIComponent(this.apiKey)}`;
      const tsResp: any = await this.clientTyped.get(tsUrl);
      // time_series returns { values: [{ datetime, open, high, low, close, volume }], meta: {...} }
      const values = Array.isArray(tsResp?.values) ? tsResp.values : [];
      const latest = values[0] ?? null;
      r = latest ? { price: latest.close, timestamp: latest.datetime, raw_series: tsResp } : tsResp;
    }

    // Parse price result shapes:
    // price endpoint -> { price: "123.45" }
    // fallback shape from time_series mapped above -> { price: "123.45", timestamp: "2025-10-18 12:00:00" }
    const priceVal = (r?.price ?? r?.close ?? r?.last) as unknown;
    const tsCandidate = r?.timestamp ?? r?.datetime ?? r?.ts ?? undefined;

    // Normalize timestamp:
    let ts: number;
    if (typeof tsCandidate === "number") {
      ts = tsCandidate > 1e12 ? Number(tsCandidate) : Number(tsCandidate) * 1000;
    } else if (typeof tsCandidate === "string") {
      const parsed = Date.parse(tsCandidate);
      ts = Number.isFinite(parsed) ? parsed : Date.now();
    } else {
      ts = Date.now();
    }

    return {
      symbol: normalized,
      // Twelve Data price endpoint doesn't provide bid/ask in lightweight endpoint — use last as proxy
      bid: this.safeNumber(priceVal),
      ask: this.safeNumber(priceVal),
      last: this.safeNumber(priceVal),
      ts,
      raw: r ?? null,
    };
  }
}