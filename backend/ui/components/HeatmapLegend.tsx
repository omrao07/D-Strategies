// components/heatmaplegend.tsx
// Tiny, dependency-free legend for heatmaps/gradients.
// - Horizontal or vertical
// - Continuous gradient (min→max) or discrete color stops
// - Ticks with custom formatter + unit
// - Works as SVG so it scales crisply
//
// Example:
// <HeatmapLegend
//   min={9.2} max={14.8} unit="%"
//   width={200} height={44} orientation="horizontal"
// />
//
// <HeatmapLegend
//   stops={[{at:0,color:"#2563eb"},{at:0.5,color:"#f59e0b"},{at:1,color:"#ef4444"}]}
//   ticks={[0,0.25,0.5,0.75,1]}
//   format={(v)=>`${Math.round(v*100)}%`}
//   orientation="vertical" height={160} width={60}
// />

import React from "react";

type CSSProps = React.CSSProperties;

export type LegendStop = { at: number; color: string }; // 0..1

export interface HeatmapLegendProps {
  // Domain & scale
  min?: number;
  max?: number;
  ticks?: number[];                  // if omitted, nice ticks are computed (when min/max provided)
  format?: (v: number) => string;    // formats domain values
  unit?: string;                     // appended AFTER format if provided

  // Custom color stops (overrides min/max gradient colors if given)
  stops?: LegendStop[];              // array of {at:0..1,color}

  // Layout
  orientation?: "horizontal" | "vertical";
  width?: number;                    // overall SVG width
  height?: number;                   // overall SVG height
  barThickness?: number;             // gradient bar thickness px
  radius?: number;                   // bar corner radius
  title?: string;                    // optional caption
  className?: string;
  style?: CSSProps;

  // Colors (for simple min→max gradient)
  colorMin?: string;
  colorMax?: string;
}

export default function HeatmapLegend({
  min,
  max,
  ticks,
  format,
  unit = "",
  stops,
  orientation = "horizontal",
  width = 220,
  height = 48,
  barThickness,
  radius = 6,
  title,
  className,
  style,
  colorMin = "hsl(210 90% 70%)",
  colorMax = "hsl(0 80% 55%)",
}: HeatmapLegendProps) {
  const hor = orientation === "horizontal";
  const barLen = hor ? Math.max(80, width - 20) : Math.max(80, height - 28);
  const barTh = barThickness ?? (hor ? 10 : 12);
  const pad = 8;

  // Domain ticks
  const hasDomain = typeof min === "number" && typeof max === "number" && isFinite(min) && isFinite(max);
  const derivedTicks = ticks ?? (hasDomain ? niceTicks(min!, max!, 4) : undefined);

  // Gradient id
  const gradId = React.useMemo(() => `legend-grad-${Math.random().toString(36).slice(2)}`, []);

  // Tick to position (px along bar)
  const pos = (v: number) => {
    if (!hasDomain || min === max) return 0;
    return ((v - (min as number)) / ((max as number) - (min as number))) * barLen;
  };

  // Layout helpers
  const vbW = hor ? width : height;
  const vbH = hor ? height : width;

  // Title position (top-left)
  const titleX = hor ? 0 : 0;
  const titleY = 12;

  // Bar position
  const barX = hor ? 0 : pad + 2;
  const barY = hor ? 18 : 0;

  // Tick labels style
  const labelProps = { fontSize: 11, fill: "var(--text, #111827)" } as const;
  const muted = { fontSize: 10, fill: "var(--text-muted, #6b7280)" } as const;

  return (
    <svg
      className={className}
      style={{ display: "block", width: hor ? width : height, height: hor ? height : width, ...style }}
      viewBox={`0 0 ${vbW} ${vbH}`}
      role="img"
      aria-label={title ? `${title} legend` : "Heatmap legend"}
    >
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2={hor ? "100%" : "0%"} y2={hor ? "0%" : "100%"}>
          {(stops && stops.length
            ? stops
            : [
                { at: 0, color: colorMin },
                { at: 1, color: colorMax },
              ]
          ).map((s, i) => (
            <stop key={i} offset={`${clamp01(s.at) * 100}%`} stopColor={s.color} />
          ))}
        </linearGradient>
      </defs>

      {/* Title */}
      {title && (
        <text x={titleX} y={titleY} {...labelProps} fontWeight={600}>
          {title}
        </text>
      )}

      {/* Gradient bar */}
      <g transform={hor ? `translate(${(width - barLen) / 2},${barY})` : `translate(${barX},${(height - barLen) / 2}) rotate(90)`}>
        <rect x={0} y={0} width={barLen} height={barTh} rx={radius} fill={`url(#${gradId})`} />
        {/* Ticks */}
        {derivedTicks?.map((t, i) => {
          const x = pos(t);
          return (
            <g key={i} transform={`translate(${x},0)`}>
              <line x1={0} x2={0} y1={barTh} y2={barTh + 4} stroke="var(--border,#e5e7eb)" />
              <text x={0} y={barTh + 16} textAnchor="middle" {...muted}>
                {fmt(t, format, unit)}
              </text>
            </g>
          );
        })}
        {/* Min/Max labels when no ticks provided */}
        {!derivedTicks && hasDomain && (
          <>
            <text x={0} y={barTh + 16} textAnchor="start" {...muted}>
              {fmt(min!, format, unit)}
            </text>
            <text x={barLen} y={barTh + 16} textAnchor="end" {...muted}>
              {fmt(max!, format, unit)}
            </text>
          </>
        )}
      </g>
    </svg>
  );
}

/* ------------------------------- Utilities -------------------------------- */

function fmt(v: number, fmt?: (v: number) => string, unit?: string) {
  const base =
    fmt ? fmt(v) : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v);
  return unit ? `${base}${unit}` : base;
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function niceTicks(min: number, max: number, count = 4): number[] {
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
// --- IGNORE ---