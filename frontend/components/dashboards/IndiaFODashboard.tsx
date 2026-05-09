// frontend/components/dashboards/IndiaFODashboard.tsx
// India F&O market status panel: market hours, circuit halts, ban list, margin utilisation.

"use client";
import React from "react";
import { useTradingStore } from "@/store/useTradingStore";

// ── Small helpers ─────────────────────────────────────────────────────────────

function Badge({
  label,
  color,
}: {
  label: string;
  color: "green" | "red" | "yellow" | "gray";
}) {
  const bg: Record<string, string> = {
    green: "#14532d",
    red: "#450a0a",
    yellow: "#422006",
    gray: "#1e293b",
  };
  const fg: Record<string, string> = {
    green: "#4ade80",
    red: "#f87171",
    yellow: "#fbbf24",
    gray: "#94a3b8",
  };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 700,
        background: bg[color],
        color: fg[color],
        letterSpacing: "0.04em",
      }}
    >
      {label}
    </span>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: "#475569",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        marginBottom: 8,
      }}
    >
      {title}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "#0f172a",
        border: "1px solid #1e293b",
        borderRadius: 8,
        padding: 16,
      }}
    >
      {children}
    </div>
  );
}

// ── Margin bar ─────────────────────────────────────────────────────────────────

function MarginBar({
  used,
  available,
}: {
  used: number;
  available: number;
}) {
  const total = used + available;
  const pct = total > 0 ? (used / total) * 100 : 0;
  const color =
    pct > 80 ? "#ef4444" : pct > 60 ? "#f59e0b" : "#22c55e";

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 12,
          color: "#94a3b8",
          marginBottom: 6,
        }}
      >
        <span>Margin used</span>
        <span style={{ color, fontWeight: 700 }}>{pct.toFixed(1)}%</span>
      </div>
      <div
        style={{
          height: 6,
          background: "#1e293b",
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: color,
            borderRadius: 3,
            transition: "width 0.4s ease",
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          color: "#475569",
          marginTop: 4,
        }}
      >
        <span>₹{(used / 1e5).toFixed(2)}L used</span>
        <span>₹{(available / 1e5).toFixed(2)}L free</span>
      </div>
    </div>
  );
}

// ── Symbol chip list ───────────────────────────────────────────────────────────

function SymbolList({
  symbols,
  color,
  emptyText,
}: {
  symbols: string[];
  color: "red" | "yellow";
  emptyText: string;
}) {
  if (symbols.length === 0) {
    return (
      <span style={{ fontSize: 12, color: "#334155" }}>{emptyText}</span>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {symbols.map((s) => (
        <Badge key={s} label={s} color={color} />
      ))}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function IndiaFODashboard() {
  const india = useTradingStore((s) => s.india);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Market status */}
      <Card>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <SectionHeader title="NSE / BSE Market" />
          <Badge
            label={india.isOpen ? "OPEN" : "CLOSED"}
            color={india.isOpen ? "green" : "gray"}
          />
        </div>
        <div style={{ fontSize: 13, color: "#64748b" }}>
          {india.nextEvent || (india.isOpen ? "Market is open" : "Market is closed")}
        </div>
      </Card>

      {/* Margin utilisation */}
      <Card>
        <SectionHeader title="SPAN Margin" />
        <MarginBar
          used={india.marginUsed}
          available={india.marginAvailable}
        />
      </Card>

      {/* Circuit breakers */}
      <Card>
        <SectionHeader title="Circuit Breaker Halts" />
        <SymbolList
          symbols={india.circuitHalted}
          color="red"
          emptyText="No circuit halts active"
        />
      </Card>

      {/* F&O ban list */}
      <Card>
        <SectionHeader title="F&O Ban List" />
        <SymbolList
          symbols={india.foBanList}
          color="yellow"
          emptyText="No F&O bans today"
        />
        {india.foBanList.length > 0 && (
          <div
            style={{
              marginTop: 8,
              fontSize: 11,
              color: "#475569",
              lineHeight: 1.5,
            }}
          >
            New positions in banned stocks are prohibited. Existing positions
            may be retained but not increased.
          </div>
        )}
      </Card>

    </div>
  );
}

export default IndiaFODashboard;
