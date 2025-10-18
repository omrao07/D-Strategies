// backend/src/routes/gee.ts
import { Router, Request, Response } from 'express';

const r = Router();

const BASE = process.env.GEE_APP_BASE || '';
if (!BASE) {
  console.warn('[gee] GEE_APP_BASE is not set. /api/gee/* will return errors until you configure it.');
}

// Default params if caller omits them
const DEFAULTS = {
  lat: 29.37,
  lon: 48.03,
  km: 40,
  // “yesterday” UTC, formatted YYYY-MM-DD
  date: new Date(Date.now() - 24 * 3600e3).toISOString().slice(0, 10),
  ndvi: 1,
  rain: 1,
  era: 1,
  fires: 1,
  sar: 1,
  crop: 0,
};

function coerceBool01(v: any, def: 0 | 1) {
  const s = String(v ?? def);
  return s === '1' ? '1' : '0';
}
function clampNum(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function buildGeeUrl(q: any): string {
  if (!BASE) throw new Error('GEE_APP_BASE missing');

  const lat = Number(q.lat ?? DEFAULTS.lat);
  const lon = Number(q.lon ?? DEFAULTS.lon);
  const km = Number(q.km ?? DEFAULTS.km);
  const date = String(q.date ?? DEFAULTS.date);

  // basic sanity
  const safeLat = clampNum(isFinite(lat) ? lat : DEFAULTS.lat, -90, 90);
  const safeLon = clampNum(isFinite(lon) ? lon : DEFAULTS.lon, -180, 180);
  const safeKm = clampNum(isFinite(km) ? km : DEFAULTS.km, 1, 5000);

  const params = new URLSearchParams({
    lat: String(safeLat),
    lon: String(safeLon),
    km: String(safeKm),
    date,
    ndvi: coerceBool01(q.ndvi, DEFAULTS.ndvi as 0 | 1),
    rain: coerceBool01(q.rain, DEFAULTS.rain as 0 | 1),
    era: coerceBool01(q.era, DEFAULTS.era as 0 | 1),
    fires: coerceBool01(q.fires, DEFAULTS.fires as 0 | 1),
    sar: coerceBool01(q.sar, DEFAULTS.sar as 0 | 1),
    crop: coerceBool01(q.crop, DEFAULTS.crop as 0 | 1),
  });

  // Ensure base already points to /view/<app>; just append query
  return `${BASE}?${params.toString()}`;
}

/**
 * GET /api/gee/url
 * Build and return a GEE App URL with query params.
 * Example:
 *   /api/gee/url?lat=29.37&lon=48.03&km=40&date=2025-09-15&ndvi=1&rain=1&era=1&fires=1&sar=1&crop=0
 */
r.get('/url', (req: Request, res: Response) => {
  try {
    const url = buildGeeUrl(req.query);
    res.json({ ok: true, url });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message || 'Failed to build GEE URL' });
  }
});

/**
 * GET /api/gee/redirect
 * 302 redirect to the computed GEE App URL (nice for manual testing or iframes).
 */
r.get('/redirect', (req: Request, res: Response) => {
  try {
    const url = buildGeeUrl(req.query);
    res.redirect(302, url);
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message || 'Failed to build GEE URL' });
  }
});

export default r;