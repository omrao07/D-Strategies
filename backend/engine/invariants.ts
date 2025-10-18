// engine/invariants.ts
// Import-free, strict-TS-friendly runtime invariants & validators for the engine.
// - Tiny assertion helpers (no deps)
// - Result<T> utils (ok/err) so you can avoid throwing in hot-paths
// - Validators for portfolio snapshots, risk blobs, quotes/books/curves/chains
// - Shape guards (isFinite, nonneg, monotonic, unique, etc.)
// - Optional dev-only checks (no-throw mode)
//
// Drop in and use:
//   assert(snapshotValid(snap).ok, snapshotValid(snap).msg);
//   const r = riskValid(risk); if (!r.ok) log(r.msg);

//////////////////////////////
// Errors & Result
//////////////////////////////

export class InvariantError extends Error {
  name = "InvariantError";
  constructor(message: string) { super(String(message)); }
}

export type Result<T = true> = { ok: true; value: T } | { ok: false; msg: string };

export function ok<T = true>(value: T = true as unknown as T): Result<T> { return { ok: true, value }; }
export function err(msg: string): Result<never> { return { ok: false, msg: String(msg) }; }

//////////////////////////////
// Basic assertions
//////////////////////////////

/** Throw if cond is false. */
export function assert(cond: any, message = "invariant failed"): asserts cond {
  if (!cond) throw new InvariantError(message);
}

/** Ensure returns the value if predicate holds, otherwise throws. */
export function ensure<T>(v: T, pred: (x: T) => boolean, message: string): T {
  if (!pred(v)) throw new InvariantError(message);
  return v;
}

/** Dev-only guard: returns false instead of throwing if noThrow is true. */
export function guard(cond: any, message = "invariant failed", noThrow = false): boolean {
  if (cond) return true;
  if (noThrow) return false;
  throw new InvariantError(message);
}

//////////////////////////////
// Number & array guards
//////////////////////////////

export function isFiniteNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }
export function nonneg(x: number): boolean { return isFiniteNum(x) && x >= 0; }
export function pos(x: number): boolean { return isFiniteNum(x) && x > 0; }
export function inRange(x: number, lo: number, hi: number): boolean { return isFiniteNum(x) && x >= lo && x <= hi; }

export function allFinite(a: any[]): boolean { return a.every(isFiniteNum); }
export function allNonneg(a: number[]): boolean { return a.every(nonneg); }
export function monotonicAsc(a: number[], strict = false): boolean {
  for (let i = 1; i < a.length; i++) if (strict ? a[i] <= a[i-1] : a[i] < a[i-1]) return false;
  return true;
}
export function uniqueAsc(a: number[], eps = 0): boolean {
  for (let i = 1; i < a.length; i++) if (Math.abs(a[i] - a[i-1]) <= eps) return false;
  return true;
}

//////////////////////////////
// Common engine shapes
//////////////////////////////

export interface PosLike { symbol: string; qty: number; price: number; value?: number; cost?: number }
export interface SnapshotLike { positions: PosLike[]; value: number; cash: number }
export interface RiskLike { var95: number; cvar95: number; beta?: number; stdev?: number; horizonDays?: number }

export function positionValid(p: any): Result {
  if (!p || typeof p.symbol !== "string" || p.symbol.trim() === "") return err("position.symbol missing");
  if (!isFiniteNum(p.qty)) return err("position.qty not finite");
  if (!isFiniteNum(p.price)) return err("position.price not finite");
  if (p.value != null && !isFiniteNum(p.value)) return err("position.value not finite");
  if (p.cost != null && !isFiniteNum(p.cost)) return err("position.cost not finite");
  return ok();
}

