// core/config.ts
//
// Central config (strongly typed, no imports). Provides sane defaults and small
// setters so other modules can tweak at runtime without reaching into internals.

export type Fees = {
  makerBps: number;   // maker fee in basis points
  takerBps: number;   // taker fee in basis points
  min: number;        // minimum absolute fee per fill (quote ccy units)
};

export type SchedulerConfig = {
  tz: string;                 // IANA timezone for market-hours gating
  jitterMs: number;           // random jitter applied to cron-like loops
  rebalanceCron: string;      // cron-ish string, e.g. "0 14 * * 1-5" (14:00 on weekdays)
  marketHours: {              // local-market hours (display); engine should use UTC internally
    start: string;            // "09:30"
    end: string;              // "16:00"
    days: number[];           // 1..5 = Mon..Fri
  };
};

export type RiskLimits = {
  maxGrossExposure: number;   // e.g. 1.0 = 100% NAV
  maxNetExposure: number;     // e.g. 0.5 = 50% net
  maxLeverage: number;        // total gross / NAV
  maxCorrelation: number;     // cap on pairwise correlation used for gating (0..1)
  maxDrawdown: number;        // e.g. 0.2 = 20%
};

export type Paths = {
  dataPacksDir: string;       // where small mock packs live
  calendarsDir: string;       // holiday/exchange calendars
  snapshotsDir: string;       // persistence snapshots
  journalPath: string;        // fills/orders journal store
  outcomesPath: string;       // backtest export target
};

export type BrokerConfig = {
  defaultVenueLatencyMs: number; // baseline latency used by mock broker
  defaultVenueDepth: number;     // baseline depth used by mock broker
  rejectOn?: {
    notionalLimit?: number;      // reject orders above this notional
  };
  fees: Fees;
};

export type FxBoot = { pair: string; ts: number; rate: number };

export type BacktestConfig = {
  seed: number;                 // RNG seed for reproducibility
  writeOutcomes: boolean;       // if true, CLI writes outcomes.json
};

export type UiFlags = {
  enableA11yAudit: boolean;     // accessibility smoke tests toggler
  demoMode: boolean;            // enables synthetic live updates in UI
};

export type Config = {
  BASE_CCY: string;             // global base currency for valuation
  FX_PAIRS: FxBoot[];           // seed FX (optional; can be empty then seeded later)
  scheduler: SchedulerConfig;
  risk: RiskLimits;
  paths: Paths;
  broker: BrokerConfig;
  backtest: BacktestConfig;
  ui: UiFlags;
};

// -------------------- Defaults --------------------

const DEFAULT_CONFIG: Config = {
  BASE_CCY: "USD",
  FX_PAIRS: [],
  scheduler: {
    tz: "America/New_York",
    jitterMs: 250,
    rebalanceCron: "0 14 * * 1-5",
    marketHours: { start: "09:30", end: "16:00", days: [1, 2, 3, 4, 5] }
  },
  risk: {
    maxGrossExposure: 1.0,
    maxNetExposure: 0.5,
    maxLeverage: 2.0,
    maxCorrelation: 0.85,
    maxDrawdown: 0.2
  },
  paths: {
    dataPacksDir: "data/packs",
    calendarsDir: "data/calendars",
    snapshotsDir: "state/snapshots",
    journalPath: "state/journal.json",
    outcomesPath: "docs/outcomes.json"
  },
  broker: {
    defaultVenueLatencyMs: 50,
    defaultVenueDepth: 10000,
    rejectOn: { notionalLimit: 5_000_000 },
    fees: { makerBps: 0.10, takerBps: 0.30, min: 0.01 }
  },
  backtest: {
    seed: 1337,
    writeOutcomes: true
  },
  ui: {
    enableA11yAudit: false,
    demoMode: true
  }
};

// A single mutable config instance for the app.
let CONFIG: Config = deepClone(DEFAULT_CONFIG);

// -------------------- Getters / Setters --------------------

export function getConfig(): Config {
  // Return a shallow readonly view to discourage mutation from callers.
  return CONFIG;
}

export function resetConfig(): void {
  CONFIG = deepClone(DEFAULT_CONFIG);
}

export function setBaseCurrency(ccy: string): void {
  CONFIG.BASE_CCY = ccy.trim().toUpperCase();
}

export function seedFxPairs(pairs: FxBoot[]): void {
  CONFIG.FX_PAIRS = pairs.slice();
}

export function updateFees(next: Partial<Fees>): void {
  CONFIG.broker.fees = { ...CONFIG.broker.fees, ...next };
}

export function setRiskLimits(next: Partial<RiskLimits>): void {
  CONFIG.risk = { ...CONFIG.risk, ...next };
}

export function setScheduler(next: Partial<SchedulerConfig>): void {
  CONFIG.scheduler = { ...CONFIG.scheduler, ...next };
}

export function setPaths(next: Partial<Paths>): void {
  CONFIG.paths = { ...CONFIG.paths, ...next };
}

export function setBroker(next: Partial<BrokerConfig>): void {
  CONFIG.broker = { ...CONFIG.broker, ...next, fees: { ...CONFIG.broker.fees, ...(next.fees || {}) } };
}

export function setBacktest(next: Partial<BacktestConfig>): void {
  CONFIG.backtest = { ...CONFIG.backtest, ...next };
}

export function setUiFlags(next: Partial<UiFlags>): void {
  CONFIG.ui = { ...CONFIG.ui, ...next };
}

// Merge arbitrary partial config (deep-ish merge for first level objects)
export function mergeConfig(next: Partial<Config>): void {
  if (next.BASE_CCY) setBaseCurrency(next.BASE_CCY);
  if (next.FX_PAIRS) seedFxPairs(next.FX_PAIRS);
  if (next.scheduler) setScheduler(next.scheduler);
  if (next.risk) setRiskLimits(next.risk);
  if (next.paths) setPaths(next.paths);
  if (next.broker) setBroker(next.broker);
  if (next.backtest) setBacktest(next.backtest);
  if (next.ui) setUiFlags(next.ui);
}

// -------------------- Utils --------------------

function deepClone<T>(x: T): T {
  // structuredClone is not guaranteed everywhere; JSON clone suffices for simple config objects.
  return JSON.parse(JSON.stringify(x)) as T;
}