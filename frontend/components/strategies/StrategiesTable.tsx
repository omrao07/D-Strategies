import React, { useState, useMemo, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { useTradingStore } from "@/store/useTradingStore";

export type Strategy = {
  id: string;
  name: string;
  family: string;
  region: string;
  type: string;
  risk: string;
  pnlYTD?: number;
};

const COLS: { key: keyof Strategy; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "family", label: "Family" },
  { key: "region", label: "Region" },
  { key: "type", label: "Type" },
  { key: "risk", label: "Risk" },
  { key: "pnlYTD", label: "PnL YTD" },
];

export function StrategiesTable() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<keyof Strategy>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const signals = useTradingStore((s) => s.signals);

  useEffect(() => {
    apiFetch<{ strategies: Strategy[] }>("/api/strategies")
      .then((r) => setStrategies(r.strategies ?? []))
      .catch(() => {});
  }, []);

  const enriched = useMemo(
    () =>
      strategies.map((s) => ({
        ...s,
        pnlYTD: signals[s.name]?.score != null ? signals[s.name].score * 100 : s.pnlYTD,
      })),
    [strategies, signals]
  );

  const filtered = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return enriched;
    return enriched.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.family.toLowerCase().includes(q) ||
        s.region.toLowerCase().includes(q)
    );
  }, [enriched, filter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number")
        return sortAsc ? av - bv : bv - av;
      return sortAsc
        ? String(av ?? "").localeCompare(String(bv ?? ""))
        : String(bv ?? "").localeCompare(String(av ?? ""));
    });
    return arr;
  }, [filtered, sortKey, sortAsc]);

  const th: React.CSSProperties = {
    padding: "8px 10px",
    textAlign: "left",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "#64748b",
    cursor: "pointer",
    userSelect: "none",
    borderBottom: "1px solid #1e293b",
  };
  const td: React.CSSProperties = {
    padding: "7px 10px",
    fontSize: 12,
    color: "#cbd5e1",
    borderBottom: "1px solid #0f172a",
  };

  return (
    <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid #1e293b" }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: "#e2e8f0" }}>
          Strategies ({sorted.length})
        </span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search…"
          style={{
            background: "#1e293b",
            border: "1px solid #334155",
            borderRadius: 6,
            padding: "5px 10px",
            fontSize: 12,
            color: "#e2e8f0",
            outline: "none",
            width: 180,
          }}
        />
      </div>
      <div style={{ overflowX: "auto", maxHeight: 400, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {COLS.map((col) => (
                <th
                  key={col.key as string}
                  style={th}
                  onClick={() => {
                    if (sortKey === col.key) setSortAsc((s) => !s);
                    else { setSortKey(col.key); setSortAsc(true); }
                  }}
                >
                  {col.label}{sortKey === col.key ? (sortAsc ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={COLS.length} style={{ ...td, textAlign: "center", color: "#475569", padding: "24px" }}>
                  {strategies.length === 0 ? "Loading…" : "No strategies found"}
                </td>
              </tr>
            ) : (
              sorted.map((s) => {
                const pnlColor = (s.pnlYTD ?? 0) > 0 ? "#10b981" : (s.pnlYTD ?? 0) < 0 ? "#ef4444" : "#94a3b8";
                return (
                  <tr key={s.id}>
                    <td style={{ ...td, fontWeight: 600, color: "#e2e8f0" }}>{s.name.replace(/_/g, " ")}</td>
                    <td style={td}>{s.family}</td>
                    <td style={td}>{s.region}</td>
                    <td style={td}>{s.type}</td>
                    <td style={td}>{s.risk}</td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: pnlColor }}>
                      {s.pnlYTD != null ? `${s.pnlYTD >= 0 ? "+" : ""}${s.pnlYTD.toFixed(1)}%` : "–"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default StrategiesTable;
