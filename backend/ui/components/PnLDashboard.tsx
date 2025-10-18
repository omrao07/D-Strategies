// components/pnldashboard.tsx
// Portfolio P&L Dashboard — React TSX, zero dependencies.
// - Summary tiles (MTD / YTD / Total / Win Rate)
// - Equity curve (SVG line) + Daily P&L bars
// - Distribution histogram of daily P&L
// - Filter bar: date range, symbol, strategy, realized/unrealized toggle, search notes
// - Breakdown tables: by Symbol, by Strategy, by Month
//
// Drop-in: just pass `entries` (order agnostic). No external CSS required.

import React, { useMemo, useState } from "react";

/* ---------------------------------- Types --------------------------------- */

export interface PnLEntry {
  date: string | Date;        // trading day
  symbol?: string;            // e.g., "NIFTY", "AAPL"
  strategy?: string;          // e.g., "Covered Call", "Scalp"
  realized?: number;          // realized P&L for the day
  unrealized?: number;        // mark-to-market change (end of day)
  fees?: number;              // commissions, fees (negative)
  notes?: string;             // optional free text
  // Optional explicit equity/cash deltas if you have them:
  equityDelta?: number;       // will override realized+unrealized+fees if present
}

export interface PnLDashboardProps {
  entries: PnLEntry[];
  currency?: string;                  // "$", "₹", ...
  loading?: boolean;
  error?: string;
  // Optional seed for equity curve start; otherwise start at 0
  startingEquity?: number;
  className?: string;
  style?: React.CSSProperties;
}

/* -------------------------------- Component -------------------------------- */

