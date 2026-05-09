// frontend/components/live/RiskGatesPanel.tsx
// Displays the 9+2 risk gate statuses in real-time.

"use client";
import React from "react";
import { useTradingStore, selectFailedGates } from "@/store/useTradingStore";

const GATE_LABELS: Record<string, string> = {
  gate1_daily_loss: "Daily Loss (−2%)",
  gate2_drawdown: "Drawdown (−10%)",
  gate3_beta: "Portfolio Beta (>0.8)",
  gate4_position_size: "Position Size (>5%)",
  gate5_vix: "VIX (>30)",
  gate6_sector: "Sector Conc. (>30%)",
  gate7_order_rate: "Order Rate (>60/min)",
  gate8_margin: "Margin (>150%)",
  gate9_circuit: "Circuit Breaker",
  gate_fo_ban: "F&O Ban List",
  gate_kelly: "Kelly / Vol-Parity",
};

function GateBadge({ ok, reason }: { ok: boolean; reason?: string }) {
  return (
    <span
      title={reason}
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: ok ? "#10b981" : "#ef4444",
        boxShadow: ok ? "0 0 6px #10b981" : "0 0 6px #ef4444",
        flexShrink: 0,
      }}
    />
  );
}

export function RiskGatesPanel() {
  const gates = useTradingStore((s) => s.riskGates);
  const isHalted = useTradingStore((s) => s.isHalted);
  const failed = useTradingStore(selectFailedGates);

  return (
    <div
      style={{
        background: "#0f172a",
        border: `1px solid ${isHalted ? "#ef4444" : "#1e293b"}`,
        borderRadius: 10,
        padding: "12px 16px",
        minWidth: 240,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 13, color: "#e2e8f0" }}>
          Risk Gates
        </span>
        {isHalted ? (
          <span
            style={{
              fontSize: 11,
              background: "#ef444420",
              color: "#ef4444",
              border: "1px solid #ef4444",
              borderRadius: 4,
              padding: "2px 6px",
              fontWeight: 700,
            }}
          >
            HALTED ({failed.length})
          </span>
        ) : (
          <span
            style={{
              fontSize: 11,
              background: "#10b98120",
              color: "#10b981",
              border: "1px solid #10b981",
              borderRadius: 4,
              padding: "2px 6px",
              fontWeight: 600,
            }}
          >
            ALL CLEAR
          </span>
        )}
      </div>

      {gates.length === 0 ? (
        <div style={{ color: "#64748b", fontSize: 12 }}>
          Waiting for engine…
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {gates.map((g) => (
            <div
              key={g.gate}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 0",
                borderBottom: "1px solid #1e293b",
              }}
            >
              <GateBadge ok={g.ok} reason={g.reason} />
              <span
                style={{
                  fontSize: 12,
                  color: g.ok ? "#94a3b8" : "#fca5a5",
                  flex: 1,
                }}
              >
                {GATE_LABELS[g.gate] ?? g.gate}
              </span>
              {!g.ok && g.reason && (
                <span
                  style={{
                    fontSize: 10,
                    color: "#ef4444",
                    maxWidth: 100,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={g.reason}
                >
                  {g.reason}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
