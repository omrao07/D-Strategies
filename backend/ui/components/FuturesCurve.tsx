// components/futurescurve.tsx
// Lightweight Futures Curve chart (SVG, no deps)

import React, { useMemo, useState } from "react";

/* ----------------------------- Types/Props ----------------------------- */

export interface FuturesPoint {
  exp: Date | string | number;   // expiration
  price: number;                 // settlement/mark
  symbol?: string;               // optional label (e.g., "H25")
}

export interface FuturesCurveProps {
  points: FuturesPoint[];
  title?: string;
  currency?: string;             // "$", "₹", etc (prefix for axis/tooltip)
  className?: string;
  style?: React.CSSProperties;
}

/* --------------------------------- UI ---------------------------------- */

export default function FuturesCurve({
  points,
  title = "Futures Curve",
  currency = "",
  className,
  style,
}: FuturesCurveProps) {
  // --- normalize & sort by expiry
  const parsed = useMemo(() => {
    const arr = points
      .map((p) => ({
        t: toTime(p.exp),          // ms epoch
        exp: toDate(p.exp),
        price: toNum(p.price),
        symbol: p.symbol,
      }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.price))
      .sort((a, b) => a.t - b.t);
    return arr;
  }, [points]);

  // --- bounds
  const yLo = useMemo(() => {
    const ys = parsed.map((p) => p.price);
    if (!ys.length) return 0;
    const min = Math.min(...ys);
    return min - (Math.abs(min) || 1) * 0.1;
  }, [parsed]);
  const yHi = useMemo(() => {
    const ys = parsed.map((p) => p.price);
    if (!ys.length) return 1;
    const max = Math.max(...ys);
    return max + (Math.abs(max) || 1) * 0.1;
  }, [parsed]);

  // time bounds (FIX for the squiggle: parenthesize)
  const xStart = parsed.length ? parsed[0].t : Date.now();
  const xEnd   = parsed.length ? parsed[parsed.length - 1].t : Date.now();

  // --- ticks (nice)
  const xTicks = useMemo(
    () => niceDateTicks(xStart, xEnd, 5),
    [xStart, xEnd]
  );
  const yTicks = useMemo(() => niceTicks(yLo, yHi, 5), [yLo, yHi]);

  // --- hover
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const overIdx = hoverIdx ?? null;

  // --- sizing & scales
  const W = 900, H = 300;
  const m = { t: 16, r: 16, b: 34, l: 64 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;

  const x = (t: number) => ((t - xStart) / (xEnd - xStart || 1)) * iw;
  const y = (v: number) => ih - ((v - yLo) / (yHi - yLo || 1)) * ih;

  // --- path builders
  const linePath = (pts: typeof parsed) =>
    pts.map((p, i) => `${i ? "L" : "M"}${x(p.t)},${y(p.price)}`).join(" ");

  const areaPath = (pts: typeof parsed) => {
    if (!pts.length) return "";
    const top = linePath(pts);
    const last = pts[pts.length - 1];
    const first = pts[0];
    return `${top} L ${x(last.t)},${y(yLo)} L ${x(first.t)},${y(yLo)} Z`;
  };

  // --- rendered pieces
  const path = linePath(parsed);
  const area = areaPath(parsed);

  return (
    <div className={className} style={{ ...frame, ...style }}>
      <div style={header}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{title}</h3>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H, display: "block" }}>
        <rect x={0} y={0} width={W} height={H} fill="var(--surface,#fff)" rx={12} />
        <g transform={`translate(${m.l},${m.t})`}>
          {/* y grid + labels */}
          {yTicks.map((v, i) => (
            <g key={`gy-${i}`}>
              <line x1={0} y1={y(v)} x2={iw} y2={y(v)} stroke="var(--border,#e5e7eb)" strokeDasharray="2,3" />
              <text x={-8} y={y(v)} fontSize="11" textAnchor="end" dominantBaseline="middle" fill="var(--text-muted,#6b7280)">
                {fmtMoney(v, currency)}
              </text>
            </g>
          ))}

          {/* x axis ticks */}
          <line x1={0} y1={ih} x2={iw} y2={ih} stroke="var(--gray-300,#d1d5db)" />
          {xTicks.map((t, i) => (
            <g key={`gx-${i}`} transform={`translate(${x(t)},0)`}>
              <line y1={ih} y2={ih + 4} stroke="var(--border,#e5e7eb)" />
              <text y={ih + 16} fontSize="11" textAnchor="middle" fill="var(--text-muted,#6b7280)">
                {formatDateTick(t)}
              </text>
            </g>
          ))}

          {/* area + line */}
          <path d={area} fill="var(--brand-50,#eef2ff)" />
          <path d={path} fill="none" stroke="var(--primary,#6366f1)" strokeWidth={2} />

          {/* points + hover */}
          {parsed.map((p, i) => {
            const cx = x(p.t), cy = y(p.price);
            const active = overIdx === i;
            return (
              <g
                key={i}
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
              >
                <circle cx={cx} cy={cy} r={active ? 4 : 3} fill={active ? "var(--primary,#6366f1)" : "var(--success,#10b981)"} />
                {active && (
                  <g transform={`translate(${cx},${cy - 10})`}>
                    <rect x={8} y={-28} width={180} height={40} rx={6} fill="white" stroke="var(--border,#e5e7eb)" />
                    <text x={16} y={-12} fontSize="11" fill="var(--text,#111827)">{p.symbol ?? p.exp.toLocaleDateString?.() ?? formatDateTick(p.t)}</text>
                    <text x={16} y={4} fontSize="12" fontWeight={700} fill="var(--primary,#6366f1)">{fmtMoney(p.price, currency)}</text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

/* ------------------------------- Helpers -------------------------------- */

function toDate(d: Date | string | number): Date {
  return d instanceof Date ? d : new Date(d);
}
function toTime(d: Date | string | number): number {
  const t = (d instanceof Date ? d : new Date(d)).getTime();
  return Number.isFinite(t) ? t : NaN;
}
function toNum(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? v : NaN;
}

function fmtMoney(n: number, cur = "") {
  const s = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);
  return cur ? `${cur}${s}` : s;
}

/** Nice linear ticks for numbers */
function niceTicks(min: number, max: number, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) return [min];
  const span = max - min;
  const step = niceStep(span / Math.max(1, count - 1));
  const smin = Math.floor(min / step) * step;
  const smax = Math.ceil(max / step) * step;
  const n = Math.max(2, Math.round((smax - smin) / step) + 1);
  return Array.from({ length: n }, (_, i) => smin + i * step);
}
function niceStep(raw: number) {
  const pow10 = Math.pow(10, Math.floor(Math.log10(raw)));
  const err = raw / pow10;
  const mult = err >= 7.5 ? 10 : err >= 3 ? 5 : err >= 1.5 ? 2 : 1;
  return mult * pow10;
}

/** Nice date ticks: returns ms epochs */
function niceDateTicks(startMs: number, endMs: number, count = 5): number[] {
  if (!(Number.isFinite(startMs) && Number.isFinite(endMs))) return [Date.now()];
  if (startMs === endMs) return [startMs];
  const span = Math.abs(endMs - startMs);
  const stepMs = pickDateStep(span / Math.max(1, count - 1));
  const lo = Math.min(startMs, endMs);
  const hi = Math.max(startMs, endMs);
  const first = Math.ceil(lo / stepMs) * stepMs;
  const out: number[] = [];
  for (let t = first; t <= hi + 1e-6; t += stepMs) out.push(t);
  return out;
}
function pickDateStep(targetMs: number) {
  // common calendar-ish steps
  const H = 3600e3, D = 86400e3, W = 7 * D, M = 30 * D, Q = 90 * D, Y = 365 * D;
  const steps = [D, 2 * D, 3 * D, W, 2 * W, M, 2 * M, Q, 2 * Q, Y];
  let best = steps[0];
  for (const s of steps) if (Math.abs(s - targetMs) < Math.abs(best - targetMs)) best = s;
  return best;
}
function formatDateTick(ms: number) {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
}

/* -------------------------------- Styles -------------------------------- */

const frame: React.CSSProperties = {
  background: "var(--surface,#fff)",
  border: "1px solid var(--border,#e5e7eb)",
  borderRadius: 12,
  padding: 10,
  boxShadow: "var(--shadow-sm,0 1px 2px rgba(0,0,0,0.06))",
  color: "var(--text,#111827)",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 6,
};
// utils/dates.ts
// Pure TypeScript date utilities (no imports).

// -------------------- Basic date math --------------------
export function startOfUTC(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function toISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function diffDays(later: Date, earlier: Date): number {
  const ms = startOfUTC(later).getTime() - startOfUTC(earlier).getTime();
  return Math.round(ms / 864e5);
}

export function addDays(date: Date, count: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + count);
  return d;
}

// -------------------- Business days --------------------
export type DayCount = "ACT/365" | "ACT/360" | "30/360" | "30E/360"; // Euro 30/360

export function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

export function addBusinessDays(date: Date, count: number): Date {
  let d = new Date(date);
  const step = count < 0 ? -1 : 1;
  let n = Math.abs(count);
  while (n > 0) {
    d.setUTCDate(d.getUTCDate() + step);
    if (!isWeekend(d)) n -= 1;
  }
  return d;
}

export function businessDaysBetween(later: Date, earlier: Date): number {
  let count = 0;
  let d = new Date(earlier);
  const end = startOfUTC(later).getTime();
  while (d.getTime() < end) {
    if (!isWeekend(d)) count += 1;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}   