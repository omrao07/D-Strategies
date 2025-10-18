// macro/currencycarry.ts
// Pure TypeScript (no imports). Self-contained currency carry strategy with
// basis adjustment, daily simulation, optional volatility targeting, and caps.

// ----------------- Types -----------------
export type CarrySignal = {
  side: "long_foreign" | "short_foreign" | "flat";
  strength: number;     // 0–1, magnitude of edge
  diffAnnual: number;   // (rf - rd - basis)
};

export type BacktestConfig = {
  rebalanceDays?: number;   // default 1 (daily)
  bandBp?: number;          // neutral band around zero diff; default 10 bp
  targetVol?: number;       // annual vol target (e.g., 0.1). If undefined, no vol target.
  volLookback?: number;     // days for realized vol estimate, default 60
  maxLeverage?: number;     // hard cap on leverage, default 5
};

export type BacktestResult = {
  dailyStrategyRet: number[]; // applied (with leverage) daily returns
  dailyRawRet: number[];      // un-levered daily returns
  dailyLev: number[];         // leverage path
  signalPath: CarrySignal[];  // signal used at each step
  cumReturn: number;          // total compounded return over sample
  annReturn: number;          // annualized geometric return
  annVol: number;             // annualized volatility of dailyStrategyRet
  sharpe: number;             // annReturn / annVol (0 if annVol=0)
};

// ----------------- Utils -----------------
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
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - m;
    v += d * d;
  }
  return v / (a.length - 1);
}
function annVolFromDaily(daily: number[]): number {
  const v = variance(daily);
  return Math.sqrt(v) * Math.sqrt(252);
}
function annualizeFromDaily(daily: number[]): number {
  // geometric annualization
  if (daily.length === 0) return 0;
  let c = 1;
  for (let i = 0; i < daily.length; i++) c *= (1 + daily[i]);
  const yrs = daily.length / 252;
  return yrs > 0 ? Math.pow(c, 1 / yrs) - 1 : 0;
}

// ----------------- Core: signal -----------------
/**
 * Currency carry signal using short-rate differential adjusted by basis.
 * Positive edge when foreign > domestic after basis → long foreign.
 * @param rd  domestic rate (annualized decimal)
 * @param rf  foreign rate  (annualized decimal)
 * @param basis  hedge/basis adj (annualized decimal). Positive if it BENEFITS domestic.
 * @param bandBp neutral band (in basis points) to avoid churn
 */
export function currencyCarrySignal(
  rd: number,
  rf: number,
  basis: number = 0,
  bandBp: number = 10
): CarrySignal {
  const diff = safe(rf) - safe(rd) - safe(basis); // edge for long foreign
  const band = Math.abs(bandBp) / 10000;
  let side: CarrySignal["side"] = "flat";
  let strength = 0;

  if (diff > band) {
    side = "long_foreign";
    // normalize strength assuming 0–5% typical diff
    strength = clamp(diff / 0.05, 0, 1);
  } else if (diff < -band) {
    side = "short_foreign";
    strength = clamp((-diff) / 0.05, 0, 1);
  } else {
    side = "flat";
    strength = 0;
  }
  return { side, strength, diffAnnual: diff };
}

// ----------------- Strategy backtest -----------------
export type CurrencyCarryInputs = {
  /**
   * Spot series S_t = units of DOMESTIC per 1 unit of FOREIGN (e.g., USD per 1 AUD).
   * Going long_foreign benefits when S rises (foreign appreciates vs domestic).
   */
  spot: number[];
  rd: number[];          // domestic annual short rate series (decimal)
  rf: number[];          // foreign annual short rate series (decimal)
  basis?: number[];      // annual basis series (decimal), optional
  config?: BacktestConfig;
};

/**
 * Simulates a simple carry strategy:
 * - Determine signal from (rf - rd - basis).
 * - Daily unlevered return = position * (spot log return + carry/252).
 * - Optional vol targeting using rolling realized vol of unlevered returns.
 */
export function runCurrencyCarry(inputs: CurrencyCarryInputs): BacktestResult {
  const S = inputs.spot || [];
  const n = S.length;
  const rd = inputs.rd || [];
  const rf = inputs.rf || [];
  const basis = inputs.basis || [];
  const cfg = inputs.config || {};

  const rebalanceDays = clamp(Math.floor(safe(cfg.rebalanceDays, 1)), 1, 252);
  const bandBp = isFiniteNumber(cfg.bandBp) ? cfg.bandBp! : 10;
  const targetVol = cfg.targetVol;
  const volLb = Math.max(2, Math.floor(safe(cfg.volLookback, 60)));
  const maxLev = safe(cfg.maxLeverage, 5);

  const rawRet: number[] = [];
  const levRet: number[] = [];
  const levPath: number[] = [];
  const sigPath: CarrySignal[] = [];

  let pos = 0; // +1 long foreign, -1 short foreign, 0 flat
  let lev = 1;

  for (let t = 1; t < n; t++) {
    // Recompute signal on rebalance days or first step
    if (t % rebalanceDays === 1 || t === 1) {
      const b = isFiniteNumber(basis[t]) ? basis[t] : 0;
      const sig = currencyCarrySignal(rd[t], rf[t], b, bandBp);
      sigPath.push(sig);
      pos = sig.side === "long_foreign" ? 1 : sig.side === "short_foreign" ? -1 : 0;
    } else {
      // keep last signal
      sigPath.push(sigPath[sigPath.length - 1]);
    }

    // Spot log return
    const rSpot = Math.log(S[t] / S[t - 1]);

    // Carry accrual for foreign exposure (per day)
    const diff = safe(rf[t]) - safe(rd[t]) - safe(isFiniteNumber(basis[t]) ? basis[t] : 0);
    const rCarry = diff / 252;

    const rUnlev = pos * (rSpot + rCarry);
    rawRet.push(rUnlev);

    // Vol targeting
    if (isFiniteNumber(targetVol)) {
      const lbStart = Math.max(0, rawRet.length - volLb);
      const window = rawRet.slice(lbStart, rawRet.length);
      const realized = annVolFromDaily(window);
      lev = realized > 0 ? clamp(targetVol! / realized, 0, maxLev) : 0;
    } else {
      lev = 1;
    }
    levPath.push(lev);

    const rLev = rUnlev * lev;
    levRet.push(rLev);
  }

  const cum = levRet.reduce((c, r) => c * (1 + r), 1) - 1;
  const annR = annualizeFromDaily(levRet);
  const annV = annVolFromDaily(levRet);
  const shp = annV > 0 ? annR / annV : 0;

  return {
    dailyStrategyRet: levRet,
    dailyRawRet: rawRet,
    dailyLev: levPath,
    signalPath: sigPath,
    cumReturn: cum,
    annReturn: annR,
    annVol: annV,
    sharpe: shp,
  };
}

// ----------------- Convenience one-shot -----------------
/**
 * Single-period (no series) carry summary for quick use.
 */
export function currencyCarrySummary(
  rd: number,
  rf: number,
  basis: number = 0,
  horizonDays: number = 30
) {
  const sig = currencyCarrySignal(rd, rf, basis);
  const T = Math.max(0, horizonDays) / 365;
  const ann = sig.diffAnnual;                 // annual edge
  const horizon = ann * T;                    // linearized over short horizons
  return {
    signal: sig,
    horizonReturn: horizon,
    annualized: ann,
    notes: [
      "Positive diffAnnual favors long foreign currency.",
      "Horizon return is linearized: diffAnnual × T (small-T approximation).",
    ],
  };
}
