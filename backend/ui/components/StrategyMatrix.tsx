// components/strategymatrix.tsx
// Strategy Matrix — sortable heatmap table with sparklines (no deps).

import React, { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------- Props/Types ------------------------------- */

export interface RowMeta {
  win?: number;     // %
  trades?: number;  // count
  pnl?: number;     // absolute or R
}

export interface StrategyMatrixProps {
  strategies: string[];
  scenarios: string[];
  values: (number | null | undefined)[][];
  title?: string;
  unit?: string;
  colorMin?: string;   // low value color
  colorMax?: string;   // high value color
  colorZero?: string;  // middle color for diverging
  diverging?: boolean;
  formatter?: (v: number) => string;

  rowMeta?: Record<string, RowMeta>;
  initialSort?: SortKey;
  onCellClick?: (info: { row: number; col: number; strategy: string; scenario: string; value: number | null }) => void;
  onRowClick?: (info: { strategy: string; index: number }) => void;

  height?: number;
  className?: string;
  style?: React.CSSProperties;
}

type Row = {
  name: string;
  index: number;
  vals: number[]; // NaN where missing
  stats: { avg: number; max: number; min: number; win?: number; trades?: number; pnl?: number };
};

export type SortKey = "name" | "avg" | "max" | "min" | "win" | "trades" | "pnl";

/* -------------------------------- Component -------------------------------- */

export default function StrategyMatrix({
  strategies,
  scenarios,
  values,
  title = "Strategy Matrix",
  unit = "",
  colorMin = "hsl(210 90% 70%)",
  colorMax = "hsl(0 80% 55%)",
  colorZero = "hsl(220 10% 96%)",
  diverging = false,
  formatter,
  rowMeta,
  initialSort = "avg",
  onCellClick,
  onRowClick,
  height = 420,
  className,
  style,
}: StrategyMatrixProps) {
  // responsive container width (for legend text wrapping etc.)
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(900);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // search + sort
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: initialSort, dir: -1 });

  // normalize rows
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (let r = 0; r < strategies.length; r++) {
      const name = strategies[r];
      const valRow = (values[r] ?? []).map((v) => (typeof v === "number" && isFinite(v) ? v : NaN));
      const avg = mean(valRow);
      const mx = max(valRow);
      const mn = min(valRow);
      const meta = rowMeta?.[name];
      out.push({ name, index: r, vals: valRow, stats: { avg, max: mx, min: mn, win: meta?.win, trades: meta?.trades, pnl: meta?.pnl } });
    }
    return out;
  }, [strategies, values, rowMeta]);

  // color domain
  const domain = useMemo(() => {
    const flat = rows.flatMap((r) => r.vals.filter(isFinite));
    if (!flat.length) return { lo: 0, hi: 1 };
    let lo = Math.min(...flat);
    let hi = Math.max(...flat);
    if (diverging) {
      const m = Math.max(Math.abs(lo), Math.abs(hi));
      lo = -m; hi = m;
    }
    return { lo, hi };
  }, [rows, diverging]);

  // filter & sort
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : rows;
  }, [rows, q]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const k = sort.key, d = sort.dir;
      const av = colValue(a, k), bv = colValue(b, k);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * d;
      return String(av).localeCompare(String(bv)) * d;
    });
    return arr;
  }, [filtered, sort]);

  // color scale
  const color = (v: number) => {
    if (!isFinite(v)) return "var(--gray-200,#e5e7eb)";
    if (diverging) {
      const t = norm(v, domain.lo, domain.hi) * 2 - 1; // [-1..1]
      if (t >= 0) return mix(colorZero, colorMax, t);
      return mix(colorZero, colorMin, -t);
    }
    return mix(colorMin, colorMax, norm(v, domain.lo, domain.hi));
  };

  const stickyFirstWidth = 220;
  const metaCols = (["win", "trades", "pnl"] as const).filter((k) => rows.some((r) => typeof r.stats[k] === "number" && isFinite(r.stats[k] as number)));

  return (
    <div ref={wrapRef} className={className} style={{ ...frame, ...style }}>
      {/* Toolbar */}
      <div style={toolbar}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{title}</h2>
          <Legend lo={domain.lo} hi={domain.hi} unit={unit} colorMin={colorMin} colorMax={colorMax} diverging={diverging} />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Field label="Search">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Strategy…" style={input} />
          </Field>
          <Field label="Sort">
            <select
              value={sort.key}
              onChange={(e) => setSort((s) => ({ ...s, key: e.target.value as SortKey }))}
              style={select}
            >
              <option value="avg">Avg</option>
              <option value="max">Max</option>
              <option value="min">Min</option>
              {metaCols.includes("win") && <option value="win">Win %</option>}
              {metaCols.includes("trades") && <option value="trades">Trades</option>}
              {metaCols.includes("pnl") && <option value="pnl">PnL</option>}
              <option value="name">Name</option>
            </select>
          </Field>
          <button type="button" onClick={() => setSort((s) => ({ ...s, dir: s.dir === 1 ? -1 : 1 }))} style={btn}>
            {sort.dir === 1 ? "Asc ↑" : "Desc ↓"}
          </button>
        </div>
      </div>

      {/* Table viewport */}
      <div style={{ ...viewport, maxHeight: height }}>
        <table style={table}>
          <thead>
            <tr>
              <th
                style={{
                  ...th,
                  position: "sticky",
                  left: 0,
                  zIndex: 2,
                  width: stickyFirstWidth,
                  minWidth: stickyFirstWidth,
                  textAlign: "left",
                }}
              >
                Strategy
              </th>

              {metaCols.map((k) => (
                <th key={`m-${k}`} style={th}>{metaHeaderLabel(k)}</th>
              ))}

              {scenarios.map((s, i) => (
                <th key={`h-${i}`} style={{ ...th, textAlign: "center" }}>{s}</th>
              ))}

              <th style={th}>Avg</th>
              <th style={th}>Spark</th>
            </tr>
          </thead>

          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={2 + scenarios.length + metaCols.length} style={{ padding: 14, color: "var(--text-muted,#6b7280)" }}>
                  No strategies match.
                </td>
              </tr>
            )}

            {sorted.map((r) => {
              const avg = r.stats.avg;
              return (
                <tr key={r.name} style={tr}>
                  {/* sticky first col */}
                  <td
                    onClick={() => onRowClick?.({ strategy: r.name, index: r.index })}
                    style={{
                      ...tdLeft,
                      position: "sticky",
                      left: 0,
                      zIndex: 1,
                      width: stickyFirstWidth,
                      minWidth: stickyFirstWidth,
                      cursor: onRowClick ? "pointer" : "default",
                      background: "var(--bg,#fff)",
                    }}
                    title="Click row"
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <strong>{r.name}</strong>
                    </div>
                  </td>

                  {/* meta columns */}
                  {metaCols.map((k) => (
                    <td key={`rm-${k}`} style={tdRight}>
                      {metaCellValue(r.stats, k, unit)}
                    </td>
                  ))}

                  {/* heatmap cells */}
                  {r.vals.map((v, c) => {
                    const fill = color(v);
                    const label = isFinite(v) ? formatCell(v, unit, formatter) : "—";
                    return (
                      <td
                        key={`c-${c}`}
                        style={{ ...tdCell, background: fill }}
                        title={`${r.name} · ${scenarios[c]} = ${label}`}
                        onClick={() =>
                          onCellClick?.({
                            row: r.index,
                            col: c,
                            strategy: r.name,
                            scenario: scenarios[c],
                            value: isFinite(v) ? v : null,
                          })
                        }
                      >
                        <span style={{ background: "rgba(255,255,255,0.85)", borderRadius: 6, padding: "1px 6px", fontSize: 12 }}>
                          {label}
                        </span>
                      </td>
                    );
                  })}

                  {/* avg + spark */}
                  <td style={{ ...tdRight, fontWeight: 600, color: toneColor(avg) }}>
                    {formatCell(avg, unit, formatter)}
                  </td>
                  <td style={{ ...tdRight, paddingRight: 8 }}>
                    <Spark values={r.vals} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* --------------------------------- Sparkline ------------------------------- */

function Spark({ values }: { values: number[] }) {
  const W = 90, H = 24, pad = 2;
  const ys = values.filter(isFinite);
  const has = ys.length > 0;
  const lo = has ? Math.min(...ys) : 0;
  const hi = has ? Math.max(...ys) : 1;
  const x = (i: number) => pad + ((W - pad * 2) * i) / Math.max(1, values.length - 1);
  const y = (v: number) => H - pad - ((H - pad * 2) * (v - lo)) / (hi - lo || 1);
  return (
    <svg width={W} height={H} aria-hidden="true">
      <polyline
        points={values.map((v, i) => `${x(i)},${y(isFinite(v) ? v : lo)}`).join(" ")}
        fill="none"
        stroke="var(--primary,#6366f1)"
        strokeWidth={1.6}
      />
      {has && <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="var(--border,#e5e7eb)" strokeDasharray="2,3" />}
    </svg>
  );
}

/* --------------------------------- Legend --------------------------------- */

function Legend({
  lo, hi, unit, colorMin, colorMax, diverging,
}: { lo: number; hi: number; unit?: string; colorMin: string; colorMax: string; diverging?: boolean }) {
  const W = 180, H = 24, R = 6;
  const id = React.useMemo(() => `sm-grad-${Math.random().toString(36).slice(2)}`, []);
  return (
    <svg width={W} height={H} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={colorMin} />
          {diverging && <stop offset="50%" stopColor="hsl(220 10% 96%)" />}
          <stop offset="100%" stopColor={colorMax} />
        </linearGradient>
      </defs>
      <rect x={0} y={H / 2 - 6} width={W} height={12} rx={R} fill={`url(#${id})`} />
      <text x={0} y={H - 2} fontSize="10" fill="var(--text-muted,#6b7280)">{formatCell(lo, unit)}</text>
      <text x={W} y={H - 2} fontSize="10" textAnchor="end" fill="var(--text-muted,#6b7280)">{formatCell(hi, unit)}</text>
    </svg>
  );
}

/* -------------------------------- Utilities -------------------------------- */

// meta header label + cell value
function metaHeaderLabel(k: "win" | "trades" | "pnl") {
  switch (k) {
    case "win": return "Win %";
    case "trades": return "Trades";
    case "pnl": return "PnL";
  }
}
function metaCellValue(
  stats: Row["stats"],
  k: "win" | "trades" | "pnl",
  unit: string
) {
  const v = stats[k];
  if (typeof v !== "number" || !isFinite(v)) return "—";
  if (k === "win") return `${formatNumber(v)}%`;
  if (k === "trades") return formatInt(v);
  return `${formatCell(v, unit)}`;
}

// column value used for sorting
function colValue(r: Row, key: SortKey): number | string | undefined {
  switch (key) {
    case "name": return r.name;
    case "avg": return r.stats.avg;
    case "max": return r.stats.max;
    case "min": return r.stats.min;
    case "win": return r.stats.win;
    case "trades": return r.stats.trades;
    case "pnl": return r.stats.pnl;
  }
}

// formatting + colors
function formatCell(v?: number, unit = "", custom?: (v: number) => string) {
  if (!(typeof v === "number" && isFinite(v))) return "—";
  const s = custom
    ? custom(v)
    : formatNumber(v);
  return `${s}${unit}`;
}
function formatNumber(v: number) {
  const d = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: d }).format(v);
}
function formatInt(v: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(v);
}
function toneColor(n?: number) {
  if (!(typeof n === "number" && isFinite(n))) return "inherit";
  return n > 0 ? "var(--success,#10b981)" : n < 0 ? "var(--danger,#ef4444)" : "inherit";
}

// stats
function mean(xs: number[]) { const a = xs.filter(isFinite); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN; }
function max(xs: number[]) { const a = xs.filter(isFinite); return a.length ? Math.max(...a) : NaN; }
function min(xs: number[]) { const a = xs.filter(isFinite); return a.length ? Math.min(...a) : NaN; }

// scales/colors
function norm(v: number, lo: number, hi: number) {
  if (hi === lo) return 0.5;
  return Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
}
function parseHsl(s: string): { h: number; s: number; l: number } | null {
  const m = s.trim().match(/^hsl\(([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)$/i);
  return m ? { h: +m[1], s: +m[2], l: +m[3] } : null;
}
function mix(a: string, b: string, t: number) {
  const pa = parseHsl(a), pb = parseHsl(b);
  if (pa && pb) {
    const h = pa.h + (pb.h - pa.h) * t;
    const s = pa.s + (pb.s - pa.s) * t;
    const l = pa.l + (pb.l - pa.l) * t;
    return `hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}%)`;
  }
  // rgb fallback
  const ra = hexToRgb(a) ?? { r: 59, g: 130, b: 246 };
  const rb = hexToRgb(b) ?? { r: 239, g: 68, b: 68 };
  const r = Math.round(ra.r + (rb.r - ra.r) * t);
  const g = Math.round(ra.g + (rb.g - ra.g) * t);
  const b_ = Math.round(ra.b + (rb.b - ra.b) * t);
  return `rgb(${r},${g},${b_})`;
}
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const s = hex.replace("#", "");
  if (s.length !== 6) return null;
  const n = parseInt(s, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/* --------------------------------- Styles --------------------------------- */

const frame: React.CSSProperties = {
  background: "var(--surface,#fff)",
  color: "var(--text,#111827)",
  border: "1px solid var(--border,#e5e7eb)",
  borderRadius: 12,
  padding: 12,
  boxShadow: "var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.06))",
};

const toolbar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};

const viewport: React.CSSProperties = {
  marginTop: 10,
  border: "1px solid var(--border,#e5e7eb)",
  borderRadius: 12,
  overflow: "auto",
};

const table: React.CSSProperties = {
  width: "100%",
  borderCollapse: "separate",
  borderSpacing: 0,
};

const th: React.CSSProperties = {
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
};

const tr: React.CSSProperties = {
  borderTop: "1px solid var(--border,#e5e7eb)",
};

const tdLeft: React.CSSProperties = {
  padding: "8px 10px",
  whiteSpace: "nowrap",
  textAlign: "left",
};

const tdRight: React.CSSProperties = {
  padding: "8px 10px",
  whiteSpace: "nowrap",
  textAlign: "right",
};

const tdCell: React.CSSProperties = {
  padding: 4,
  textAlign: "center",
  whiteSpace: "nowrap",
};

const input: React.CSSProperties = {
  border: "1px solid var(--border,#e5e7eb)",
  borderRadius: 10,
  padding: "6px 10px",
  background: "var(--bg,#fff)",
  color: "inherit",
  outline: "none",
  fontSize: 14,
  width: 140,
};

const select: React.CSSProperties = {
  ...input,
  width: 120,
};

const btn: React.CSSProperties = {
  border: "1px solid var(--border,#e5e7eb)",
  background: "var(--bg,#fff)",
  color: "var(--text,#111827)",
  padding: "6px 10px",
  borderRadius: 10,
  cursor: "pointer",
  fontSize: 13,
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--text-muted,#6b7280)" }}>{label}</span>
      {children}
    </label>
  );
}