export default function PnLDashboard({
  entries,
  currency = "",
  loading,
  error,
  startingEquity = 0,
  className,
  style,
}: PnLDashboardProps) {
  // ---------- Filters ----------
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [symbol, setSymbol] = useState<string>("");
  const [strategy, setStrategy] = useState<string>("");
  const [onlyRealized, setOnlyRealized] = useState<boolean>(false);
  const [q, setQ] = useState<string>(""); // search notes

  // ---------- Prep & Filter ----------
  const norm = useMemo(() => normalizeEntries(entries), [entries]);

  const symbols = useMemo(() => unique(norm.map(e => e.symbol).filter(Boolean) as string[]), [norm]);
  const strategies = useMemo(() => unique(norm.map(e => e.strategy).filter(Boolean) as string[]), [norm]);

  const filtered = useMemo(() => {
    const fromTs = from ? +new Date(from) : -Infinity;
    const toTs = to ? +new Date(to) : Infinity;
    const ql = q.trim().toLowerCase();
    return norm.filter(e => {
      if (!(+e.date >= fromTs && +e.date <= toTs)) return false;
      if (symbol && e.symbol !== symbol) return false;
      if (strategy && e.strategy !== strategy) return false;
      if (ql && !(e.notes?.toLowerCase().includes(ql))) return false;
      return true;
    }).map(e => ({
      ...e,
      pnl: onlyRealized ? (e.realized + (e.fees ?? 0)) : e.pnl, // realized view
    }));
  }, [norm, from, to, symbol, strategy, onlyRealized, q]);

  const byDay = useMemo(() => rollDaily(filtered), [filtered]);
  const equity = useMemo(() => buildEquityCurve(byDay, startingEquity), [byDay, startingEquity]);

  // ---------- KPIs ----------
  const totals = useMemo(() => {
    const total = sum(byDay.map(d => d.pnl));
    const fees = sum(filtered.map(e => e.fees ?? 0));
    const r = sum(filtered.map(e => e.realized ?? 0));
    const u = sum(filtered.map(e => e.unrealized ?? 0));
    const mtd = sum(byDay.filter(d => sameMonth(d.date, new Date())).map(d => d.pnl));
    const ytd = sum(byDay.filter(d => d.date.getFullYear() === new Date().getFullYear()).map(d => d.pnl));
    const wins = byDay.filter(d => d.pnl > 0).length;
    const wr = byDay.length ? (wins / byDay.length) * 100 : 0;
    return { total, fees, realized: r, unrealized: u, mtd, ytd, winRate: wr };
  }, [byDay, filtered]);

  // ---------- Breakdowns ----------
  const bySym = useMemo(() => groupSum(filtered, e => e.symbol ?? "(none)"), [filtered]);
  const byStrat = useMemo(() => groupSum(filtered, e => e.strategy ?? "(none)"), [filtered]);
  const byMonth = useMemo(() => groupSum(filtered, e => labelYYYYMM(e.date)), [filtered]);

  // ---------- Render ----------
  return (
    <div className={className} style={{ ...frame, ...style }}>
      {/* Toolbar */}
      <div style={toolbar}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>P&amp;L Dashboard</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Field label="From">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={input} />
          </Field>
          <Field label="To">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={input} />
          </Field>
          <Field label="Symbol">
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)} style={select}>
              <option value="">All</option>
              {symbols.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Strategy">
            <select value={strategy} onChange={(e) => setStrategy(e.target.value)} style={select}>
              <option value="">All</option>
              {strategies.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Notes">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" style={{ ...input, width: 160 }} />
          </Field>
          <label style={check}>
            <input type="checkbox" checked={onlyRealized} onChange={(e) => setOnlyRealized(e.target.checked)} />
            Realized only
          </label>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div role="alert" style={errorBox}>{error}</div>
      )}

      {/* Summary tiles */}
      <div style={tiles}>
        <Tile title="MTD P&L" value={fmtMoney(totals.mtd, currency)} tone={tonePNL(totals.mtd)} />
        <Tile title="YTD P&L" value={fmtMoney(totals.ytd, currency)} tone={tonePNL(totals.ytd)} />
        <Tile title="Total P&L" value={fmtMoney(totals.total, currency)} tone={tonePNL(totals.total)} />
        <Tile title="Win Rate" value={`${fmtPct(totals.winRate)}`} subtitle={`${byDay.length} days`} />
        <Tile title="Realized" value={fmtMoney(totals.realized, currency)} />
        <Tile title="Unrealized" value={fmtMoney(totals.unrealized, currency)} />
        <Tile title="Fees" value={fmtMoney(totals.fees, currency)} tone="danger" />
      </div>

      {/* Charts */}
      <div style={chartsGrid}>
        <Panel title="Equity Curve">
          {loading ? <Skeleton height={220} /> : <EquityCurve data={equity} currency={currency} />}
        </Panel>
        <Panel title="Daily P&L">
          {loading ? <Skeleton height={220} /> : <DailyBars days={byDay} currency={currency} />}
        </Panel>
        <Panel title="P&L Distribution">
          {loading ? <Skeleton height={220} /> : <Histogram days={byDay} bins={20} currency={currency} />}
        </Panel>
      </div>

      {/* Tables */}
      <div style={tablesGrid}>
        <Table
          title="By Symbol"
          rows={bySym.map(([k, v]) => ({ key: k, value: v }))}
          currency={currency}
        />
        <Table
          title="By Strategy"
          rows={byStrat.map(([k, v]) => ({ key: k, value: v }))}
          currency={currency}
        />
        <Table
          title="By Month"
          rows={byMonth.map(([k, v]) => ({ key: k, value: v }))}
          currency={currency}
        />
      </div>

      {(!loading && filtered.length === 0) && (
        <Empty title="No matching entries" description="Adjust filters or load more data." />
      )}
    </div>
  );
}

/* --------------------------------- Charts --------------------------------- */