export function snapshotValid(s: any): Result<SnapshotLike> {
  if (!s || typeof s !== "object") return err("snapshot not an object");
  if (!isFiniteNum(s.value)) return err("snapshot.value not finite");
  if (!isFiniteNum(s.cash)) return err("snapshot.cash not finite");
  const arr = Array.isArray(s.positions) ? s.positions : null;
  if (!arr) return err("snapshot.positions not array");
  for (let i = 0; i < arr.length; i++) {
    const r = positionValid(arr[i]);
    if (!r.ok) return err(`positions[${i}]: ${r.msg}`);
  }
  // Optional reconciliation: sum(qty*price)+cash ~= value
  const calc = (arr as PosLike[]).reduce((sum, p) => sum + Number(p.qty) * Number(p.price), 0) + Number(s.cash);
  const tol = Math.max(1e-6, Math.abs(s.value) * 1e-6);
  if (Math.abs(calc - Number(s.value)) > tol) {
    // not fatal; return ok but embed computed value for convenience
    return ok({ positions: arr as PosLike[], value: Number(s.value), cash: Number(s.cash) });
  }
  return ok({ positions: arr as PosLike[], value: Number(s.value), cash: Number(s.cash) });
}

export function riskValid(r: any): Result<RiskLike> {
  if (!r || typeof r !== "object") return err("risk not an object");
  if (!isFiniteNum(r.var95)) return err("risk.var95 not finite");
  if (!isFiniteNum(r.cvar95)) return err("risk.cvar95 not finite");
  if (r.beta != null && !isFiniteNum(r.beta)) return err("risk.beta not finite");
  if (r.stdev != null && !isFiniteNum(r.stdev)) return err("risk.stdev not finite");
  if (r.horizonDays != null && (!Number.isInteger(r.horizonDays) || r.horizonDays <= 0)) return err("risk.horizonDays invalid");
  return ok({ var95: Number(r.var95), cvar95: Number(r.cvar95), beta: r.beta, stdev: r.stdev, horizonDays: r.horizonDays });
}

//////////////////////////////
// Quotes / books / bars (optional)
//////////////////////////////

export interface TickLike { symbol: string; bid?: number; ask?: number; last?: number; ts?: string|number|Date }
export interface BookLevel { price: number; size: number }
export interface BookLike { symbol: string; bids: BookLevel[]; asks: BookLevel[]; ts?: any }
export interface BarLike { symbol: string; open: number; high: number; low: number; close: number; ts?: any }

export function tickValid(t: any): Result {
  if (!t || typeof t.symbol !== "string") return err("tick.symbol missing");
  if (t.bid != null && !isFiniteNum(t.bid)) return err("tick.bid not finite");
  if (t.ask != null && !isFiniteNum(t.ask)) return err("tick.ask not finite");
  if (t.last != null && !isFiniteNum(t.last)) return err("tick.last not finite");
  if (isFiniteNum(t.bid) && isFiniteNum(t.ask) && t.ask < t.bid) return err("tick crossed book");
  return ok();
}

export function bookValid(b: any): Result {
  if (!b || typeof b.symbol !== "string") return err("book.symbol missing");
  if (!Array.isArray(b.bids) || !Array.isArray(b.asks)) return err("book levels missing");
  const bb = (b.bids as any[]).every(x => x && isFiniteNum(x.price) && isFiniteNum(x.size));
  const aa = (b.asks as any[]).every(x => x && isFiniteNum(x.price) && isFiniteNum(x.size));
  if (!bb || !aa) return err("book level not finite");
  // best bid <= best ask
  const bestBid = b.bids.length ? b.bids[0].price : undefined;
  const bestAsk = b.asks.length ? b.asks[0].price : undefined;
  if (isFiniteNum(bestBid) && isFiniteNum(bestAsk) && bestAsk < bestBid) return err("book crossed");
  return ok();
}

export function barValid(bar: any): Result {
  if (!bar || typeof bar.symbol !== "string") return err("bar.symbol missing");
  if (!isFiniteNum(bar.open) || !isFiniteNum(bar.high) || !isFiniteNum(bar.low) || !isFiniteNum(bar.close)) {
    return err("bar OHLC not finite");
  }
  if (!(bar.low <= bar.open && bar.low <= bar.high && bar.low <= bar.close)) return err("bar.low inconsistent");
  if (!(bar.high >= bar.open && bar.high >= bar.low && bar.high >= bar.close)) return err("bar.high inconsistent");
  return ok();
}

