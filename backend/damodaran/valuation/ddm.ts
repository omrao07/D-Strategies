// valuation/ddm.ts
// Multi-stage Dividend Discount Model with Gordon terminal.
// Supports explicit dividends or projection from EPS & payout.
// No external deps; TS/ESM friendly.

export type TerminalMethod = "gordon";

export interface DDMInputs {
  /** Explicit dividends for forecast years (t = 1..N). If absent, use projection inputs. */
  dividends?: number[];

  /** Projection inputs (used if `dividends` not provided) */
  d0?: number;                 // last dividend paid, optional when projecting
  eps0?: number;               // last EPS (for projection)
  growth?: number[];           // per-year growth rates for EPS/dividends (length == years)
  payout?: number[] | number;  // payout ratio per year or constant (0..1), optional

  /** Cost of equity (decimal), e.g., 0.10 for 10% */
  cost: number;

  /** Terminal growth (decimal), used in Gordon terminal */
  terminalGrowth: number;

  /** Forecast years (required only if projecting) */
  years?: number;

  /** Mid-year convention: discount by (t - 0.5) instead of t */
  midYear?: boolean;

  /** Shares outstanding (for per-share value) */
  sharesOut?: number;

  /** If true (default), clamp negative terminal value to zero */
  clampNegativeTV?: boolean;
}

export interface DDMResult {
  years: number;
  cost: number;
  midYear: boolean;
  dividends: number[];               // forecast dividends (t = 1..N)
  pvDividends: number;
  terminal: {
    method: TerminalMethod;
    nextDividend: number;            // D_{N+1}
    growth: number;
    value: number;                   // terminal at t=N (undiscounted)
    pv: number;                      // discounted terminal
  };
  equityValue: number;               // total equity value (PV of dividends + terminal)
  perShare?: number;
  assumptions: {
    fromProjection: boolean;
    clampNegativeTV: boolean;
  };
}

/* ============================== Helpers =============================== */

const EPS = 1e-9;
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const max0 = (x: number) => (x < 0 ? 0 : x);

function df(t: number, r: number, midYear = false): number {
  const shift = midYear ? t - 0.5 : t;
  return 1 / Math.pow(1 + r, shift);
}

function gordon(nextDividend: number, r: number, g: number): number {
  if (r - g <= EPS) return Number.POSITIVE_INFINITY;
  return nextDividend / (r - g);
}

/* =============== Projection (EPS × payout) and/or from d0 ============== */

export interface DdmProjectionInputs {
  years: number;
  d0?: number;                 // last dividend
  eps0?: number;               // last EPS (if payout given, we can seed with eps0×payout)
  growth: number[];            // per-year growth rates (length == years)
  payout?: number[] | number;  // payout ratio each year (0..1), or constant
}

/**
 * Project dividends for `years` using either:
 *  - last dividend `d0` grown by `growth[t]`, or
 *  - EPS path (eps0 grown by `growth`) × payout.
 * If both d0 and eps0&payout provided, EPS×payout takes precedence.
 */
export function projectDividends(p: DdmProjectionInputs): number[] {
  const { years, d0, eps0, growth, payout } = p;
  if (!Array.isArray(growth) || growth.length !== years) {
    throw new Error("projectDividends: `growth.length` must equal `years`.");
  }

  const toArray = (x: number[] | number | undefined, fallback: number) =>
    Array.isArray(x) ? x : Array.from({ length: years }, () => (isNum(x) ? x : fallback));

  const payoutArr = toArray(payout, 0); // if not provided, treat as 0 (dividends from d0 path)
  const divs: number[] = [];

  // EPS × payout path if eps0 and any payout provided
  if (isNum(eps0) && (Array.isArray(payout) || isNum(payout))) {
    let eps = eps0;
    for (let t = 0; t < years; t++) {
      eps = eps * (1 + growth[t]);
      const d = eps * payoutArr[t];
      divs.push(d);
    }
    return divs;
  }

  // Otherwise: grow last dividend d0 by growth
  if (!isNum(d0)) {
    throw new Error("projectDividends: either provide `dividends` or `d0` or `eps0&payout`.");
  }
  let d = d0;
  for (let t = 0; t < years; t++) {
    d = d * (1 + growth[t]);
    divs.push(d);
  }
  return divs;
}

/* ============================== Core DDM =============================== */

