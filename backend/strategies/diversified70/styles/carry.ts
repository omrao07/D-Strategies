// styles/carry.ts
// Pure TypeScript, no imports. Production-ready utilities + carry models.

// ---------- Utils ----------
type Num = number;

function isFiniteNumber(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
function safe(x: any, def: number = 0): number {
  return isFiniteNumber(x) ? x : def;
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
function yrs(days: number | undefined | null): number {
  const d = safe(days, 0);
  return d <= 0 ? 0 : d / 365;
}

// ---------- Common return shape ----------
export type CarryBreakdown = {
  annualized: Num;      // annualized return (decimal)
  horizonReturn: Num;   // total return over horizon (decimal)
  horizonYears: Num;    // T in years
  // Component attributions (optional by model)
  income?: Num;         // income/carry leg over horizon (decimal)
  financing?: Num;      // funding/borrow leg (annualized if noted in comments)
  rolldown?: Num;       // rolldown/curve component over horizon (decimal)
  price?: Num;          // price impact over horizon (decimal)
  notes: string[];      // model hints/warnings
};

// =======================================================
// 1) Equity carry (dividends vs borrow & funding on cash)
// =======================================================
export type EquityCarryInput = {
  dividendYield?: number;  // forward annual dividend yield (decimal)
  borrowCost?: number;     // stock borrow cost if short (decimal, annual)
  fundingRate?: number;    // cash rate on long collateral (decimal, annual)
  horizonDays: number;     // horizon in days
  isLong?: boolean;        // default true
};

export function carryEquity(input: EquityCarryInput): CarryBreakdown {
  const T = yrs(input.horizonDays);

  const div = Math.max(0, safe(input.dividendYield));
  const borrow = Math.max(0, safe(input.borrowCost));
  const rf = safe(input.fundingRate);
  const long = input.isLong !== false; // default long

  // Annualized carry:
  // Long: +div + rf
  // Short: -div - borrow + rf (earn cash on short proceeds, ignore frictions)
  const ann = long ? (div + rf) : (-div - borrow + rf);
  const horizonRet = ann * T;

  const notes: string[] = [];
  if (!isFiniteNumber(input.dividendYield)) notes.push("No dividend_yield provided.");
  if (!long && !isFiniteNumber(input.borrowCost))
    notes.push("No borrow_cost; short carry may be overstated.");

  return {
    annualized: ann,
    horizonReturn: horizonRet,
    horizonYears: T,
    income: long ? div : -div,
    financing: long ? rf : (rf - borrow),
    notes,
  };
}

// =====================================
// 2) FX carry (CIP/basis adjusted rate)
// =====================================
export type FXCarryInput = {
  rateDomestic: number;   // domestic short rate (annualized, decimal)
  rateForeign: number;    // foreign short rate (annualized, decimal)
  hedgeCostAdj?: number;  // cross-currency basis, positive if USD receives (decimal, annual)
  horizonDays: number;
};

export function carryFX(input: FXCarryInput): CarryBreakdown {
  const T = yrs(input.horizonDays);
  const rd = safe(input.rateDomestic);
  const rf = safe(input.rateForeign);
  const basis = safe(input.hedgeCostAdj); // CIP/basis adjustment

  // Annualized differential adjusted by basis
  const diff = (rd - rf) + basis;
  const horizonRet = diff * T;
  const annualized = T > 0 ? diff : 0;

  const notes: string[] = [];
  if (!isFiniteNumber(input.hedgeCostAdj))
    notes.push("No hedge basis provided; carry is pure short-rate differential.");

  return {
    annualized,
    horizonReturn: horizonRet,
    horizonYears: T,
    income: diff * T, // treat as income-style accrual over horizon
    notes,
  };
}

// ===================================================
// 3) Credit carry (spread minus expected default loss)
//     + rolldown from credit curve slope
// ===================================================
export type CreditCarryInput = {
  spread?: number;                 // current spread (decimal, annual)
  spreadDuration?: number;         // spread DV01-like duration in years
  curveSlopeBpPerYear?: number;    // local spread curve slope in bp/year
  annualDefaultProb?: number;      // annual default probability (decimal)
  lossGivenDefault?: number;       // LGD in decimal (e.g., 0.6)
  horizonDays: number;
};

export function carryCredit(input: CreditCarryInput): CarryBreakdown {
  const T = yrs(input.horizonDays);

  const s = clamp(safe(input.spread), -1, 1);
  const SD = Math.max(0, safe(input.spreadDuration));
  const slope = safe(input.curveSlopeBpPerYear) / 10000; // bp -> decimal
  const h = Math.max(0, safe(input.annualDefaultProb));
  const LGD = isFiniteNumber(input.lossGivenDefault) ? (input.lossGivenDefault as number) : 0.6;

  // Income over horizon: spread accrual minus expected credit loss
  const incomeH = (s - h * LGD) * T;

  // Rolldown: spread change from sliding down the curve
  // Approx: P&L ≈ SD * (−ΔSpread). With slope as +bp/year further out,
  // when time passes T, local spread moves by (slope * T) toward shorter maturity.
  // Here we model return impact as SD * (− slope * T).
  const rolldownH = SD * (-slope) * T;

  const horizonRet = incomeH + rolldownH;
  const annualized = T > 0 ? Math.pow(1 + horizonRet, 1 / T) - 1 : 0;

  const notes: string[] = [];
  if (!isFiniteNumber(input.spread)) notes.push("No spread provided.");
  if (!isFiniteNumber(input.spreadDuration)) notes.push("No spread duration; rolldown omitted.");
  if (!isFiniteNumber(input.curveSlopeBpPerYear)) notes.push("No credit curve slope; rolldown assumes flat.");
  if (!isFiniteNumber(input.annualDefaultProb)) notes.push("No default probability; expected loss may be understated.");
  if (!isFiniteNumber(input.lossGivenDefault)) notes.push("No LGD; defaulted to 60%.");

  return {
    annualized,
    horizonReturn: horizonRet,
    horizonYears: T,
    income: incomeH,
    rolldown: rolldownH,
    notes,
  };
}

// ===========================================================
// 4) Rates/Bond carry (carry + rolldown using D, convexity)
// ===========================================================
export type RatesCarryInput = {
  yieldToMaturity: number;     // YTM (decimal, annual)
  modifiedDuration?: number;   // modified duration
  macaulayDuration?: number;   // macaulay duration (years)
  convexity?: number;          // price convexity
  couponRate?: number;         // annual coupon rate (decimal)
  slopeBpPerYear?: number;     // local yield curve slope in bp/year
  horizonDays: number;
};

export function carryRates(input: RatesCarryInput): CarryBreakdown {
  const T = yrs(input.horizonDays);

  const y = safe(input.yieldToMaturity);
  const Dm = isFiniteNumber(input.modifiedDuration)
    ? (input.modifiedDuration as number)
    : (isFiniteNumber(input.macaulayDuration) ? (input.macaulayDuration as number) / (1 + y) : 0);

  const Cx = safe(input.convexity);
  const cpn = isFiniteNumber(input.couponRate) ? (input.couponRate as number) : y;

  // Income (rough): coupon accrual over horizon
  const incomeH = cpn * T;

  // Rolldown via local curve slope (bp per year converted to Δy over horizon)
  const slopeBp = isFiniteNumber(input.slopeBpPerYear) ? (input.slopeBpPerYear as number) : 0;
  const dY = (slopeBp / 10000) * T; // bp -> decimal, scaled by T

  // Price P&L (percentage) ≈ -D * Δy + 0.5 * Convexity * (Δy)^2
  const priceH = (-Dm * dY) + 0.5 * Cx * dY * dY;

  const horizonRet = incomeH + priceH;
  const annualized = T > 0 ? (Math.pow(1 + horizonRet, 1 / T) - 1) : 0;

  const notes: string[] = [];
  if (!isFiniteNumber(input.convexity))
    notes.push("No convexity provided; rolldown is first-order.");
  if (!isFiniteNumber(input.slopeBpPerYear))
    notes.push("No local slope; rolldown excludes curve view.");

  return {
    annualized,
    horizonReturn: horizonRet,
    horizonYears: T,
    income: incomeH,
    rolldown: priceH,
    notes,
  };
}

// -----------------------------------------------------------
// Optional: Generic router if the caller wants a single entry
// -----------------------------------------------------------
export type AssetClass =
  | { kind: "equity"; input: EquityCarryInput }
  | { kind: "fx"; input: FXCarryInput }
  | { kind: "credit"; input: CreditCarryInput }
  | { kind: "rates"; input: RatesCarryInput };

export function carry(ac: AssetClass): CarryBreakdown {
  switch (ac.kind) {
    case "equity": return carryEquity(ac.input);
    case "fx": return carryFX(ac.input);
    case "credit": return carryCredit(ac.input);
    case "rates": return carryRates(ac.input);
    default: return { annualized: 0, horizonReturn: 0, horizonYears: 0, notes: ["Unknown asset class."] };
  }
}
