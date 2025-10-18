// components/optionschain.tsx
// React TSX, zero-dependency Options Chain table with sorting, quick filters,
// strike ladder layout (Calls | Strike | Puts), ATM highlight, IV bars, and greeks.
// Works with any underlying (FX/Index/Equity). No external CSS required.

import React, { useMemo, useState } from "react";

/* ---------------------------------- Types --------------------------------- */

export type Side = "C" | "P";

export interface Quote {
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  iv?: number | null;         // in percent (e.g., 12.3 for 12.3%)
  delta?: number | null;      // signed (calls +, puts -)
  gamma?: number | null;
  vega?: number | null;       // per 1 vol point or 0.01, up to user
  theta?: number | null;      // per day (negative usually)
  oi?: number | null;         // open interest
  vol?: number | null;        // volume
}

export interface ChainRow {
  strike: number;
  call: Quote;
  put: Quote;
}

export interface OptionsChainProps {
  rows: ChainRow[];                       // must be a full strike ladder (unsorted ok)
  spot?: number;                          // current underlying spot for ATM highlighting
  expiry?: string | Date;                 // optional display
  currency?: string;                      // e.g. "$" or "₹"
  showGreeks?: boolean;                   // initial toggle state for greek columns
  showIV?: boolean;                       // initial toggle for IV column
  strikesAroundATM?: number | "all";      // initial filter (# strikes either side of ATM)
  minOI?: number;                         // filter out rows where both sides OI < minOI
  loading?: boolean;
  error?: string;
  onRowClick?: (r: ChainRow) => void;
  className?: string;
  style?: React.CSSProperties;
}

/* -------------------------------- Component -------------------------------- */

