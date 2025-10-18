// backend/src/services/apinijas.ts
import axios, { AxiosError } from 'axios';

/**
 * API Ninjas – Commodities service
 * Docs: https://api-ninjas.com/api
 *
 * This module wraps the `commodityprice` endpoint with:
 *  - .env-based auth (API_NINJAS_KEY)
 *  - small in-memory cache (TTL)
 *  - retry with backoff
 *  - normalized response shape
 */

const API_NINJAS_KEY = process.env.API_NINJAS_KEY || '';
if (!API_NINJAS_KEY) {
  // We don't exit the process; routes can still boot and show a helpful error.
  // Throwing here would crash imports during build.
  console.warn('[apinijas] Missing API_NINJAS_KEY in .env — calls will fail until set.');
}

const BASE = 'https://api.api-ninjas.com/v1/commodityprice';

export type CommodityQuote = {
  symbol: string;       // requested symbol (e.g., CL, NG, GC)
  price?: number;       // parsed price if present
  unit?: string;        // unit if provided by API Ninjas
  timestamp?: string;   // ISO timestamp if provided
  raw: any;             // raw API payload (for debugging)
  source: 'api-ninjas';
  cached: boolean;      // whether this response came from cache
};

type CacheEntry = { ts: number; payload: any };
const CACHE = new Map<string, CacheEntry>();

// Tune for your plan
const TTL_MS = 30_000;          // 30s cache per symbol
const MAX_RETRIES = 2;          // total attempts = 1 + MAX_RETRIES
const BASE_DELAY_MS = 300;      // backoff base delay between retries

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function now() {
  return Date.now();
}

function getFromCache(symbol: string): any | null {
  const hit = CACHE.get(symbol);
  if (!hit) return null;
  if (now() - hit.ts > TTL_MS) {
    CACHE.delete(symbol);
    return null;
  }
  return hit.payload;
}

function saveToCache(symbol: string, payload: any) {
  CACHE.set(symbol, { ts: now(), payload });
}

/**
 * Normalize API Ninjas commodityprice response into a CommodityQuote.
 * API payload shape can vary; this tries to be resilient.
 */
function normalizeQuote(symbol: string, payload: any, cached: boolean): CommodityQuote {
  // Common patterns seen from API Ninjas:
  // - { symbol: "CL", price: 77.12, timestamp: 1699999999 }
  // - [{ commodity: "Wheat", price: 5.82, unit: "USD/bu", ... }]
  let price: number | undefined;
  let unit: string | undefined;
  let timestamp: string | undefined;

  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload)) {
      const first = payload[0] || {};
      price = typeof first.price === 'number' ? first.price : undefined;
      unit = typeof first.unit === 'string' ? first.unit : undefined;
      if (first.timestamp) {
        // API sometimes returns seconds; sometimes ISO. Try to coerce.
        timestamp = typeof first.timestamp === 'number'
          ? new Date(first.timestamp * 1000).toISOString()
          : String(first.timestamp);
      }
    } else {
      price = typeof payload.price === 'number' ? payload.price : undefined;
      unit = typeof payload.unit === 'string' ? payload.unit : undefined;
      if (payload.timestamp) {
        timestamp = typeof payload.timestamp === 'number'
          ? new Date(payload.timestamp * 1000).toISOString()
          : String(payload.timestamp);
      }
    }
  }

  return {
    symbol: symbol.toUpperCase(),
    price,
    unit,
    timestamp,
    raw: payload,
    source: 'api-ninjas',
    cached,
  };
}

/**
 * Fetch a single symbol with retries + backoff.
 */
export async function getCommodityQuote(symbol: string): Promise<CommodityQuote> {
  const sym = symbol.trim().toUpperCase();
  if (!sym) throw new Error('Empty symbol');

  // Serve from cache if fresh
  const cachedPayload = getFromCache(sym);
  if (cachedPayload) return normalizeQuote(sym, cachedPayload, true);

  if (!API_NINJAS_KEY) {
    throw new Error('API_NINJAS_KEY missing; set it in .env');
  }

  let attempt = 0;
  let lastErr: unknown;

  while (attempt <= MAX_RETRIES) {
    try {
      const url = `${BASE}?symbol=${encodeURIComponent(sym)}`;
      const res = await axios.get(url, {
        headers: { 'X-Api-Key': API_NINJAS_KEY },
        timeout: 10_000,
      });
      saveToCache(sym, res.data);
      return normalizeQuote(sym, res.data, false);
    } catch (err) {
      lastErr = err;
      const e = err as AxiosError;
      const status = e.response?.status;

      // If it's a client error (400/401/403/404), don't retry further.
      if (status && status >= 400 && status < 500) break;

      // Otherwise backoff and retry
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt); // 300, 600, 1200...
        await sleep(delay);
      }
      attempt += 1;
    }
  }

  // At this point, all attempts failed.
  const errMsg = (lastErr as any)?.message || 'API Ninjas request failed';
  throw new Error(`[api-ninjas:${sym}] ${errMsg}`);
}

/**
 * Fetch multiple symbols (polite by default: serial to honor rate limits).
 * Switch to parallel if your plan allows: set { parallel: true }.
 */
export async function getCommodityQuotes(
  symbols: string[],
  opts: { parallel?: boolean } = {}
): Promise<Record<string, CommodityQuote | { error: string }>> {
  const clean = symbols.map(s => s.trim()).filter(Boolean);
  const out: Record<string, CommodityQuote | { error: string }> = {};

  if (opts.parallel) {
    const results = await Promise.allSettled(clean.map(s => getCommodityQuote(s)));
    results.forEach((r, i) => {
      const sym = clean[i].toUpperCase();
      if (r.status === 'fulfilled') out[sym] = r.value;
      else out[sym] = { error: (r.reason as Error)?.message || 'failed' };
    });
    return out;
  }

  for (const s of clean) {
    const sym = s.toUpperCase();
    try {
      out[sym] = await getCommodityQuote(sym);
      // gentle jitter between calls
      await sleep(150);
    } catch (e: any) {
      out[sym] = { error: e?.message || 'failed' };
    }
  }
  return out;
}

/** Clear the in-memory cache (e.g., in tests) */
export function clearApiNinjasCache() {
  CACHE.clear();
}