function EquityCurve({ data, currency }: { data: { t: Date; equity: number }[]; currency?: string }) {
  const W = 900, H = 260; const m = { t: 12, r: 12, b: 28, l: 56 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const xs = data.map(d => +d.t);
  const ys = data.map(d => d.equity);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const x = (t: number) => (iw * (t - xMin)) / (xMax - xMin || 1);
  const y = (v: number) => ih - (ih * (v - yMin)) / (yMax - yMin || 1);
  const path = data.map((d, i) => `${i ? "L" : "M"}${x(+d.t)},${y(d.equity)}`).join(" ");
  const ticks = 5;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H, display: "block" }} role="img" aria-label="Equity curve">
      <rect x={0} y={0} width={W} height={H} fill="var(--surface,#fff)" rx={12} />
      <g transform={`translate(${m.l},${m.t})`}>
        {Array.from({ length: ticks }).map((_, i) => {
          const v = yMin + ((yMax - yMin) * i) / (ticks - 1);
          return (
            <g key={`gy-${i}`}>
              <line x1={0} x2={iw} y1={y(v)} y2={y(v)} stroke="var(--border,#e5e7eb)" strokeDasharray="2,3" />
              <text x={-8} y={y(v)} fontSize="11" textAnchor="end" dominantBaseline="middle" fill="var(--text-muted,#6b7280)">
                {fmtMoney(v, currency)}
              </text>
            </g>
          );
        })}
        <path d={path} fill="none" stroke="var(--primary,#6366f1)" strokeWidth={2} />
      </g>
    </svg>
  );
}

function DailyBars({ days, currency }: { days: { date: Date; pnl: number }[]; currency?: string }) {
  const W = 900, H = 260; const m = { t: 12, r: 12, b: 28, l: 56 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const xs = days.map(d => +d.date);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(0, ...days.map(d => d.pnl));
  const yMax = Math.max(0, ...days.map(d => d.pnl));
  const x = (t: number) => (iw * (t - xMin)) / (xMax - xMin || 1);
  const y = (v: number) => ih - (ih * (v - yMin)) / (yMax - yMin || 1);
  const bw = Math.max(2, iw / Math.max(1, days.length)); // bar width
  const ticks = 5;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H, display: "block" }} role="img" aria-label="Daily P&L">
      <rect x={0} y={0} width={W} height={H} fill="var(--surface,#fff)" rx={12} />
      <g transform={`translate(${m.l},${m.t})`}>
        {Array.from({ length: ticks }).map((_, i) => {
          const v = yMin + ((yMax - yMin) * i) / (ticks - 1);
          return (
            <g key={`gy-${i}`}>
              <line x1={0} x2={iw} y1={y(v)} y2={y(v)} stroke="var(--border,#e5e7eb)" strokeDasharray="2,3" />
              <text x={-8} y={y(v)} fontSize="11" textAnchor="end" dominantBaseline="middle" fill="var(--text-muted,#6b7280)">
                {fmtMoney(v, currency)}
              </text>
            </g>
          );
        })}
        {/* zero line */}
        <line x1={0} x2={iw} y1={y(0)} y2={y(0)} stroke="var(--gray-300,#d1d5db)" />
        {/* bars */}
        {days.map((d, i) => {
          const cx = x(+d.date);
          const val = d.pnl;
          const fill = val >= 0 ? "var(--success,#10b981)" : "var(--danger,#ef4444)";
          const by = Math.min(y(0), y(val));
          const bh = Math.abs(y(val) - y(0));
          return <rect key={i} x={cx - bw / 2} y={by} width={Math.max(2, bw * 0.8)} height={bh} rx={4} fill={fill} />;
        })}
      </g>
    </svg>
  );
}

function Histogram({ days, bins = 20, currency }: { days: { date: Date; pnl: number }[]; bins?: number; currency?: string }) {
  const values = days.map(d => d.pnl);
  const min = Math.min(...values, 0), max = Math.max(...values, 0);
  const edges = linspace(min, max, Math.max(3, bins));
  const counts = new Array(edges.length - 1).fill(0);
  for (let v of values) {
    const i = Math.min(edges.length - 2, Math.max(0, Math.floor(((v - min) / (max - min || 1)) * (edges.length - 1))));
    counts[i]++;
  }
  const W = 900, H = 260; const m = { t: 12, r: 12, b: 28, l: 56 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = (i: number) => (iw * i) / (counts.length - 1 || 1);
  const y = (c: number) => ih - (ih * c) / (Math.max(...counts) || 1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H, display: "block" }} role="img" aria-label="P&L distribution">
      <rect x={0} y={0} width={W} height={H} fill="var(--surface,#fff)" rx={12} />
      <g transform={`translate(${m.l},${m.t})`}>
        {counts.map((c, i) => {
          const bx = x(i);
          const bw = Math.max(3, iw / counts.length * 0.9);
          return <rect key={i} x={bx - bw / 2} y={y(c)} width={bw} height={ih - y(c)} rx={3} fill="var(--brand-300,#a5b4fc)" />;
        })}
        {/* x-axis min/max labels */}
        <text x={0} y={ih + 16} fontSize="11" fill="var(--text-muted,#6b7280)">{fmtMoney(min, currency)}</text>
        <text x={iw} y={ih + 16} fontSize="11" textAnchor="end" fill="var(--text-muted,#6b7280)">{fmtMoney(max, currency)}</text>
      </g>
    </svg>
  );
}