export default function OptionsChain({
  rows,
  spot,
  expiry,
  currency = "",
  showGreeks = true,
  showIV = true,
  strikesAroundATM = 12,
  minOI = 0,
  loading,
  error,
  onRowClick,
  className,
  style,
}: OptionsChainProps) {
  // --- state ---
  const [q, setQ] = useState(""); // search by strike exact/contains
  const [onlyTradable, setOnlyTradable] = useState(false); // require both bid/ask present on at least one side
  const [showG, setShowG] = useState(showGreeks);
  const [showV, setShowV] = useState(showIV);
  const [strikeWindow, setStrikeWindow] = useState<number | "all">(strikesAroundATM);
  const [minOi, setMinOi] = useState<number>(minOI);
  const [sort, setSort] = useState<SortKey>({ col: "strike", dir: 1 });

  // --- prep ---
  const sorted = useMemo(() => {
    const arr = [...rows].sort((a, b) => a.strike - b.strike);
    return arr;
  }, [rows]);

  const atmIndex = useMemo(() => {
    if (!isFiniteNum(spot) || sorted.length === 0) return -1;
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < sorted.length; i++) {
      const d = Math.abs(sorted[i].strike - (spot as number));
      if (d < bestDiff) { best = i; bestDiff = d; }
    }
    return best;
  }, [sorted, spot]);

  const filtered = useMemo(() => {
    let out = sorted;

    // strike window around ATM
    if (strikeWindow !== "all" && atmIndex >= 0) {
      const half = Math.max(0, strikeWindow);
      const lo = Math.max(0, atmIndex - half);
      const hi = Math.min(sorted.length - 1, atmIndex + half);
      out = out.slice(lo, hi + 1);
    }

    // min OI filter
    if (minOi > 0) {
      out = out.filter(r => (r.call.oi ?? 0) >= minOi || (r.put.oi ?? 0) >= minOi);
    }

    // "tradable" filter: at least one side has both bid and ask
    if (onlyTradable) {
      out = out.filter(r =>
        (isFiniteNum(r.call.bid) && isFiniteNum(r.call.ask)) ||
        (isFiniteNum(r.put.bid) && isFiniteNum(r.put.ask))
      );
    }

    // search by strike (string contains or exact number)
    if (q.trim()) {
      const qs = q.trim().toLowerCase();
      out = out.filter(r => String(r.strike).toLowerCase().includes(qs));
    }

    // sort
    const dir = sort.dir;
    const col = sort.col;
    const get = getter(col);
    out = [...out].sort((a, b) => {
      const av = get(a), bv = get(b);
      const aU = av == null, bU = bv == null;
      if (aU && bU) return 0;
      if (aU) return 1;
      if (bU) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return out;
  }, [sorted, strikeWindow, atmIndex, minOi, onlyTradable, q, sort]);

  // domain for IV bars
  const ivAll = useMemo(() => {
    const v: number[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      if (isFiniteNum(r.call.iv)) v.push(r.call.iv as number);
      if (isFiniteNum(r.put.iv)) v.push(r.put.iv as number);
    }
    if (!v.length) return { min: 0, max: 1 };
    return { min: Math.min(...v), max: Math.max(...v) };
  }, [sorted]);

  return (
    <div className={className} style={{ ...container, ...style }}>
      {/* Toolbar */}
      <div style={toolbar}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Options Chain</h2>
          {expiry && (
            <span style={{ fontSize: 12, color: "var(--text-muted,#6b7280)" }}>
              Expiry: {fmtDate(expiry)}
            </span>
          )}
          {isFiniteNum(spot) && (
            <span style={{ fontSize: 12, color: "var(--text-muted,#6b7280)" }}>
              Spot: {fmtNum(spot, currency)}
            </span>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Field label="Search">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Strike…"
              style={input}
            />
          </Field>
          <Field label="Window">
            <select
              value={strikeWindow as any}
              onChange={(e) => setStrikeWindow(e.target.value === "all" ? "all" : +e.target.value)}
              style={select}
              title="Strikes around ATM"
            >
              <option value="all">All</option>
              <option value={6}>±6</option>
              <option value={10}>±10</option>
              <option value={12}>±12</option>
              <option value={16}>±16</option>
              <option value={20}>±20</option>
            </select>
          </Field>
          <Field label="Min OI">
            <input
              value={String(minOi)}
              onChange={(e) => setMinOi(Math.max(0, Number(e.target.value) || 0))}
              type="number"
              min={0}
              step={1}
              style={{ ...input, width: 90 }}
            />
          </Field>
          <label style={checkLabel}>
            <input type="checkbox" checked={onlyTradable} onChange={(e) => setOnlyTradable(e.target.checked)} />
            Tradable
          </label>
          <label style={checkLabel}>
            <input type="checkbox" checked={showV} onChange={(e) => setShowV(e.target.checked)} />
            IV
          </label>
          <label style={checkLabel}>
            <input type="checkbox" checked={showG} onChange={(e) => setShowG(e.target.checked)} />
            Greeks
          </label>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div role="alert" style={errorBox}>
          {error}
        </div>
      )}

      {/* Table */}
      <div style={tableWrap}>
        <table style={table}>
          <thead>
            <tr>
              {/* Calls */}
              {th("C Bid", "cBid", true)}
              {th("C Ask", "cAsk", true)}
              {th("C Last", "cLast", true)}
              {showV && th("C IV", "cIV", true)}
              {showG && th("Δ", "cDelta", true)}
              {showG && th("Γ", "cGamma", true)}
              {showG && th("V", "cVega", true)}
              {showG && th("Θ", "cTheta", true)}
              {th("C OI", "cOI", true)}
              {th("C Vol", "cVol", true)}

              {/* Strike middle */}
              {th("Strike", "strike", true)}

              {/* Puts */}
              {th("P Bid", "pBid", true)}
              {th("P Ask", "pAsk", true)}
              {th("P Last", "pLast", true)}
              {showV && th("P IV", "pIV", true)}
              {showG && th("Δ", "pDelta", true)}
              {showG && th("Γ", "pGamma", true)}
              {showG && th("V", "pVega", true)}
              {showG && th("Θ", "pTheta", true)}
              {th("P OI", "pOI", true)}
              {th("P Vol", "pVol", true)}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 10 }).map((_, i) => (
                  <tr key={`sk-${i}`}>
                    <td colSpan={showV && showG ? 21 : showV ? 17 : showG ? 19 : 15} style={{ padding: 8 }}>
                      <Skeleton height={16} />
                    </td>
                  </tr>
                ))
              : filtered.map((r, i) => {
                  const isAtm = atmIndex >= 0 && sorted[atmIndex]?.strike === r.strike;
                  const rowStyle: React.CSSProperties = isAtm
                    ? { background: "var(--brand-50,#eef2ff)" }
                    : {};
                  return (
                    <tr
                      key={`row-${r.strike}-${i}`}
                      onClick={() => onRowClick?.(r)}
                      style={{ ...rowBase, ...rowStyle, cursor: onRowClick ? "pointer" : "default" }}
                    >
                      {/* Calls */}
                      <td style={tdRight}>{fmtNum(r.call.bid, currency)}</td>
                      <td style={tdRight}>{fmtNum(r.call.ask, currency)}</td>
                      <td style={tdRight}>{fmtNum(r.call.last, currency)}</td>
                      {showV && (
                        <td style={tdRight}>
                          {ivCell(r.call.iv, ivAll)}
                        </td>
                      )}
                      {showG && <td style={tdRight} title="Delta">{fmtGreek(r.call.delta)}</td>}
                      {showG && <td style={tdRight} title="Gamma">{fmtGreek(r.call.gamma)}</td>}
                      {showG && <td style={tdRight} title="Vega">{fmtGreek(r.call.vega)}</td>}
                      {showG && <td style={tdRight} title="Theta">{fmtGreek(r.call.theta)}</td>}
                      <td style={tdRightMuted}>{fmtInt(r.call.oi)}</td>
                      <td style={tdRightMuted}>{fmtInt(r.call.vol)}</td>

                      {/* Strike */}
                      <td style={{ ...tdStrike, color: isAtm ? "var(--primary,#6366f1)" : "inherit", fontWeight: isAtm ? 700 : 500 }}>
                        {fmtNum(r.strike, currency)}
                      </td>

                      {/* Puts */}
                      <td style={tdRight}>{fmtNum(r.put.bid, currency)}</td>
                      <td style={tdRight}>{fmtNum(r.put.ask, currency)}</td>
                      <td style={tdRight}>{fmtNum(r.put.last, currency)}</td>
                      {showV && (
                        <td style={tdRight}>
                          {ivCell(r.put.iv, ivAll)}
                        </td>
                      )}
                      {showG && <td style={tdRight} title="Delta">{fmtGreek(r.put.delta)}</td>}
                      {showG && <td style={tdRight} title="Gamma">{fmtGreek(r.put.gamma)}</td>}
                      {showG && <td style={tdRight} title="Vega">{fmtGreek(r.put.vega)}</td>}
                      {showG && <td style={tdRight} title="Theta">{fmtGreek(r.put.theta)}</td>}
                      <td style={tdRightMuted}>{fmtInt(r.put.oi)}</td>
                      <td style={tdRightMuted}>{fmtInt(r.put.vol)}</td>
                    </tr>
                  );
                })}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={showV && showG ? 21 : showV ? 17 : showG ? 19 : 15} style={{ padding: 16 }}>
                  <EmptyState title="No contracts match" description="Adjust filters or widen the strike window." />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  /* ------------------------ header cell with sorting ------------------------ */

  function th(label: string, col: SortCol, numeric = false) {
    const active = sort.col === col;
    const dirArrow = active ? (sort.dir === 1 ? "▲" : "▼") : "";
    return (
      <th
        onClick={() =>
          setSort((s) => ({
            col,
            dir: s.col === col ? (s.dir === 1 ? -1 : 1) : (numeric ? -1 : 1),
          }))
        }
        style={{
          ...thBase,
          textAlign: numeric ? "right" : "left",
        }}
        title="Sort"
      >
        {label} <span style={{ opacity: 0.5 }}>{dirArrow}</span>
      </th>
    );
  }
}

