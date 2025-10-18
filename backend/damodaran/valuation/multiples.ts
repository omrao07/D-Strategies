// valuation/multiples.ts
// Peer-based valuation (EV/EBITDA, P/E, EV/Sales, EV/EBIT) with robust stats,
// winsorization, IQR filter, percentile/median/mean centers, and implied price.
// No external deps.

export type MultipleKind = "EV/EBITDA" | "P/E" | "EV/Sales" | "EV/EBIT";
export type Center = "median" | "mean" | "percentile";

export interface PeerRow {
  ticker: string;
  multiple: number;           // the comparable multiple (e.g., EV/EBITDA)
  weight?: number;            // optional weight (defaults 1)
}

export interface SubjectInputs {
  kind: MultipleKind;

  // Subject operating metrics:
  ebitda?: number;
  ebit?: number;
  sales?: number;
  netIncome?: number;

  // Balance sheet for bridge to equity:
  cash?: number;
  debt?: number;
  netDebt?: number;           // overrides cash/debt if present
  minorities?: number;        // subtract
  investments?: number;       // add

  // Shares for per-share output:
  sharesOut?: number;
}

export interface PeerOptions {
  winsorPct?: number;         // e.g., 0.02 trims 2% tails (two-sided)
  iqrFilter?: boolean;        // remove points outside [Q1-1.5IQR, Q3+1.5IQR]
  minN?: number;              // minimum peers to keep after filtering
  center?: Center;            // "median" (default), "mean", "percentile"
  percentile?: number;        // when center="percentile", e.g., 0.75 for 75th
  minMultiple?: number;       // guard rails; ignore nonsensical values
  maxMultiple?: number;
}

export interface PeerStats {
  nRaw: number;
  nUsed: number;
  mean: number;
  median: number;
  p25: number;
  p50: number;
  p75: number;
  sd: number;
  iqr: number;
  zScores: Array<{ ticker: string; z: number }>;
  used: PeerRow[];
}

export interface MultiplesResult {
  kind: MultipleKind;
  stats: PeerStats;
  chosenMultiple: number;     // the center used for valuation
  implied: {
    enterpriseValue?: number; // for EV-based kinds
    equityValue: number;
    perShare?: number;
  };
  bridge: {
    cash: number;
    debt: number;
    netDebt: number;
    minorities: number;
    investments: number;
  };
  subjectBasis: {
    ebitda?: number;
    ebit?: number;
    sales?: number;
    netIncome?: number;
  };
}