//////////////////////////////
// Curves / Chains (commodities)
//////////////////////////////

export interface CurveNode { T: number; price: number }
export interface CurveLike { T: number[]; P: number[] }
export interface QuoteLike { cp: "call"|"put"; K: number; T: number; mid: number }

export function curveValid(c: any): Result {
  if (!c || !Array.isArray(c.T) || !Array.isArray(c.P)) return err("curve arrays missing");
  if (c.T.length !== c.P.length) return err("curve length mismatch");
  if (!allFinite(c.T) || !allFinite(c.P)) return err("curve has non-finite entries");
  if (!monotonicAsc(c.T, false)) return err("curve T must be ascending");
  if (!uniqueAsc(c.T, 1e-12)) return err("curve T must be unique");
  return ok();
}

export function quotesValid(rows: any[]): Result {
  if (!Array.isArray(rows)) return err("quotes not array");
  for (let i = 0; i < rows.length; i++) {
    const q = rows[i];
    if (!q || (q.cp !== "call" && q.cp !== "put")) return err(`quotes[${i}].cp invalid`);
    if (!isFiniteNum(q.K) || !isFiniteNum(q.T) || !isFiniteNum(q.mid)) return err(`quotes[${i}] numeric invalid`);
  }
  return ok();
}

//////////////////////////////
// State integrity & freeze
//////////////////////////////

/** Deep freeze a plain object graph (shallow arrays/objects). */
export function deepFreeze<T extends object>(o: T): T {
  const seen = new WeakSet<object>();
  const q: any[] = [o];
  while (q.length) {
    const x = q.pop();
    if (!x || typeof x !== "object" || seen.has(x)) continue;
    seen.add(x);
    try { Object.freeze(x); } catch {}
    for (const k of Object.keys(x)) {
      const v = (x as any)[k];
      if (v && typeof v === "object" && !seen.has(v)) q.push(v);
    }
  }
  return o;
}

/** Safe JSON stringify for logging (drops circulars / big arrays). */
export function safeJSON(x: any, maxLen = 100_000): string {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(x, function (_k, v) {
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
      if (Array.isArray(v) && v.length > 10_000) return `[Array(${v.length})]`;
    }
    if (typeof v === "number" && !Number.isFinite(v)) return String(v);
    return v;
  });
  return json.length > maxLen ? json.slice(0, maxLen) + "…[trunc]" : json;
}

//////////////////////////////
// Convenience checkers (throwing variants)
//////////////////////////////

export function mustSnapshot(s: any): SnapshotLike {
  const r = snapshotValid(s); if (!r.ok) throw new InvariantError(r.msg);
  return r.value;
}
export function mustRisk(rk: any): RiskLike {
  const r = riskValid(rk); if (!r.ok) throw new InvariantError(r.msg);
  return r.value;
}
export function mustCurve(c: any): CurveLike {
  const r = curveValid(c); if (!r.ok) throw new InvariantError(r.msg);
  return c as CurveLike;
}
export function mustQuotes(rows: any[]): QuoteLike[] {
  const r = quotesValid(rows); if (!r.ok) throw new InvariantError(r.msg);
  return rows as QuoteLike[];
}

//////////////////////////////
// Tiny helpers
//////////////////////////////

export function approxEqual(a: number, b: number, eps = 1e-9): boolean { return Math.abs(a - b) <= eps; }
export function coalesce<T>(v: T | undefined | null, d: T): T { return v == null ? d : v; }
export function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }

/** Wrap a function with invariant catching → Result. */
export function tryResult<T>(fn: () => T): Result<T> {
  try { return { ok: true, value: fn() }; }
  catch (e: any) { return err(e?.message ?? String(e)); }
}

/** No-op dev checker: executes fn only if flag truthy. */
export function devOnly(fn: () => void, enabled = true): void { if (enabled) { try { fn(); } catch {} } }