/* --------------------------------- Sorting -------------------------------- */

type SortCol =
  | "strike"
  | "cBid" | "cAsk" | "cLast" | "cIV" | "cDelta" | "cGamma" | "cVega" | "cTheta" | "cOI" | "cVol"
  | "pBid" | "pAsk" | "pLast" | "pIV" | "pDelta" | "pGamma" | "pVega" | "pTheta" | "pOI" | "pVol";

type SortKey = { col: SortCol; dir: 1 | -1 };

function getter(col: SortCol): (r: ChainRow) => any {
  switch (col) {
    case "strike": return r => r.strike;
    case "cBid": return r => r.call.bid;
    case "cAsk": return r => r.call.ask;
    case "cLast": return r => r.call.last;
    case "cIV": return r => r.call.iv;
    case "cDelta": return r => r.call.delta;
    case "cGamma": return r => r.call.gamma;
    case "cVega": return r => r.call.vega;
    case "cTheta": return r => r.call.theta;
    case "cOI": return r => r.call.oi;
    case "cVol": return r => r.call.vol;
    case "pBid": return r => r.put.bid;
    case "pAsk": return r => r.put.ask;
    case "pLast": return r => r.put.last;
    case "pIV": return r => r.put.iv;
    case "pDelta": return r => r.put.delta;
    case "pGamma": return r => r.put.gamma;
    case "pVega": return r => r.put.vega;
    case "pTheta": return r => r.put.theta;
    case "pOI": return r => r.put.oi;
    case "pVol": return r => r.put.vol;
  }
}

/* -------------------------------- Primitives ------------------------------- */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--text-muted,#6b7280)" }}>{label}</span>
      {children}
    </label>
  );
}

function Skeleton({ height = 14 }: { height?: number }) {
  return (
    <div
      style={{
        width: "100%",
        height,
        borderRadius: 8,
        background:
          "linear-gradient(90deg, var(--gray-200,#e5e7eb) 0%, var(--gray-100,#f3f4f6) 50%, var(--gray-200,#e5e7eb) 100%)",
        backgroundSize: "200% 100%",
        animation: "sk 1.1s linear infinite",
      }}
    />
  );
}

function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div style={{ textAlign: "center", color: "var(--text-muted,#6b7280)" }}>
      <div style={{ fontSize: 36, lineHeight: 1 }}>🗂️</div>
      <div style={{ fontWeight: 600, marginTop: 6, color: "var(--text,#111827)" }}>{title}</div>
      {description && <div style={{ fontSize: 13, marginTop: 4 }}>{description}</div>}
    </div>
  );
}

