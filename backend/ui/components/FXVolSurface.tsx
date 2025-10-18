// components/fxvolsurface.tsx
// FX Vol Surface (2D heatmap) — React TSX, no external libs.
// - X: Tenor (e.g., 1W, 1M, 3M, 1Y)
// - Y: Delta/Strike slice (e.g., 10P, 25P, ATM, 25C, 10C) — order controls layout
// - Cell color encodes vol; hover shows tooltip, click callback fires
// - Legend with min/max; handles NaN / missing gracefully
//
// Usage:
/*
<FXVolSurface
  tenors={["1W","1M","3M","6M","1Y"]}
  slices={["10P","25P","ATM","25C","10C"]}
  vols={[
    // rows in the SAME order as `slices`, columns follow `tenors`
    [13.1, 12.6, 11.9, 11.1, 10.5], // 10P
    [12.2, 11.9, 11.3, 10.9, 10.2], // 25P
    [10.4, 10.1,  9.8,  9.5,  9.2], // ATM
    [11.6, 11.3, 10.8, 10.4, 10.0], // 25C
    [12.8, 12.4, 11.8, 11.3, 10.8], // 10C
  ]}
  title="EURUSD Implied Vol Surface"
  unit="%"
  onCellClick={({row, col, slice, tenor, vol}) => console.log(row, col, slice, tenor, vol)}
/>
*/

import React, { useMemo, useState, useRef, useEffect } from "react";

export interface FXVolSurfaceProps {
  tenors: string[];                  // x axis labels
  slices: string[];                  // y axis labels (top->bottom order)
  vols: (number | null | undefined)[][]; // [row=slice][col=tenor] matrix
  width?: number;                    // fixed width; otherwise responsive
  height?: number;                   // default 340
  title?: string;                    // optional heading inside chart
  unit?: string;                     // e.g. "%"
  margin?: { top: number; right: number; bottom: number; left: number };
  colorMin?: string;                 // override gradient left color
  colorMax?: string;                 // override gradient right color
  className?: string;
  style?: React.CSSProperties;
  onCellClick?: (info: { row: number; col: number; slice: string; tenor: string; vol: number | null }) => void;
}

export default function FXVolSurface({
  tenors,
  slices,
  vols,
  width,
  height = 340,
  title,
  unit = "%",
  margin = { top: 26, right: 18, bottom: 36, left: 56 },
  colorMin = "hsl(210 90% 70%)",     // blue-ish
  colorMax = "hsl(0 80% 55%)",       // red-ish
  className,
  style,
  onCellClick,
}: FXVolSurfaceProps) {
  // responsive width
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState<number>(width || 720);
  useEffect(() => {
    if (width) return;
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [width]);

  // grid geometry
  const cols = tenors.length;
  const rows = slices.length;
  const innerW = Math.max(1, (width ?? w) - margin.left - margin.right);
  const innerH = Math.max(1, height - margin.top - margin.bottom);
  const cw = innerW / Math.max(1, cols);
  const ch = innerH / Math.max(1, rows);

  // domain (ignore null/undefined/NaN)
  const flat = vols.flat().filter((v): v is number => typeof v === "number" && isFinite(v));
  const vMin = flat.length ? Math.min(...flat) : 0;
  const vMax = flat.length ? Math.max(...flat) : 1;
  const color = (v: number | null | undefined) =>
    v == null || !isFinite(v as number) ? "var(--gray-200,#e5e7eb)" : lerpColor(colorMin, colorMax, norm(v as number, vMin, vMax));

  // hover state
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const over = hover ? { r: hover.r, c: hover.c, v: get(vols, hover.r, hover.c) } : null;

  // ticks for y (labels are slices) and x (tenors)
  const xTicks = tenors;
  const yTicks = slices;

  // gradient for legend
  const gradId = useMemo(() => `fxvs-grad-${Math.random().toString(36).slice(2)}`, []);

  return (
    <div ref={wrapRef} className={className} style={{ width: width ? width : "100%", ...style }}>
      <svg
        role="img"
        aria-label={title || "FX vol surface"}
        width={width ?? w}
        height={height}
        viewBox={`0 0 ${width ?? w} ${height}`}
        style={{ display: "block" }}
      >
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={colorMin} />
            <stop offset="100%" stopColor={colorMax} />
          </linearGradient>
        </defs>

        {/* background panel */}
        <rect x={0} y={0} width={width ?? w} height={height} fill="var(--surface,#fff)" rx={12} />

        {/* title */}
        {title && (
          <text x={margin.left} y={18} fontSize="12" fontWeight={600} fill="var(--text,#111827)">{title}</text>
        )}

        <g transform={`translate(${margin.left},${margin.top})`}>
          {/* grid + cells */}
          {/* horizontal grid lines */}
          {Array.from({ length: rows + 1 }).map((_, i) => (
            <line
              key={`hg-${i}`}
              x1={0}
              x2={innerW}
              y1={i * ch}
              y2={i * ch}
              stroke="var(--border,#e5e7eb)"
              strokeDasharray="2,3"
            />
          ))}
          {/* vertical grid lines */}
          {Array.from({ length: cols + 1 }).map((_, j) => (
            <line
              key={`vg-${j}`}
              y1={0}
              y2={innerH}
              x1={j * cw}
              x2={j * cw}
              stroke="var(--border,#e5e7eb)"
              strokeDasharray="2,3"
            />
          ))}

          {/* heatmap cells */}
          {slices.map((slice, r) =>
            tenors.map((tenor, c) => {
              const v = get(vols, r, c);
              const x = c * cw;
              const y = r * ch;
              const fill = color(v);
              const active = hover && hover.r === r && hover.c === c;
              return (
                <g
                  key={`cell-${r}-${c}`}
                  transform={`translate(${x},${y})`}
                  onMouseEnter={() => setHover({ r, c })}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onCellClick?.({ row: r, col: c, slice, tenor, vol: v ?? null })}
                  style={{ cursor: onCellClick ? "pointer" : "default" }}
                >
                  <rect
                    x={0}
                    y={0}
                    width={cw}
                    height={ch}
                    fill={fill}
                    stroke="var(--surface,#fff)"
                    strokeWidth={active ? 2 : 1}
                    rx={6}
                    opacity={v == null ? 0.35 : 1}
                  />
                  {/* inline value for dense view */}
                  {cw > 60 && ch > 24 && (
                    <text
                      x={cw / 2}
                      y={ch / 2 + 4}
                      fontSize="11"
                      textAnchor="middle"
                      fill="var(--text,#111827)"
                    >
                      {v == null || !isFinite(v) ? "—" : formatVol(v, unit)}
                    </text>
                  )}
                </g>
              );
            })
          )}

          {/* x axis labels */}
          {xTicks.map((t, j) => (
            <text
              key={`xt-${j}`}
              x={j * cw + cw / 2}
              y={innerH + 18}
              fontSize="11"
              textAnchor="middle"
              fill="var(--text-muted,#6b7280)"
            >
              {t}
            </text>
          ))}

          {/* y axis labels */}
          {yTicks.map((s, i) => (
            <text
              key={`yt-${i}`}
              x={-8}
              y={i * ch + ch / 2}
              fontSize="11"
              textAnchor="end"
              dominantBaseline="middle"
              fill="var(--text-muted,#6b7280)"
            >
              {s}
            </text>
          ))}

          {/* legend */}
          <g transform={`translate(${innerW - 160},${-18})`} aria-hidden="true">
            <rect x={0} y={0} width={160} height={8} rx={4} fill={`url(#${gradId})`} />
            <text x={0} y={-3} fontSize="10" fill="var(--text-muted,#6b7280)">Low</text>
            <text x={160} y={-3} fontSize="10" textAnchor="end" fill="var(--text-muted,#6b7280)">High</text>
            <text x={0} y={20} fontSize="10" fill="var(--text-muted,#6b7280)">
              {formatVol(vMin, unit)}
            </text>
            <text x={160} y={20} fontSize="10" textAnchor="end" fill="var(--text-muted,#6b7280)">
              {formatVol(vMax, unit)}
            </text>
          </g>

          {/* hover tooltip */}
          {over && (
            <Tooltip
              x={clamp(over.c * cw + cw / 2, 60, innerW - 60)}
              y={clamp(over.r * ch + 10, 18, innerH - 18)}
              lines={[
                `${slices[over.r]} · ${tenors[over.c]}`,
                over.v == null || !isFinite(over.v) ? "—" : `${formatVol(over.v, unit)}`
              ]}
            />
          )}
        </g>
      </svg>
    </div>
  );
}

