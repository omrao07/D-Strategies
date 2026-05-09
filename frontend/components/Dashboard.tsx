// frontend/components/Dashboard.tsx
// Main dashboard — wires the Zustand store + WS sync, renders all panels.

"use client";
import React, { Suspense } from "react";
import dynamic from "next/dynamic";
import { useWsSync } from "@/store/useWsSync";
import { useTradingStore } from "@/store/useTradingStore";
import { EngineStatusBar } from "./live/EngineStatusBar";
import { SignalBoard } from "./live/SignalBoard";
import { RiskGatesPanel } from "./live/RiskGatesPanel";

// Heavy panels loaded lazily
const StrategiesTable = dynamic(
  () =>
    import("./strategies/StrategiesTable").then((m) => ({
      default: m.StrategiesTable ?? m.default,
    })),
  { ssr: false, loading: () => <Spinner /> }
);
const PortfolioOverview = dynamic(
  () =>
    import("./dashboards/PortfolioOverview").then((m) => ({
      default: m.PortfolioOverview ?? m.default,
    })),
  { ssr: false, loading: () => <Spinner /> }
);
const RiskDashboard = dynamic(
  () =>
    import("./dashboards/RiskDashboard").then((m) => ({
      default: m.RiskDashboard ?? m.default,
    })),
  { ssr: false, loading: () => <Spinner /> }
);

function Spinner() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: 120,
        color: "#475569",
        fontSize: 13,
      }}
    >
      Loading…
    </div>
  );
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "strategies", label: "Strategies" },
  { id: "risk", label: "Risk" },
  { id: "portfolio", label: "Portfolio" },
];

function TabBar() {
  const activeTab = useTradingStore((s) => s.activeTab);
  const setActiveTab = useTradingStore((s) => s.setActiveTab);

  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        borderBottom: "1px solid #1e293b",
        padding: "0 16px",
        background: "#0f172a",
      }}
    >
      {TABS.map((t) => (
        <button
          key={t.id}
          onClick={() => setActiveTab(t.id)}
          style={{
            padding: "10px 16px",
            background: "none",
            border: "none",
            borderBottom:
              activeTab === t.id ? "2px solid #6366f1" : "2px solid transparent",
            color: activeTab === t.id ? "#e2e8f0" : "#64748b",
            fontWeight: activeTab === t.id ? 700 : 400,
            fontSize: 13,
            cursor: "pointer",
            transition: "color 0.15s",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function OverviewTab() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 260px",
        gridTemplateRows: "auto auto",
        gap: 16,
        padding: 16,
        flex: 1,
        overflow: "auto",
      }}
    >
      {/* Left column */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Suspense fallback={<Spinner />}>
          <PortfolioOverview />
        </Suspense>
        <Suspense fallback={<Spinner />}>
          <StrategiesTable />
        </Suspense>
      </div>

      {/* Right column */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <SignalBoard />
        <RiskGatesPanel />
      </div>
    </div>
  );
}

function TabContent() {
  const activeTab = useTradingStore((s) => s.activeTab);

  switch (activeTab) {
    case "overview":
      return <OverviewTab />;
    case "strategies":
      return (
        <div style={{ padding: 16, flex: 1, overflow: "auto" }}>
          <Suspense fallback={<Spinner />}>
            <StrategiesTable />
          </Suspense>
        </div>
      );
    case "risk":
      return (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 260px",
            gap: 16,
            padding: 16,
            flex: 1,
            overflow: "auto",
          }}
        >
          <Suspense fallback={<Spinner />}>
            <RiskDashboard />
          </Suspense>
          <RiskGatesPanel />
        </div>
      );
    case "portfolio":
      return (
        <div style={{ padding: 16, flex: 1, overflow: "auto" }}>
          <Suspense fallback={<Spinner />}>
            <PortfolioOverview />
          </Suspense>
        </div>
      );
    default:
      return <OverviewTab />;
  }
}

// ---- Root Dashboard -------------------------------------------------------

export default function Dashboard() {
  // Mount WS sync once at the root
  useWsSync();

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#020817",
        color: "#e2e8f0",
        fontFamily:
          'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        overflow: "hidden",
      }}
    >
      <EngineStatusBar />
      <TabBar />
      <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
        <TabContent />
      </div>
    </div>
  );
}
