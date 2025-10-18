// components/futuresmonitor.tsx
// Lightweight Futures Monitor dashboard (React TSX, no external libs).

import React, { useMemo, useState } from "react";

/* ---------------------------------- Types --------------------------------- */

export type CurvePoint = { expiry: string | Date; price: number; label?: string };

export type FuturesRow = {
  symbol: string;
  contract: string;
  expiry: string | Date;
  last: number;
  change: number;
  pctChange?: number;
  prevClose?: number;
  volume?: number;
  openInterest?: number;
  basis?: number;
};

export interface FuturesMonitorProps {
  title?: string;
  rows: FuturesRow[];
  curve?: CurvePoint[];
  curvePrev?: CurvePoint[];
  currency?: string;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
  onRowClick?: (row: FuturesRow) => void;
  CurveComponent?: React.ComponentType<{
    data: CurvePoint[];
    previous?: CurvePoint[];
    height?: number;
    currency?: string;
    className?: string;
    style?: React.CSSProperties;
  }>;
}

/* -------------------------------- Component -------------------------------- */

export default function FuturesMonitor({
  title = "Futures Monitor",
  rows,
  curve,
  curvePrev,
  currency = "",
  loading,
  error,
  onRefresh,
  onRowClick,
  CurveComponent,
}: FuturesMonitorProps) {
  const [query, setQuery] = useState("");
  const [month, setMonth] = useState<string>("");
  const [sort, setSort] = useState<{ key: keyof FuturesRow | "pctChange"; dir: 1 | -1 }>({
    key: "expiry",
    dir: 1,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      const matchQ = !q || `${r.symbol} ${r.contract}`.toLowerCase().includes(q);
      const mm = month && labelMonYY(r.expiry) !== month ? false : true;
      return matchQ && mm;
    });
  }, [rows, query, month]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const k = sort.key;
    const d = sort.dir;
    arr.sort((a, b) => {
      const av = valueFor(a, k);
      const bv = valueFor(b, k);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * d;
      return String(av).localeCompare(String(bv)) * d;
    });
    return arr;
  }, [filtered, sort]);

  const firstTwo = (curve ?? []).slice(0, 2);
  const front = firstTwo[0]?.price;
  const next = firstTwo[1]?.price;
  const slope = isFiniteNum(front) && isFiniteNum(next) ? next - front : null;
  const contango = slope != null ? slope > 0 : null;

  const totalOI = sum(rows.map((r) => r.openInterest ?? 0));
  const totalVol = sum(rows.map((r) => r.volume ?? 0));
  const avgBasis =
    rows.length ? sum(rows.map((r) => (isFiniteNum(r.basis) ? (r.basis as number) : 0))) / rows.length : null;

  const months = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => set.add(labelMonYY(r.expiry)));
    return Array.from(set).sort();
  }, [rows]);

  return (
    <div
      style={{
        background: "var(--surface, #fff)",
        color: "var(--text, #111827)",
        border: "1px solid var(--border, #e5e7eb)",
        borderRadius: 12,
        padding: 12,
        boxShadow: "var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.06))",
      }}
    >
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h2>
        <div style={{ flexGrow: 1 }} />
        <SearchBox value={query} onChange={setQuery} />
        <SelectBox
          value={month}
          onChange={setMonth}
          options={[{ value: "", label: "All months" }, ...months.map((m) => ({ value: m, label: m }))]}
        />
        <button
          type="button"
          onClick={onRefresh}
          style={btnStyle(true)}
          disabled={loading}
          aria-label="Refresh"
          title="Refresh"
        >
          {loading ? <Spinner size={14} /> : "↻"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div
          role="alert"
          style={{
            marginTop: 10,
            padding: "6px 10px",
            borderRadius: 10,
            border: "1px solid var(--danger, #ef4444)",
            color: "var(--danger, #ef4444)",
            background: "var(--red-50, #fef2f2)",
          }}
        >
          {error}
        </div>
      )}

      {/* Summaries */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 10, marginTop: 10 }}>
        <Tile title="Front" value={front != null ? withCommas(front) : "—"} subtitle={firstTwo[0]?.label ?? ""} tone="info" loading={!!loading} />
        <Tile
          title="Spread (1→2)"
          value={
            slope == null ? "—" : `${contango ? "Contango" : "Backward"} ${contango ? "↑" : "↓"} ${
              currency
            }${withCommas(Math.abs(slope))}`
          }
          subtitle={`${firstTwo[0]?.label ?? ""} → ${firstTwo[1]?.label ?? ""}`}
          tone={contango == null ? "neutral" : contango ? "success" : "danger"}
          loading={!!loading}
        />
        <Tile title="Open Interest" value={withCommas(totalOI)} subtitle="Total" tone="neutral" loading={!!loading} />
        <Tile title="Volume" value={withCommas(totalVol)} subtitle="Session" tone="neutral" loading={!!loading} />
      </div>

      {/* Curve */}
      <div style={{ marginTop: 10, border: "1px solid var(--border, #e5e7eb)", borderRadius: 12, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 12 }}>
            <Skeleton variant="rect" height={220} />
          </div>
        ) : curve && curve.length ? (
          CurveComponent ? (
            <CurveComponent data={curve} previous={curvePrev} height={260} currency={currency} />
          ) : (
            <MiniCurve data={curve} previous={curvePrev} height={260} currency={currency} />
          )
        ) : (
          <EmptyState title="No curve data" description="Add contracts to visualize the term structure." icon="📉" />
        )}
      </div>

      {/* Table */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <strong style={{ fontSize: 13, color: "var(--text-muted, #6b7280)" }}>
            {sorted.length} {sorted.length === 1 ? "contract" : "contracts"}
          </strong>
        </div>

        <div style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead style={{ background: "var(--gray-50,#f8fafc)" }}>
              <tr>
                {header("Symbol", "symbol")}
                {header("Contract", "contract")}
                {header("Expiry", "expiry")}
                {header("Last", "last", true)}
                {header("Δ", "change", true)}
                {header("%", "pctChange", true)}
                {header("Volume", "volume", true)}
                {header("OI", "openInterest", true)}
                {header("Basis", "basis", true)}
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: 6 }).map((_, i) => (
                    <tr key={`sk-${i}`}>
                      <td colSpan={9} style={{ padding: 8 }}>
                        <Skeleton variant="rect" height={16} />
                      </td>
                    </tr>
                  ))
                : sorted.length === 0
                ? (
                  <tr>
                    <td colSpan={9} style={{ padding: 16 }}>
                      <EmptyState title="No matching contracts" description="Try adjusting your filters." icon="🔎" />
                    </td>
                  </tr>
                  )
                : sorted.map((r, i) => (
                    <tr
                      key={`${r.symbol}:${r.contract}:${i}`}
                      onClick={() => onRowClick?.(r)}
                      style={{ cursor: onRowClick ? "pointer" : "default", borderTop: "1px solid var(--border, #e5e7eb)" }}
                    >
                      <td style={tdLeft}>{r.symbol}</td>
                      <td style={tdLeft}>{r.contract}</td>
                      <td style={tdLeftMuted}>{labelMonYY(r.expiry)}</td>
                      <td style={tdRight}>{fmtNum(r.last)}</td>
                      <td style={{ ...tdRight, color: colorDelta(r.change) }}>{fmtSign(r.change)}</td>
                      <td style={{ ...tdRight, color: colorDelta(pctFor(r)) }}>{fmtPct(pctFor(r))}</td>
                      <td style={tdRight}>{fmtInt(r.volume)}</td>
                      <td style={tdRight}>{fmtInt(r.openInterest)}</td>
                      <td style={{ ...tdRight, color: toneBasis(r.basis) }}>{fmtNum(r.basis)}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

  function header(label: string, key: keyof FuturesRow | "pctChange", numeric = false) {
    const active = sort.key === key;
    const dirArrow = active ? (sort.dir === 1 ? "▲" : "▼") : "";
    return (
      <th
        onClick={() =>
          setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : (numeric ? -1 : 1) }))
        }
        style={{
          textAlign: numeric ? "right" : "left",
          padding: "8px 10px",
          fontWeight: 600,
          fontSize: 12,
          userSelect: "none",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
        title="Sort"
      >
        {label} <span style={{ opacity: 0.6 }}>{dirArrow}</span>
      </th>
    );
  }
}

