// macro/ratearb.ts
// Pure TypeScript. Interest-rate arbitrage via cost-of-carry mispricing between
// spot and futures. Includes signal + simple daily backtest with optional vol targeting.

// ---------------- Types ----------------
export type RateArbSignal = {
  side: "cash_and_carry" | "reverse_cash_and_carry" | "flat";
  edgeAnnual: number;   // annualized edge vs financing (decimal)
  impliedRate: number;  // annualized rate implied by F/S (decimal)
  fairFutures: number;  // theoretical F from carry model
  band: number;         // neutral band (decimal)
};

export type BacktestConfig = {
  bandBp?: number;        // ignore edges inside this band (bp). Default 5
  volTarget?: number;     // annual vol target (e.g., 0.10). If undefined, no targeting
  volLookback?: number;   // days for realized vol estimate. Default 60
  maxLeverage?: number;   // cap on leverage. Default 5
};

export type BacktestResult = {
  dailyRawRet: number[];      // unlevered daily returns path
  dailyLevRet: number[];      // levered (targeted) returns path
  dailyLev: number[];         // leverage used each day
  signalPath: RateArbSignal[];// signal each day
  cumReturn: number;          // compounded return
  annReturn: number;          // geometric annualized
  annVol: number;             // annualized volatility
  sharpe: number;             // annReturn / annVol (0 if annVol=0)
};

