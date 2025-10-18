// components/futuresroll.tsx
// Futures Roll analyzer (React TSX, zero dependencies).
// - Input a term-structure (curve) and we compute roll metrics between consecutive contracts
// - Shows a color-coded bar chart of annualized roll yield (%/yr) and a details table
// - Works with Date or ISO strings for expiries

import React, { useMemo } from "react";

/* ---------------------------------- Types ---------------------------------- */

export type CurvePoint = {
  expiry: string | Date;     // contract expiry (front -> far)
  price: number;             // settlement/mark
  label?: string;            // e.g., "Oct'25"
};

export type RollRow = {
  leg: string;               // "Oct'25 → Nov'25"
  from: CurvePointN;
  to: CurvePointN;
  dte: number;               // days between expiries
  spread: number;            // to.price - from.price
  pct: number;               // spread / from.price
  annPct: number;            // pct annualized by dte (365d)
};

export interface FuturesRollProps {
  curve: CurvePoint[];                         // ordered or unordered, we'll sort by expiry
  height?: number;                             // chart height (default 220)
  currency?: string;                           // e.g. "$", "₹" for table nicety
  className?: string;
  style?: React.CSSProperties;
  showTable?: boolean;                         // default true
}

/* -------------------------------- Component -------------------------------- */

export default function FuturesRoll({
  curve,
  height = 220,
  currency = "",
  className,
  style,
  showTable = true,
}: FuturesRollProps) {
  const pts = useMemo(() => sortByDate(curve.map(normalizePoint)), [curve]);
  const rows: RollRow[] = useMemo(() => buildRollRows(pts), [pts]);

  // Chart domain
  const values = rows.map((r) => r.annPct);
  const vMin = Math.min(0, ...values);
  const vMax = Math.max(0, ...values);
  const pad = (vMax - vMin || 1) * 0.12;
  const lo = vMin - pad;
  const hi = vMax + pad;

  // Layout
  const margin = { top: 14, right: 16, bottom: 40, left: 56 };
  const width = Math.max(360, rows.length * 70);
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const x = (i: number) => {
    const bw = innerW / Math.max(1, rows.length);
    return { cx: i * bw + bw / 2, bw: Math.max(10, Math.min(42, bw * 0.6)) };
  };
  const y = (v: number) => (hi === lo ? innerH / 2 : innerH - ((v - lo) / (hi - lo)) * innerH);
  const zeroY = y(0);

  return (
    <div className={className} style={style}>
      {/* BAR CHART */}
      <svg
        role="img"
        aria-label="Annualized roll yield by leg"
        viewBox={`0 0 ${width} ${height}`}
        style={{ display: "block", width: "100%", height }}
      >
        <rect x={0} y={0} width={width} height={height} fill="var(--surface,#fff)" rx={12} />

        <g transform={`translate(${margin.left},${margin.top})`}>
          {/* Y grid + axis labels */}
          {niceTicks(lo, hi, 5).map((v, i) => (
            <g key={`gy-${i}`}>
              <line x1={0} x2={innerW} y1={y(v)} y2={y(v)} stroke="var(--border,#e5e7eb)" strokeDasharray="2,3" />
              <text x={-8} y={y(v)} textAnchor="end" dominantBaseline="middle" fontSize="11" fill="var(--text-muted,#6b7280)">
                {fmtPct(v)}
              </text>
            </g>
          ))}

          {/* Zero line */}
          <line x1={0} x2={innerW} y1={zeroY} y2={zeroY} stroke="var(--border,#e5e7eb)" />

          {/* Bars */}
          {rows.map((r, i) => {
            const { cx, bw } = x(i);
            const by = Math.min(zeroY, y(r.annPct));
            const bh = Math.abs(zeroY - y(r.annPct));
            const fill = r.annPct >= 0 ? "var(--success,#10b981)" : "var(--danger,#ef4444)";
            return (
              <g key={`bar-${i}`} transform={`translate(${cx - bw / 2},0)`}>
                <rect x={0} y={by} width={bw} height={bh} fill={fill} rx={6} />
                {/* Value label */}
                <text
                  x={bw / 2}
                  y={by - 6}
                  fontSize="11"
                  fill="var(--text,#111827)"
                  textAnchor="middle"
                >
                  {fmtPct(r.annPct)}
                </text>
                {/* X labels */}
                <text
                  x={bw / 2}
                  y={innerH + 16}
                  fontSize="11"
                  fill="var(--text-muted,#6b7280)"
                  textAnchor="middle"
                >
                  {r.leg}
                </text>
                <text
                  x={bw / 2}
                  y={innerH + 30}
                  fontSize="10"
                  fill="var(--text-muted,#6b7280)"
                  textAnchor="middle"
                >
                  {r.dte}d
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* TABLE */}
      {showTable && (
        <div
          style={{
            marginTop: 10,
            border: "1px solid var(--border,#e5e7eb)",
            borderRadius: 12,
            overflow: "hidden",
            background: "var(--bg,#fff)",
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead style={{ background: "var(--gray-50,#f8fafc)" }}>
              <tr>
                <Th align="left">Leg</Th>
                <Th align="left">From</Th>
                <Th align="left">To</Th>
                <Th align="right">DTE</Th>
                <Th align="right">Spread</Th>
                <Th align="right">% (simple)</Th>
                <Th align="right">%/yr (ann.)</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`row-${i}`} style={{ borderTop: "1px solid var(--border,#e5e7eb)" }}>
                  <Td align="left">{r.leg}</Td>
                  <Td align="left">
                    {labelMonYY(r.from.exp)} @ {fmtNum(r.from.price, currency)}
                  </Td>
                  <Td align="left">
                    {labelMonYY(r.to.exp)} @ {fmtNum(r.to.price, currency)}
                  </Td>
                  <Td align="right">{r.dte}</Td>
                  <Td align="right" style={{ color: toneDelta(r.spread) }}>
                    {fmtNum(r.spread, currency)}
                  </Td>
                  <Td align="right" style={{ color: toneDelta(r.pct) }}>{fmtPct(r.pct * 100)}</Td>
                  <Td align="right" style={{ color: toneDelta(r.annPct) }}>{fmtPct(r.annPct * 100)}</Td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <Td align="left" colSpan={7} style={{ padding: 16, color: "var(--text-muted,#6b7280)" }}>
                    No roll pairs. Provide at least two curve points.
                  </Td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* --------------------------------- Pieces ---------------------------------- */

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      style={{
        textAlign: align,
        padding: "8px 10px",
        fontWeight: 600,
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}
function Td({
  children,
  align = "left",
  colSpan,
  style,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  colSpan?: number;
  style?: React.CSSProperties;
}) {
  return (
    <td
      colSpan={colSpan}
      style={{
        padding: "8px 10px",
        textAlign: align,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

/* --------------------------------- Logic ----------------------------------- */

type CurvePointN = { exp: Date; price: number; label: string };

function normalizePoint(p: CurvePoint): CurvePointN {
  const exp = p.expiry instanceof Date ? p.expiry : new Date(p.expiry);
  return { exp, price: Number(p.price), label: p.label ?? labelMonYY(exp) };
}
function sortByDate<T extends { exp: Date }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => +a.exp - +b.exp);
}

function buildRollRows(pts: CurvePointN[]): RollRow[] {
  const out: RollRow[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dte = Math.max(1, daysBetween(a.exp, b.exp));
    const spread = b.price - a.price;
    const pct = a.price !== 0 ? spread / a.price : 0;          // simple forward carry
    const annPct = pct * (365 / dte);                          // annualized
    out.push({
      leg: `${a.label} → ${b.label}`,
      from: a,
      to: b,
      dte,
      spread,
      pct,
      annPct,
    });
  }
  return out;
}

function daysBetween(a: Date, b: Date): number {
  const ms = +b - +a;
  return Math.round(ms / 86400000);
}

/* --------------------------------- Utils ----------------------------------- */

function labelMonYY(d: Date | number | string) {
  const dt = d instanceof Date ? d : new Date(d);
  const m = dt.toLocaleString(undefined, { month: "short" });
  const y = String(dt.getFullYear()).slice(-2);
  return `${m} '${y}`;
}

function fmtNum(n: number, cur?: string) {
  if (!isFinite(n)) return String(n);
  const s = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);
  return cur ? `${cur}${s}` : s;
}

function fmtPct(n: number) {
  if (!isFinite(n)) return "—";
  const x = Math.abs(n);
  const d = x >= 100 ? 0 : x >= 10 ? 1 : 2;
  const s = x.toFixed(d).replace(/\.0+$/, "");
  return `${n >= 0 ? "" : "-"}${s}%`;
}

function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(isFinite(min) && isFinite(max)) || min === max) return [min];
  const span = max - min;
  const step = niceStep(span / Math.max(1, count));
  const start = Math.ceil(min / step) * step;
  const end = Math.floor(max / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + 1e-9; v += step) out.push(Number(v.toFixed(12)));
  return out.length ? out : [min, max];
}
function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.abs(raw))));
  const n = raw / pow;
  const nice = n >= 7.5 ? 10 : n >= 3.5 ? 5 : n >= 1.5 ? 2 : 1;
  return nice * pow;
}

function toneDelta(v: number) {
  if (!isFinite(v)) return "inherit";
  return v > 0 ? "var(--success,#10b981)" : v < 0 ? "var(--danger,#ef4444)" : "inherit";
}