/* ------------------------------ Small Pieces ------------------------------ */

function SearchBox({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        width: 220,
        background: "var(--bg, #fff)",
        border: "1px solid var(--border, #e5e7eb)",
        borderRadius: 10,
        padding: "6px 10px",
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 13, opacity: 0.75 }}>🔎</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search symbol or contract…"
        style={{ flex: "1 1 auto", border: "none", outline: "none", background: "transparent", fontSize: 14, color: "inherit" }}
      />
      {value && (
        <button type="button" onClick={() => onChange("")} style={btnIcon} aria-label="Clear">
          ✕
        </button>
      )}
    </div>
  );
}

function SelectBox({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        background: "var(--bg, #fff)",
        border: "1px solid var(--border, #e5e7eb)",
        borderRadius: 10,
        padding: "6px 10px",
        gap: 6,
        minWidth: 160,
      }}
    >
      <span style={{ fontSize: 12, color: "var(--text-muted,#6b7280)" }}>Month</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          flex: "1 1 auto",
          border: "none",
          outline: "none",
          background: "transparent",
          fontSize: 14,
          color: "var(--text,#111827)",
          WebkitAppearance: "none",
          appearance: "none",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span aria-hidden="true" style={{ fontSize: 12, opacity: 0.6 }}>▾</span>
    </div>
  );
}

