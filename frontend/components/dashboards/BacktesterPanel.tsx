// frontend/components/dashboards/BacktesterPanel.tsx
// UI for running vectorized backtests and viewing results.

"use client";
import React, { useState, useCallback } from "react";
import { apiFetch } from "../../lib/api";

interface BacktestConfig {
  universe: string;
  strategy: string;
  startDate: string;
  endDate: string;
  capital: number;
  feeBps: number;
  slippageBps: number;
}

interface BacktestResult {
  sharpe: number;
  max_drawdown: number;
  calmar: number;
  total_return: number;
  win_rate: number;
  n_trades: number;
}

const DEFAULT_CONFIG: BacktestConfig = {
  universe: "NIFTY50",
  strategy: "",
  startDate: "2022-01-01",
  endDate: "2024-12-31",
  capital: 1_000_000,
  feeBps: 5,
  slippageBps: 5,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "#64748b",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "#020817",
  border: "1px solid #1e293b",
  borderRadius: 4,
  padding: "6px 10px",
  fontSize: 13,
  color: "#e2e8f0",
  width: "100%",
  boxSizing: "border-box",
};

function MetricBox({
  label,
  value,
  good,
}: {
  label: string;
  value: string;
  good?: boolean;
}) {
  return (
    <div
      style={{
        background: "#0f172a",
        border: "1px solid #1e293b",
        borderRadius: 6,
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ fontSize: 11, color: "#475569", textTransform: "uppercase" }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: good === undefined ? "#e2e8f0" : good ? "#4ade80" : "#f87171",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function BacktesterPanel() {
  const [config, setConfig] = useState<BacktestConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const update = useCallback(
    <K extends keyof BacktestConfig>(key: K, val: BacktestConfig[K]) =>
      setConfig((c) => ({ ...c, [key]: val })),
    []
  );

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await apiFetch<{ summary?: unknown }>("/api/backtest/run", {
        method: "POST",
        body: JSON.stringify(config),
      });
      setResult((data.summary ?? data) as BacktestResult);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [config]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Config form */}
      <div
        style={{
          background: "#0f172a",
          border: "1px solid #1e293b",
          borderRadius: 8,
          padding: 20,
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: "#94a3b8",
            marginBottom: 16,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          Backtest Configuration
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 16,
          }}
        >
          <Field label="Universe">
            <select
              value={config.universe}
              onChange={(e) => update("universe", e.target.value)}
              style={inputStyle}
            >
              <option value="NIFTY50">NIFTY 50</option>
              <option value="NIFTY100">NIFTY 100</option>
              <option value="NIFTYBANK">NIFTY Bank</option>
              <option value="MIDCAP150">MIDCAP 150</option>
              <option value="custom">Custom</option>
            </select>
          </Field>

          <Field label="Strategy">
            <input
              type="text"
              placeholder="e.g. MomentumAlpha"
              value={config.strategy}
              onChange={(e) => update("strategy", e.target.value)}
              style={inputStyle}
            />
          </Field>

          <Field label="Capital (₹)">
            <input
              type="number"
              value={config.capital}
              onChange={(e) => update("capital", Number(e.target.value))}
              style={inputStyle}
              min={100000}
              step={100000}
            />
          </Field>

          <Field label="Start Date">
            <input
              type="date"
              value={config.startDate}
              onChange={(e) => update("startDate", e.target.value)}
              style={inputStyle}
            />
          </Field>

          <Field label="End Date">
            <input
              type="date"
              value={config.endDate}
              onChange={(e) => update("endDate", e.target.value)}
              style={inputStyle}
            />
          </Field>

          <Field label="Fee (bps)">
            <input
              type="number"
              value={config.feeBps}
              onChange={(e) => update("feeBps", Number(e.target.value))}
              style={inputStyle}
              min={0}
              max={50}
            />
          </Field>
        </div>

        <div style={{ marginTop: 16, display: "flex", gap: 12 }}>
          <button
            onClick={run}
            disabled={loading}
            style={{
              padding: "8px 24px",
              borderRadius: 6,
              background: loading ? "#1e293b" : "#6366f1",
              color: loading ? "#475569" : "#fff",
              fontWeight: 700,
              fontSize: 13,
              border: "none",
              cursor: loading ? "not-allowed" : "pointer",
              transition: "background 0.15s",
            }}
          >
            {loading ? "Running…" : "Run Backtest"}
          </button>

          {error && (
            <span style={{ fontSize: 12, color: "#f87171", lineHeight: "32px" }}>
              {error}
            </span>
          )}
        </div>
      </div>

      {/* Results */}
      {result && (
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "#475569",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: 12,
            }}
          >
            Results
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 12,
            }}
          >
            <MetricBox
              label="Sharpe"
              value={result.sharpe.toFixed(2)}
              good={result.sharpe >= 1.0}
            />
            <MetricBox
              label="Total Return"
              value={`${(result.total_return * 100).toFixed(1)}%`}
              good={result.total_return > 0}
            />
            <MetricBox
              label="Max Drawdown"
              value={`${(result.max_drawdown * 100).toFixed(1)}%`}
              good={Math.abs(result.max_drawdown) < 0.2}
            />
            <MetricBox
              label="Calmar"
              value={result.calmar.toFixed(2)}
              good={result.calmar >= 0.5}
            />
            <MetricBox
              label="Win Rate"
              value={`${(result.win_rate * 100).toFixed(1)}%`}
              good={result.win_rate >= 0.5}
            />
            <MetricBox
              label="Trades"
              value={String(result.n_trades)}
            />
          </div>
        </div>
      )}

    </div>
  );
}

export default BacktesterPanel;
