// commodities/curves.ts
// Tiny, import-free futures curve utilities (strict-TS friendly).
// - Build a curve from dated nodes (expiry + price)
// - Interpolate (linear or log-linear in price)
// - Compute calendar spreads, roll yield, slope/shape stats
// - Merge/roll helpers and CSV export
//
// All time math uses ACT/365f year fractions. You can feed either `expiryISO`
// strings or explicit `T` (time in years). If both are present, T wins.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Interp = "linear" | "loglinear";

export interface CurveNode {
  symbol?: string;         // e.g., CLZ5
  expiryISO?: string;      // YYYY-MM-DD (UTC midnight assumed)
  T?: number;              // time to expiry in years (ACT/365f); overrides expiryISO if set
  price: number;           // futures price
  meta?: Record<string, any>;
}

export interface CurveInput {
  asOf?: string;           // ISO date for year fractions (default: today)
  method?: Interp;         // interpolation method (default: linear)
  nodes: CurveNode[];      // unsorted is fine
  // If true, will drop nodes with non-finite price/T; otherwise they’re zeroed.
  strict?: boolean;
}

export interface Curve {
  asOf: string;
  method: Interp;
  T: number[];             // ascending (>=0)
  P: number[];             // prices aligned with T
  nodes: Array<CurveNode & { T: number }>;
  eval: (T: number) => number;               // interpolate price at time T
  evalSafe: (T: number) => number | null;    // returns null outside domain if strict
}

export interface SpreadRow {
  nearIdx: number;
  farIdx: number;
  Tnear: number;
  Tfar: number;
  nearSym?: string;
  farSym?: string;
  nearP: number;
  farP: number;
  spread: number;        // far - near
  pct: number;           // (far/near - 1)
  annualizedPct?: number;// (far/near - 1) / (Tfar - Tnear)
}

export interface ShapeStats {
  n: number;                // nodes
  domain: [number, number]; // [minT, maxT]
  slopeFront?: number;      // dP/dT at front (finite diff)
  slopeBack?: number;       // dP/dT at back  (finite diff)
  contangoFront?: boolean;  // near→next upward?
  contangoAny?: boolean;    // any upward segments exist
  backwardAny?: boolean;    // any downward segments exist
  avgMonthlyCarryPct?: number; // average (P_{i+1}/P_i -1)/ΔT * 1m
  kinks?: number;           // sign changes in first differences
}

// ------------------------- Construction -------------------------

export function makeCurve(input: CurveInput): Curve {
  const asOf = input.asOf ? toISO(input.asOf) : toISO(new Date().toISOString());
  const method: Interp = (input.method === "loglinear" ? "loglinear" : "linear");
  const strict = !!input.strict;

  // Normalize nodes → (T, P)
  const base = toDate(asOf);
  const rows = (input.nodes || []).map(n => {
    const T = isFiniteNum(n.T) ? Math.max(0, Number(n.T))
      : (n.expiryISO ? Math.max(0, yearFrac(base, toDate(n.expiryISO))) : NaN);
    return { ...n, T, price: num(n.price) };
  });

  const filtered = rows
    .filter(r => (strict ? (isFiniteNum(r.T) && isFiniteNum(r.price)) : true))
    .map(r => ({
      ...r,
      T: isFiniteNum(r.T) ? r.T : 0,
      price: isFiniteNum(r.price) ? r.price : 0
    }))
    .sort((a, b) => a.T - b.T);

  // Deduplicate identical T keeping the last non-zero price
  const T: number[] = [];
  const P: number[] = [];
  const nodes: Array<CurveNode & { T: number }> = [];
  for (const r of filtered) {
    if (!T.length || Math.abs(r.T - T[T.length - 1]) > 1e-12) {
      T.push(r.T); P.push(r.price); nodes.push({ ...r });
    } else {
      // same T as previous → overwrite with latest non-zero price if present
      const i = T.length - 1;
      if (r.price !== 0) { P[i] = r.price; nodes[i] = { ...r }; }
    }
  }

  const evalLinear = (x: number): number | null => {
    if (!T.length) return null;
    if (x <= T[0]) return P[0];
    if (x >= T[T.length - 1]) return P[P.length - 1];
    const i = upperBound(T, x);
    const t0 = T[i - 1], t1 = T[i];
    const p0 = P[i - 1], p1 = P[i];
    const w = (x - t0) / Math.max(1e-12, t1 - t0);
    return p0 + w * (p1 - p0);
  };

  const evalLogLinear = (x: number): number | null => {
    if (!T.length) return null;
    if (x <= T[0]) return P[0];
    if (x >= T[T.length - 1]) return P[P.length - 1];
    const i = upperBound(T, x);
    const t0 = T[i - 1], t1 = T[i];
    const p0 = Math.max(P[i - 1], 1e-12), p1 = Math.max(P[i], 1e-12);
    const w = (x - t0) / Math.max(1e-12, t1 - t0);
    const y = Math.log(p0) + w * (Math.log(p1) - Math.log(p0));
    return Math.exp(y);
  };

  const evalSafe = (x: number): number | null => {
    if (!isFiniteNum(x)) return null;
    if (x < T[0] - 1e-12 || x > T[T.length - 1] + 1e-12) return null;
    return method === "loglinear" ? evalLogLinear(x) : evalLinear(x);
  };
  const evalClamped = (x: number): number => {
    const v = evalSafe(x);
    if (v == null) {
      if (!T.length) return 0;
      return x < T[0] ? P[0] : P[P.length - 1];
    }
    return v;
  };

  return { asOf, method, T, P, nodes, eval: evalClamped, evalSafe };
}