export function computeDDM(input: DDMInputs): DDMResult {
  const {
    dividends,
    d0,
    eps0,
    growth,
    payout,
    cost,
    terminalGrowth,
    years,
    midYear = true,
    sharesOut,
    clampNegativeTV = true,
  } = input;

  if (!isNum(cost) || cost <= 0) {
    throw new Error("DDM: `cost` (cost of equity) must be > 0.");
  }
  if (!isNum(terminalGrowth)) {
    throw new Error("DDM: `terminalGrowth` must be a number.");
  }

  let path: number[] | undefined = dividends;
  let fromProjection = false;

  if (!path) {
    if (!isNum(years) || !Array.isArray(growth)) {
      throw new Error("DDM: when `dividends` absent, provide `years` and `growth[]`.");
    }
    path = projectDividends({ years, d0, eps0, growth, payout });
    fromProjection = true;
  }

  const N = path.length;
  if (N === 0) throw new Error("DDM: empty dividend path.");

  // Present value of forecast dividends
  let pvDividends = 0;
  for (let t = 1; t <= N; t++) {
    pvDividends += path[t - 1] * df(t, cost, midYear);
  }

  // Gordon terminal at t=N using D_{N+1} = D_N * (1 + g)
  const last = path[N - 1];
  const next = last * (1 + terminalGrowth);
  let tv = gordon(next, cost, terminalGrowth);
  if (clampNegativeTV) tv = max0(tv);
  const pvTV = tv * df(N, cost, midYear);

  const equityValue = pvDividends + pvTV;
  const perShare = isNum(sharesOut) && sharesOut > 0 ? equityValue / sharesOut : undefined;

  return {
    years: N,
    cost,
    midYear,
    dividends: path,
    pvDividends,
    terminal: {
      method: "gordon",
      nextDividend: next,
      growth: terminalGrowth,
      value: tv,
      pv: pvTV,
    },
    equityValue,
    perShare,
    assumptions: {
      fromProjection,
      clampNegativeTV,
    },
  };
}

/* ===================== Sensitivity (cost × g) ========================= */

export interface DdmSensitivity {
  costs: number[];      // rows header dimension
  growths: number[];    // columns header dimension
  table: number[][];    // equity values [i=cost][j=growth]
}

/**
 * Equity value sensitivity matrix across cost-of-equity × terminal growth,
 * using the provided dividend path (or projection via inputs).
 */
export function ddmSensitivityGrid(
  base: Omit<DDMInputs, "cost" | "terminalGrowth"> & { dividends?: number[] },
  costs: number[],
  growths: number[]
): DdmSensitivity {
  // Ensure we have a path of dividends
  let path = base.dividends;
  if (!path) {
    const years = base.years ?? (base.growth?.length ?? 0);
    if (!years || !base.growth) throw new Error("ddmSensitivityGrid: need dividends or projection inputs.");
    path = projectDividends({
      years,
      d0: base.d0,
      eps0: base.eps0,
      growth: base.growth,
      payout: base.payout,
    });
  }

  const costsArr = costs.slice();
  const gArr = growths.slice();

  const table = costsArr.map((r) =>
    gArr.map((g) =>
      computeDDM({
        ...base,
        dividends: path,
        cost: r,
        terminalGrowth: g,
      }).equityValue
    )
  );

  return { costs: costsArr, growths: gArr, table };
}

/** Pretty print the sensitivity matrix for CLI */
export function formatSensitivity(s: DdmSensitivity, digits = 0): string {
  const { costs, growths, table } = s;
  const fmtP = (x: number) => (x * 100).toFixed(1) + "%";
  const fmtN = (x: number) => x.toFixed(digits);

  const header = ["r \\ g", ...growths.map(fmtP)].join("\t");
  const rows = costs.map((r, i) => [fmtP(r), ...table[i].map(fmtN)].join("\t"));
  return [header, ...rows].join("\n");
}

/* ============================== Example =============================== */
/*
Usage 1: Explicit dividends + DDM
const res = computeDDM({
  dividends: [1.10, 1.21, 1.33, 1.46, 1.60],
  cost: 0.10,
  terminalGrowth: 0.03,
  sharesOut: 1000,
});

Usage 2: Project from EPS×payout
const res2 = computeDDM({
  eps0: 5.00,
  payout: 0.35,
  years: 5,
  growth: [0.08, 0.07, 0.06, 0.05, 0.04],
  cost: 0.095,
  terminalGrowth: 0.025,
  sharesOut: 1000,
});

Sensitivity grid:
const base = { dividends: [1.1,1.2,1.3,1.4,1.5], midYear: true };
const grid = ddmSensitivityGrid(base, [0.09,0.10,0.11], [0.02,0.025,0.03]);
console.log(formatSensitivity(grid, 2));
*/