function Tile({
  title,
  value,
  subtitle,
  tone = "neutral",
  loading,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  tone?: "neutral" | "success" | "danger" | "info";
  loading?: boolean;
}) {
  const toneCol =
    tone === "success"
      ? "var(--success,#10b981)"
      : tone === "danger"
      ? "var(--danger,#ef4444)"
      : tone === "info"
      ? "var(--info,#3b82f6)"
      : "var(--text,#111827)";
  return (
    <div style={{ border: "1px solid var(--border,#e5e7eb)", borderRadius: 12, padding: 12, background: "var(--bg,#fff)" }}>
      <div style={{ fontSize: 12, color: "var(--text-muted,#6b7280)" }}>{title}</div>
      <div style={{ marginTop: 6, fontSize: 20, fontWeight: 700, color: toneCol }}>
        {loading ? <Skeleton variant="rect" height={20} /> : value}
      </div>
      {subtitle && <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-muted,#6b7280)" }}>{subtitle}</div>}
    </div>
  );
}

/* ------------------------------ Mini Curve SVG ----------------------------- */

function MiniCurve({
  data,
  previous,
  height = 260,
  currency,
  className,
  style,
}: {
  data: CurvePoint[];
  previous?: CurvePoint[];
  height?: number;
  currency?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const pts = useMemo(() => sortByDate(data.map(nPoint)), [data]);
  const prev = useMemo(() => (previous ? sortByDate(previous.map(nPoint)) : undefined), [previous]);

  const margin = { top: 12, right: 12, bottom: 26, left: 44 };
  const width = 800;
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const xs = pts.map((p) => +p.exp);
  const ys = pts.map((p) => p.price).concat(prev?.map((p) => p.price) ?? []);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const pad = (yMax - yMin || 1) * 0.08;
  const lo = yMin - pad;
  const hi = yMax + pad;

  const x = (t: number) => (xMax === xMin ? innerW / 2 : ((t - xMin) / (xMax - xMin)) * innerW);
  const y = (v: number) => (hi === lo ? innerH / 2 : innerH - ((v - lo) / (hi - lo)) * innerH);

  const line = (arr: ReturnType<typeof nPoint>[]) =>
    arr.map((p, i) => `${i ? "L" : "M"}${x(+p.exp)},${y(p.price)}`).join(" ");

  // ✅ FIXED: avoid unary + on optional chain — use getTime with guards
  const startMs = pts.length ? pts[0].exp.getTime() : Date.now();
  const endMs = pts.length ? pts[pts.length - 1].exp.getTime() : startMs;
  const xTicks = niceDateTicks(startMs, endMs, 5);
  const yTicks = niceTicks(lo, hi, 4);

  return (
    <svg
      className={className}
      style={{ display: "block", width: "100%", height, ...style }}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Futures curve"
    >
      <rect x={0} y={0} width={width} height={height} fill="var(--surface,#fff)" />
      <g transform={`translate(${margin.left},${margin.top})`}>
        {yTicks.map((v, i) => (
          <g key={`gy-${i}`}>
            <line x1={0} x2={innerW} y1={y(v)} y2={y(v)} stroke="var(--border,#e5e7eb)" strokeDasharray="2,3" />
            <text x={-8} y={y(v)} textAnchor="end" dominantBaseline="middle" fontSize="11" fill="var(--text-muted,#6b7280)">
                {currency}{withCommas(v)}
            </text>
          </g>
        ))}
        <line x1={0} x2={innerW} y1={innerH} y2={innerH} stroke="var(--border,#e5e7eb)" />
        {xTicks.map((t, i) => (
          <g key={`gx-${i}`} transform={`translate(${x(+t)},0)`}>
            <line y1={innerH} y2={innerH + 4} stroke="var(--border,#e5e7eb)" />
            <text y={innerH + 16} textAnchor="middle" fontSize="11" fill="var(--text-muted,#6b7280)">
              {labelMonYY(t)}
            </text>
          </g>
        ))}

        {prev && prev.length > 0 && (
          <path d={line(prev)} fill="none" stroke="var(--gray-400,#94a3b8)" strokeWidth={1.5} strokeDasharray="4,4" />
        )}

        <path d={line(pts)} fill="none" stroke="var(--primary,#6366f1)" strokeWidth={2} />
        {pts.map((p, i) => (
          <circle key={i} cx={x(+p.exp)} cy={y(p.price)} r={3} fill="var(--surface,#fff)" stroke="var(--primary,#6366f1)" />
        ))}
      </g>
    </svg>
  );
}

/* --------------------------- Inline primitives ---------------------------- */

function Skeleton({ variant = "rect", height = 14 }: { variant?: "rect"; height?: number }) {
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

function Spinner({ size = 16 }: { size?: number }) {
  const r = (size - 3) / 2;
  const c = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block" }} aria-hidden="true">
      <circle cx={c} cy={c} r={r} stroke="var(--border,#e5e7eb)" strokeWidth={3} fill="none" />
      <circle
        cx={c}
        cy={c}
        r={r}
        stroke="var(--primary,#6366f1)"
        strokeWidth={3}
        strokeDasharray={`${Math.PI * r * 0.9} ${Math.PI * r * 0.6}`}
        strokeLinecap="round"
        fill="none"
      >
        <animateTransform attributeName="transform" type="rotate" from={`0 ${c} ${c}`} to={`360 ${c} ${c}`} dur="0.9s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

function EmptyState({ title, description, icon }: { title: string; description?: string; icon?: string }) {
  return (
    <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted,#6b7280)" }}>
      <div style={{ fontSize: 36, lineHeight: 1 }}>{icon ?? "🗂️"}</div>
      <div style={{ fontWeight: 600, marginTop: 6, color: "var(--text,#111827)" }}>{title}</div>
      {description && <div style={{ fontSize: 13, marginTop: 4 }}>{description}</div>}
    </div>
  );
}

/* --------------------------------- Styles --------------------------------- */

const btnIcon: React.CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
  color: "var(--text-muted,#6b7280)",
};

const btnStyle = (outlined = false): React.CSSProperties => ({
  border: outlined ? "1px solid var(--border,#e5e7eb)" : "none",
  background: outlined ? "transparent" : "var(--primary,#6366f1)",
  color: outlined ? "var(--text,#111827)" : "var(--on-primary,#fff)",
  padding: "6px 10px",
  borderRadius: 10,
  cursor: "pointer",
  fontSize: 13,
});

const tdLeft: React.CSSProperties = { padding: "8px 10px", textAlign: "left", whiteSpace: "nowrap" };
const tdLeftMuted: React.CSSProperties = { ...tdLeft, color: "var(--text-muted,#6b7280)" };
const tdRight: React.CSSProperties = { padding: "8px 10px", textAlign: "right", whiteSpace: "nowrap" };

/* --------------------------------- Utils ---------------------------------- */

function nPoint(p: CurvePoint) {
  const exp = p.expiry instanceof Date ? p.expiry : new Date(p.expiry);
  return { exp, price: Number(p.price), label: p.label ?? labelMonYY(exp) };
}
function sortByDate<T extends { exp: Date }>(arr: T[]) { return [...arr].sort((a, b) => +a.exp - +b.exp); }
function labelMonYY(d: Date | string | number) {
  const dt = d instanceof Date ? d : new Date(d);
  const m = dt.toLocaleString(undefined, { month: "short" });
  const y = String(dt.getFullYear()).slice(-2);
  return `${m} '${y}`;
}
function sum(arr: number[]) { let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i]; return s; }
function withCommas(n: number | undefined | null) {
  if (!isFiniteNum(n)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n as number);
}
function isFiniteNum(v: any): v is number { return typeof v === "number" && isFinite(v); }
function fmtNum(n?: number | null) { return isFiniteNum(n) ? withCommas(n) : "—"; }
function fmtInt(n?: number | null) {
  if (!isFiniteNum(n)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
}
function valueFor(r: FuturesRow, k: keyof FuturesRow | "pctChange"): any {
  if (k === "pctChange") return pctFor(r);
  if (k === "expiry") return +new Date(r.expiry);
  return (r as any)[k];
}
function pctFor(r: FuturesRow): number | null {
  if (isFiniteNum(r.pctChange)) return r.pctChange!;
  if (isFiniteNum(r.prevClose) && isFiniteNum(r.last) && r.prevClose) {
    return ((r.last! - r.prevClose!) / r.prevClose!) * 100;
    }
  if (isFiniteNum(r.change) && isFiniteNum(r.last) && r.last) {
    return (r.change! / (r.last! - r.change!)) * 100;
  }
  return null;
}
function fmtPct(n: number | null) {
  if (!isFiniteNum(n)) return "—";
  const x = Math.abs(n as number);
  const d = x >= 100 ? 0 : x >= 10 ? 1 : 2;
  const s = x.toFixed(d).replace(/\.0+$/, "");
  return `${n! >= 0 ? "+" : "-"}${s}%`;
}
function fmtSign(n?: number | null) {
  if (!isFiniteNum(n)) return "—";
  const x = Math.abs(n as number);
  const d = x >= 100 ? 0 : x >= 10 ? 1 : 2;
  const s = x.toFixed(d).replace(/\.0+$/, "");
  return `${n! >= 0 ? "+" : "-"}${s}`;
}
function colorDelta(n?: number | null) {
  if (!isFiniteNum(n)) return "inherit";
  return n! > 0 ? "var(--success,#10b981)" : n! < 0 ? "var(--danger,#ef4444)" : "inherit";
}
function toneBasis(n?: number | null) {
  if (!isFiniteNum(n)) return "inherit";
  return n! > 0 ? "var(--info,#3b82f6)" : n! < 0 ? "var(--warning,#f59e0b)" : "inherit";
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
function niceDateTicks(minMs: number, maxMs: number, count = 5): Date[] {
  if (minMs === maxMs) return [new Date(minMs)];
  const span = maxMs - minMs;
  const months = [1, 2, 3, 6];
  let stride = 1;
  for (let i = 0; i < months.length; i++) {
    const s = months[i];
    const ticks = Math.ceil(span / approxMonthMs / s);
    if (ticks <= count + 2) { stride = s; break; }
  }
  const out: Date[] = [];
  const start = new Date(minMs);
  let y = start.getFullYear(), m = start.getMonth();
  m = m - (m % stride);
  for (let i = 0; i < 48; i++) {
    const d = new Date(Date.UTC(y, m, 1));
    if (+d >= minMs - approxMonthMs && +d <= maxMs + approxMonthMs) out.push(d);
    m += stride;
    if (m >= 12) { y += Math.floor(m / 12); m %= 12; }
  }
  return out;
}
const approxMonthMs = 30 * 24 * 3600 * 1000;

/* ------------------------------ Keyframes CSS ----------------------------- */

(function ensureKeyframes() {
  if (typeof document === "undefined") return;
  const id = "futuresmonitor-inline-anim";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `@keyframes sk{0%{background-position:-200% 0}100%{background-position:200% 0}}`;
  document.head.appendChild(style);
})();