// ------------------------- Spreads & carry -------------------------

/** All pairwise calendar spreads near/far (ascending by (nearIdx, farIdx)). */
export function calendarSpreads(curve: Curve): SpreadRow[] {
  const out: SpreadRow[] = [];
  for (let i = 0; i < curve.T.length; i++) {
    for (let j = i + 1; j < curve.T.length; j++) {
      const nearP = curve.P[i], farP = curve.P[j];
      const spread = farP - nearP;
      const pct = nearP !== 0 ? (farP / nearP - 1) : 0;
      const dT = curve.T[j] - curve.T[i];
      const annualizedPct = dT > 0 ? pct / dT : undefined;
      out.push({
        nearIdx: i, farIdx: j,
        Tnear: curve.T[i], Tfar: curve.T[j],
        nearSym: curve.nodes[i].symbol, farSym: curve.nodes[j].symbol,
        nearP, farP, spread, pct, annualizedPct
      });
    }
  }
  return out;
}

/**
 * Roll yield (annualized % carry) from contract i → i+1:
 *   ry = (P_{i+1}/P_i - 1) / (T_{i+1} - T_i)
 * Returns an array of length N-1.
 */
export function rollYieldAnnualized(curve: Curve): number[] {
  const N = curve.T.length;
  const out: number[] = new Array(Math.max(0, N - 1)).fill(0);
  for (let i = 0; i < N - 1; i++) {
    const p0 = curve.P[i], p1 = curve.P[i + 1];
    const dT = curve.T[i + 1] - curve.T[i];
    out[i] = dT > 0 && p0 !== 0 ? (p1 / p0 - 1) / dT : 0;
  }
  return out;
}

/** One-step calendar spread (next − near). */
export function frontSpread(curve: Curve): SpreadRow | null {
  if (curve.T.length < 2) return null;
  const i = 0, j = 1;
  const nearP = curve.P[i], farP = curve.P[j];
  const pct = nearP !== 0 ? (farP / nearP - 1) : 0;
  const dT = curve.T[j] - curve.T[i];
  return {
    nearIdx: i, farIdx: j,
    Tnear: curve.T[i], Tfar: curve.T[j],
    nearSym: curve.nodes[i].symbol, farSym: curve.nodes[j].symbol,
    nearP, farP, spread: farP - nearP, pct,
    annualizedPct: dT > 0 ? pct / dT : undefined
  };
}

// ------------------------- Shape stats -------------------------

export function shape(curve: Curve): ShapeStats {
  const n = curve.T.length;
  const stats: ShapeStats = { n, domain: [n ? curve.T[0] : 0, n ? curve.T[n - 1] : 0] };

  if (n >= 2) {
    const d0 = (curve.P[1] - curve.P[0]) / Math.max(1e-12, curve.T[1] - curve.T[0]);
    const dk = (curve.P[n - 1] - curve.P[n - 2]) / Math.max(1e-12, curve.T[n - 1] - curve.T[n - 2]);
    stats.slopeFront = d0;
    stats.slopeBack = dk;

    let up = false, down = false, kinks = 0;
    let prevSign = 0;
    let carrySum = 0, carryN = 0;

    for (let i = 0; i < n - 1; i++) {
      const dp = curve.P[i + 1] - curve.P[i];
      const s = dp > 0 ? 1 : dp < 0 ? -1 : 0;
      if (s > 0) up = true; else if (s < 0) down = true;
      if (prevSign !== 0 && s !== 0 && s !== prevSign) kinks++;
      prevSign = s !== 0 ? s : prevSign;

      const dT = curve.T[i + 1] - curve.T[i];
      if (dT > 0 && curve.P[i] !== 0) { carrySum += (curve.P[i + 1] / curve.P[i] - 1) / dT; carryN++; }
    }

    stats.contangoFront = curve.P[1] >= curve.P[0];
    stats.contangoAny = up;
    stats.backwardAny = down;
    stats.kinks = kinks;
    // Convert average annualized carry to “per month” approximation
    stats.avgMonthlyCarryPct = carryN ? (carrySum / carryN) * (1 / 12) : undefined;
  }

  return stats;
}

