// frontend/components/Chart.tsx
// Dependency-free SVG chart with axes, grid, legend, hover tooltip, multi-series.
// React 17+ compatible. Fixed typing and JSX issues.

import React, { useMemo, useState } from "react";

export type Point = { x: number; y: number };
export type Series = {
  name: string;
  points: Point[];
  stroke?: string;
  width?: number;
  dash?: string;
};

type Padding = { top: number; right: number; bottom: number; left: number };

export type ChartProps = {
  series: Series[];
  width?: number;
  height?: number;
  padding?: Padding;
  xLabel?: string;
  yLabel?: string;
  xIsTime?: boolean;
  ariaLabel?: string;
  showGrid?: boolean;
  showLegend?: boolean;
  yMin?: number;
  yMax?: number;
  xMin?: number;
  xMax?: number;
};

type Scales = {
  x: (v: number) => number;
  y: (v: number) => number;
  ix: (px: number) => number;
  minX: number; maxX: number; minY: number; maxY: number;
};

const DEFAULT_PALETTE = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#f59e0b", "#0ea5e9"];

function extent(nums: number[]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const n of nums) {
    if (Number.isFinite(n)) { if (n < lo) lo = n; if (n > hi) hi = n; }
  }
  if (lo === Infinity) return [0, 1];
  if (lo === hi) return [lo - 1, hi + 1];
  return [lo, hi];
}

function niceStep(raw: number): number {
  const pow10 = Math.pow(10, Math.floor(Math.log10(raw)));
  const div = raw / pow10;
  if (div <= 1) return 1 * pow10;
  if (div <= 2) return 2 * pow10;
  if (div <= 5) return 5 * pow10;
  return 10 * pow10;
}

function ticks(min: number, max: number, count: number): number[] {
  if (count <= 0) return [];
  const span = max - min || 1;
  const step = niceStep(span / count);
  const start = Math.ceil(min / step) * step;
  const end = Math.floor(max / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + 1e-9; v += step) out.push(+v.toFixed(12));
  return out;
}

function buildScales(
  series: Series[],
  width: number,
  height: number,
  pad: Padding,
  bounds: { xMin?: number; xMax?: number; yMin?: number; yMax?: number }
): Scales {
  const xs: number[] = [], ys: number[] = [];
  for (const s of series) for (const p of s.points) { xs.push(p.x); ys.push(p.y); }
  let [minX, maxX] = extent(xs);
  let [minY, maxY] = extent(ys);
  if (Number.isFinite(bounds.xMin!)) minX = bounds.xMin!;
  if (Number.isFinite(bounds.xMax!)) maxX = bounds.xMax!;
  if (Number.isFinite(bounds.yMin!)) minY = bounds.yMin!;
  if (Number.isFinite(bounds.yMax!)) maxY = bounds.yMax!;
  const yPad = (maxY - minY) * 0.05 || 1;
  minY -= yPad; maxY += yPad;

  const iw = Math.max(10, width - pad.left - pad.right);
  const ih = Math.max(10, height - pad.top - pad.bottom);

  const x = (v: number) => pad.left + ((v - minX) / (maxX - minX || 1)) * iw;
  const y = (v: number) => pad.top + (1 - (v - minY) / (maxY - minY || 1)) * ih;
  const ix = (px: number) => minX + ((px - pad.left) / iw) * (maxX - minX || 1);

  return { x, y, ix, minX, maxX, minY, maxY };
}

