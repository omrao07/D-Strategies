// frontend/store/useWsSync.ts
// Connects the WebSocket feed to the Zustand store.
// Mount this once at the app root level.

import { useEffect } from "react";
import { useWS } from "@/lib/ws/useWS";
import { useTradingStore } from "./useTradingStore";

const WS_URL =
  (typeof window !== "undefined"
    ? `ws://${window.location.hostname}:8000/ws/live`
    : "ws://localhost:8000/ws/live");

interface WsMessage {
  type: string;
  payload: Record<string, unknown>;
}

export function useWsSync() {
  const {
    setEngine,
    upsertSignal,
    setRiskGates,
    upsertPosition,
    appendPnL,
    upsertTick,
    setIndia,
    setIndiaDash,
    setPnl,
    setWsStatus,
    setHeartbeat,
  } = useTradingStore();

  const { status } = useWS<WsMessage>({
    url: WS_URL,
    autoReconnect: true,
    heartbeatMs: 30_000,
    onMessage: (msg) => {
      if (!msg?.type) return;
      const { type, payload } = msg;

      switch (type) {
        case "engine_status":
          setEngine({
            running: !!payload.running,
            nStrategies: Number(payload.n_strategies ?? 0),
            combinedScore: Number(payload.combined_score ?? 0),
            dailyPnl: Number(payload.daily_pnl ?? 0),
            drawdown: Number(payload.drawdown ?? 0),
            vix: payload.vix != null ? Number(payload.vix) : undefined,
          });
          break;

        case "signal":
          upsertSignal({
            name: String(payload.name ?? ""),
            score: Number(payload.score ?? 0),
            vol: Number(payload.vol ?? 0.2),
            drawdown: Number(payload.drawdown ?? 0),
            tsMs: Number(payload.ts_ms ?? Date.now()),
            enabled: payload.enabled !== false,
            region: payload.region ? String(payload.region) : undefined,
            tags: Array.isArray(payload.tags)
              ? (payload.tags as unknown[]).map(String)
              : undefined,
          });
          break;

        case "risk_gates":
          if (Array.isArray(payload.gates)) {
            setRiskGates(
              (payload.gates as unknown[]).map((g: any) => ({
                gate: String(g.gate ?? ""),
                ok: Boolean(g.ok),
                reason: g.reason ? String(g.reason) : undefined,
              }))
            );
          }
          break;

        case "position":
          upsertPosition({
            symbol: String(payload.symbol ?? ""),
            qty: Number(payload.qty ?? 0),
            avgPx: Number(payload.avg_px ?? 0),
            currentPx: Number(payload.current_px ?? 0),
            pnl: Number(payload.pnl ?? 0),
            notional: Number(payload.notional ?? 0),
            strategy: String(payload.strategy ?? ""),
          });
          break;

        case "pnl":
          appendPnL({
            date: String(payload.date ?? ""),
            realized: Number(payload.realized ?? 0),
            unrealized: Number(payload.unrealized ?? 0),
            fees: Number(payload.fees ?? 0),
            net: Number(payload.net ?? 0),
            cumulativeNet: Number(payload.cumulative_net ?? 0),
          });
          // Also update the pnl summary slice
          setPnl({
            daily: Number(payload.net ?? 0),
            cumulative: Number(payload.cumulative_net ?? 0),
            drawdown: Number(payload.drawdown ?? 0),
            hwm: Number(payload.hwm ?? 0),
          });
          break;

        case "tick":
          upsertTick({
            symbol: String(payload.symbol ?? ""),
            venue: String(payload.venue ?? ""),
            bid: Number(payload.bid ?? 0),
            ask: Number(payload.ask ?? 0),
            last: Number(payload.last ?? 0),
            tsMs: Number(payload.ts_ms ?? Date.now()),
          });
          break;

        case "india_status":
          setIndia({
            isOpen: Boolean(payload.is_open),
            nextEvent: String(payload.next_event ?? ""),
            circuitHalted: Array.isArray(payload.circuit_halted)
              ? (payload.circuit_halted as unknown[]).map(String)
              : [],
            foBanList: Array.isArray(payload.fo_ban_list)
              ? (payload.fo_ban_list as unknown[]).map(String)
              : [],
            marginUsed: Number(payload.margin_used ?? 0),
            marginAvailable: Number(payload.margin_available ?? 0),
          });
          // Also update the indiaDash summary slice
          setIndiaDash({
            vix: Number(payload.vix ?? 0),
            pcr: Number(payload.pcr ?? 0),
            regime: String(payload.regime ?? "unknown"),
            fo_ban: Array.isArray(payload.fo_ban_list)
              ? (payload.fo_ban_list as unknown[]).map(String)
              : [],
          });
          break;

        case "india":
          setIndiaDash({
            vix: Number(payload.vix ?? 0),
            pcr: Number(payload.pcr ?? 0),
            regime: String(payload.regime ?? "unknown"),
            fo_ban: Array.isArray(payload.fo_ban)
              ? (payload.fo_ban as unknown[]).map(String)
              : [],
          });
          break;

        case "heartbeat":
          setHeartbeat();
          break;

        case "pong":
          setHeartbeat();
          break;

        default:
          break;
      }
    },
  });

  useEffect(() => {
    setWsStatus(status as any);
  }, [status, setWsStatus]);
}