/* --------------------------------- Tables --------------------------------- */

function Table({ title, rows, currency }: { title: string; rows: { key: string; value: number }[]; currency?: string }) {
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  return (
    <div style={{ border: "1px solid var(--border,#e5e7eb)", borderRadius: 12, overflow: "hidden", background: "var(--bg,#fff)" }}>
      <div style={{ padding: "8px 10px", fontWeight: 700, fontSize: 12, background: "var(--gray-50,#f8fafc)" }}>{title}</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={i} style={{ borderTop: "1px solid var(--border,#e5e7eb)" }}>
              <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>{r.key}</td>
              <td style={{ padding: "8px 10px", textAlign: "right", whiteSpace: "nowrap", color: toneColor(r.value) }}>
                {fmtMoney(r.value, currency)}
              </td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={2} style={{ padding: 12, color: "var(--text-muted,#6b7280)" }}>No data</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--border,#e5e7eb)", borderRadius: 12, overflow: "hidden", background: "var(--bg,#fff)" }}>
      <div style={{ padding: "8px 10px", fontWeight: 700, fontSize: 12, background: "var(--gray-50,#f8fafc)" }}>{title}</div>
      <div style={{ padding: 10 }}>{children}</div>
    </div>
  );
}

/* -------------------------------- Primitives ------------------------------- */

function Tile({
  title,
  value,
  subtitle,
  tone = "neutral",
}: { title: string; value: string | number; subtitle?: string; tone?: "neutral" | "success" | "danger" }) {
  const toneCol =
    tone === "success" ? "var(--success,#10b981)" :
    tone === "danger" ? "var(--danger,#ef4444)" : "var(--text,#111827)";
  return (
    <div style={{ border: "1px solid var(--border,#e5e7eb)", borderRadius: 12, padding: 12, background: "var(--bg,#fff)" }}>
      <div style={{ fontSize: 12, color: "var(--text-muted,#6b7280)" }}>{title}</div>
      <div style={{ marginTop: 6, fontSize: 20, fontWeight: 700, color: toneCol }}>{value}</div>
      {subtitle && <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-muted,#6b7280)" }}>{subtitle}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--text-muted,#6b7280)" }}>{label}</span>
      {children}
    </label>
  );
}

function Skeleton({ height = 220 }: { height?: number }) {
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

function Empty({ title, description }: { title: string; description?: string }) {
  return (
    <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted,#6b7280)" }}>
      <div style={{ fontSize: 36, lineHeight: 1 }}>🗂️</div>
      <div style={{ fontWeight: 600, marginTop: 6, color: "var(--text,#111827)" }}>{title}</div>
      {description && <div style={{ fontSize: 13, marginTop: 4 }}>{description}</div>}
    </div>
  );
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

const tiles: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
  gap: 10,
  marginTop: 10,
};

const chartsGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "2fr 2fr 1.5fr",
  gap: 10,
  marginTop: 10,
};

const tablesGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: 10,
  marginTop: 10,
};

const input: React.CSSProperties = {
  border: "1px solid var(--border,#e5e7eb)",
  borderRadius: 10,
  padding: "6px 10px",
  background: "var(--bg,#fff)",
  color: "inherit",
  outline: "none",
  fontSize: 14,
};

const select: React.CSSProperties = {
  ...input,
};

const check: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
};