function formatX(x: number, time: boolean) {
  if (!time) return String(x);
  const d = new Date(x);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function formatNum(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + "k";
  return n.toFixed(2);
}

export default function Chart({
  series,
  width = 640,
  height = 280,
  padding = { top: 18, right: 14, bottom: 28, left: 44 },
  xLabel,
  yLabel,
  xIsTime = false,
  ariaLabel = "Chart",
  showGrid = true,
  showLegend = true,
  yMin, yMax, xMin, xMax
}: ChartProps) {
  const pad: Padding = padding;
  const scales = useMemo(
    () => buildScales(series, width, height, pad, { xMin, xMax, yMin, yMax }),
    [series, width, height, pad.left, pad.right, pad.top, pad.bottom, xMin, xMax, yMin, yMax]
  );
  const xTicks = useMemo(() => ticks(scales.minX, scales.maxX, 6), [scales.minX, scales.maxX]);
  const yTicks = useMemo(() => ticks(scales.minY, scales.maxY, 5), [scales.minY, scales.maxY]);

  const [hover, setHover] = useState<{ px: number; x: number } | null>(null);

  const paths = useMemo(() => {
    return series.map((s, i) => {
      const d = s.points.map((p, idx) => `${idx ? "L" : "M"}${scales.x(p.x)},${scales.y(p.y)}`).join(" ");
      const color = s.stroke || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
      return { name: s.name, d, color, width: s.width ?? 2, dash: s.dash };
    });
  }, [series, scales]);

  const tips = useMemo(() => {
    if (!hover) return [];
    const worldX = scales.ix(hover.px);
    const all = series.map((s, i) => {
      let best: Point | null = null, bestDx = Infinity;
      for (const p of s.points) {
        const dx = Math.abs(p.x - worldX);
        if (dx < bestDx) { bestDx = dx; best = p; }
      }
      return best ? {
        name: s.name,
        color: s.stroke || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
        x: best.x, y: best.y,
        px: scales.x(best.x), py: scales.y(best.y)
      } : null;
    }).filter(Boolean) as { name: string; color: string; x: number; y: number; px: number; py: number; }[];
    return all;
  }, [hover, series, scales]);

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={ariaLabel}
      onMouseMove={(e) => {
        const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const px = e.clientX - rect.left;
        setHover({ px, x: scales.ix(px) });
      }}
      onMouseLeave={() => setHover(null)}
      style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8 }}
    >
      {/* Grid */}
      {showGrid && yTicks.map((t, i) => (
        <line key={`gy-${i}`} x1={pad.left} x2={width - pad.right} y1={scales.y(t)} y2={scales.y(t)} stroke="#f3f4f6" />
      ))}
      {showGrid && xTicks.map((t, i) => (
        <line key={`gx-${i}`} x1={scales.x(t)} x2={scales.x(t)} y1={pad.top} y2={height - pad.bottom} stroke="#f9fafb" />
      ))}

      {/* Axes */}
      <line x1={pad.left} y1={height - pad.bottom} x2={width - pad.right} y2={height - pad.bottom} stroke="#9ca3af" />
      <line x1={pad.left} y1={pad.top} x2={pad.left} y2={height - pad.bottom} stroke="#9ca3af" />

      {/* Axis ticks & labels */}
      {xTicks.map((t, i) => (
        <g key={`xt-${i}`}>
          <line x1={scales.x(t)} x2={scales.x(t)} y1={height - pad.bottom} y2={height - pad.bottom + 5} stroke="#6b7280" />
          <text x={scales.x(t)} y={height - pad.bottom + 18} fontSize="10" textAnchor="middle" fill="#374151">
            {formatX(t, xIsTime)}
          </text>
        </g>
      ))}
      {yTicks.map((t, i) => (
        <g key={`yt-${i}`}>
          <line x1={pad.left - 5} x2={pad.left} y1={scales.y(t)} y2={scales.y(t)} stroke="#6b7280" />
          <text x={pad.left - 8} y={scales.y(t) + 3} fontSize="10" textAnchor="end" fill="#374151">
            {formatNum(t)}
          </text>
        </g>
      ))}

      {/* Axis titles */}
      {xLabel && (
        <text
          x={(width - pad.left - pad.right) / 2 + pad.left}
          y={height - 4}
          textAnchor="middle"
          fontSize="11"
          fill="#111827"
        >
          {xLabel}
        </text>
      )}
      {yLabel && (
        <text
          transform={`rotate(-90 ${12} ${(height - pad.top - pad.bottom) / 2 + pad.top})`}
          x={12}
          y={(height - pad.top - pad.bottom) / 2 + pad.top}
          textAnchor="middle"
          fontSize="11"
          fill="#111827"
        >
          {yLabel}
        </text>
      )}

      {/* Series */}
      {paths.map((p, i) => (
        <path
          key={`p-${i}`}
          d={p.d}
          fill="none"
          stroke={p.color}
          strokeWidth={p.width}
          strokeLinejoin="round"
          strokeLinecap="round"
          strokeDasharray={p.dash}
        />
      ))}

      {/* Hover line & points */}
      {hover && <line x1={hover.px} x2={hover.px} y1={pad.top} y2={height - pad.bottom} stroke="#d1d5db" />}
      {tips.map((t, i) => (
        <g key={`tip-${i}`}>
          <circle cx={t.px} cy={t.py} r={3.2} fill="#fff" stroke={t.color} strokeWidth={2} />
        </g>
      ))}

      {/* Tooltip */}
      {hover && tips.length > 0 && (
        <foreignObject
          x={Math.min(hover.px + 12, width - 200)}
          y={pad.top + 8}
          width={188}
          height={Math.min(220, 24 + tips.length * 18)}
        >
          {/* Note: no xmlns attribute (fixes React TS JSX warning) */}
          <div
            style={{
              fontSize: 12,
              background: "rgba(255,255,255,0.98)",
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              padding: "6px 8px",
              boxShadow: "0 2px 8px rgba(0,0,0,0.06)"
            }}
          >
            <div style={{ marginBottom: 4, color: "#374151" }}>
              <strong>{xIsTime ? new Date(scales.ix(hover.px)).toLocaleString() : formatNum(scales.ix(hover.px))}</strong>
            </div>
            {tips.map((t, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span aria-hidden style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: t.color }} />
                <span style={{ color: "#374151" }}>{t.name}:</span>
                <span style={{ marginLeft: "auto", color: "#111827" }}>{formatNum(t.y)}</span>
              </div>
            ))}
          </div>
        </foreignObject>
      )}

      {/* Legend */}
      {showLegend && paths.length > 0 && (
        <g>
          {paths.map((p, i) => {
            const x = pad.left + i * 140;
            const y = pad.top - 6;
            return (
              <g key={`lg-${i}`} transform={`translate(${x}, ${y})`}>
                <rect x={0} y={-12} width={120} height={16} fill="white" opacity={0.7} rx={4} />
                <line x1={8} y1={-4} x2={28} y2={-4} stroke={p.color} strokeWidth={p.width} strokeDasharray={p.dash} />
                <text x={34} y={-2} fontSize="10" fill="#111827">{p.name}</text>
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );
}