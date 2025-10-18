// core/fx.ts
//
// Minimal FX conversion utilities with last-known lookup, inversion,
// and single-hop triangulation via common hub currencies.
// Pure TypeScript, no imports.

export type FxTick = { pair: string; ts: number; rate: number }; // pair: "BASE/QUOTE" → 1 BASE = rate QUOTE

// -------------------- Internal state --------------------
let _BASE_CCY = "USD";
const _fxSeries: Record<string, FxTick[]> = Object.create(null); // key: "BASE/QUOTE", sorted by ts asc
const HUBS = ["USD", "EUR", "JPY", "GBP", "INR"];

// -------------------- Public API --------------------
export function setBaseCurrency(ccy: string): void {
  _BASE_CCY = norm(ccy);
}
export function getBaseCurrency(): string {
  return _BASE_CCY;
}

export function resetFx(): void {
  for (const k in _fxSeries) delete _fxSeries[k];
}

export function seedFx(ticks: FxTick[]): void {
  addFxTicks(ticks);
}

export function addFxTick(t: FxTick): void {
  const p = normPair(t.pair);
  const [base, quote] = splitPair(p);
  const k = key(base, quote);
  const arr = ensureSeries(k);
  // Insert in order (append then fix ordering with binary insert if out of order)
  if (arr.length === 0 || arr[arr.length - 1].ts <= t.ts) {
    arr.push({ pair: k, ts: t.ts, rate: t.rate });
  } else {
    // binary position
    let lo = 0,
      hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].ts <= t.ts) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, { pair: k, ts: t.ts, rate: t.rate });
  }
}

export function addFxTicks(ts: FxTick[]): void {
  for (const t of ts) addFxTick(t);
}

export function getRate(base: string, quote: string, ts: number): number {
  const b = norm(base);
  const q = norm(quote);
  if (b === q) return 1;

  // 1) Direct
  const direct = lastKnownRate(b, q, ts);
  if (isFinitePos(direct)) return direct as number;

  // 2) Inverse
  const inv = lastKnownRate(q, b, ts);
  if (isFinitePos(inv)) return 1 / (inv as number);

  // 3) Single-hop triangulation via hubs
  const rateTri = viaHub(b, q, ts);
  if (isFinitePos(rateTri)) return rateTri as number;

  throw new Error(`FX rate not found for ${b}/${q} @ ${ts}`);
}

export function convert(amount: number, from: string, to: string, ts: number): number {
  if (!isFinite(amount)) throw new Error("Amount must be finite");
  const r = getRate(from, to, ts);
  return amount * r;
}

export function toBase(amount: number, ccy: string, ts: number): number {
  return convert(amount, ccy, _BASE_CCY, ts);
}

export function fromBase(amount: number, ccy: string, ts: number): number {
  return convert(amount, _BASE_CCY, ccy, ts);
}

// -------------------- Internals --------------------
function norm(x: string): string {
  return x.trim().toUpperCase();
}
function normPair(p: string): string {
  const s = p.replace(/\s+/g, "");
  const parts = s.split("/");
  if (parts.length !== 2) throw new Error(`Invalid pair: ${p}`);
  return `${norm(parts[0])}/${norm(parts[1])}`;
}
function splitPair(p: string): [string, string] {
  const i = p.indexOf("/");
  return [p.slice(0, i), p.slice(i + 1)] as [string, string];
}
function key(base: string, quote: string): string {
  return `${base}/${quote}`;
}
function ensureSeries(k: string): FxTick[] {
  if (!_fxSeries[k]) _fxSeries[k] = [];
  return _fxSeries[k];
}

function lastKnownRate(base: string, quote: string, ts: number): number | null {
  const k = key(base, quote);
  const series = _fxSeries[k];
  if (!series || series.length === 0) return null;
  const idx = upperBoundTs(series, ts) - 1;
  if (idx < 0) return null;
  const r = series[idx].rate;
  return r > 0 && isFinite(r) ? r : null;
}

// Find first index with tick.ts > ts
function upperBoundTs(arr: FxTick[], ts: number): number {
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function viaHub(base: string, quote: string, ts: number): number | null {
  // Try in order of HUBS; prefer hubs that have both legs available
  for (const h0 of HUBS) {
    const h = norm(h0);
    if (h === base || h === quote) continue;
    const leg1 = getLeg(base, h, ts);
    if (!isFinitePos(leg1)) continue;
    const leg2 = getLeg(h, quote, ts);
    if (!isFinitePos(leg2)) continue;
    return (leg1 as number) * (leg2 as number);
  }
  return null;
}

function getLeg(from: string, to: string, ts: number): number | null {
  if (from === to) return 1;
  let r = lastKnownRate(from, to, ts);
  if (isFinitePos(r)) return r as number;
  const inv = lastKnownRate(to, from, ts);
  if (isFinitePos(inv)) return 1 / (inv as number);
  return null;
}

function isFinitePos(x: unknown): x is number {
  return typeof x === "number" && isFinite(x) && x > 0;
}

// -------------------- Optional: tiny self-check (can be removed) --------------------
// Uncomment to quick-test locally without a test runner.
/*
(function selfCheck(){
  resetFx();
  addFxTicks([
    { pair: "INR/USD", ts: 1_000, rate: 0.012 }, // 1 INR = 0.012 USD
    { pair: "EUR/USD", ts: 1_000, rate: 1.10 },  // 1 EUR = 1.10 USD
    { pair: "USD/JPY", ts: 1_000, rate: 155 },   // 1 USD = 155 JPY
  ]);
  // Direct
  console.log("INR→USD", getRate("INR","USD", 1500)); // ~0.012
  // Inverse
  console.log("USD→INR", getRate("USD","INR", 1500)); // ~83.333
  // Triangulate (INR→EUR via USD hub)
  console.log("INR→EUR", getRate("INR","EUR", 1500)); // (INR→USD)/(EUR→USD) inverted: 0.012 / 1.10 ≈ 0.010909...
})();
*/