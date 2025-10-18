// backend/src/routes/ais.ts
import { Router, Request, Response } from 'express';
import WebSocket from 'ws';

const r = Router();
const AIS_KEY = process.env.AISSTREAM_API_KEY!;

/**
 * GET /api/ais/stream
 * Example:
 *   /api/ais/stream?minLat=0.5&minLon=103.4&maxLat=1.8&maxLon=104.2
 *
 * Opens an SSE stream that forwards AIS position messages.
 */
r.get('/stream', (req: Request, res: Response) => {
  if (!AIS_KEY) {
    res.status(500).json({ ok: false, error: 'AISSTREAM_API_KEY missing in .env' });
    return;
  }

  const minLat = Number(req.query.minLat ?? -90);
  const minLon = Number(req.query.minLon ?? -180);
  const maxLat = Number(req.query.maxLat ?? 90);
  const maxLon = Number(req.query.maxLon ?? 180);

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Connect to AIS WebSocket
  const ws = new WebSocket(`wss://stream.aisstream.io/v0/stream?apikey=${AIS_KEY}`);

  ws.on('open', () => {
    const subscription = {
      Apikey: AIS_KEY,
      BoundingBoxes: [[[minLat, minLon], [maxLat, maxLon]]],
      FiltersShipMMSI: [],
      FilterMessageTypes: ["position"] // only ship positions
    };
    ws.send(JSON.stringify(subscription));
  });

  ws.on('message', (data) => {
    res.write(`data: ${data.toString()}\n\n`);
  });

  ws.on('error', (err) => {
    console.error('[AIS WS error]', err);
    res.write(`event: error\ndata: ${JSON.stringify(String(err))}\n\n`);
  });

  ws.on('close', () => {
    res.write(`event: end\ndata: {}\n\n`);
    res.end();
  });

  // If client disconnects, close WS
  req.on('close', () => {
    try { ws.close(); } catch {}
  });
});

export default r;