/* --------------------------------- Styles --------------------------------- */

const container: React.CSSProperties = {
  background: "var(--surface,#fff)",
  color: "var(--text,#111827)",
  border: "1px solid var(--border,#e5e7eb)",
  borderRadius: 12,
  padding: 12,
  boxShadow: "var(--shadow-sm,0 1px 2px rgba(0,0,0,0.06))",
};

const toolbar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  marginBottom: 8,
  justifyContent: "space-between",
};

const input: React.CSSProperties = {
  border: "1px solid var(--border,#e5e7eb)",
  borderRadius: 10,
  padding: "6px 10px",
  background: "var(--bg,#fff)",
  color: "inherit",
  outline: "none",
  width: 120,
  fontSize: 14,
};

const select: React.CSSProperties = {
  border: "1px solid var(--border,#e5e7eb)",
  borderRadius: 10,
  padding: "6px 10px",
  background: "var(--bg,#fff)",
  color: "inherit",
  outline: "none",
  fontSize: 14,
};

const checkLabel: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  color: "var(--text,#111827)",
};

const errorBox: React.CSSProperties = {
  marginTop: 8,
  padding: "6px 10px",
  borderRadius: 10,
  border: "1px solid var(--danger,#ef4444)",
  color: "var(--danger,#ef4444)",
  background: "var(--red-50,#fef2f2)",
};

const tableWrap: React.CSSProperties = {
  marginTop: 8,
  border: "1px solid var(--border,#e5e7eb)",
  borderRadius: 10,
  overflow: "hidden",
};

const table: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  tableLayout: "fixed",
};

const thBase: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  background: "var(--gray-50,#f8fafc)",
  fontSize: 12,
  fontWeight: 700,
  color: "var(--text,#111827)",
  padding: "8px 10px",
  borderBottom: "1px solid var(--border,#e5e7eb)",
  whiteSpace: "nowrap",
  cursor: "pointer",
  userSelect: "none",
};

const rowBase: React.CSSProperties = {
  borderTop: "1px solid var(--border,#e5e7eb)",
};

const tdRight: React.CSSProperties = {
  padding: "8px 10px",
  textAlign: "right",
  whiteSpace: "nowrap",
};

const tdRightMuted: React.CSSProperties = {
  ...tdRight,
  color: "var(--text-muted,#6b7280)",
};

const tdStrike: React.CSSProperties = {
  padding: "8px 10px",
  textAlign: "center",
  whiteSpace: "nowrap",
  borderLeft: "1px dashed var(--border,#e5e7eb)",
  borderRight: "1px dashed var(--border,#e5e7eb)",
  background: "var(--bg,#fff)",
  position: "sticky",
  left: "50%",
};

/* ---------------------------------- Utils --------------------------------- */

function isFiniteNum(v: any): v is number {
  return typeof v === "number" && isFinite(v);
}

function fmtNum(n?: number | null, cur?: string) {
  if (!isFiniteNum(n)) return "—";
  const s = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);
  return cur ? `${cur}${s}` : s;
}
function fmtInt(n?: number | null) {
  if (!isFiniteNum(n)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
}
function fmtGreek(n?: number | null) {
  if (!isFiniteNum(n)) return "—";
  const abs = Math.abs(n);
  const d = abs >= 10 ? 1 : 3;
  const s = n.toFixed(d).replace(/\.0+$/, "");
  return s;
}
function fmtDate(d: Date | string): string {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

function ivCell(iv?: number | null, dom?: { min: number; max: number }) {
  if (!isFiniteNum(iv)) return "—";
  const t = dom ? normalize(iv, dom.min, dom.max) : 0.5;
  const bar = (
    <span style={{ display: "inline-block", verticalAlign: "middle", width: 48, height: 8, background: "#eef2ff", borderRadius: 9999, marginRight: 6, overflow: "hidden" }}>
      <span style={{ display: "block", height: "100%", width: `${Math.round(t * 100)}%`, background: "var(--primary,#6366f1)" }} />
    </span>
  );
  const label = `${iv.toFixed(iv >= 100 ? 0 : iv >= 10 ? 1 : 2).replace(/\.0+$/, "")}%`;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
      {bar}
      <span>{label}</span>
    </span>
  );
}

function normalize(v: number, min: number, max: number) {
  if (max === min) return 0.5;
  const t = (v - min) / (max - min);
  return Math.max(0, Math.min(1, t));
}

/* ------------------------------ Keyframes CSS ----------------------------- */

(function ensureKeyframes() {
  if (typeof document === "undefined") return;
  const id = "optionschain-inline-anim";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
@keyframes sk { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
`;
  document.head.appendChild(style);
})();
