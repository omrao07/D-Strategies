// valuation/dcf.ts
// Lightweight DCF engine with FCFF, Gordon/Exit terminal, mid-year convention,
// projection helper, and WACC × g sensitivity grid.
//
// No external deps; safe to drop-in. Node/TS/ESM friendly.

export type DCFMode = "fcff";
export type TerminalMethod = "gordon" | "exit-multiple";

export interface DCFInputs {
  /** Forecast free cash flow to firm for each forecast year (t=1..N) */
  fcff: number[];
  /** Discount rate (WACC) as decimal, e.g., 0.09 for 9% */
  wacc: number;
  /** Terminal growth as decimal (used if terminal.method = "gordon") */
  terminalGrowth?: number;
  /** Exit multiple applied to terminal base (used if terminal.method = "exit-multiple") */
  terminalMultiple?: number;
  /** What terminal method to use; default "gordon" */
  terminalMethod?: TerminalMethod;
  /** Terminal base; if omitted, uses last-year FCFF (or last EBITDA if you feed it) */
  terminalBase?: number;
  /** Mid-year convention (shifts discount by 0.5 years) */
  midYear?: boolean;

  /** Balance sheet / capital structure for equity bridge */
  cash?: number;         // excess cash
  debt?: number;         // gross debt
  netDebt?: number;      // if supplied, overrides cash/debt bridge
  minorities?: number;   // minority interest (subtract)
  investments?: number;  // non-operating investments (add)

  /** Shares outstanding for per-share value */
  sharesOut?: number;

  /** Sanity guards */
  clampNegativeTV?: boolean; // default: true
}

export interface DCFResult {
  mode: DCFMode;
  years: number;
  wacc: number;
  midYear: boolean;
  terminal: {
    method: TerminalMethod;
    base: number;
    growth?: number;
    multiple?: number;
    value: number;      // terminal value at t=N (not discounted)
    pv: number;         // discounted terminal value
  };
  pvFcff: number;       // PV of forecast FCFF
  enterpriseValue: number;
  equityBridge: {
    cash: number;
    debt: number;
    netDebt: number;
    minorities: number;
    investments: number;
  };
  equityValue: number;
  perShare?: number;
  assumptions: {
    clampNegativeTV: boolean;
  };
}

/* ============================== Helpers =============================== */

