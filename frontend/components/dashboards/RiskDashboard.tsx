import React, { useMemo } from "react";
import { useTradingStore, selectFailedGates, selectGrossExposure, selectNetExposure } from "@/store/useTradingStore";

const fmtPct = (x?: number, d = 2) =>
  Number.isFinite(x as number) ? `${((x as number) * 100).toFixed(d)}%` : "–";
const fmt = (x?: number, d = 2) =>
  Number.isFinite(x as number) ? (x as number).toFixed(d) : "–";

function MetricRow({ label, value, color, warn }: { label: string; value: string; color?: string; warn?: boolean }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "7px 0",
      borderBottom: "1px solid #1e293b",
    }}>
      <span style={{ fontSize: 12, color: "#64748b" }}>{label}</span>
      <span style={{
        fontSize: 13,
        fontWeight: 700,
        fontVariantNumeric: "tabular-nums",
        color: warn ? "#ef4444" : (color ?? "#e2e8f0"),
      }}>
        {value}
      </span>
    </div>
  );
}

function Spark({ points, color = "#6366f1" }: { points: { value: number }[]; color?: string }) {
  if (!points.length) return <div style={{ color: "#475569", fontSize: 11 }}>–</div>;
  const w = 300; const h = 50;
  const ys = points.map((p) => p.value);
  const min = Math.min(...ys); const max = Math.max(...ys);
  const range = Math.max(1e-9, max - min);
  const step = points.length > 1 ? (w / (points.length - 1)) : w;
  const Y = (v: number) => h - ((v - min) / range) * (h - 4) - 2;
  let d = `M 0 ${Y(ys[0])}`;
  for (let i = 1; i < ys.length; i++) d += ` L ${i * step} ${Y(ys[i])}`;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ overflow: "visible" }}>
      <path d={`${d} L ${w} ${h} L 0 ${h} Z`} fill={color} fillOpacity={0.15} />
      <path d={d} stroke={color} fill="none" strokeWidth={1.8} />
    </svg>
  );
}

function GateRow({ gate, ok, reason }: { gate: string; ok: boolean; reason?: string }) {
  const LABELS: Record<string, string> = {
    gate1_daily_loss: "Daily Loss", gate2_drawdown: "Drawdown",
    gate3_beta: "Beta", gate4_position_size: "Position Size",
    gate5_vix: "VIX", gate6_sector: "Sector Conc.",
    gate7_order_rate: "Order Rate", gate8_margin: "Margin",
    gate9_circuit: "Circuit Breaker", gate_fo_ban: "F&O Ban",
    gate_kelly: "Kelly / Vol-Parity",
  };
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "6px 0", borderBottom: "1px solid #0f172a",
    }}>
      <div style={{
        width: 8, height: 8, borderRadius: "50%",
        background: ok ? "#10b981" : "#ef4444",
        boxShadow: `0 0 5px ${ok ? "#10b981" : "#ef4444"}`,
        flexShrink: 0,
      }} />
      <span style={{ fontSize: 12, color: ok ? "#94a3b8" : "#fca5a5", flex: 1 }}>
        {LABELS[gate] ?? gate}
      </span>
      {!ok && reason && (
        <span style={{ fontSize: 10, color: "#ef4444", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {reason}
        </span>
      )}
    </div>
  );
}

export function RiskDashboard() {
  const engine = useTradingStore((s) => s.engine);
  const riskGates = useTradingStore((s) => s.riskGates);
  const pnlHistory = useTradingStore((s) => s.pnlHistory);
  const isHalted = useTradingStore((s) => s.isHalted);
  const grossExposure = useTradingStore(selectGrossExposure);
  const netExposure = useTradingStore(selectNetExposure);
  const failedGates = useTradingStore(selectFailedGates);

  const ddSeries = useMemo(
    () => pnlHistory.map((p) => ({ value: p.net })),
    [pnlHistory]
  );

  const pnlColor = engine.dailyPnl > 0 ? "#10b981" : engine.dailyPnl < 0 ? "#ef4444" : "#94a3b8";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>Risk Dashboard</span>
        {isHalted && (
          <span style={{
            fontSize: 11, background: "#ef444420", color: "#ef4444",
            border: "1px solid #ef4444", borderRadius: 4, padding: "2px 8px", fontWeight: 700,
          }}>
            HALTED — {failedGates.length} gate{failedGates.length !== 1 ? "s" : ""} failed
          </span>
        )}
      </div>

      {/* Metrics card */}
      <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, padding: "12px 16px" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8", marginBottom: 4, display: "block" }}>
          Portfolio Risk
        </span>
        <MetricRow label="Daily P&L" value={`${engine.dailyPnl >= 0 ? "+" : ""}$${Math.abs(engine.dailyPnl).toLocaleString()}`} color={pnlColor} />
        <MetricRow label="Drawdown" value={fmtPct(engine.drawdown)} warn={engine.drawdown < -0.05} />
        <MetricRow label="Gross Exposure" value={`$${grossExposure.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
        <MetricRow
          label="Net Exposure"
          value={`${netExposure >= 0 ? "+" : ""}$${Math.abs(netExposure).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
          color={netExposure >= 0 ? "#10b981" : "#ef4444"}
        />
        <MetricRow label="Signal" value={`${engine.combinedScore >= 0 ? "+" : ""}${(engine.combinedScore * 100).toFixed(1)}%`} />
        {engine.vix != null && (
          <MetricRow label="VIX" value={engine.vix.toFixed(1)} warn={engine.vix >= 30} />
        )}
      </div>

      {/* Daily P&L sparkline */}
      {pnlHistory.length > 1 && (
        <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, padding: "12px 16px" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8", marginBottom: 8, display: "block" }}>
            Daily P&L History ({pnlHistory.length}d)
          </span>
          <Spark points={ddSeries} color={engine.dailyPnl >= 0 ? "#10b981" : "#ef4444"} />
        </div>
      )}

      {/* Risk gates */}
      <div style={{ background: "#0f172a", border: `1px solid ${isHalted ? "#ef4444" : "#1e293b"}`, borderRadius: 10, padding: "12px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8" }}>Risk Gates</span>
          <span style={{ fontSize: 11, color: isHalted ? "#ef4444" : "#10b981" }}>
            {isHalted ? `${failedGates.length} FAILED` : "ALL CLEAR"}
          </span>
        </div>
        {riskGates.length === 0 ? (
          <div style={{ color: "#475569", fontSize: 12 }}>Waiting for engine…</div>
        ) : (
          riskGates.map((g) => <GateRow key={g.gate} {...g} />)
        )}
      </div>
    </div>
  );
}

export default RiskDashboard;
