import React, { useMemo } from "react";
import {
  useTradingStore,
  selectGrossExposure,
  selectNetExposure,
  selectTotalUnrealizedPnL,
} from "@/store/useTradingStore";

const fmtPct = (x?: number, d = 2) =>
  Number.isFinite(x as number) ? `${((x as number) * 100).toFixed(d)}%` : "–";
const fmtNum = (x?: number, d = 0) =>
  Number.isFinite(x as number)
    ? (x as number).toLocaleString(undefined, { maximumFractionDigits: d })
    : "–";

function hashColor(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360} 65% 55%)`;
}

function KPICard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{
      background: "#0f172a",
      border: "1px solid #1e293b",
      borderRadius: 8,
      padding: "10px 14px",
    }}>
      <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color ?? "#e2e8f0", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
    </div>
  );
}

function SparkLine({ data }: { data: { date: string; value: number }[] }) {
  const w = 600; const h = 100;
  if (!data.length) return (
    <div style={{ height: h, display: "flex", alignItems: "center", justifyContent: "center", color: "#475569", fontSize: 12 }}>
      No performance data
    </div>
  );
  const vals = data.map((d) => d.value);
  const tMin = 0; const tMax = data.length - 1;
  const yMin = Math.min(...vals); const yMax = Math.max(...vals);
  const yRange = yMax - yMin || 1;
  const px = (i: number) => (i / Math.max(1, tMax)) * (w - 40) + 20;
  const py = (v: number) => h - 16 - ((v - yMin) / yRange) * (h - 30);
  const d = data.map((p, i) => `${i === 0 ? "M" : "L"} ${px(i)} ${py(p.value)}`).join(" ");
  const last = vals[vals.length - 1];
  const lineColor = last >= 0 ? "#10b981" : "#ef4444";
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ overflow: "visible" }}>
      <line x1={20} x2={w - 20} y1={h - 16} y2={h - 16} stroke="#1e293b" />
      {yMin < 0 && yMax > 0 && (
        <line x1={20} x2={w - 20} y1={py(0)} y2={py(0)} stroke="#334155" strokeDasharray="4 4" />
      )}
      <path
        d={`${d} L ${px(tMax)} ${h - 16} L ${px(0)} ${h - 16} Z`}
        fill={lineColor}
        fillOpacity={0.12}
      />
      <path d={d} stroke={lineColor} fill="none" strokeWidth={1.8} />
    </svg>
  );
}

export function PortfolioOverview() {
  const positions = useTradingStore((s) => s.positions);
  const pnlHistory = useTradingStore((s) => s.pnlHistory);
  const engine = useTradingStore((s) => s.engine);
  const grossExposure = useTradingStore(selectGrossExposure);
  const netExposure = useTradingStore(selectNetExposure);
  const unrealizedPnL = useTradingStore(selectTotalUnrealizedPnL);

  const posList = Object.values(positions);

  const sectorAlloc = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of posList) {
      const key = p.strategy || "Other";
      map[key] = (map[key] ?? 0) + Math.abs(p.notional);
    }
    const total = Object.values(map).reduce((a, b) => a + b, 0) || 1;
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([bucket, val]) => ({ bucket, weight: val / total }));
  }, [posList]);

  const perfData = pnlHistory.map((p) => ({ date: p.date, value: p.cumulativeNet }));

  const pnlColor = engine.dailyPnl > 0 ? "#10b981" : engine.dailyPnl < 0 ? "#ef4444" : "#94a3b8";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>Portfolio Overview</span>
        <span style={{ fontSize: 11, color: "#64748b" }}>
          {posList.length} open positions
        </span>
      </div>

      {/* KPI grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <KPICard
          label="Daily P&L"
          value={`${engine.dailyPnl >= 0 ? "+" : ""}$${fmtNum(Math.abs(engine.dailyPnl))}`}
          color={pnlColor}
        />
        <KPICard
          label="Unrealized"
          value={`${unrealizedPnL >= 0 ? "+" : ""}$${fmtNum(Math.abs(unrealizedPnL))}`}
          color={unrealizedPnL >= 0 ? "#10b981" : "#ef4444"}
        />
        <KPICard
          label="Drawdown"
          value={fmtPct(engine.drawdown)}
          color={engine.drawdown < -0.05 ? "#ef4444" : "#94a3b8"}
        />
        <KPICard label="Gross Exposure" value={`$${fmtNum(grossExposure)}`} />
        <KPICard
          label="Net Exposure"
          value={`${netExposure >= 0 ? "+" : ""}$${fmtNum(Math.abs(netExposure))}`}
          color={netExposure >= 0 ? "#10b981" : "#ef4444"}
        />
        <KPICard
          label="Strategies"
          value={String(engine.nStrategies)}
          color="#818cf8"
        />
      </div>

      {/* Performance chart */}
      <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, padding: "12px 16px" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8", marginBottom: 8, display: "block" }}>
          Cumulative P&L
        </span>
        <SparkLine data={perfData} />
      </div>

      {/* Allocations */}
      {sectorAlloc.length > 0 && (
        <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, padding: "12px 16px" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8", marginBottom: 10, display: "block" }}>
            Strategy Allocation
          </span>
          {/* Stacked bar */}
          <div style={{ display: "flex", height: 20, borderRadius: 6, overflow: "hidden", marginBottom: 10 }}>
            {sectorAlloc.map((a) => (
              <div
                key={a.bucket}
                title={`${a.bucket}: ${fmtPct(a.weight)}`}
                style={{ width: `${a.weight * 100}%`, background: hashColor(a.bucket) }}
              />
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {sectorAlloc.map((a) => (
              <div key={a.bucket} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#94a3b8" }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: hashColor(a.bucket), flexShrink: 0 }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.bucket}</span>
                <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>{fmtPct(a.weight)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top positions table */}
      {posList.length > 0 && (
        <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid #1e293b", fontSize: 12, fontWeight: 700, color: "#94a3b8" }}>
            Top Positions
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#020817" }}>
                  {["Symbol", "Strategy", "Qty", "Avg Px", "Notional", "P&L"].map((h) => (
                    <th key={h} style={{ padding: "7px 10px", textAlign: "left", color: "#475569", fontWeight: 600, fontSize: 11 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {posList.slice(0, 8).map((p) => (
                  <tr key={p.symbol} style={{ borderTop: "1px solid #0f172a" }}>
                    <td style={{ padding: "6px 10px", color: "#e2e8f0", fontWeight: 600 }}>{p.symbol}</td>
                    <td style={{ padding: "6px 10px", color: "#94a3b8" }}>{p.strategy}</td>
                    <td style={{ padding: "6px 10px", color: p.qty >= 0 ? "#10b981" : "#ef4444", fontVariantNumeric: "tabular-nums" }}>
                      {p.qty >= 0 ? "+" : ""}{p.qty}
                    </td>
                    <td style={{ padding: "6px 10px", color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>
                      {p.avgPx.toFixed(2)}
                    </td>
                    <td style={{ padding: "6px 10px", color: "#cbd5e1", fontVariantNumeric: "tabular-nums" }}>
                      ${fmtNum(Math.abs(p.notional))}
                    </td>
                    <td style={{ padding: "6px 10px", color: p.pnl >= 0 ? "#10b981" : "#ef4444", fontVariantNumeric: "tabular-nums" }}>
                      {p.pnl >= 0 ? "+" : ""}${fmtNum(Math.abs(p.pnl))}
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

export default PortfolioOverview;
