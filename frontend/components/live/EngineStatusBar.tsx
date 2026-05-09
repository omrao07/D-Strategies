// frontend/components/live/EngineStatusBar.tsx
// Top-of-page status bar showing engine health, daily P&L, and WS connection.

"use client";
import React from "react";
import { useTradingStore } from "@/store/useTradingStore";

function Metric({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 10, color: "#64748b", marginBottom: 2, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: color ?? "#e2e8f0", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
    </div>
  );
}

function WsIndicator({ status }: { status: string }) {
  const dot =
    status === "open"
      ? { bg: "#10b981", label: "LIVE" }
      : status === "connecting"
      ? { bg: "#f59e0b", label: "CONN…" }
      : { bg: "#ef4444", label: "OFFLINE" };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dot.bg,
          boxShadow: `0 0 6px ${dot.bg}`,
        }}
      />
      <span style={{ fontSize: 11, color: dot.bg, fontWeight: 700 }}>
        {dot.label}
      </span>
    </div>
  );
}

export function EngineStatusBar() {
  const engine = useTradingStore((s) => s.engine);
  const wsStatus = useTradingStore((s) => s.wsStatus);
  const isHalted = useTradingStore((s) => s.isHalted);

  const pnlColor =
    engine.dailyPnl > 0
      ? "#10b981"
      : engine.dailyPnl < 0
      ? "#ef4444"
      : "#94a3b8";

  const scoreColor =
    engine.combinedScore > 0.1
      ? "#10b981"
      : engine.combinedScore < -0.1
      ? "#ef4444"
      : "#94a3b8";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "#0f172a",
        borderBottom: `1px solid ${isHalted ? "#ef4444" : "#1e293b"}`,
        padding: "8px 20px",
        gap: 24,
      }}
    >
      {/* Brand */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 16, fontWeight: 800, color: "#e2e8f0" }}>
          D-Strategies
        </span>
        {isHalted && (
          <span
            style={{
              fontSize: 10,
              background: "#ef444420",
              color: "#ef4444",
              border: "1px solid #ef4444",
              borderRadius: 4,
              padding: "2px 6px",
              fontWeight: 700,
            }}
          >
            HALTED
          </span>
        )}
        {engine.running && !isHalted && (
          <span
            style={{
              fontSize: 10,
              background: "#10b98120",
              color: "#10b981",
              border: "1px solid #10b981",
              borderRadius: 4,
              padding: "2px 6px",
              fontWeight: 700,
            }}
          >
            LIVE
          </span>
        )}
      </div>

      {/* Metrics */}
      <div style={{ display: "flex", gap: 28, flex: 1, justifyContent: "center" }}>
        <Metric
          label="Daily P&L"
          value={`${engine.dailyPnl >= 0 ? "+" : ""}$${Math.abs(engine.dailyPnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
          color={pnlColor}
        />
        <Metric
          label="Drawdown"
          value={`${(engine.drawdown * 100).toFixed(2)}%`}
          color={engine.drawdown < -0.05 ? "#ef4444" : "#94a3b8"}
        />
        <Metric
          label="Signal"
          value={`${engine.combinedScore >= 0 ? "+" : ""}${(engine.combinedScore * 100).toFixed(1)}%`}
          color={scoreColor}
        />
        <Metric
          label="Strategies"
          value={String(engine.nStrategies)}
        />
        {engine.vix != null && (
          <Metric
            label="VIX"
            value={engine.vix.toFixed(1)}
            color={engine.vix >= 30 ? "#ef4444" : engine.vix >= 20 ? "#f59e0b" : "#94a3b8"}
          />
        )}
      </div>

      {/* WS status */}
      <WsIndicator status={wsStatus} />
    </div>
  );
}
