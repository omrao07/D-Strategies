// frontend/store/useTradingStore.ts
// Global Zustand store for live trading state.
// Populated by WebSocket messages from the backend.

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

// ---- Types ----------------------------------------------------------------

export interface StrategySignal {
  name: string;
  score: number;          // [-1, +1]
  vol: number;
  drawdown: number;
  tsMs: number;
  enabled: boolean;
  region?: string;
  tags?: string[];
}

export interface RiskGateStatus {
  gate: string;
  ok: boolean;
  reason?: string;
}

export interface Position {
  symbol: string;
  qty: number;           // positive=long, negative=short
  avgPx: number;
  currentPx: number;
  pnl: number;
  notional: number;
  strategy: string;
}

export interface DailyPnL {
  date: string;
  realized: number;
  unrealized: number;
  fees: number;
  net: number;
  cumulativeNet: number;
}

export interface MarketTick {
  symbol: string;
  venue: string;
  bid: number;
  ask: number;
  last: number;
  tsMs: number;
}

export interface EngineStatus {
  running: boolean;
  nStrategies: number;
  combinedScore: number;
  dailyPnl: number;
  drawdown: number;
  vix?: number;
}

export interface IndiaMarketState {
  isOpen: boolean;
  nextEvent: string;   // "Opens in 2h 15m" | "Closes in 45m"
  circuitHalted: string[];
  foBanList: string[];
  marginUsed: number;
  marginAvailable: number;
}

// Additional slices required by the dashboard

export interface IndiaDashState {
  vix: number;
  pcr: number;
  regime: string;
  fo_ban: string[];
}

export interface PnLSummary {
  daily: number;
  cumulative: number;
  drawdown: number;
  hwm: number;
}

export interface TickSummary {
  price: number;
  change: number;
  ts: number;
}

// ---- Store ----------------------------------------------------------------

interface TradingStore {
  // Engine
  engine: EngineStatus;
  setEngine: (s: Partial<EngineStatus>) => void;

  // Strategy signals
  signals: Record<string, StrategySignal>;
  upsertSignal: (sig: StrategySignal) => void;
  setStrategyEnabled: (name: string, enabled: boolean) => void;

  // Risk gates
  riskGates: RiskGateStatus[];
  setRiskGates: (gates: RiskGateStatus[]) => void;
  isHalted: boolean;

  // Positions
  positions: Record<string, Position>;
  upsertPosition: (pos: Position) => void;
  clearPositions: () => void;

  // P&L history (last 252 days)
  pnlHistory: DailyPnL[];
  appendPnL: (pnl: DailyPnL) => void;
  todayPnL: number;

  // Live ticks
  ticks: Record<string, MarketTick>;
  upsertTick: (tick: MarketTick) => void;

  // India
  india: IndiaMarketState;
  setIndia: (s: Partial<IndiaMarketState>) => void;

  // UI state
  selectedStrategy: string | null;
  setSelectedStrategy: (name: string | null) => void;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  sidebarOpen: boolean;
  toggleSidebar: () => void;

  // WebSocket health
  wsStatus: "idle" | "connecting" | "open" | "closed" | "error" | "connected" | "disconnected" | "reconnecting";
  setWsStatus: (s: TradingStore["wsStatus"]) => void;
  lastHeartbeatMs: number;
  heartbeat: number;
  setHeartbeat: () => void;

  // India dash state (vix/pcr/regime/fo_ban summary)
  indiaDash: IndiaDashState;
  setIndiaDash: (s: Partial<IndiaDashState>) => void;

  // P&L summary slice
  pnl: PnLSummary;
  setPnl: (s: Partial<PnLSummary>) => void;
}

export const useTradingStore = create<TradingStore>()(
  subscribeWithSelector((set, get) => ({
    // Engine
    engine: {
      running: false,
      nStrategies: 0,
      combinedScore: 0,
      dailyPnl: 0,
      drawdown: 0,
      vix: undefined,
    },
    setEngine: (s) =>
      set((state) => ({ engine: { ...state.engine, ...s } })),

    // Signals
    signals: {},
    upsertSignal: (sig) =>
      set((state) => ({
        signals: { ...state.signals, [sig.name]: sig },
      })),
    setStrategyEnabled: (name, enabled) =>
      set((state) => ({
        signals: {
          ...state.signals,
          [name]: state.signals[name]
            ? { ...state.signals[name], enabled }
            : ({ name, enabled, score: 0, vol: 0, drawdown: 0, tsMs: Date.now() } as StrategySignal),
        },
      })),

    // Risk gates
    riskGates: [],
    setRiskGates: (gates) =>
      set({ riskGates: gates, isHalted: gates.some((g) => !g.ok) }),
    isHalted: false,

    // Positions
    positions: {},
    upsertPosition: (pos) =>
      set((state) => ({
        positions: { ...state.positions, [pos.symbol]: pos },
      })),
    clearPositions: () => set({ positions: {} }),

    // P&L history
    pnlHistory: [],
    appendPnL: (pnl) =>
      set((state) => ({
        pnlHistory: [...state.pnlHistory.slice(-251), pnl],
        todayPnL: pnl.net,
      })),
    todayPnL: 0,

    // Live ticks
    ticks: {},
    upsertTick: (tick) =>
      set((state) => ({
        ticks: { ...state.ticks, [tick.symbol]: tick },
      })),

    // India
    india: {
      isOpen: false,
      nextEvent: "",
      circuitHalted: [],
      foBanList: [],
      marginUsed: 0,
      marginAvailable: 0,
    },
    setIndia: (s) =>
      set((state) => ({ india: { ...state.india, ...s } })),

    // UI state
    selectedStrategy: null,
    setSelectedStrategy: (name) => set({ selectedStrategy: name }),
    activeTab: "overview",
    setActiveTab: (tab) => set({ activeTab: tab }),
    sidebarOpen: true,
    toggleSidebar: () =>
      set((state) => ({ sidebarOpen: !state.sidebarOpen })),

    // WebSocket
    wsStatus: "idle",
    setWsStatus: (s) => set({ wsStatus: s }),
    lastHeartbeatMs: 0,
    heartbeat: 0,
    setHeartbeat: () => {
      const now = Date.now();
      set({ lastHeartbeatMs: now, heartbeat: now });
    },

    // India dash state
    indiaDash: {
      vix: 0,
      pcr: 0,
      regime: "unknown",
      fo_ban: [],
    },
    setIndiaDash: (s) =>
      set((state) => ({ indiaDash: { ...state.indiaDash, ...s } })),

    // P&L summary
    pnl: {
      daily: 0,
      cumulative: 0,
      drawdown: 0,
      hwm: 0,
    },
    setPnl: (s) =>
      set((state) => ({ pnl: { ...state.pnl, ...s } })),
  }))
);

// ---- Selectors (memoized-style) -------------------------------------------

export const selectActiveSignals = (state: TradingStore) =>
  Object.values(state.signals).filter(
    (s) => s.enabled && Date.now() - s.tsMs < 30_000
  );

export const selectGrossExposure = (state: TradingStore) =>
  Object.values(state.positions).reduce((sum, p) => sum + Math.abs(p.notional), 0);

export const selectNetExposure = (state: TradingStore) =>
  Object.values(state.positions).reduce((sum, p) => sum + p.notional, 0);

export const selectTotalUnrealizedPnL = (state: TradingStore) =>
  Object.values(state.positions).reduce((sum, p) => sum + p.pnl, 0);

export const selectFailedGates = (state: TradingStore) =>
  state.riskGates.filter((g) => !g.ok);