const EPS = 1e-9;
const max0 = (x: number) => (x < 0 ? 0 : x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function df(t: number, r: number, midYear = false): number {
  const shift = midYear ? t - 0.5 : t; // t=1..N
  return 1 / Math.pow(1 + r, shift);
}

function terminalGordon(next: number, r: number, g: number): number {
  // TV at t=N using perpetuity growth: FCFF_{N+1}/(r-g)
  if (r - g <= EPS) return Number.POSITIVE_INFINITY;
  return next / (r - g);
}

/* ============================== Core DCF ============================== */

/**
 * Compute a DCF based on FCFF with either Gordon growth or exit multiple.
 */
export function computeDCF(inps: DCFInputs): DCFResult {
  const {
    fcff,
    wacc,
    terminalGrowth = 0.02,
    terminalMultiple = 12,
    terminalMethod = "gordon",
    terminalBase,
    midYear = true,
    cash = 0,
    debt = 0,
    netDebt,
    minorities = 0,
    investments = 0,
    sharesOut,
    clampNegativeTV = true,
  } = inps;

  if (!Array.isArray(fcff) || fcff.length === 0) {
    throw new Error("DCF: 'fcff' must be a non-empty array of yearly forecasts.");
  }
  if (!isNum(wacc) || wacc <= 0) {
    throw new Error("DCF: 'wacc' must be a positive decimal (e.g., 0.09).");
  }

  const N = fcff.length;
  let pvFcff = 0;
  for (let t = 1; t <= N; t++) {
    pvFcff += fcff[t - 1] * df(t, wacc, midYear);
  }

  // Terminal base: prefer explicit `terminalBase`, otherwise last FCFF
  const base = isNum(terminalBase) ? terminalBase : fcff[N - 1];

  let tv = 0;
  let tvMeta: DCFResult["terminal"];

  if (terminalMethod === "gordon") {
    const next = base * (1 + terminalGrowth);
    tv = terminalGordon(next, wacc, terminalGrowth);
    if (clampNegativeTV) tv = max0(tv);
    tvMeta = {
      method: "gordon",
      base,
      growth: terminalGrowth,
      value: tv,
      pv: tv * df(N, wacc, midYear),
    };
  } else {
    // Exit multiple applied to base (commonly EBITDA or FCFF proxy)
    tv = base * terminalMultiple;
    if (clampNegativeTV) tv = max0(tv);
    tvMeta = {
      method: "exit-multiple",
      base,
      multiple: terminalMultiple,
      value: tv,
      pv: tv * df(N, wacc, midYear),
    };
  }

  const enterpriseValue = pvFcff + tvMeta.pv;

  // Equity bridge
  const useNetDebt = isNum(netDebt) ? netDebt : debt - cash;
  const equityValue = enterpriseValue - useNetDebt - (minorities || 0) + (investments || 0);
  const perShare = isNum(sharesOut) && sharesOut > 0 ? equityValue / sharesOut : undefined;

  return {
    mode: "fcff",
    years: N,
    wacc,
    midYear,
    terminal: tvMeta,
    pvFcff,
    enterpriseValue,
    equityBridge: {
      cash: cash || 0,
      debt: debt || (isNum(netDebt) ? netDebt + (cash || 0) : 0),
      netDebt: useNetDebt || 0,
      minorities: minorities || 0,
      investments: investments || 0,
    },
    equityValue,
    perShare,
    assumptions: { clampNegativeTV },
  };
}

/* ===================== Sensitivity (WACC × g) ======================== */

export interface DcfSensitivity {
  waccs: number[];
  growths: number[];
  table: number[][]; // EV grid (enterprise value) [i=g][j=wacc]
}

/**
 * Build a sensitivity grid of enterprise value across WACC × terminal growth.
 * Uses Gordon growth terminal, last FCFF as base.
 */
export function dcfSensitivityGrid(
  fcff: number[],
  waccs: number[],
  growths: number[],
  opts?: { midYear?: boolean; clampNegativeTV?: boolean }
): DcfSensitivity {
  const midYear = opts?.midYear ?? true;
  const clamp = opts?.clampNegativeTV ?? true;

  const N = fcff.length;
  // Precompute PV of forecast FCFF for each WACC
  const pvByWacc = waccs.map((r) => {
    let pv = 0;
    for (let t = 1; t <= N; t++) pv += fcff[t - 1] * df(t, r, midYear);
    return pv;
  });

  const base = fcff[N - 1];
  const table = growths.map((g) =>
    waccs.map((r, j) => {
      const next = base * (1 + g);
      const tv = terminalGordon(next, r, g);
      const tvClamped = clamp ? max0(tv) : tv;
      const ev = pvByWacc[j] + tvClamped * df(N, r, midYear);
      return ev;
    })
  );

  return { waccs, growths, table };
}

/** Pretty-print the sensitivity grid as an ASCII table (for CLI). */
export function formatSensitivity(ev: DcfSensitivity, digits = 0): string {
  const { waccs, growths, table } = ev;
  const fmtP = (x: number) => (x * 100).toFixed(1) + "%";
  const fmtN = (x: number) => x.toFixed(digits);

  const header = ["g \\ r", ...waccs.map(fmtP)].join("\t");
  const rows = growths.map((g, i) => [fmtP(g), ...table[i].map(fmtN)].join("\t"));
  return [header, ...rows].join("\n");
}

/* ==================== Projection helper (optional) ==================== */

export interface ProjectionInputs {
  years: number;               // forecast years
  revenue0: number;            // starting revenue
  growth: number[];            // length == years (yearly growth rates)
  ebitMargin: number;          // EBIT margin (decimal)
  taxRate: number;             // decimal
  depPctOfSales: number;       // depreciation % of sales
  capexPctOfSales: number;     // capex % of sales
  wcPctOfSales: number;        // working capital % of sales
}

/**
 * Derive FCFF series from simple, transparent operating assumptions.
 * FCFF ≈ NOPAT + Depreciation − Capex − ΔWC
 */
export function projectFCFF(p: ProjectionInputs): { sales: number[]; ebit: number[]; fcff: number[] } {
  const {
    years,
    revenue0,
    growth,
    ebitMargin,
    taxRate,
    depPctOfSales,
    capexPctOfSales,
    wcPctOfSales,
  } = p;

  if (growth.length !== years) {
    throw new Error("projectFCFF: 'growth' length must equal 'years'.");
  }

  const sales: number[] = [];
  const ebit: number[] = [];
  const dep: number[] = [];
  const capex: number[] = [];
  const wc: number[] = []; // level of working capital as % of sales
  const fcff: number[] = [];

  let s = revenue0;
  let prevWC = revenue0 * wcPctOfSales;

  for (let t = 0; t < years; t++) {
    s = s * (1 + growth[t]);
    const e = s * ebitMargin;
    const nopat = e * (1 - taxRate);
    const d = s * depPctOfSales;
    const c = s * capexPctOfSales;
    const wcLvl = s * wcPctOfSales;
    const dWC = wcLvl - prevWC;

    const f = nopat + d - c - dWC;

    sales.push(s);
    ebit.push(e);
    dep.push(d);
    capex.push(c);
    wc.push(wcLvl);
    fcff.push(f);

    prevWC = wcLvl;
  }

  return { sales, ebit, fcff };
}

/* ============================== Example =============================== */
/*
Example usage:

// 1) Project FCFF from simple drivers
const proj = projectFCFF({
  years: 5,
  revenue0: 1000,
  growth: [0.08, 0.07, 0.06, 0.05, 0.04],
  ebitMargin: 0.18,
  taxRate: 0.24,
  depPctOfSales: 0.03,
  capexPctOfSales: 0.04,
  wcPctOfSales: 0.12,
});

// 2) Compute DCF with Gordon terminal
const res = computeDCF({
  fcff: proj.fcff,
  wacc: 0.09,
  terminalGrowth: 0.025,
  terminalMethod: "gordon",
  cash: 150,
  debt: 400,
  minorities: 0,
  investments: 50,
  sharesOut: 100,
});

// 3) Sensitivity grid (EV across WACC × g)
const grid = dcfSensitivityGrid(proj.fcff, [0.08,0.09,0.10,0.11], [0.01,0.02,0.03]);
console.log(formatSensitivity(grid, 0));
*/