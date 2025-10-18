// backend/src/services/aisstream.ts
import WebSocket from 'ws';

export type BBox = {
  minLat: number; minLon: number;
  maxLat: number; maxLon: number;
};

export type AISOptions = {
  /** Default: ['position'] to keep bandwidth low */
  messageTypes?: ('position' | 'static' | 'voyage' | string)[];
  /** MMSI allow-list; leave empty for all */
  mmsiFilter?: number[];
  /** Reconnect backoff (ms) */
  minReconnectDelayMs?: number;   // default 1_000
  maxReconnectDelayMs?: number;   // default 30_000
  /** Consider WS dead if no messages in this many ms (send close and reconnect) */
  inactivityTimeoutMs?: number;   // default 60_000
  /** Optional additional server params */
  endpoint?: string;              // default wss://stream.aisstream.io/v0/stream
  /** Debug logging */
  debug?: boolean;
};

export type AISHandlers = {
  onMessage: (msg: any) => void;
  onOpen?: () => void;
  onError?: (err: any) => void;
  onClose?: (code: number, reason: string) => void;
  onReconnect?: (attempt: number, delayMs: number) => void;
};

export type AISClient = {
  /** Stop streaming and prevent further reconnects */
  stop: () => void;
  /** Is the client currently connected */
  isConnected: () => boolean;
  /** Update bbox (will resubscribe without full reconnect) */
  updateBBox: (bbox: BBox) => void;
};

const DEFAULT_ENDPOINT = 'wss://stream.aisstream.io/v0/stream';

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/**
 * Build AIS subscription payload per aisstream.io
 */
function buildSubscription(
  apikey: string,
  bbox: BBox,
  types: AISOptions['messageTypes'] = ['position'],
  mmsiFilter: AISOptions['mmsiFilter'] = []
) {
  return {
    Apikey: apikey,
    BoundingBoxes: [
      [
        [bbox.minLat, bbox.minLon],
        [bbox.maxLat, bbox.maxLon],
      ],
    ],
    FiltersShipMMSI: mmsiFilter,
    FilterMessageTypes: types,
  };
}

/**
 * Create a resilient AISstream client with reconnect, heartbeats, and bbox updates.
 */
export function createAISClient(
  bbox: BBox,
  handlers: AISHandlers,
  opts: AISOptions = {}
): AISClient {
  const {
    messageTypes = ['position'],
    mmsiFilter = [],
    minReconnectDelayMs = 1_000,
    maxReconnectDelayMs = 30_000,
    inactivityTimeoutMs = 60_000,
    endpoint = DEFAULT_ENDPOINT,
    debug = false,
  } = opts;

  const APIKEY = process.env.AISSTREAM_API_KEY || '';
  if (!APIKEY) {
    throw new Error('AISSTREAM_API_KEY missing in .env');
  }

  let ws: WebSocket | null = null;
  let stopped = false;
  let connected = false;
  let reconnectAttempt = 0;
  let lastMessageAt = Date.now();
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let currentBBox: BBox = { ...bbox };

  function log(...args: any[]) {
    if (debug) console.log('[ais]', ...args);
  }

  function scheduleHeartbeat() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      const silentMs = Date.now() - lastMessageAt;
      if (silentMs >= inactivityTimeoutMs) {
        log(`inactivity ${silentMs}ms ≥ ${inactivityTimeoutMs}ms, forcing reconnect`);
        try { ws?.close(); } catch {}
      } else {
        scheduleHeartbeat();
      }
    }, inactivityTimeoutMs);
  }

  function connect() {
    if (stopped) return;
    const url = `${endpoint}?apikey=${encodeURIComponent(APIKEY)}`;
    ws = new WebSocket(url);

    ws.on('open', () => {
      connected = true;
      reconnectAttempt = 0;
      lastMessageAt = Date.now();
      scheduleHeartbeat();
      // Send (or re-send) subscription for current bbox
      const sub = buildSubscription(APIKEY, currentBBox, messageTypes, mmsiFilter);
      ws!.send(JSON.stringify(sub));
      handlers.onOpen?.();
      log('connected & subscribed', currentBBox);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      lastMessageAt = Date.now();
      // Restart heartbeat timer
      scheduleHeartbeat();

      try {
        const obj = JSON.parse(data.toString());
        handlers.onMessage(obj);
      } catch (e) {
        handlers.onError?.(e);
        log('parse error', e);
      }
    });

    ws.on('close', (code, reasonBuf) => {
      connected = false;
      if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
      const reason = reasonBuf ? reasonBuf.toString() : '';
      handlers.onClose?.(code, reason);
      log('closed', code, reason);
      if (!stopped) {
        scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      handlers.onError?.(err);
      log('error', err);
      // Let close handler trigger reconnect (some ws libs emit both)
    });
  }

  function scheduleReconnect() {
    reconnectAttempt += 1;
    const expo = Math.min(maxReconnectDelayMs, minReconnectDelayMs * Math.pow(2, reconnectAttempt - 1));
    const jitter = Math.round(expo * (0.5 + Math.random() * 0.5)); // 50–100% jitter
    const delay = clamp(jitter, minReconnectDelayMs, maxReconnectDelayMs);
    handlers.onReconnect?.(reconnectAttempt, delay);
    log(`reconnect #${reconnectAttempt} in ${delay}ms`);
    setTimeout(() => connect(), delay);
  }

  function stop() {
    stopped = true;
    if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
    try { ws?.close(); } catch {}
    ws = null;
  }

  function isConnected() {
    return connected;
  }

  /**
   * Update bounding box without full reconnect.
   * If socket open → send a fresh subscription.
   * If closed → will be used on next reconnect.
   */
  function updateBBox(b: BBox) {
    currentBBox = { ...b };
    if (ws && connected && ws.readyState === WebSocket.OPEN) {
      const sub = buildSubscription(APIKEY, currentBBox, messageTypes, mmsiFilter);
      try {
        ws.send(JSON.stringify(sub));
        log('resubscribed with new bbox', currentBBox);
      } catch (e) {
        log('resubscribe failed, closing to reconnect', e);
        try { ws.close(); } catch {}
      }
    } else {
      log('bbox updated (will apply on next connect)', currentBBox);
    }
  }

  // kick off
  connect();

  return { stop, isConnected, updateBBox };
}

/** Helper: build bbox from center + km radius (approx, WGS84 degrees) */
export function bboxFromCenter(lat: number, lon: number, km: number): BBox {
  const dLat = km / 110.574;
  const dLon = km / (111.320 * Math.cos((lat * Math.PI) / 180));
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLon: lon - dLon,
    maxLon: lon + dLon,
  };
}