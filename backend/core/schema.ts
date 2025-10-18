// core/schema.ts

// --- Instrument definition ---
export type Instrument = {
  symbol: string;        // e.g. "AAPL"
  name?: string;         // optional descriptive name
  currency: string;      // currency of trading/settlement (e.g. "USD", "INR")
  lot?: number;          // lot size if applicable
  multiplier?: number;   // contract multiplier (futures/options)
};

// --- Price row ---
export type PriceRow = {
  ts: number;            // unix timestamp (ms)
  symbol: string;        // instrument symbol
  close: number;         // closing/last price
  pxCcy: string;         // NEW: currency of this price series
  volume?: number;       // optional trading volume
};

// --- Portfolio Position ---
export type Position = {
  symbol: string;
  qty: number;           // positive = long, negative = short
  avgPx: number;         // average price
  ccy: string;           // position currency
};

// --- Order schema ---
export type Order = {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  px: number;
  tif: "DAY" | "IOC" | "FOK";
  ts: number;
  ccy: string;
};

// --- Fill schema ---
export type Fill = {
  id: string;
  orderId: string;
  symbol: string;
  qty: number;
  px: number;
  ts: number;
  fee: number;
  final: boolean;
  status: "PARTIAL" | "FILLED" | "CANCELED" | "REJECTED";
};

// --- Journal entry (for persistence/reconciliation) ---
export type JournalEntry = {
  orderId: string;
  symbol: string;
  qty: number;
  px: number;
  ts: number;
  fee: number;
  status: string;
};

// --- FX tick ---
export type FxTick = {
  pair: string;          // e.g. "INR/USD" (quote in base)
  ts: number;            // unix timestamp
  rate: number;          // conversion rate
};