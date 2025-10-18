// backend/src/server.ts
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dashboardRouter from './routes/dashboard';

// ---- Routers (make sure these files exist) ----
import geeRouter from './routes/gee';
import commoditiesRouter from './routes/commodities';
import aisRouter from './routes/ais';

// ---- Basic env validation (keep it light) ----
const required = ['API_NINJAS_KEY', 'AISSTREAM_API_KEY', 'GEE_APP_BASE'] as const;
for (const k of required) {
  if (!process.env[k]) {
    console.warn(`[warn] Missing ${k} in .env. The related route may fail until you add it.`);
  }
}

const PORT = Number(process.env.PORT || 8080);

const app = express();

// Reverse proxy friendly (if behind nginx)
app.set('trust proxy', true);

// Middlewares
app.use(cors());
app.use(express.json({ limit: '1mb' }));


// ---- Health check ----
app.get('/api/health', (_req: Request, res: Response) => {
  const mask = (v?: string) => (v ? `${v.slice(0, 4)}•••` : 'MISSING');
  res.json({
    ok: true,
    env: {
      PORT,
      API_NINJAS_KEY: mask(process.env.API_NINJAS_KEY),
      AISSTREAM_API_KEY: mask(process.env.AISSTREAM_API_KEY),
      GEE_APP_BASE: process.env.GEE_APP_BASE || 'MISSING',
    },
    uptime_s: Math.round(process.uptime()),
  });
});

// ---- API routes ----
app.use('/api/gee', geeRouter);                 // GET /api/gee/url
app.use('/api/commodities', commoditiesRouter); // GET /api/commodities/quotes
app.use('/api/ais', aisRouter);                 // GET /api/ais/stream (SSE)
app.use('/api/dashboard', dashboardRouter);

// ---- 404 handler ----
app.use((req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: 'Not found', path: req.originalUrl });
});

// ---- Error handler ----
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', err);
  res.status(err?.status || 500).json({
    ok: false,
    error: err?.message || 'Internal Server Error',
  });
});

// ---- Start server ----
app.listen(PORT, () => {
  console.log(`\n🚀 Backend listening on http://localhost:${PORT}`);
  console.log(`   GEE app: ${process.env.GEE_APP_BASE || '(not set)'}\n`);
});