/* =============================== Utils =============================== */

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function sorted(xs: number[]): number[] {
  return xs.slice().sort((a, b) => a - b);
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = sorted(xs);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (s[base + 1] !== undefined) return s[base] + rest * (s[base + 1] - s[base]);
  return s[base];
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function winsorize(xs: number[], p = 0.02): number[] {
  if (!p || p <= 0) return xs.slice();
  const s = sorted(xs);
  const lo = quantile(s, p);
  const hi = quantile(s, 1 - p);
  return xs.map((x) => Math.min(Math.max(x, lo), hi));
}

function iqrFilter(xs: number[]): { kept: boolean[]; q1: number; q3: number; iqr: number } {
  const q1 = quantile(xs, 0.25);
  const q3 = quantile(xs, 0.75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const kept = xs.map((x) => x >= lo && x <= hi);
  return { kept, q1, q3, iqr };
}

/* ========================== Peer Statistics ========================== */

export function computePeerStats(rows: PeerRow[], opts: PeerOptions = {}): PeerStats {
  const {
    winsorPct = 0.02,
    iqrFilter: doIqr = true,
    minN = 6,
    minMultiple = 0,
    maxMultiple = Infinity,
  } = opts;

  const raw = rows.filter((r) => isNum(r.multiple) && r.multiple >= minMultiple && r.multiple <= maxMultiple);
  const nRaw = raw.length;

  const vals0 = raw.map((r) => r.multiple);
  const valsW = winsorize(vals0, winsorPct);

  let mask = valsW.map(() => true);
  let q1 = NaN, q3 = NaN, IQR = NaN;

  if (doIqr) {
    const f = iqrFilter(valsW);
    mask = f.kept;
    q1 = f.q1;
    q3 = f.q3;
    IQR = f.iqr;
  }

  const used: PeerRow[] = [];
  const vals: number[] = [];
  raw.forEach((r, i) => {
    if (mask[i]) {
      used.push(r);
      vals.push(valsW[i]);
    }
  });

  const nUsed = vals.length;
  if (nUsed < Math.min(minN, nRaw)) {
    // if filter is too strict, fall back to winsorized values
    used.length = 0; vals.length = 0;
    raw.forEach((r, i) => { used.push(r); vals.push(valsW[i]); });
  }

  const mu = mean(vals);
  const med = quantile(vals, 0.5);
  const p25 = quantile(vals, 0.25);
  const p50 = med;
  const p75 = quantile(vals, 0.75);
  const sdev = sd(vals);
  const zs = used.map((r, i) => ({ ticker: r.ticker, z: sdev > 0 ? (vals[i] - mu) / sdev : 0 }));

  return {
    nRaw,
    nUsed: used.length,
    mean: mu,
    median: med,
    p25,
    p50,
    p75,
    sd: sdev,
    iqr: IQR,
    zScores: zs,
    used,
  };
}

/* ======================= Valuation Calculation ======================= */

export interface MultiplesOptions extends PeerOptions {
  center?: Center;           // which statistic to use as the multiple (default median)
  percentile?: number;       // used when center="percentile" (0..1)
}

export function chooseCenter(stats: PeerStats, center: Center = "median", percentile = 0.5): number {
  const xs = stats.used.map((r) => r.multiple);
  if (xs.length === 0) return NaN;
  if (center === "mean") return mean(xs);
  if (center === "percentile") return quantile(xs, Math.min(Math.max(percentile, 0), 1));
  return stats.median; // default
}

export function computeMultiplesValuation(
  peers: PeerRow[],
  subj: SubjectInputs,
  opts: MultiplesOptions = {}
): MultiplesResult {
  const stats = computePeerStats(peers, opts);
  const chosen = chooseCenter(stats, opts.center ?? "median", opts.percentile ?? 0.5);

  if (!isNum(chosen) || !Number.isFinite(chosen)) {
    throw new Error("multiples: could not determine a valid center multiple.");
  }

  const {
    kind,
    ebitda,
    ebit,
    sales,
    netIncome,
    cash = 0,
    debt = 0,
    netDebt,
    minorities = 0,
    investments = 0,
    sharesOut,
  } = subj;

  let enterpriseValue: number | undefined;
  let equityValue = 0;

  const basis: Record<string, number | undefined> = {
    ebitda, ebit, sales, netIncome,
  };

  switch (kind) {
    case "EV/EBITDA": {
      if (!isNum(ebitda)) throw new Error("multiples: need 'ebitda' for EV/EBITDA.");
      enterpriseValue = chosen * ebitda;
      break;
    }
    case "EV/EBIT": {
      if (!isNum(ebit)) throw new Error("multiples: need 'ebit' for EV/EBIT.");
      enterpriseValue = chosen * ebit;
      break;
    }
    case "EV/Sales": {
      if (!isNum(sales)) throw new Error("multiples: need 'sales' for EV/Sales.");
      enterpriseValue = chosen * sales;
      break;
    }
    case "P/E": {
      if (!isNum(netIncome)) throw new Error("multiples: need 'netIncome' for P/E.");
      equityValue = chosen * netIncome;
      break;
    }
    default:
      throw new Error(`multiples: unsupported kind ${kind as string}`);
  }

  let perShare: number | undefined;

  if (kind === "P/E") {
    // equity value already computed
    perShare = isNum(sharesOut) && sharesOut > 0 ? equityValue / sharesOut : undefined;
  } else {
    // bridge EV → equity
    const nd = isNum(netDebt) ? netDebt : (debt - cash);
    const eq = (enterpriseValue ?? 0) - nd - (minorities || 0) + (investments || 0);
    equityValue = eq;
    perShare = isNum(sharesOut) && sharesOut > 0 ? eq / sharesOut : undefined;
  }

  return {
    kind,
    stats,
    chosenMultiple: chosen,
    implied: {
      enterpriseValue,
      equityValue,
      perShare,
    },
    bridge: {
      cash,
      debt,
      netDebt: isNum(netDebt) ? netDebt : (debt - cash),
      minorities: minorities || 0,
      investments: investments || 0,
    },
    subjectBasis: {
      ebitda, ebit, sales, netIncome,
    },
  };
}

/* =========================== Sensitivity ============================= */

export interface MultipleSensitivity {
  multiples: number[];        // candidate multiples to test
  values: number[];           // implied equity value (or per share if sharesOut provided)
  perShare?: number[];        // if sharesOut present
}

/**
 * Simple sensitivity over an array of candidate multiples.
 * For EV-based kinds, varies EV → equity bridge. For P/E, varies equity direct.
 */
export function multiplesSensitivity(
  subj: SubjectInputs,
  kind: MultipleKind,
  candidates: number[]
): MultipleSensitivity {
  const outValues: number[] = [];
  const outPerShare: number[] = [];

  candidates.forEach((m) => {
    const peers: PeerRow[] = [{ ticker: "center", multiple: m }];
    const res = computeMultiplesValuation(peers, { ...subj, kind }, { center: "median" });
    outValues.push(res.implied.equityValue);
    if (isNum(subj.sharesOut) && subj.sharesOut > 0) {
      outPerShare.push((res.implied.perShare ?? NaN));
    }
  });

  return {
    multiples: candidates.slice(),
    values: outValues,
    perShare: outPerShare.length ? outPerShare : undefined,
  };
}

/* =============================== Examples ============================ */
/*
const peers: PeerRow[] = [
  { ticker: "AAA", multiple: 9.8 },
  { ticker: "BBB", multiple: 11.2 },
  { ticker: "CCC", multiple: 13.1 },
  { ticker: "DDD", multiple: 10.4 },
  { ticker: "EEE", multiple: 25.0 },  // outlier; filtered by IQR+winsor
];

const subj: SubjectInputs = {
  kind: "EV/EBITDA",
  ebitda: 1200,
  cash: 300,
  debt: 1800,
  sharesOut: 500,
};

const res = computeMultiplesValuation(peers, subj, { winsorPct: 0.02, iqrFilter: true, center: "median" });
console.log("Chosen multiple:", res.chosenMultiple);
console.log("Implied equity value:", res.implied.equityValue);
console.log("Per share:", res.implied.perShare);

const sens = multiplesSensitivity(subj, "EV/EBITDA", [8, 9, 10, 11, 12]);
console.log(sens);
*/