// ------------------------- Rolling & merge helpers -------------------------

/** Merge two curves (e.g., different data sources). Later curve overrides duplicate T. */
export function mergeCurves(a: Curve, b: Curve): Curve {
  const map = new Map<number, number>();
  for (let i = 0; i < a.T.length; i++) map.set(a.T[i], a.P[i]);
  for (let i = 0; i < b.T.length; i++) map.set(b.T[i], b.P[i]);
  const T = Array.from(map.keys()).sort((x, y) => x - y);
  const P = T.map(t => map.get(t) as number);
  return makeCurve({ asOf: a.asOf, method: a.method, nodes: T.map((t, i) => ({ T: t, price: P[i] })) });
}

/**
 * Create a simple time-based roll between two curves A (near) and B (far).
 * weight = clamp((t - t0) / (t1 - t0), 0..1), result = (1-weight)*A + weight*B
 */
export function timeWeightedRoll(A: Curve, B: Curve, t0: number, t1: number): Curve {
  const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
  const grid = unionSorted(A.T, B.T);
  const nodes: CurveNode[] = grid.map(T => {
    const w = clamp((T - lo) / Math.max(1e-12, hi - lo), 0, 1);
    const p = (1 - w) * A.eval(T) + w * B.eval(T);
    return { T, price: p };
  });
  return makeCurve({ asOf: A.asOf, method: A.method, nodes });
}

// ------------------------- CSV / pretty -------------------------

export function toCSV(curve: Curve): string {
  const head = "T,price,symbol,expiryISO";
  const rows = curve.nodes.map(n => [round6(n.T), round6(n.price), n.symbol ?? "", n.expiryISO ?? ""].join(","));
  return [head, ...rows].join("\n");
}

export function pretty(curve: Curve): string {
  const s = shape(curve);
  const header = `curve  asOf=${curve.asOf}  nodes=${curve.T.length}  domain=[${round4(s.domain[0])}, ${round4(s.domain[1])}]  method=${curve.method}`;
  const lines = [header, "T        price      sym    expiry"];
  for (let i = 0; i < curve.T.length; i++) {
    const t = padLeft(round4(curve.T[i]).toFixed(4), 8);
    const p = padLeft(round4(curve.P[i]).toFixed(4), 10);
    const sym = padRight(curve.nodes[i].symbol ?? "", 7);
    const exp = curve.nodes[i].expiryISO ?? "";
    lines.push(`${t}  ${p}  ${sym}  ${exp}`);
  }
  return lines.join("\n");
}

// ------------------------- Tiny utils -------------------------

export function yearFrac(from: Date, to: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  const days = (to.getTime() - from.getTime()) / msPerDay;
  return days / 365; // ACT/365f
}

function toDate(x: string): Date {
  // accept full ISO or YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(x)) return new Date(x + "T00:00:00Z");
  const d = new Date(x);
  return new Date(d.toISOString()); // normalize to UTC
}
function toISO(x: string): string {
  return toDate(x).toISOString().slice(0, 10);
}

function isFiniteNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }
function num(x: any): number { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }
function round4(x: number): number { return Math.round(x * 1e4) / 1e4; }
function round6(x: number): number { return Math.round(x * 1e6) / 1e6; }
function padLeft(s: string, n: number): string { s = String(s); return s.length >= n ? s : " ".repeat(n - s.length) + s; }
function padRight(s: string, n: number): string { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); }

/** first index with T[i] > x (array must be ascending and non-empty). */
function upperBound(T: number[], x: number): number {
  let lo = 0, hi = T.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (T[mid] <= x) lo = mid + 1; else hi = mid;
  }
  return Math.max(1, Math.min(T.length - 1, lo));
}

/** union of two ascending arrays with unique results (1e-12 tolerance). */
function unionSorted(a: number[], b: number[]): number[] {
  const out: number[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    const va = i < a.length ? a[i] : Number.POSITIVE_INFINITY;
    const vb = j < b.length ? b[j] : Number.POSITIVE_INFINITY;
    const v = va <= vb ? va : vb;
    if (!out.length || Math.abs(v - out[out.length - 1]) > 1e-12) out.push(v);
    if (va <= vb) i++; else j++;
  }
  return out;
}

// ------------------------- Minimal factory -------------------------

/**
 * Convenience: build curve from {symbol, expiryISO, price} tuples.
 * `asOf` optional; when omitted, uses today for T calculation.
 */
export function fromQuotes(
  quotes: Array<{ symbol?: string; expiryISO: string; price: number }>,
  asOf?: string,
  method: Interp = "linear"
): Curve {
  const nodes: CurveNode[] = quotes.map(q => ({ symbol: q.symbol, expiryISO: q.expiryISO, price: q.price }));
  return makeCurve({ asOf, method, nodes, strict: true });
}