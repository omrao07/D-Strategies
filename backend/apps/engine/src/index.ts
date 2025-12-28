// engine/src/index.ts
// Public entry point for the trading engine
// Strict-safe barrel: exports only verified modules

import StrategyBase from "./strategies/base";

/* ======================================================================
   Core Strategy Base
   ====================================================================== */

export { default as StrategyBase } from "./strategies/base";
export { StrategyBase as BaseStrategy };

/* ======================================================================
   Core Strategy Types
   ====================================================================== */

export type {
   Side,
   OrderType,
   TIF,
   Bar,
   Series,
   Order,
   Fill,
   Position,
   Trade,
   Portfolio,
   RiskConfig,
   StrategyOptions,
   RunReport,
   Summary,
   Ctx,
   OrderInput,
} from "./strategies/base";

/* ======================================================================
   Alpha Strategies
   ====================================================================== */

export * from "./strategies/alpha/carryTrade";

/*
  Add more strategies ONLY after files exist:

  export * from "./strategies/alpha/momentum";
  export * from "./strategies/alpha/meanReversion";
*/

/* ======================================================================
   Data Loaders
   ====================================================================== */

export * from "./data/loaders/api";

/*
  Optional loaders — enable only when implemented:

  export * from "./data/loaders/csv";
  export * from "./data/loaders/parquet";
*/

/* ======================================================================
   Brokers (Execution Adapters)
   ====================================================================== */

/*
  These MUST exist on disk before enabling.
  Leaving them commented avoids TS2307 errors.

  export * from "./brokers/alpaca";
  export * from "./brokers/ibkr";
  export * from "./brokers/zerodha";
*/

/* ======================================================================
   Exchanges (Market Metadata)
   ====================================================================== */

/*
  Enable only when files exist:

  export * from "./exchanges/binance";
  export * from "./exchanges/cme";
  export * from "./exchanges/nse";
*/

/* ======================================================================
   Version
   ====================================================================== */

export const ENGINE_VERSION = "0.1.0";