/* -------------------------------- Tooltip --------------------------------- */

function Tooltip({ x, y, lines }: { x: number; y: number; lines: string[] }) {
  const padX = 8, padY = 6, lineH = 14;
  const w = Math.max(...lines.map(l => l.length)) * 7.5 + padX * 2;
  const h = lineH * lines.length + padY * 2;
  return (
    <g transform={`translate(${x - w / 2},${y - h - 8})`} pointerEvents="none">
      <rect width={w} height={h} rx={6} fill="var(--surface,#fff)" stroke="var(--border,#e5e7eb)" />
      {lines.map((l, i) => (
        <text key={i} x={padX} y={padY + (i + 1) * lineH - 3} fontSize="11" fill="var(--text,#111827)">
          {l}
        </text>
      ))}
    </g>
  );
}

/* --------------------------------- Utils ---------------------------------- */

// robust matrix getter
function get<T>(m: (T | null | undefined)[][], r: number, c: number): T | null {
  const row = m[r];
  if (!row) return null;
  const v = row[c];
  return (v as any) ?? null;
}

function norm(v: number, min: number, max: number) {
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (v - min) / (max - min)));
}

function lerpColor(a: string, b: string, t: number) {
  // parse "hsl(H S% L%)" or hex (#RRGGBB) — keep simple: handle HSL preferred, else fallback mix in RGB.
  const pa = parseHsl(a);
  const pb = parseHsl(b);
  if (pa && pb) {
    const h = pa.h + (pb.h - pa.h) * t;
    const s = pa.s + (pb.s - pa.s) * t;
    const l = pa.l + (pb.l - pa.l) * t;
    return `hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}%)`;
  }
  const ra = hexToRgb(a) ?? { r: 59, g: 130, b: 246 }; // blue-500 fallback
  const rb = hexToRgb(b) ?? { r: 239, g: 68, b: 68 };  // red-500 fallback
  const r = Math.round(ra.r + (rb.r - ra.r) * t);
  const g = Math.round(ra.g + (rb.g - ra.g) * t);
  const b_ = Math.round(ra.b + (rb.b - ra.b) * t);
  return `rgb(${r},${g},${b_})`;
}

function parseHsl(s: string): { h: number; s: number; l: number } | null {
  const m = s.trim().match(/^hsl\(([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)$/i);
  if (!m) return null;
  return { h: +m[1], s: +m[2], l: +m[3] };
}
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const s = hex.replace("#", "");
  if (s.length !== 6) return null;
  const n = parseInt(s, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function formatVol(v: number, unit: string) {
  if (!isFinite(v)) return "—";
  const x = Math.abs(v);
  const d = x >= 100 ? 0 : x >= 10 ? 1 : 2;
  const s = x.toFixed(d).replace(/\.0+$/, "");
  return `${v < 0 ? "-" : ""}${s}${unit}`;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}
