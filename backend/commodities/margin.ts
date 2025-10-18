// commodities/margin.ts
// Minimal, import-free margin estimator for futures & options on futures.
// Strict-TS friendly. This is NOT a full SPAN® replica, but a pragmatic,
// transparent approximation suitable for backtesting / pre-trade checks.
//
// What it supports
// - Futures margin = notional * baseRate
// - Options margin:
//    * Long options: premium only
//    * Short options: max( SPAN-like scan risk , premium floor )
//      where scan risk = worst of N up/down underlying shocks + vol shocks,
//      plus an add-on for deep ITM exposure.
// - Portfolio aggregation with offsets by underlying symbol.
//
// Tune via `MarginParams`. Sensible defaults are provided.
//
// DISCLAIMER: Use exchange/broker figures for production. This is a model.

export type CP = "call" | "put";
export type Kind = "FUT" | "OPT";

export interface FutLeg {
  kind: "FUT";
  symbol: string;     // e.g., CL
  qty: number;        // positive long, negative short
  price: number;      // futures price
  multiplier: number; // $ per 1.00 price move (e.g., CL: 1000)
}

export interface OptLeg {
  kind: "OPT";
  symbol: string;     // underlying symbol (same as future's root)
  qty: number;        // +long, -short
  cp: CP;
  K: number;          // strike
  F: number;          // current forward/futures price of underlying
  premium: number;    // option price (per 1.00 underlying unit)
  multiplier: number; // contract multiplier
  iv?: number;        // (optional) implied vol for vol shock sizing
}

export type Leg = FutLeg | OptLeg;

export interface MarginParams {
  // Base per-underlying futures initial & maintenance rates (as % of notional)
  baseInitialPct?: number;      // default 0.08 (8%)
  baseMaintenancePct?: number;  // default 0.07 (7%)

  // Short option scan risk config
  scanUpPct?: number;           // underlying +% shock (default 15%)
  scanDownPct?: number;         // underlying -% shock absolute (default 15%)
  extraDownPutPct?: number;     // extra downside emphasis for puts (default 10%)
  volShockAbs?: number;         // IV absolute shock (e.g., +10 vol pts) if iv present (default 0.10)

  // Floors / caps
  shortOptPremFloorPct?: number; // min margin = floor * premium * |qty| * multiplier (default 1.0x)
  itmAddOnPct?: number;          // add-on for deep ITM exposure vs. K (default 0.10 = 10% of intrinsic)

  // Netting
  crossOffsetPct?: number;       // percent offset when long/short deltas oppose on same symbol (default 0.75)

  // Scenario count (2 = up/down only). Keep small for performance.
  scenarios?: number;            // default 2 (up/down)
}

export interface LegMarginResult {
  leg: Leg;
  initial: number;
  maintenance: number;
  detail: string;
}

export interface PortfolioMarginResult {
  perLeg: LegMarginResult[];
  perSymbol: Record<string, { initial: number; maintenance: number }>;
  initial: number;
  maintenance: number;
  params: Required<MarginParams>;
}

// ---------------- Defaults ----------------

function defaults(): Required<MarginParams> {
  return {
    baseInitialPct: 0.08,
    baseMaintenancePct: 0.07,
    scanUpPct: 0.15,
    scanDownPct: 0.15,
    extraDownPutPct: 0.10,
    volShockAbs: 0.10,
    shortOptPremFloorPct: 1.0,
    itmAddOnPct: 0.10,
    crossOffsetPct: 0.75,
    scenarios: 2,
  };
}

// ---------------- Public API ----------------

/** Compute portfolio margin (approx). Legs must have consistent multipliers per symbol. */
export function margin(legs: Leg[], params: MarginParams = {}): PortfolioMarginResult {
  const P = { ...defaults(), ...params };

  const perLeg: LegMarginResult[] = [];
  const bySym: Record<string, { legs: LegMarginResult[] }> = {};

  for (const leg of legs) {
    const res = leg.kind === "FUT"
      ? marginFutures(leg, P)
      : marginOption(leg, P);

    perLeg.push(res);
    const sym = leg.symbol.toUpperCase();
    if (!bySym[sym]) bySym[sym] = { legs: [] };
    bySym[sym].legs.push(res);
  }

  // Aggregate by symbol with cross-offset for opposing risk
  const perSymbol: Record<string, { initial: number; maintenance: number }> = {};
  for (const sym of Object.keys(bySym)) {
    const group = bySym[sym].legs;

    const initLong = sum(group.filter(r => netDeltaSign(r.leg) > 0).map(r => r.initial));
    const initShort = sum(group.filter(r => netDeltaSign(r.leg) < 0).map(r => r.initial));
    const maintLong = sum(group.filter(r => netDeltaSign(r.leg) > 0).map(r => r.maintenance));
    const maintShort = sum(group.filter(r => netDeltaSign(r.leg) < 0).map(r => r.maintenance));

    // Offset opposing sides
    const initial = pairOffset(initLong, initShort, P.crossOffsetPct);
    const maintenance = pairOffset(maintLong, maintShort, P.crossOffsetPct);

    perSymbol[sym] = { initial, maintenance };
  }

  const initial = sum(Object.values(perSymbol).map(x => x.initial));
  const maintenance = sum(Object.values(perSymbol).map(x => x.maintenance));

  return { perLeg, perSymbol, initial, maintenance, params: P };
}

// ---------------- Per-leg calcs ----------------

function marginFutures(leg: FutLeg, P: Required<MarginParams>): LegMarginResult {
  const notional = Math.abs(leg.qty) * leg.price * leg.multiplier;
  const initial = notional * P.baseInitialPct;
  const maintenance = notional * P.baseMaintenancePct;
  return {
    leg,
    initial,
    maintenance,
    detail: `FUT notional=${fmt(notional)} init=${pct(P.baseInitialPct)} maint=${pct(P.baseMaintenancePct)}`
  };
}

