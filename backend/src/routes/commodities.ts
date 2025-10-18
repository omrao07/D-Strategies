// backend/src/routes/commodities.ts
import { Router, Request, Response } from 'express';
import axios from 'axios';

const r = Router();
const API_NINJAS_KEY = process.env.API_NINJAS_KEY!;
const BASE = 'https://api.api-ninjas.com/v1/commodityprice';

// --- tiny in-memory cache (per symbol) to reduce rate hits ---
type CacheEntry = { ts: number; data: any };
const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 30_000; // 30s cache; tweak per your plan/needs

function fromCache(symbol: string): any | null {
  const hit = CACHE.get(symbol);
  if (!hit) return null;
  if (Date.now() - hit.ts > TTL_MS) {
    CACHE.delete(symbol);
    return null;
  }
  return hit.data;
}

async function fetchSymbol(symbol: string) {
  const cached = fromCache(symbol);
  if (cached) return { symbol, data: cached, cached: true };

  const url = `${BASE}?symbol=${encodeURIComponent(symbol)}`;
  const res = await axios.get(url, {
    headers: { 'X-Api-Key': API_NINJAS_KEY },
    timeout: 10_000,
  });

  CACHE.set(symbol, { ts: Date.now(), data: res.data });
  return { symbol, data: res.data, cached: false };
}

/**
 * GET /api/commodities/quotes?symbols=CL,NG,GC
 * - symbols: comma-separated list (e.g., CL for WTI, NG for NatGas, GC for Gold)
 */
r.get('/quotes', async (req: Request, res: Response) => {
  try {
    if (!API_NINJAS_KEY) {
      return res.status(500).json({ ok: false, error: 'API_NINJAS_KEY missing in .env' });
    }

    const symbolsRaw = String(req.query.symbols || 'CL,NG,GC');
    const symbols = symbolsRaw
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    if (!symbols.length) {
      return res.status(400).json({ ok: false, error: 'Provide at least one symbol via ?symbols=' });
    }

    // Fetch in series to be kind to rate limits (change to Promise.all if your plan allows).
    const results: Record<string, any> = {};
    for (const s of symbols) {
      try {
        const { data, cached } = await fetchSymbol(s);
        results[s] = { cached, data };
        // small jitter between calls to avoid bursts
        await new Promise(r => setTimeout(r, 150));
      } catch (e: any) {
        results[s] = { error: e?.response?.statusText || e?.message || 'fetch failed' };
      }
    }

    res.json({ ok: true, symbols, ttl_ms: TTL_MS, results });
  } catch (err: any) {
    console.error('[commodities] error', err?.response?.data || err);
    res.status(500).json({ ok: false, error: err?.message || 'Internal Server Error' });
  }
});

export default r;