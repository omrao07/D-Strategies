// components/optionsworkbench.tsx
// Options Strategy Workbench — React TSX, no external deps.

import React, { useMemo, useState } from "react";

/* ------------------------------- Types -------------------------------- */

export type Side = "C" | "P";
export type Action = "BUY" | "SELL";

export interface Leg {
  id: string;
  side: Side;
  action: Action;
  strike: number;
  qty: number;
  premium: number;
  iv?: number;           // % (e.g., 20)
  expiry?: string | Date;
}

export interface OptionsWorkbenchProps {
  spot: number;
  legs?: Leg[];
  r?: number;                 // risk-free annual (0.05 = 5%)
  daysToExpiry?: number;      // for greeks when expiry missing
  currency?: string;
  showGreeksByDefault?: boolean;
  onChange?: (legs: Leg[]) => void;
  className?: string;
  style?: React.CSSProperties;
}

/* ------------------------------ Component ----------------------------- */

export default function OptionsWorkbench({
  spot: spotInit,
  legs: legsInit = [],
  r = 0,
  daysToExpiry = 30,
  currency = "",
  showGreeksByDefault = false,
  onChange,
  className,
  style,
}: OptionsWorkbenchProps) {
  const [spot, setSpot] = useState(spotInit);
  const [rate, setRate] = useState(r);
  const [rangeMin, setRangeMin] = useState(Math.max(0, spotInit * 0.6));
  const [rangeMax, setRangeMax] = useState(spotInit * 1.4);
  const [points, setPoints] = useState(181);
  const [useGreeks, setUseGreeks] = useState(showGreeksByDefault);
  const [benchDays, setBenchDays] = useState(daysToExpiry);
  const [legs, setLegs] = useState<Leg[]>([...legsInit]);

  // ---- leg helpers
  const patch = (i: number, p: Partial<Leg>) =>
    setLegs(prev => {
      const next = [...prev];
      next[i] = { ...next[i], ...p };
      onChange?.(next);
      return next;
    });

  const addLeg = (side: Side, action: Action) => {
    const id = Math.random().toString(36).slice(2);
    const K = roundTo(spot, 1);
    const leg: Leg = { id, side, action, strike: K, qty: 1, premium: 1, iv: 20 };
    setLegs(prev => {
      const next = [...prev, leg];
      onChange?.(next);
      return next;
    });
  };
  const removeLeg = (i: number) =>
    setLegs(prev => {
      const next = prev.filter((_, idx) => idx !== i);
      onChange?.(next);
      return next;
    });
  const clearLegs = () => {
    setLegs([]);
    onChange?.([]);
  };

  // ---- grid + totals
  const grid = useMemo(
    () => linspace(rangeMin, rangeMax, clamp(Math.floor(points), 21, 2001)),
    [rangeMin, rangeMax, points]
  );

  const totals = useMemo(() => {
    const netPrem = legs.reduce((s, l) => s + signed(l) * l.premium * Math.abs(l.qty), 0);
    const pnl = grid.map(S => -netPrem + legs.reduce((a, l) => a + payoffAtExpiry(l, S), 0));
    return {
      netPremium: netPrem,
      pnl,
      breakevens: findBreakevens(grid, pnl),
      maxGain: Math.max(...pnl),
      maxLoss: Math.min(...pnl),
    };
  }, [legs, grid]);

  const greeks = useMemo(() => {
    if (!useGreeks) return null;
    const T = Math.max(0, benchDays) / 365;
    const agg = { delta: 0, gamma: 0, vega: 0, theta: 0, price: 0 };
    for (const l of legs) {
      const q = signed(l) * Math.abs(l.qty);
      const sigma = toSigma(l.iv);
      if (!(sigma > 0) || T === 0) {
        agg.price += q * l.premium;
        continue;
      }
      const g = bsGreeks(spot, l.strike, rate, sigma, T, l.side);
      const pr = bsPrice(spot, l.strike, rate, sigma, T, l.side);
      agg.delta += q * g.delta;
      agg.gamma += q * g.gamma;
      agg.vega  += q * (g.vega / 100); // per 1 vol point
      agg.theta += q * (g.theta / 365);
      agg.price += q * pr;
    }
    return agg;
  }, [useGreeks, legs, spot, rate, benchDays]);

  /* ------------------------------- Render ------------------------------- */

  return (
    <div className={className} style={{ ...frame, ...style }}>
      {/* Toolbar */}
      <div style={toolbar}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Options Workbench</h2>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Field label="Spot"><NumberInput value={spot} onChange={setSpot} width={100} /></Field>
          <Field label="Rate (r)"><NumberInput value={rate} onChange={setRate} width={90} step={0.001} /></Field>
          <Field label="Days"><NumberInput value={benchDays} onChange={v => setBenchDays(Math.max(0, Math.round(v)))} width={80} step={1} /></Field>

          <Field label="Range">
            <NumberInput value={rangeMin} onChange={setRangeMin} width={100} />
            <span>→</span>
            <NumberInput value={rangeMax} onChange={setRangeMax} width={100} />
          </Field>

          <Field label="Points"><NumberInput value={points} onChange={setPoints} width={80} step={20} /></Field>

          <label style={check}>
            <input type="checkbox" checked={useGreeks} onChange={e => setUseGreeks(e.target.checked)} />
            Greeks / MTM
          </label>

          <button type="button" onClick={() => addLeg("C", "BUY")} style={btn}>+ Buy Call</button>
          <button type="button" onClick={() => addLeg("P", "BUY")} style={btn}>+ Buy Put</button>
          <button type="button" onClick={() => addLeg("C", "SELL")} style={btnGhost}>+ Sell Call</button>
          <button type="button" onClick={() => addLeg("P", "SELL")} style={btnGhost}>+ Sell Put</button>
          <button type="button" onClick={clearLegs} style={btnDanger}>Clear</button>
        </div>
      </div>

      {/* Tiles */}
      <div style={tiles}>
        <Tile title="Net Premium" value={fmtMoney(totals.netPremium, currency)} subtitle={totals.netPremium >= 0 ? "Credit" : "Debit"} tone={totals.netPremium >= 0 ? "success" : "danger"} />
        <Tile title="Max Gain*" value={fmtMoney(totals.maxGain, currency)} subtitle="within range" />
        <Tile title="Max Loss*" value={fmtMoney(totals.maxLoss, currency)} subtitle="within range" />
        <Tile title="Breakevens" value={totals.breakevens.length ? totals.breakevens.map(b => fmtNum(b)).join(", ") : "—"} subtitle="approx" />
        {useGreeks && greeks && (
          <>
            <Tile title="Δ" value={fmtNum(greeks.delta, 3)} />
            <Tile title="Γ" value={fmtNum(greeks.gamma, 6)} />
            <Tile title="Vega" value={fmtNum(greeks.vega, 3)} subtitle="per 1 vol pt" />
            <Tile title="Theta" value={fmtNum(greeks.theta, 2)} subtitle="per day" />
          </>
        )}
      </div>

      {/* Chart */}
      <div style={chartWrap}>
        <PayoffChart grid={grid} pnl={totals.pnl} spot={spot} currency={currency} />
      </div>

      {/* Legs Table */}
      <div style={tableWrap}>
        <table style={table}>
          <thead>
            <tr>
              <Th>Side</Th>
              <Th>Action</Th>
              <Th align="right">Qty</Th>
              <Th align="right">Strike</Th>
              <Th align="right">Premium</Th>
              <Th align="right">IV %</Th>
              <Th>Expiry</Th>
              <Th /> {/* actions */}
            </tr>
          </thead>
          <tbody>
            {legs.length === 0 && (
              <tr>
                <Td colSpan={8} style={{ padding: 16 }}>
                  <Empty title="No legs" description="Add a call/put leg to start building your strategy." />
                </Td>
              </tr>
            )}
            {legs.map((l, idx) => (
              <LegRow
                key={l.id}
                leg={l}
                onChange={(p) => patch(idx, p)}
                onRemove={() => removeLeg(idx)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <Note>* Max gain/loss computed within the current price range only.</Note>
    </div>
  );
}

/* ---------------------------- Leg Row (table) --------------------------- */

function LegRow({
  leg,
  onChange,
  onRemove,
}: {
  leg: Leg;
  onChange: (patch: Partial<Leg>) => void;
  onRemove: () => void;
}) {
  return (
    <tr style={{ borderTop: "1px solid var(--border,#e5e7eb)" }}>
      <Td>{leg.side}</Td>
      <Td>
        <select
          value={leg.action}
          onChange={(e) => onChange({ action: e.target.value as Action })}
          style={select}
        >
          <option value="BUY">BUY</option>
          <option value="SELL">SELL</option>
        </select>
      </Td>
      <Td align="right">
        <NumberInput value={leg.qty} onChange={(v) => onChange({ qty: v })} width={90} step={1} />
      </Td>
      <Td align="right">
        <NumberInput value={leg.strike} onChange={(v) => onChange({ strike: v })} width={110} />
      </Td>
      <Td align="right">
        <NumberInput value={leg.premium} onChange={(v) => onChange({ premium: v })} width={110} />
      </Td>
      <Td align="right">
        <NumberInput value={leg.iv ?? 0} onChange={(v) => onChange({ iv: v })} width={100} />
      </Td>
      <Td>
        <input
          value={toISO(leg.expiry)}
          onChange={(e) => onChange({ expiry: e.target.value })}
          type="date"
          style={input}
        />
      </Td>
      <Td align="right">
        <button type="button" onClick={onRemove} style={btnDanger}>Remove</button>
      </Td>
    </tr>
  );
}

/* ------------------------------- Chart -------------------------------- */

function PayoffChart({
  grid, pnl, spot, currency,
}: { grid: number[]; pnl: number[]; spot: number; currency?: string }) {
  const W = 900, H = 300;
  const m = { t: 12, r: 16, b: 28, l: 56 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;

  const xMin = Math.min(...grid), xMax = Math.max(...grid);
  const yMin = Math.min(0, ...pnl),  yMax = Math.max(0, ...pnl);
  const x = (S: number) => (iw * (S - xMin)) / (xMax - xMin || 1);
  const y = (v: number) => ih - (ih * (v - yMin)) / (yMax - yMin || 1);
  const path = grid.map((S, i) => `${i ? "L" : "M"}${x(S)},${y(pnl[i])}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 320, display: "block" }} role="img" aria-label="Payoff chart">
      <rect x={0} y={0} width={W} height={H} fill="var(--surface,#fff)" rx={12} />
      <g transform={`translate(${m.l},${m.t})`}>
        {/* y grid/labels */}
        {Array.from({ length: 5 }).map((_, i) => {
          const v = yMin + ((yMax - yMin) * i) / 4;
          return (
            <g key={i}>
              <line x1={0} x2={iw} y1={y(v)} y2={y(v)} stroke="var(--border,#e5e7eb)" strokeDasharray="2,3" />
              <text x={-8} y={y(v)} fontSize="11" textAnchor="end" dominantBaseline="middle" fill="var(--text-muted,#6b7280)">
                {fmtMoney(v, currency)}
              </text>
            </g>
          );
        })}
        {/* zero + spot */}
        <line x1={0} x2={iw} y1={y(0)} y2={y(0)} stroke="var(--gray-300,#d1d5db)" />
        <line x1={x(spot)} x2={x(spot)} y1={0} y2={ih} stroke="var(--primary,#6366f1)" strokeDasharray="3,3" opacity={0.6} />
        <text x={x(spot)} y={-2} fontSize="10" textAnchor="middle" fill="var(--primary,#6366f1)">{`Spot ${fmtNum(spot)}`}</text>
        {/* curve */}
        <path d={path} fill="none" stroke="var(--success,#10b981)" strokeWidth={2} />
      </g>
    </svg>
  );
}

/* ------------------------------- Primitives ----------------------------- */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--text-muted,#6b7280)" }}>{label}</span>
      {children}
    </label>
  );
}

function Tile({ title, value, subtitle, tone = "neutral" }: { title: string; value: string | number; subtitle?: string; tone?: "neutral" | "success" | "danger" }) {
  const color =
    tone === "success" ? "var(--success,#10b981)" :
    tone === "danger"  ? "var(--danger,#ef4444)" : "var(--text,#111827)";
  return (
    <div style={{ border: "1px solid var(--border,#e5e7eb)", borderRadius: 12, padding: 12, background: "var(--bg,#fff)" }}>
      <div style={{ fontSize: 12, color: "var(--text-muted,#6b7280)" }}>{title}</div>
      <div style={{ marginTop: 6, fontSize: 20, fontWeight: 700, color }}>{value}</div>
      {subtitle && <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-muted,#6b7280)" }}>{subtitle}</div>}
    </div>
  );
}

/** Self-contained number input (prevents NaN) */
function NumberInput({
  value,
  onChange,
  width = 100,
  step = 0.1,
}: {
  value: number;
  onChange: (v: number) => void;
  width?: number;
  step?: number;
}) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      onChange={(e) => onChange(Number(e.target.value || 0))}
      step={step}
      style={{ ...input, width }}
    />
  );
}

// header/data cells (children optional so <Th /> OK)
function Th({ children, align = "left" }: { children?: React.ReactNode; align?: "left" | "right" }) {
  return <th style={{ ...th, textAlign: align }}>{children}</th>;
}
function Td({ children, align = "left", colSpan, style }: { children?: React.ReactNode; align?: "left" | "right"; colSpan?: number; style?: React.CSSProperties }) {
  return <td colSpan={colSpan} style={{ ...td, textAlign: align, ...style }}>{children}</td>;
}

function Empty({ title, description }: { title: string; description?: string }) {
  return (
    <div style={{ textAlign: "center", color: "var(--text-muted,#6b7280)" }}>
      <div style={{ fontSize: 36, lineHeight: 1 }}>🧩</div>
      <div style={{ fontWeight: 600, marginTop: 6, color: "var(--text,#111827)" }}>{title}</div>
      {description && <div style={{ fontSize: 13, marginTop: 4 }}>{description}</div>}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p style={{ marginTop: 10, fontSize: 11, color: "var(--text-muted,#6b7280)" }}>{children}</p>;
}

/* -------------------------------- Styles -------------------------------- */

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
  gridTemplateColumns: "repeat(6, minmax(0,1fr))",
  gap: 10,
  marginTop: 10,
};
const chartWrap: React.CSSProperties = {
  marginTop: 10,
  border: "1px solid var(--border,#e5e7eb)",
  borderRadius: 12,
  overflow: "hidden",
};
const tableWrap: React.CSSProperties = {
  marginTop: 10,
  border: "1px solid var(--border,#e5e7eb)",
  borderRadius: 12,
  overflow: "hidden",
};
const table: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};
const th: React.CSSProperties = {
  background: "var(--gray-50,#f8fafc)",
  fontSize: 12,
  fontWeight: 700,
  color: "var(--text,#111827)",
  padding: "8px 10px",
  borderBottom: "1px solid var(--border,#e5e7eb)",
  whiteSpace: "nowrap",
  position: "sticky",
  top: 0,
  zIndex: 1,
};
const td: React.CSSProperties = {
  padding: "8px 10px",
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
};
const select: React.CSSProperties = { ...input };
const btn: React.CSSProperties = {
  border: "1px solid var(--border,#e5e7eb)",
  background: "var(--bg,#fff)",
  color: "var(--text,#111827)",
  padding: "6px 10px",
  borderRadius: 10,
  cursor: "pointer",
  fontSize: 13,
};
const btnGhost: React.CSSProperties = { ...btn, opacity: 0.85 };
const btnDanger: React.CSSProperties = { ...btn, borderColor: "var(--danger,#ef4444)", color: "var(--danger,#ef4444)" };
const check: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 };

/* -------------------------------- Math --------------------------------- */

function signed(l: Leg) { return l.action === "BUY" ? 1 : -1; }
function payoffAtExpiry(l: Leg, S: number) { const q = Math.abs(l.qty) * signed(l); return l.side === "C" ? q * Math.max(0, S - l.strike) : q * Math.max(0, l.strike - S); }

function findBreakevens(xs: number[], ys: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < xs.length; i++) {
    if ((ys[i - 1] <= 0 && ys[i] >= 0) || (ys[i - 1] >= 0 && ys[i] <= 0)) {
      const t = ys[i] - ys[i - 1];
      out.push(t === 0 ? xs[i] : xs[i - 1] + (xs[i] - xs[i - 1]) * (0 - ys[i - 1]) / t);
    }
  }
  return dedupe(out, 1e-6);
}

/* --------------------------- Black–Scholes ----------------------------- */

function toSigma(iv?: number) { return typeof iv === "number" && isFinite(iv) ? Math.max(1e-6, iv / 100) : NaN; }
function d1d2(S: number, K: number, r: number, s: number, T: number) { const v = s * Math.sqrt(T); const d1 = (Math.log((S+1e-12)/(K+1e-12)) + (r + 0.5*s*s)*T) / (v + 1e-12); return { d1, d2: d1 - v }; }
function N(x: number) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function n(x: number) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
function erf(x: number) { const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911; const s=Math.sign(x),ax=Math.abs(x),t=1/(1+p*ax); const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-ax*ax); return s*y; }
function bsPrice(S:number,K:number,r:number,s:number,T:number,side:Side){const{d1,d2}=d1d2(S,K,r,s,T);return side==="C"?S*N(d1)-K*Math.exp(-r*T)*N(d2):K*Math.exp(-r*T)*N(-d2)-S*N(-d1);}
function bsGreeks(S:number,K:number,r:number,s:number,T:number,side:Side){const{d1,d2}=d1d2(S,K,r,s,T);const nd1=n(d1),disc=Math.exp(-r*T);const delta=side==="C"?N(d1):N(d1)-1;const gamma=nd1/(S*s*Math.sqrt(T));const vega=S*nd1*Math.sqrt(T);const thetaC=-(S*nd1*s)/(2*Math.sqrt(T))-r*K*disc*N(d2);const thetaP=-(S*nd1*s)/(2*Math.sqrt(T))+r*K*disc*N(-d2);return{delta,gamma,vega,theta:side==="C"?thetaC:thetaP};}

/* -------------------------------- Utils -------------------------------- */

function linspace(a:number,b:number,n:number){if(n<=1)return[a];const h=(b-a)/(n-1);return Array.from({length:n},(_,i)=>a+i*h);}
function dedupe(xs:number[],eps=1e-9){const out:number[]=[];xs.sort((a,b)=>a-b);for(let i=0;i<xs.length;i++)if(i===0||Math.abs(xs[i]-xs[i-1])>eps)out.push(xs[i]);return out;}
function clamp(x:number,lo:number,hi:number){return Math.max(lo,Math.min(hi,x));}
function roundTo(n:number,step=1){return Math.round(n/step)*step;}
function fmtNum(n?:number|null,d?:number){if(!(typeof n==="number"&&isFinite(n)))return "—";const f=d??(Math.abs(n)>=1000?0:Math.abs(n)>=100?1:2);return new Intl.NumberFormat(undefined,{maximumFractionDigits:f}).format(n);}
function fmtMoney(n?:number|null,cur?:string){if(!(typeof n==="number"&&isFinite(n)))return "—";const s=new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(n);return cur?`${cur}${s}`:s;}
function toISO(d?:Date|string){if(!d)return "";const dt=d instanceof Date?d:new Date(d);return isNaN(+dt)?"":dt.toISOString().slice(0,10);}