const errorBox: React.CSSProperties = {
  marginTop: 8,
  padding: "6px 10px",
  borderRadius: 10,
  border: "1px solid var(--danger,#ef4444)",
  color: "var(--danger,#ef4444)",
  background: "var(--red-50,#fef2f2)",
};

/* --------------------------------- Utils ---------------------------------- */

type Norm = {
  date: Date;
  symbol?: string;
  strategy?: string;
  realized: number;
  unrealized: number;
  fees: number;
  notes?: string;
  pnl: number; // realized + unrealized + fees (unless equityDelta provided)
};

function normalizeEntries(entries: PnLEntry[]): Norm[] {
  const out: Norm[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const d = e.date instanceof Date ? e.date : new Date(e.date);
    const realized = num(e.realized);
    const unrealized = num(e.unrealized);
    const fees = num(e.fees);
    const pnl = typeof e.equityDelta === "number"
      ? e.equityDelta
      : realized + unrealized + fees;
    out.push({
      date: d,
      symbol: e.symbol?.trim() || undefined,
      strategy: e.strategy?.trim() || undefined,
      realized, unrealized, fees,
      notes: e.notes,
      pnl,
    });
  }
  return out;
}

function rollDaily(xs: Norm[]): { date: Date; pnl: number }[] {
  const map = new Map<number, number>();
  for (let i = 0; i < xs.length; i++) {
    const t = +stripTime(xs[i].date);
    map.set(t, (map.get(t) ?? 0) + xs[i].pnl);
  }
  const arr = Array.from(map.entries()).map(([t, v]) => ({ date: new Date(t), pnl: v }));
  arr.sort((a, b) => +a.date - +b.date);
  return arr;
}

function buildEquityCurve(days: { date: Date; pnl: number }[], start = 0) {
  let acc = start;
  const out: { t: Date; equity: number }[] = [];
  for (let i = 0; i < days.length; i++) {
    acc += days[i].pnl;
    out.push({ t: days[i].date, equity: acc });
  }
  if (out.length === 0) out.push({ t: new Date(), equity: start });
  return out;
}

function groupSum<T>(xs: T[], key: (x: T) => string) {
  const map = new Map<string, number>();
  for (let i = 0; i < xs.length; i++) {
    const k = key(xs[i]) || "(none)";
    const v = (xs[i] as any).pnl as number;
    map.set(k, (map.get(k) ?? 0) + (isFinite(v) ? v : 0));
  }
  return Array.from(map.entries());
}

function labelYYYYMM(d: Date | string | number) {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = dt.toLocaleString(undefined, { month: "short" });
  return `${m} ${y}`;
}

function sameMonth(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function stripTime(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function unique(xs: string[]) {
  return Array.from(new Set(xs)).sort();
}

function sum(xs: number[]) { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[i]; return s; }
function num(n?: number) { return typeof n === "number" && isFinite(n) ? n : 0; }

function fmtMoney(n?: number | null, cur?: string) {
  if (!(typeof n === "number" && isFinite(n))) return "—";
  const s = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);
  return cur ? `${cur}${s}` : s;
}
function fmtPct(n?: number | null) {
  if (!(typeof n === "number" && isFinite(n))) return "—";
  const x = Math.abs(n);
  const d = x >= 100 ? 0 : x >= 10 ? 1 : 2;
  const s = x.toFixed(d).replace(/\.0+$/, "");
  return `${n < 0 ? "-" : ""}${s}%`;
}
function tonePNL(n: number) { return n > 0 ? "success" : n < 0 ? "danger" : "neutral"; }
function toneColor(n: number) {
  return n > 0 ? "var(--success,#10b981)" : n < 0 ? "var(--danger,#ef4444)" : "inherit";
}
function linspace(a: number, b: number, n: number) {
  if (n <= 1) return [a];
  const step = (b - a) / (n - 1);
  return Array.from({ length: n }, (_, i) => a + i * step);
}

/* ------------------------------ Keyframes CSS ----------------------------- */

(function ensureKeyframes() {
  if (typeof document === "undefined") return;
  const id = "pnldashboard-inline-anim";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
@keyframes sk { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
`;
  document.head.appendChild(style);
})();
