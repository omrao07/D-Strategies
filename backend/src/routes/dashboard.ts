import { Router, Request, Response } from 'express';
import { getCommodityQuotes } from '../services/apinijas';

const r = Router();

// defaults; change to what you actually want
const DEFAULT_SYMBOLS = ['CL','NG','GC','SI','HG','ZC','ZW']; // WTI, Gas, Gold, Silver, Copper, Corn, Wheat

function bool01(v: any, def: 0|1) { return String(v ?? def) === '1' ? 1 : 0; }
function clamp(n: number, mi: number, ma: number) { return Math.max(mi, Math.min(ma, n)); }

function buildGeeUrl(q: any): string {
  const base = process.env.GEE_APP_BASE;
  if (!base) throw new Error('GEE_APP_BASE not set');

  const lat = clamp(Number(q.lat ?? 29.37), -90, 90);
  const lon = clamp(Number(q.lon ?? 48.03), -180, 180);
  const km  = clamp(Number(q.km  ?? 40), 1, 5000);
  const date = String(q.date ?? new Date(Date.now() - 86400000).toISOString().slice(0,10));

  const params = new URLSearchParams({
    lat: String(lat), lon: String(lon), km: String(km), date,
    ndvi: String(bool01(q.ndvi,1)),
    rain: String(bool01(q.rain,1)),
    era:  String(bool01(q.era,1)),
    fires:String(bool01(q.fires,1)),
    sar:  String(bool01(q.sar,1)),
    crop: String(bool01(q.crop,0)),
  });
  return `${base}?${params.toString()}`;
}

/**
 * GET /api/dashboard
 * Returns:
 *  - commodities quotes (API Ninjas, cached in service)
 *  - GEE iframe url
 *  - AIS SSE endpoint URL (so UIs/engines know where to connect)
 */
r.get('/', async (req: Request, res: Response) => {
  try {
    const symbols = String(req.query.symbols ?? DEFAULT_SYMBOLS.join(','))
      .split(',').map(s => s.trim()).filter(Boolean);

    const quotes = await getCommodityQuotes(symbols); // from services/apinijas.ts
    const geeUrl = buildGeeUrl(req.query);

    // You can also offer a bbox-based AIS URL; here we mirror your /api/ais/stream
    const ais = {
      sse: `/api/ais/stream`, // client supplies bbox via query; or you can echo a prebuilt one
      example: `/api/ais/stream?minLat=0.5&minLon=103.4&maxLat=1.8&maxLon=104.2`
    };

    res.json({
      ok: true,
      data: {
        quotes,
        geeUrl,
        ais
      }
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'dashboard failed' });
  }
});

export default r;