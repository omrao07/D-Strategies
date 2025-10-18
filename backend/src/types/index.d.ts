// backend/src/types/index.d.ts

// ========== Commodities ==========

/** Normalized commodity quote from API Ninjas */
export interface CommodityQuote {
  symbol: string;
  price?: number;
  unit?: string;
  timestamp?: string;
  raw: any;
  source: 'api-ninjas';
  cached: boolean;
}

/** Commodity quotes response map */
export type CommodityQuotesResponse = Record<
  string,
  CommodityQuote | { error: string }
>;

// ========== AISstream ==========

/** Geographic bounding box */
export interface BBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** AIS metadata and message container (simplified) */
export interface AISMessage {
  MetaData: {
    MMSI: string;
    ShipName?: string;
    [k: string]: any;
  };
  Message: any; // e.g., { PositionReport: { Lat, Lon, Cog, Sog, ... } }
}

/** AIS client instance */
export interface AISClient {
  stop: () => void;
  isConnected: () => boolean;
  updateBBox: (bbox: BBox) => void;
}

// ========== GEE ==========

/** Input params to build a GEE App URL */
export interface GEEQueryParams {
  lat: number;
  lon: number;
  km: number;
  date: string; // YYYY-MM-DD
  ndvi?: 0 | 1;
  rain?: 0 | 1;
  era?: 0 | 1;
  fires?: 0 | 1;
  sar?: 0 | 1;
  crop?: 0 | 1;
}

/** GEE URL builder result */
export interface GEEUrlResponse {
  ok: boolean;
  url?: string;
  error?: string;
}

// ========== General ==========

/** Healthcheck response shape */
export interface HealthResponse {
  ok: boolean;
  env: {
    PORT: number | string;
    API_NINJAS_KEY: string;
    AISSTREAM_API_KEY: string;
    GEE_APP_BASE: string;
  };
  uptime_s: number;
}