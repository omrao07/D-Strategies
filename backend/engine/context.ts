// engine/context.ts
// Provides a central runtime context for the hedge fund engine.
// No imports — everything defined locally.

// === Persistence Schemas (inline) ===
export interface PortfolioState {
  id: string;
  timestamp: string;
  positions: Record<string, number>; // symbol → shares/units
  cash: number;
  equity: number;
}

export interface PortfolioSnapshot {
  id: string;
  runId: string;
  timestamp: string;
  portfolio: PortfolioState;
  metrics: Record<string, number>;
}

// === Config ===
export interface EngineConfig {
  env: "dev" | "test" | "prod";
  dataPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  version: string;
}

// === Repos ===
export interface Repo<T> {
  save(id: string, value: T): Promise<void>;
  load(id: string): Promise<T | undefined>;
  list?(): Promise<string[]>;
}

// === Runtime State ===
export interface RuntimeState {
  portfolio: PortfolioState | null;
  lastSnapshot: PortfolioSnapshot | null;
  runId?: string;
  strategyId?: string;
  startedAt: string;
}

// === Engine Context ===
export interface EngineContext {
  config: EngineConfig;
  repos: {
    portfolio: Repo<PortfolioState>;
    snapshots: Repo<PortfolioSnapshot>;
    runs: Repo<any>;
    strategies: Repo<any>;
  };
  state: RuntimeState;
  log: (
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    meta?: Record<string, any>
  ) => void;
}

// === Context Builder ===
export function createContext(
  config: EngineConfig,
  repos: EngineContext["repos"],
  logger?: EngineContext["log"]
): EngineContext {
  const state: RuntimeState = {
    portfolio: null,
    lastSnapshot: null,
    startedAt: new Date().toISOString(),
  };

  const log: EngineContext["log"] = (level, msg, meta) => {
    const levels = ["debug", "info", "warn", "error"];
    if (levels.indexOf(level) >= levels.indexOf(config.logLevel)) {
      const entry = { t: new Date().toISOString(), level, msg, ...meta };
      console.log(JSON.stringify(entry));
    }
  };

  return { config, repos, state, log: logger ?? log };
}

// === Defaults ===
export function defaultConfig(): EngineConfig {
  return {
    env: "dev",
    dataPath: "./data",
    logLevel: "info",
    version: "1.0.0",
  };
}