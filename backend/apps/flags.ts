// app/flags.ts
// Central feature toggles for the platform

export const flags = {
  // --- Data sources ---
  USE_MOCK_DATA: true,     // true = load from /data/ packs & samples
  USE_LIVE_ADAPTERS: false,// true = use broker + market-data APIs (when wired)

  // --- Modules ---
  ENABLE_FNO: false,       // Futures & Options module (chain, Greeks, payoff UI)
  ENABLE_FUTURES: false,   // Commodities/Futures module (curve, roll, margin)
  ENABLE_DAMODARAN: true,  // Damodaran bot (ingest, retrieval, hooks)

  // --- Engine ---
  ENABLE_RISK_GATES: true, // enforce MDD/exposure/correlation caps before exec
  ENABLE_SCHEDULER: true,  // cron-like scheduling, market hours gating
  ENABLE_PERSISTENCE: true,// save/load portfolio snapshots + journals
  ENABLE_BACKTEST: true,   // auto backtester CLI + exports

  // --- UI ---
  ENABLE_A11Y: false,      // accessibility pass (ARIA, keyboard nav)
  ENABLE_NOTIFICATIONS: true,// toasts/webhooks for breaches/events
  ENABLE_COMMAND_PALETTE: false,// ⌘K menu

  // --- Modes ---
  DEMO_MODE: true,         // seeded deterministic ticks, safe for demos
  DEBUG_LOGS: true,        // verbose console logs
  STRICT_MODE: false       // extra runtime checks (slow)
}

// Helper to flip quickly
export function setFlag(key: keyof typeof flags, value: boolean) {
  (flags as any)[key] = value
}