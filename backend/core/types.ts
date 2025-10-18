// core/types.ts
//
// Canonical types used across engine, broker, risk, fx, and docs.

//
// ---------- Instruments / Market Data ----------
//

export type Instrument = {
  symbol: string;
  name?: string;
  currency: string;       // e.g. "USD"
  lot?: number;           // lot size (if relevant)
  multiplier?: number;    // contract multiplier (futures/options)
};

export type PriceRow = {
  ts: number;             // timestamp (ms)
  symbol: string;
  close: number;
  pxCcy: string;          // currency of this price
  volume?: number;
};

export type FxTick = {
  pair: string;           // "BASE/QUOTE"
  ts: number;
  rate: number;
};

//
// ---------- Portfolio / Orders / Broker ----------
//

export type Position = {
  symbol: string;
  qty: number;            // positive = long, negative = short
  avgPx: number;
  ccy: string;
};

export type OrderSide = "BUY" | "SELL";
export type TimeInForce = "DAY" | "IOC" | "FOK";

export type Order = {
  id: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  px: number;
  tif: TimeInForce;
  ts: number;
  ccy: string;
};

export type FillStatus = "PARTIAL" | "FILLED" | "CANCELED" | "REJECTED";

export type Fill = {
  id: string;
  orderId: string;
  symbol: string;
  qty: number;
  px: number;
  ts: number;
  fee: number;
  final: boolean;
  status: FillStatus;
};

export type JournalEntry = {
  orderId: string;
  symbol: string;
  qty: number;
  px: number;
  ts: number;
  fee: number;
  status: string;
};

//
// ---------- Risk / Metrics ----------
//

export type RiskLimits = {
  maxGrossExposure: number;
  maxNetExposure: number;
  maxLeverage: number;
  maxCorrelation: number;
  maxDrawdown: number;
};

export type Metrics = {
  sharpe: number;
  sortino: number;
  calmar: number;
  hitRate: number;
  turnover: number;
  drawdown: number;
};

//
// ---------- Damodaran Bot ----------
//

export type Citation = {
  sourceId: string;
  page: number;
  snippet: string;
};

export type ExtractOut = {
  wacc?: number;
  taxRate?: number;
  growth?: number;
  shares?: number;
  citations: Citation[];
};

//
// ---------- Backtest ----------
//

export type BacktestOutcome = {
  sharpe: number;
  calmar: number;
  activeReturn: number;
  ablation: { noCosts: number; withCosts: number };
};

//
// ---------- Utility ----------
//

export type Dict<T> = Record<string, T>;