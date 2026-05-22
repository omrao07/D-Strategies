// frontend/pages/backtester.tsx
// Backtesting page — wraps BacktesterPanel and shows recent results table.

import React, { Suspense, lazy, useState } from "react";

const BacktesterPanel = lazy(() =>
  import("../components/dashboards/BacktesterPanel").then((m) => ({
    default: m.BacktesterPanel ?? m.default,
  }))
);

// ---- Types ---------------------------------------------------------------

interface BacktestRun {
  id: string;
  strategy: string;
  universe: string;
  startDate: string;
  endDate: string;
  sharpe: number;
  totalReturn: number;
  maxDrawdown: number;
  calmar: number;
  winRate: number;
  nTrades: number;
  ranAt: Date;
}

// ---- Helpers -------------------------------------------------------------

function fmt(v: number, decimals = 2): string {
  return v.toFixed(decimals);
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function scoreColor(v: number, good: boolean): string {
  return good ? (v >= 0 ? "#4ade80" : "#f87171") : v < 0 ? "#f87171" : "#4ade80";
}

function Spinner() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: 200,
        color: "#475569",
        fontSize: 13,
      }}
    >
      Loading backtester…
    </div>
  );
}

// ---- Demo recent results (seeded) ----------------------------------------

const DEMO_RESULTS: BacktestRun[] = [
  {
    id: "1",
    strategy: "MomentumAlpha",
    universe: "NIFTY50",
    startDate: "2022-01-01",
    endDate: "2023-12-31",
    sharpe: 1.82,
    totalReturn: 0.312,
    maxDrawdown: -0.143,
    calmar: 1.29,
    winRate: 0.54,
    nTrades: 412,
    ranAt: new Date(Date.now() - 3_600_000),
  },
  {
    id: "2",
    strategy: "BundBTPSpread",
    universe: "NIFTY100",
    startDate: "2021-01-01",
    endDate: "2024-06-30",
    sharpe: 2.14,
    totalReturn: 0.578,
    maxDrawdown: -0.089,
    calmar: 2.71,
    winRate: 0.61,
    nTrades: 287,
    ranAt: new Date(Date.now() - 7_200_000),
  },
  {
    id: "3",
    strategy: "BettingAgainstBeta",
    universe: "NIFTYBANK",
    startDate: "2022-06-01",
    endDate: "2024-12-31",
    sharpe: 0.94,
    totalReturn: 0.182,
    maxDrawdown: -0.228,
    calmar: 0.42,
    winRate: 0.48,
    nTrades: 631,
    ranAt: new Date(Date.now() - 86_400_000),
  },
];

// ---- Main Page -----------------------------------------------------------

export default function BacktesterPage() {
  const [results, setResults] = useState<BacktestRun[]>(DEMO_RESULTS);

  // Expose a callback so BacktesterPanel can push results into the table
  // (panel doesn't accept callbacks currently, so we just seed demo data)
  void setResults;

  return (
    <div
      style={{
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 24,
        color: "#e2e8f0",
      }}
    >
      {/* Page header */}
      <div>
        <h1
          style={{
            fontSize: 20,
            fontWeight: 800,
            margin: 0,
            color: "#f8fafc",
          }}
        >
          Backtester
        </h1>
        <p
          style={{
            fontSize: 13,
            color: "#64748b",
            margin: "6px 0 0",
            maxWidth: 600,
          }}
        >
          Run vectorized backtests across the 323-strategy universe. Configure
          universe, date range, capital, fees, and slippage — then analyse
          Sharpe, drawdown, win-rate, and Calmar metrics.
        </p>
      </div>

      {/* Backtester panel */}
      <Suspense fallback={<Spinner />}>
        <BacktesterPanel />
      </Suspense>

      {/* Recent results */}
      {results.length > 0 && (
        <div>
          <h2
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "#475569",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 12,
            }}
          >
            Recent Runs
          </h2>

          <div
            style={{
              background: "#0f172a",
              border: "1px solid #1e293b",
              borderRadius: 8,
              overflow: "hidden",
              overflowX: "auto",
            }}
          >
            <table
              style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: "1px solid #1e293b",
                    background: "#020817",
                  }}
                >
                  {[
                    "Strategy",
                    "Universe",
                    "Period",
                    "Sharpe",
                    "Return",
                    "Max DD",
                    "Calmar",
                    "Win %",
                    "Trades",
                    "Run At",
                  ].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "10px 14px",
                        textAlign: "left",
                        fontSize: 11,
                        fontWeight: 700,
                        color: "#475569",
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr
                    key={r.id}
                    style={{
                      borderBottom: "1px solid #1e293b",
                      background: "#0f172a",
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) =>
                      ((e.currentTarget as HTMLElement).style.background =
                        "#1e293b")
                    }
                    onMouseLeave={(e) =>
                      ((e.currentTarget as HTMLElement).style.background =
                        "#0f172a")
                    }
                  >
                    <td
                      style={{
                        padding: "10px 14px",
                        fontSize: 13,
                        fontWeight: 600,
                        color: "#e2e8f0",
                        fontFamily: "'Fira Code', monospace",
                      }}
                    >
                      {r.strategy}
                    </td>
                    <td
                      style={{
                        padding: "10px 14px",
                        fontSize: 12,
                        color: "#64748b",
                      }}
                    >
                      {r.universe}
                    </td>
                    <td
                      style={{
                        padding: "10px 14px",
                        fontSize: 11,
                        color: "#475569",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.startDate} — {r.endDate}
                    </td>
                    <td
                      style={{
                        padding: "10px 14px",
                        fontSize: 13,
                        fontWeight: 700,
                        color: scoreColor(r.sharpe - 1, true),
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {fmt(r.sharpe)}
                    </td>
                    <td
                      style={{
                        padding: "10px 14px",
                        fontSize: 13,
                        fontWeight: 700,
                        color: scoreColor(r.totalReturn, true),
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {fmtPct(r.totalReturn)}
                    </td>
                    <td
                      style={{
                        padding: "10px 14px",
                        fontSize: 13,
                        fontWeight: 700,
                        color: scoreColor(r.maxDrawdown, false),
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {fmtPct(r.maxDrawdown)}
                    </td>
                    <td
                      style={{
                        padding: "10px 14px",
                        fontSize: 13,
                        fontWeight: 700,
                        color: scoreColor(r.calmar - 0.5, true),
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {fmt(r.calmar)}
                    </td>
                    <td
                      style={{
                        padding: "10px 14px",
                        fontSize: 13,
                        fontWeight: 700,
                        color: scoreColor(r.winRate - 0.5, true),
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {fmtPct(r.winRate)}
                    </td>
                    <td
                      style={{
                        padding: "10px 14px",
                        fontSize: 13,
                        color: "#94a3b8",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {r.nTrades}
                    </td>
                    <td
                      style={{
                        padding: "10px 14px",
                        fontSize: 11,
                        color: "#475569",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.ranAt.toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
