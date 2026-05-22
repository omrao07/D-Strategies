// frontend/components/layout/AppShell.tsx
// Application shell — left sidebar nav + top bar with engine status.

import React, { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTradingStore } from "@/store/useTradingStore";

// ---- Icon components (inline SVG, zero deps) ----------------------------

function HomeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function FlaskIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 3h6l1 7H8L9 3z" />
      <path d="M8 10L4 20h16L16 10" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9c.64-.28 1-.91 1-1.58V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.28.64.91 1 1.58 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function CollapseIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      style={{ transform: open ? "rotate(0deg)" : "rotate(180deg)", transition: "transform 0.2s" }}
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

// ---- Nav config ---------------------------------------------------------

interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", path: "/", icon: <HomeIcon /> },
  { label: "Strategies", path: "/strategies", icon: <LayersIcon /> },
  { label: "P&L", path: "/pnl", icon: <ChartIcon /> },
  { label: "Risk", path: "/risk", icon: <ShieldIcon /> },
  { label: "Compliance", path: "/compliance", icon: <CheckIcon /> },
  { label: "Backtester", path: "/backtester", icon: <FlaskIcon /> },
  { label: "Terminal", path: "/terminal", icon: <TerminalIcon /> },
  { label: "Settings", path: "/settings", icon: <SettingsIcon /> },
];

// ---- WS Badge -----------------------------------------------------------

function WsBadge({ status }: { status: string }) {
  const isLive = status === "open" || status === "connected";
  const isConnecting = status === "connecting" || status === "reconnecting";
  const color = isLive ? "#4ade80" : isConnecting ? "#f59e0b" : "#ef4444";
  const label = isLive ? "LIVE" : isConnecting ? "CONN…" : "OFFLINE";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
      }}
    >
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: color,
          boxShadow: `0 0 5px ${color}`,
        }}
      />
      <span style={{ fontSize: 10, color, fontWeight: 700 }}>{label}</span>
    </div>
  );
}

// ---- Top Bar ------------------------------------------------------------

function TopBar() {
  const engine = useTradingStore((s) => s.engine);
  const wsStatus = useTradingStore((s) => s.wsStatus);
  const isHalted = useTradingStore((s) => s.isHalted);

  const pnlColor =
    engine.dailyPnl > 0 ? "#4ade80" : engine.dailyPnl < 0 ? "#f87171" : "#94a3b8";

  return (
    <div
      style={{
        height: 44,
        background: "#0f172a",
        borderBottom: `1px solid ${isHalted ? "#ef4444" : "#1e293b"}`,
        display: "flex",
        alignItems: "center",
        gap: 20,
        padding: "0 20px",
        flexShrink: 0,
        zIndex: 10,
      }}
    >
      {/* Engine status dot */}
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: engine.running ? "#4ade80" : "#475569",
            boxShadow: engine.running ? "0 0 6px #4ade80" : "none",
          }}
        />
        <span style={{ fontSize: 12, color: "#94a3b8" }}>
          {engine.nStrategies} strategies running
        </span>
        {isHalted && (
          <span
            style={{
              fontSize: 10,
              background: "#ef444420",
              color: "#ef4444",
              border: "1px solid #ef4444",
              borderRadius: 4,
              padding: "1px 6px",
              fontWeight: 700,
            }}
          >
            HALTED
          </span>
        )}
      </div>

      {/* Daily P&L */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 10, color: "#475569", textTransform: "uppercase" }}>
          Daily P&L
        </span>
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: pnlColor,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {engine.dailyPnl >= 0 ? "+" : ""}
          {engine.dailyPnl.toLocaleString(undefined, {
            maximumFractionDigits: 0,
          })}
        </span>
      </div>

      {/* Drawdown */}
      {engine.drawdown !== 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, color: "#475569", textTransform: "uppercase" }}>
            DD
          </span>
          <span
            style={{
              fontSize: 12,
              color: engine.drawdown < -0.05 ? "#f87171" : "#64748b",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {(engine.drawdown * 100).toFixed(2)}%
          </span>
        </div>
      )}

      {/* WS status */}
      <div style={{ marginLeft: "auto" }}>
        <WsBadge status={wsStatus} />
      </div>
    </div>
  );
}

// ---- Sidebar ------------------------------------------------------------

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const location = useLocation();

  return (
    <aside
      style={{
        width: collapsed ? 52 : 200,
        background: "#0f172a",
        borderRight: "1px solid #1e293b",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        transition: "width 0.2s",
        overflow: "hidden",
      }}
    >
      {/* Brand + collapse */}
      <div
        style={{
          height: 52,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: collapsed ? "0 14px" : "0 16px",
          borderBottom: "1px solid #1e293b",
        }}
      >
        {!collapsed && (
          <span
            style={{
              fontSize: 15,
              fontWeight: 800,
              color: "#e2e8f0",
              flex: 1,
              overflow: "hidden",
              whiteSpace: "nowrap",
            }}
          >
            D-Strategies
          </span>
        )}
        <button
          onClick={onToggle}
          style={{
            background: "none",
            border: "none",
            color: "#64748b",
            cursor: "pointer",
            padding: 4,
            borderRadius: 4,
            display: "flex",
            alignItems: "center",
            marginLeft: collapsed ? 0 : "auto",
          }}
          aria-label="Toggle sidebar"
        >
          <CollapseIcon open={!collapsed} />
        </button>
      </div>

      {/* Nav links */}
      <nav
        style={{
          flex: 1,
          padding: "8px 6px",
          display: "flex",
          flexDirection: "column",
          gap: 2,
          overflowY: "auto",
        }}
      >
        {NAV_ITEMS.map((item) => {
          const isActive =
            item.path === "/"
              ? location.pathname === "/"
              : location.pathname.startsWith(item.path);

          return (
            <Link
              key={item.path}
              to={item.path}
              style={{
                display: "flex",
                alignItems: "center",
                gap: collapsed ? 0 : 10,
                justifyContent: collapsed ? "center" : "flex-start",
                padding: collapsed ? "10px 0" : "9px 12px",
                borderRadius: 6,
                textDecoration: "none",
                background: isActive ? "#6366f115" : "transparent",
                border: `1px solid ${isActive ? "#6366f1" : "transparent"}`,
                color: isActive ? "#818cf8" : "#64748b",
                fontWeight: isActive ? 600 : 400,
                fontSize: 13,
                transition: "background 0.1s, color 0.1s",
              }}
              title={collapsed ? item.label : undefined}
            >
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  color: isActive ? "#818cf8" : "#64748b",
                  flexShrink: 0,
                }}
              >
                {item.icon}
              </span>
              {!collapsed && (
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {item.label}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

// ---- AppShell -----------------------------------------------------------

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        background: "#020817",
        color: "#e2e8f0",
        fontFamily:
          'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        overflow: "hidden",
      }}
    >
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          minWidth: 0,
        }}
      >
        <TopBar />
        <main
          style={{
            flex: 1,
            overflow: "auto",
          }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

export default AppShell;
