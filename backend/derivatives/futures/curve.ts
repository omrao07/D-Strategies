// futures/curve.ts
// Term-structure utilities for futures curves (pure TS, no imports).
// Build a curve from contract quotes, compute times-to-expiry, interpolate levels,
// calendar spreads, roll yields, and simple butterflies.

export type ISODate = string; // "YYYY-MM-DD"

export type Quote = {
  symbol: string;
  expiryISO: ISODate; // last trade/expiry date
  price: number;      // clean futures price (settle/close)
};

export type CurveKnot = {
  t: number;          // time to expiry in ACT/365 years from anchor
  price: number;      // futures level at t
  symbol: string;
  expiryISO: ISODate;
};

export type Curve = {
  anchorISO: ISODate;
  knots: CurveKnot[]; // strictly ascending by t
  meta?: { note?: string };
};

/** ===== Date helpers (UTC only) ===== */
function parseISO(iso: ISODate): Date {
  const [y, m, d] = iso.split("-").map(x => parseInt(x, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

function toISO(d: Date): ISODate {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ACT/365F year fraction between anchor (inclusive) and expiry (exclusive). Negative if expiry < anchor. */
export function yearFracACT365(anchorISO: ISODate, expiryISO: ISODate): number {
  const a = parseISO(anchorISO).getTime();
  const e = parseISO(expiryISO).getTime();
  const ms = e - a;
  return ms / 86_400_000 / 365;
}

/** Clamp and basic sanity for finite numbers */
function finite(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }

/** ===== Curve construction ===== */

/** Build a curve from raw quotes. Drops invalid/expired quotes unless keepExpired=true. */
export function buildCurve(
  anchorISO: ISODate,
  quotes: Quote[],
  opts?: { keepExpired?: boolean }
): Curve {
  const keepExpired = !!opts?.keepExpired;
  const knots: CurveKnot[] = [];
  for (const q of quotes) {
    if (!finite(q.price)) continue;
    const t = yearFracACT365(anchorISO, q.expiryISO);
    if (!keepExpired && t < 0) continue;
    knots.push({ t, price: q.price, symbol: q.symbol, expiryISO: q.expiryISO });
  }
  knots.sort((a, b) => a.t - b.t || a.price - b.price);
  // dedupe on identical t (keep last)
  const uniq: CurveKnot[] = [];
  for (const k of knots) {
    if (!uniq.length || Math.abs(uniq[uniq.length - 1].t - k.t) > 1e-9) uniq.push(k);
    else uniq[uniq.length - 1] = k;
  }
  return { anchorISO, knots: uniq };
}

/** Return earliest and latest t on curve (or [NaN, NaN] if empty). */
export function tRange(curve: Curve): [number, number] {
  const ks = curve.knots;
  if (!ks.length) return [NaN, NaN];
  return [ks[0].t, ks[ks.length - 1].t];
}

/** Find surrounding knots for target t. Returns [iLeft, iRight], where iLeft==iRight means exact hit. */
function bracket(curve: Curve, t: number): [number, number] {
  const n = curve.knots.length;
  if (n === 0) return [-1, -1];
  if (t <= curve.knots[0].t) return [0, 0];
  if (t >= curve.knots[n - 1].t) return [n - 1, n - 1];
  // binary search
  let lo = 0, hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (t <= curve.knots[mid].t) hi = mid; else lo = mid;
  }
  return [lo, hi];
}

/** Piecewise-linear interpolation/extrapolation on price vs time. */
export function interpPrice(curve: Curve, t: number): number | undefined {
  const ks = curve.knots;
  if (!ks.length) return undefined;
  const [i, j] = bracket(curve, t);
  if (i === -1) return undefined;
  if (i === j) return ks[i].price;
  const k0 = ks[i], k1 = ks[j];
  const w = (t - k0.t) / (k1.t - k0.t);
  return k0.price + w * (k1.price - k0.price);
}

/** Local slope dPrice/dYear around t using adjacent knots (secant). */
export function slope(curve: Curve, t: number): number | undefined {
  const ks = curve.knots;
  if (ks.length < 2) return 0;
  const [i, j] = bracket(curve, t);
  if (i === j) {
    // center slope if possible
    if (i === 0) return (ks[1].price - ks[0].price) / (ks[1].t - ks[0].t);
    if (i === ks.length - 1) {
      const a = ks[i - 1], b = ks[i];
      return (b.price - a.price) / (b.t - a.t);
    }
    const a = ks[i - 1], b = ks[i + 1];
    return (b.price - a.price) / (b.t - a.t);
  }
  const a = ks[i], b = ks[j];
  return (b.price - a.price) / (b.t - a.t);
}

/** Calendar spread P(t2) - P(t1) for given maturities (interpolated). */
export function calendar(curve: Curve, tNear: number, tFar: number): number | undefined {
  const p1 = interpPrice(curve, tNear);
  const p2 = interpPrice(curve, tFar);
  if (!finite(p1) || !finite(p2)) return undefined;
  return p2! - p1!;
}

/** Butterfly spread: w1*P(t1) + w2*P(t2) + w3*P(t3). Defaults to fly weights [1, -2, 1]. */
export function butterfly(
  curve: Curve,
  t1: number,
  t2: number,
  t3: number,
  w: [number, number, number] = [1, -2, 1]
): number | undefined {
  const p1 = interpPrice(curve, t1);
  const p2 = interpPrice(curve, t2);
  const p3 = interpPrice(curve, t3);
  if (!finite(p1) || !finite(p2) || !finite(p3)) return undefined;
  return w[0] * p1! + w[1] * p2! + w[2] * p3!;
}

/** Annualized roll yield between two tenors: slope divided by level at near tenor. 
    roll_yield_annual ≈ (P_far - P_near) / (Δt * P_near) */
export function annualizedRollYield(curve: Curve, tNear: number, tFar: number): number | undefined {
  if (tFar <= tNear) return undefined;
  const p1 = interpPrice(curve, tNear);
  const p2 = interpPrice(curve, tFar);
  if (!finite(p1) || !finite(p2) || p1! === 0) return undefined;
  const dt = tFar - tNear;
  return (p2! - p1!) / (dt * p1!);
}

/** Front/next (1x2) roll metrics based on first two knots (or interpolated at given tNear, Δmonths). */
export function frontNextRoll(curve: Curve): {
  tNear: number; tFar: number;
  cSpread: number; annRollYield: number | undefined;
} | null {
  const ks = curve.knots;
  if (ks.length < 2) return null;
  const t1 = ks[0].t, t2 = ks[1].t;
  const p1 = ks[0].price, p2 = ks[1].price;
  const c = p2 - p1;
  const ry = p1 !== 0 ? (p2 - p1) / ((t2 - t1) * p1) : undefined;
  return { tNear: t1, tFar: t2, cSpread: c, annRollYield: ry };
}

/** Convert curve to a dense grid of (t, price) for plotting or downstream models. */
export function sample(
  curve: Curve,
  tMin?: number,
  tMax?: number,
  steps: number = 25
): { t: number; price: number }[] {
  const [lo, hi] = tRange(curve);
  if (!finite(lo) || !finite(hi) || lo === hi) return curve.knots.map(k => ({ t: k.t, price: k.price }));
  const a = tMin ?? Math.max(0, lo);
  const b = tMax ?? hi;
  if (a >= b) return [{ t: a, price: interpPrice(curve, a) ?? NaN }];
  const out: { t: number; price: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = a + (i * (b - a)) / steps;
    const p = interpPrice(curve, t);
    if (finite(p)) out.push({ t, price: p! });
  }
  return out;
}

/** Shift all prices by a constant (useful for back-adjust offsets). */
export function shift(curve: Curve, delta: number): Curve {
  return {
    anchorISO: curve.anchorISO,
    knots: curve.knots.map(k => ({ ...k, price: k.price + delta })),
    meta: curve.meta,
  };
}

/** Scale all prices by a factor (useful for ratio-adjust normalization). */
export function scale(curve: Curve, factor: number): Curve {
  return {
    anchorISO: curve.anchorISO,
    knots: curve.knots.map(k => ({ ...k, price: k.price * factor })),
    meta: curve.meta,
  };
}

/** Merge two curves by averaging overlapping tenors (linear on t grid of the denser curve). */
export function average(curveA: Curve, curveB: Curve): Curve {
  const base = curveA.knots.length >= curveB.knots.length ? curveA : curveB;
  const other = base === curveA ? curveB : curveA;
  const knots: CurveKnot[] = [];
  for (const k of base.knots) {
    const p2 = interpPrice(other, k.t);
    const p = finite(p2) ? 0.5 * (k.price + (p2 as number)) : k.price;
    knots.push({ ...k, price: p });
  }
  return { anchorISO: base.anchorISO, knots, meta: { note: "average(curveA, curveB)" } };
}

/** Construct curve directly from a map {expiryISO: price} with optional symbols (best-effort). */
export function fromExpiryMap(
  anchorISO: ISODate,
  m: Record<ISODate, number>,
  symbolByExpiry?: Record<ISODate, string>
): Curve {
  const quotes: Quote[] = [];
  for (const k of Object.keys(m)) {
    if (!finite(m[k])) continue;
    quotes.push({ symbol: symbolByExpiry?.[k] || k, expiryISO: k as ISODate, price: m[k] });
  }
  return buildCurve(anchorISO, quotes);
}

/** Pretty summary string. */
export function summarize(curve: Curve): string {
  if (!curve.knots.length) return `Curve@${curve.anchorISO}: (empty)`;
  const head = curve.knots.slice(0, Math.min(6, curve.knots.length))
    .map(k => `${k.symbol}:${k.price}@t=${k.t.toFixed(3)}`).join(", ");
  return `Curve@${curve.anchorISO} | knots=${curve.knots.length} | ${head}${curve.knots.length > 6 ? ", ..." : ""}`;
}

/** ===== Example: build front-3 metrics (safe if fewer knots) ===== */
export function front3Diagnostics(curve: Curve): {
  near?: CurveKnot; next?: CurveKnot; far?: CurveKnot;
  cal12?: number; cal23?: number; fly123?: number;
  roll12?: number | undefined; roll23?: number | undefined;
} {
  const k = curve.knots;
  const out: any = {};
  if (k[0]) out.near = k[0];
  if (k[1]) out.next = k[1];
  if (k[2]) out.far = k[2];
  if (k[0] && k[1]) {
    out.cal12 = k[1].price - k[0].price;
    out.roll12 = annualizedRollYield(curve, k[0].t, k[1].t);
  }
  if (k[1] && k[2]) {
    out.cal23 = k[2].price - k[1].price;
    out.roll23 = annualizedRollYield(curve, k[1].t, k[2].t);
  }
  if (k[0] && k[1] && k[2]) {
    out.fly123 = k[0].price - 2 * k[1].price + k[2].price;
  }
  return out;
}