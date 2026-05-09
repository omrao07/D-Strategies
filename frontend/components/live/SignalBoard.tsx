// frontend/components/live/SignalBoard.tsx
// Live strategy signal board — shows all active strategy scores.

"use client";
import React, { useMemo } from "react";
import {
  useTradingStore,
  selectActiveSignals,
  StrategySignal,
} from "@/store/useTradingStore";

function SignalBar({ score }: { score: number }) {
  const pct = Math.abs(score) * 100;
  const color =
    score > 0 ? "#10b981" : score < 0 ? "#ef4444" : "#64748b";
  const side = score >= 0 ? "left" : "right";

  return (
    <div
      style={{
        width: "100%",
        height: 4,
        background: "#1e293b",
        borderRadius: 2,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Center line */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 0,
          bottom: 0,
          width: 1,
          background: "#334155",
        }}
      />
      {/* Fill */}
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          width: `${pct / 2}%`,
          [side === "left" ? "left" : "right"]: "50%",
          background: color,
          borderRadius: 2,
        }}
      />
    </div>
  );
}

function SignalRow({
  sig,
  onClick,
  selected,
}: {
  sig: StrategySignal;
  onClick: () => void;
  selected: boolean;
}) {
  const age = Date.now() - sig.tsMs;
  const stale = age > 15_000;
  const scoreColor =
    sig.score > 0.05
      ? "#10b981"
      : sig.score < -0.05
      ? "#ef4444"
      : "#94a3b8";

  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "6px 10px",
        borderRadius: 6,
        cursor: "pointer",
        background: selected ? "#1e293b" : "transparent",
        borderLeft: selected ? "3px solid #6366f1" : "3px solid transparent",
        opacity: stale ? 0.5 : 1,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "#e2e8f0",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 140,
          }}
          title={sig.name}
        >
          {sig.name.replace(/_/g, " ")}
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: scoreColor, fontVariantNumeric: "tabular-nums" }}>
          {sig.score >= 0 ? "+" : ""}
          {(sig.score * 100).toFixed(1)}%
        </span>
      </div>
      <SignalBar score={sig.score} />
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, color: "#64748b" }}>
          vol {(sig.vol * 100).toFixed(1)}%
        </span>
        {sig.region && (
          <span style={{ fontSize: 10, color: "#475569", textTransform: "uppercase" }}>
            {sig.region}
          </span>
        )}
      </div>
    </div>
  );
}

export function SignalBoard() {
  const activeSignals = useTradingStore(selectActiveSignals);
  const allSignals = useTradingStore((s) => s.signals);
  const selectedStrategy = useTradingStore((s) => s.selectedStrategy);
  const setSelectedStrategy = useTradingStore((s) => s.setSelectedStrategy);

  const sorted = useMemo(
    () => [...activeSignals].sort((a, b) => Math.abs(b.score) - Math.abs(a.score)),
    [activeSignals]
  );

  const staleCount = Object.values(allSignals).length - activeSignals.length;

  return (
    <div
      style={{
        background: "#0f172a",
        border: "1px solid #1e293b",
        borderRadius: 10,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 14px",
          borderBottom: "1px solid #1e293b",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>
          Live Signals
        </span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {staleCount > 0 && (
            <span style={{ fontSize: 11, color: "#64748b" }}>
              {staleCount} stale
            </span>
          )}
          <span
            style={{
              fontSize: 11,
              background: "#6366f120",
              color: "#818cf8",
              borderRadius: 4,
              padding: "2px 6px",
            }}
          >
            {sorted.length} active
          </span>
        </div>
      </div>

      {/* Signals */}
      <div
        style={{
          overflowY: "auto",
          maxHeight: 400,
          padding: "4px",
        }}
      >
        {sorted.length === 0 ? (
          <div
            style={{
              padding: "24px",
              textAlign: "center",
              color: "#475569",
              fontSize: 13,
            }}
          >
            No active signals
          </div>
        ) : (
          sorted.map((sig) => (
            <SignalRow
              key={sig.name}
              sig={sig}
              selected={selectedStrategy === sig.name}
              onClick={() =>
                setSelectedStrategy(
                  selectedStrategy === sig.name ? null : sig.name
                )
              }
            />
          ))
        )}
      </div>
    </div>
  );
}
