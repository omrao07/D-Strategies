// engine/config/defaults.ts
// Central defaults for the hedge-fund engine. Zero deps, NodeNext/ESM-friendly.

export type Mode = "backtest" | "paper" | "live";

export type PathsCfg = {
  projectRoot?: string;             // e.g., process.cwd()
  outputsDir: string;               // base outputs directory
  runsDir: string;                   // outputs/runs
  curvesDir: string;                 // outputs/curves
  summariesDir: string;              // outputs/summaries
  plotsDir: string;                  // outputs/plots
  manifestPath: string;              // strategies/_manifest.json
};

export type DataCfg = {
  feed: "demo" | string;            // adapter key
  timeframe: "1d" | "1h" | "5m" | string;
  start: string;                    // ISO (YYYY-MM-DD)
  end: string;                      // ISO
  cache: boolean;                   // allow adapter caching
};

export type BrokerCfg = {
  adapter: "paper" | string;
  account?: string;
  currency: string;
  slippageBps: number;              // per trade (0.0001 = 1bps)
  commissionPerShare: number;       // simple per-share commission
  maxLeverage: number;
};

export type RiskCfg = {
  rfDaily: number;                  // daily risk-free rate
  daysPerYear: number;              // 252 trading days by default
  maxPositions?: number;
  maxGrossLeverage?: number;
  maxNotionalPerName?: number;      // fraction of equity (e.g., 0.1)
};

export type ExecCfg = {
  concurrency: number;              // parallel jobs default
  seed?: number;                    // RNG seed (optional)
  strict: boolean;                  // throw on adapter errors
  persistEachRun: boolean;          // save every run JSON
  keepRuns: number;                 // FSRepo cleanup threshold
};

export type LogCfg = {
  level: "debug" | "info" | "warn" | "error" | "silent";
  json: boolean;
  timestamps: boolean;
};

export type EngineDefaults = {
  mode: Mode;
  paths: PathsCfg;
  data: DataCfg;
  broker: BrokerCfg;
  risk: RiskCfg;
  exec: ExecCfg;
  log: LogCfg;
};

const ISO = (d: Date) => d.toISOString().slice(0, 10);

/** Minimal ISO sanitization (YYYY-MM-DD or best effort) */
export function toISO(x?: string | Date, fallback?: string): string {
  if (!x) return fallback ?? ISO(new Date());
  if (typeof x === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
    const d = new Date(x);
    return isNaN(d.getTime()) ? (fallback ?? ISO(new Date())) : ISO(d);
  }
  return ISO(x);
}

/** Shallow+deep merge (plain objects/arrays only). Right-hand overrides left. */
export function deepMerge<T>(a: Partial<T>, b: Partial<T>): T {
  const isObj = (v: any) => v && typeof v === "object" && !Array.isArray(v);
  const out: any = { ...(a as any) };
  for (const k of Object.keys(b as any)) {
    const av = (a as any)[k];
    const bv = (b as any)[k];
    if (Array.isArray(av) && Array.isArray(bv)) out[k] = [...av, ...bv];
    else if (isObj(av) && isObj(bv)) out[k] = deepMerge(av, bv);
    else out[k] = bv;
  }
  return out;
}

/** Default config (safe, repo-relative paths). */
export function getDefaults(partial?: Partial<EngineDefaults>): EngineDefaults {
  const root = (partial?.paths?.projectRoot) || process.cwd();
  const join = (p: string) => (root.endsWith("/") ? root.slice(0, -1) : root) + "/" + p.replace(/^\.?\//, "");

  const base: EngineDefaults = {
    mode: partial?.mode ?? "backtest",
    paths: {
      projectRoot: root,
      outputsDir: join("outputs"),
      runsDir: join("outputs/runs"),
      curvesDir: join("outputs/curves"),
      summariesDir: join("outputs/summaries"),
      plotsDir: join("outputs/plots"),
      manifestPath: join("strategies/_manifest.json"),
      ...(partial?.paths ?? {})
    },
    data: {
      feed: "demo",
      timeframe: "1d",
      start: toISO(partial?.data?.start || "2024-01-01", "2024-01-01"),
      end: toISO(partial?.data?.end || "2024-12-31", "2024-12-31"),
      cache: true,
      ...(partial?.data ?? {})
    },
    broker: {
      adapter: "paper",
      account: undefined,
      currency: "USD",
      slippageBps: 0.0,
      commissionPerShare: 0.0,
      maxLeverage: 2.0,
      ...(partial?.broker ?? {})
    },
    risk: {
      rfDaily: 0,            // set non-zero if you want excess returns
      daysPerYear: 252,
      maxPositions: undefined,
      maxGrossLeverage: undefined,
      maxNotionalPerName: undefined,
      ...(partial?.risk ?? {})
    },
    exec: {
      concurrency: Math.max(1, Number(partial?.exec?.concurrency ?? 2)),
      seed: partial?.exec?.seed,
      strict: partial?.exec?.strict ?? true,
      persistEachRun: partial?.exec?.persistEachRun ?? true,
      keepRuns: Math.max(1, Number(partial?.exec?.keepRuns ?? 500)),
      ...(partial?.exec ?? {})
    },
    log: {
      level: (partial?.log?.level ?? "info"),
      json: partial?.log?.json ?? false,
      timestamps: partial?.log?.timestamps ?? true,
      ...(partial?.log ?? {})
    }
  };

  return base;
}



  