function marginOption(leg: OptLeg, P: Required<MarginParams>): LegMarginResult {
  const qtyAbs = Math.abs(leg.qty);
  const premAbs = qtyAbs * leg.premium * leg.multiplier;

  if (leg.qty > 0) {
    // Long option: premium only (already paid). Initial margin = premium, maintenance = 0.
    return {
      leg,
      initial: premAbs,
      maintenance: 0,
      detail: "OPT long: premium only"
    };
  }

  // Short option: compute scan risk
  const shocks = buildScenarios(leg, P);
  let worstLoss = 0;

  for (const s of shocks) {
    const pay = optionPayoff(leg.cp, s.Fshock, leg.K) - optionPayoff(leg.cp, leg.F, leg.K); // change in intrinsic
    // Short position loses when payoff increases
    const intrinsicLoss = Math.max(0, pay) * qtyAbs * leg.multiplier;

    // Vol shock proxy: increase extrinsic proportionally to IV shock, if iv provided
    const extrinsic = Math.max(0, leg.premium - Math.max(0, optionPayoff(leg.cp, leg.F, leg.K)));
    const extrinsicShock = leg.iv != null ? Math.max(0, extrinsic) * Math.max(0, s.volBump) : 0;

    const loss = intrinsicLoss + extrinsicShock * qtyAbs * leg.multiplier;
    if (loss > worstLoss) worstLoss = loss;
  }

  // Add-on for deep ITM short exposure
  const intrinsicNow = Math.max(0, optionPayoff(leg.cp, leg.F, leg.K));
  const itmAddOn = intrinsicNow * qtyAbs * leg.multiplier * P.itmAddOnPct;

  // Floor vs. a multiple of premium
  const floor = premAbs * P.shortOptPremFloorPct;

  const initial = Math.max(worstLoss + itmAddOn, floor);
  const maintenance = initial * (P.baseMaintenancePct / Math.max(1e-9, P.baseInitialPct));

  const msg = `OPT short: worstScan=${fmt(worstLoss)} floor=${fmt(floor)} itmAddOn=${fmt(itmAddOn)}`;
  return { leg, initial, maintenance, detail: msg };
}

// ---------------- Scenarios ----------------

function buildScenarios(leg: OptLeg, P: Required<MarginParams>): Array<{ Fshock: number; volBump: number }> {
  const up = P.scanUpPct;
  let down = P.scanDownPct;
  if (leg.cp === "put") down += P.extraDownPutPct;

  const vols = leg.iv != null ? [0, +P.volShockAbs] : [0];

  const scenarios: Array<{ Fshock: number; volBump: number }> = [];
  // Up
  for (const v of vols) scenarios.push({ Fshock: leg.F * (1 + up), volBump: v });
  // Down
  for (const v of vols) scenarios.push({ Fshock: leg.F * Math.max(0, 1 - down), volBump: v });

  if (P.scenarios > 2) {
    // Optional mid scenarios (±half shock)
    const upMid = up * 0.5, dnMid = down * 0.5;
    for (const v of vols) scenarios.push({ Fshock: leg.F * (1 + upMid), volBump: v });
    for (const v of vols) scenarios.push({ Fshock: leg.F * Math.max(0, 1 - dnMid), volBump: v });
  }
  return scenarios;
}

// ---------------- Helpers ----------------

function optionPayoff(cp: CP, F: number, K: number): number {
  return cp === "call" ? Math.max(F - K, 0) : Math.max(K - F, 0);
}

function netDeltaSign(leg: Leg): number {
  if (leg.kind === "FUT") return Math.sign(leg.qty); // futures delta ~ 1
  // crude delta sign: long call/short put positive with respect to F
  const sign = leg.cp === "call" ? +1 : -1;
  return Math.sign(leg.qty * sign);
}

function pairOffset(a: number, b: number, pct: number): number {
  // combine |a| and |b| with offset on the smaller side
  const A = Math.abs(a), B = Math.abs(b);
  const big = Math.max(A, B), small = Math.min(A, B);
  return big + (1 - pct) * small;
}

function sum(a: number[]): number { let s = 0; for (const x of a) s += x; return s; }
function pct(x: number): string { return (x * 100).toFixed(1) + "%"; }
function fmt(x: number): string { return "$" + (Math.round(x * 100) / 100).toLocaleString(); }

// ---------------- Convenience: presets ----------------

/** Quick helper to build a futures leg. */
export function fut(symbol: string, qty: number, price: number, multiplier: number): FutLeg {
  return { kind: "FUT", symbol: symbol.toUpperCase(), qty, price, multiplier };
}

/** Quick helper to build an option leg on a future. */
export function opt(symbol: string, qty: number, cp: CP, K: number, F: number, premium: number, multiplier: number, iv?: number): OptLeg {
  return { kind: "OPT", symbol: symbol.toUpperCase(), qty, cp, K, F, premium, multiplier, iv };
}

/** Example presets for common commodity futures (override as needed). */
export const Multipliers: Record<string, number> = {
  CL: 1000,   // Crude Oil $1000/pt
  NG: 10000,  // NatGas $10,000/pt
  RB: 42000,  // RBOB $42,000/pt
  HO: 42000,  // Heating Oil $42,000/pt
  GC: 100,    // Gold $100/pt
  SI: 5000,   // Silver $5,000/pt
  ZC: 50,     // Corn $50/pt
  ZS: 50,     // Soybeans $50/pt
  ZW: 50,     // Wheat $50/pt
};