// -------------- Utils --------------
function isFiniteNumber(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
function safe(x: any, d = 0): number {
  return isFiniteNumber(x) ? x : d;
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
function mean(a: number[]): number {
  if (a.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}
function variance(a: number[]): number {
  if (a.length <= 1) return 0;
  const m = mean(a);
  let v = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - m; v += d * d; }
  return v / (a.length - 1);
}
function annVolFromDaily(d: number[]): number {
  const v = variance(d);
  return Math.sqrt(v) * Math.sqrt(252);
}
function annReturnFromDaily(d: number[]): number {
  if (d.length === 0) return 0;
  let c = 1;
  for (let i = 0; i < d.length; i++) c *= (1 + d[i]);
  const yrs = d.length / 252;
  return yrs > 0 ? Math.pow(c, 1 / yrs) - 1 : 0;
}

// -------------- Core carry math --------------
/**
 * Fair futures from discrete cost-of-carry: F = S * (1 + (r - y))^T
 * (T in years; r = financing rate; y = income yield/carry)
 * For short horizons difference vs continuous is negligible; we keep it simple.
 */
export function fairFuturesFromRate(
  spot: number,
  fundingRate: number,   // annual decimal
  incomeYield: number,   // annual decimal (coupon/dividend/GC specialness). Use 0 if none.
  Tyears: number
): number {
  const S = Math.max(1e-12, safe(spot, 0));
  const r = safe(fundingRate, 0);
  const y = safe(incomeYield, 0);
  const T = Math.max(0, safe(Tyears, 0));
  return S * Math.pow(1 + (r - y), T);
}

/**
 * Implied annualized rate from actual futures and spot:
 * r_impl = ( (F/S)^(1/T) - 1 ) + y
 */
export function impliedRateFromFutures(
  spot: number,
  futures: number,
  incomeYield: number,
  Tyears: number
): number {
  const S = Math.max(1e-12, safe(spot, 0));
  const F = Math.max(1e-12, safe(futures, 0));
  const y = safe(incomeYield, 0);
  const T = Math.max(1e-6, safe(Tyears, 0.000001));
  return Math.pow(F / S, 1 / T) - 1 + y;
}

/**
 * Arbitrage signal:
 * - If impliedRate >> funding → futures too rich → CASH-AND-CARRY:
 *   buy spot (finance at funding), short futures.
 * - If impliedRate << funding → futures too cheap → REVERSE C&C:
 *   short spot (borrow & pay income), long futures.
 */
export function rateArbSignal(
  spot: number,
  futures: number,
  Tyears: number,
  fundingRate: number,     // your financing (GC/repo)
  incomeYield: number = 0, // carry you receive for holding spot
  bandBp: number = 5
): RateArbSignal {
  const imp = impliedRateFromFutures(spot, futures, incomeYield, Tyears);
  const fairF = fairFuturesFromRate(spot, fundingRate, incomeYield, Tyears);
  const band = Math.abs(bandBp) / 10000;

  const edge = imp - fundingRate; // positive → C&C edge
  let side: RateArbSignal["side"] = "flat";
  if (edge > band) side = "cash_and_carry";
  else if (edge < -band) side = "reverse_cash_and_carry";

  return {
    side,
    edgeAnnual: Math.abs(edge) > band ? edge : 0,
    impliedRate: imp,
    fairFutures: fairF,
    band,
  };
}

// -------------- Backtest --------------
export type RateArbInputs = {
  /** Spot and futures price series aligned by day. */
  spot: number[];
  futures: number[];
  /** Time to futures expiry in calendar days each day (decreasing to ~0, then roll). */
  daysToExpiry: number[];
  /** Financing rate series (annual decimal), e.g., GC/repo/benchmark. */
  fundingRate: number[];
  /** Income/carry yield on the spot (annual decimal). Optional; default 0. */
  incomeYield?: number[];
  config?: BacktestConfig;
};

/**
 * Simple daily P&L model:
 * - Each day, compute signal from edge = impliedRate - funding.
 * - Unlevered daily return ~= sign * max(|edge| - band, 0) / 252.
 *   (This proxies the lockable arbitrage edge ignoring idiosyncratic basis moves.)
 * - Optional volatility targeting on the unlevered return stream.
 * - Series must be aligned; missing values treated as 0/flat.
 */
export function runRateArb(inputs: RateArbInputs): BacktestResult {
  const S = inputs.spot || [];
  const F = inputs.futures || [];
  const D = inputs.daysToExpiry || [];
  const r = inputs.fundingRate || [];
  const y = inputs.incomeYield || [];

  const n = Math.min(S.length, F.length, D.length, r.length, y.length || S.length);
  const cfg = inputs.config || {};
  const bandBp = isFiniteNumber(cfg.bandBp) ? cfg.bandBp! : 5;
  const volTarget = cfg.volTarget;
  const volLb = Math.max(2, Math.floor(safe(cfg.volLookback, 60)));
  const maxLev = safe(cfg.maxLeverage, 5);

  const raw: number[] = [];
  const lev: number[] = [];
  const levRet: number[] = [];
  const sigs: RateArbSignal[] = [];

  for (let t = 0; t < n; t++) {
    const Tyears = Math.max(0, safe(D[t], 0)) / 365;
    const sig = rateArbSignal(
      S[t],
      F[t],
      Tyears > 0 ? Tyears : 1 / 365, // avoid 0 on expiry day
      safe(r[t], 0),
      isFiniteNumber(y[t]) ? y[t] : 0,
      bandBp
    );
    sigs.push(sig);

    const sign =
      sig.side === "cash_and_carry" ? +1 :
      sig.side === "reverse_cash_and_carry" ? -1 : 0;

    const dailyEdge = Math.max(Math.abs(sig.edgeAnnual) - sig.band, 0) / 252;
    const rUnlev = sign * dailyEdge;
    raw.push(rUnlev);

    // vol targeting
    let L = 1;
    if (isFiniteNumber(volTarget)) {
      const win = raw.slice(Math.max(0, raw.length - volLb));
      const realized = annVolFromDaily(win);
      L = realized > 0 ? clamp(volTarget! / realized, 0, maxLev) : 0;
    }
    lev.push(L);
    levRet.push(rUnlev * L);
  }

  const cum = levRet.reduce((c, x) => c * (1 + x), 1) - 1;
  const aR = annReturnFromDaily(levRet);
  const aV = annVolFromDaily(levRet);
  const sh = aV > 0 ? aR / aV : 0;

  return {
    dailyRawRet: raw,
    dailyLevRet: levRet,
    dailyLev: lev,
    signalPath: sigs,
    cumReturn: cum,
    annReturn: aR,
    annVol: aV,
    sharpe: sh,
  };
}

// -------------- Convenience one-shot --------------
export function rateArbSummary(
  spot: number,
  futures: number,
  daysToExpiry: number,
  fundingRate: number,
  incomeYield: number = 0,
  bandBp: number = 5
) {
  const T = Math.max(0, daysToExpiry) / 365;
  const sig = rateArbSignal(spot, futures, T || 1 / 365, fundingRate, incomeYield, bandBp);
  const horizon = T; // years
  // Linearized horizon return from locked edge
  const horizonRet = Math.sign(sig.edgeAnnual) * Math.max(Math.abs(sig.edgeAnnual) - sig.band, 0) * horizon;

  const legs =
    sig.side === "cash_and_carry"
      ? ["Long spot (earn income)", "Short futures", "Finance at funding rate"]
      : sig.side === "reverse_cash_and_carry"
      ? ["Short spot (pay borrow/income)", "Long futures", "Invest proceeds at funding"]
      : ["No trade"];

  return {
    signal: sig,
    horizonReturn: horizonRet,
    annualized: sig.edgeAnnual,
    tradeTemplate: legs,
    notes: [
      "Edge = impliedRate − funding. Positive → futures rich → cash-and-carry.",
      "Returns are small-T approximations ignoring frictions and margining.",
    ],
  };
}
