// fixed income / creditspreadcarry.ts
// Pure TypeScript, no imports. Computes expected credit spread carry (bps)
// given bond-level rows and a PD table by rating.
//
// Formula:
// expectedCarryBps = spreadBps - (PD[rating] * LGD * 10_000)
//
// Notes:
// - spreadBps is expected as number of basis points (e.g., 150 = 1.50%).
// - PD values are annual default probabilities in decimal (e.g., 0.005 = 0.5%).
// - LGD is in decimal (e.g., 0.60 = 60%).
// - If rating not found, falls back to PD["UNK"].

export type CreditRowIn = {
  ts: number | string;        // timestamp (ms or ISO)
  id: string | number;        // instrument id
  issuer?: string | null;     // issuer name
  rating?: string | null;     // e.g., "AAA","AA","A","BBB","BB","B","CCC","CC","C","D"
  tenor?: string | number | null; // tenor label or years
  maturityY?: number | null;  // years to maturity
  spreadBps: number | string; // quoted spread in basis points
};

export type CreditRowOut = {
  ts: number | string;
  id: string;
  issuer: string;
  rating: string;
  tenor: string;
  maturityY: number | null;
  spreadBps: number;
  expectedCarryBps: number;
  bucketKey: string;
};

export type PDTable = { [rating: string]: number };

export type CarryConfig = {
  lgd: number;          // loss given default in decimal
  pd?: PDTable;         // override PD table
  tenorBuckets?: number[]; // year cutoffs for buckets, ascending. Example: [1,3,5,7,10]
};

const DEFAULT_PD: PDTable = {
  AAA: 0.0003,
  AA:  0.0005,
  A:   0.0008,
  BBB: 0.0150,
  BB:  0.0250,
  B:   0.0500,
  CCC: 0.1200,
  CC:  0.2000,
  C:   0.3000,
  D:   1.0000,
  UNK: 0.0200, // fallback for unknown ratings
};

const DEFAULT_CFG: CarryConfig = {
  lgd: 0.60,
  pd: DEFAULT_PD,
  tenorBuckets: [1, 3, 5, 7, 10],
};

function toNumber(v: unknown, fallback: number): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function cleanRating(r?: string | null): string {
  if (!r) return "UNK";
  const x = String(r).trim().toUpperCase();
  // Normalize common notations like "AA-" -> "AA", "BBB+" -> "BBB"
  const core = x.replace(/[+\-]/g, "");
  return core || "UNK";
}

function bucketFromMaturityY(years: number | null, cuts: number[]): string {
  if (years === null || !Number.isFinite(years)) return "UNK";
  for (let i = 0; i < cuts.length; i++) {
    if (years <= cuts[i]) {
      return i === 0 ? `0-${cuts[i]}Y` : `${cuts[i - 1]}-${cuts[i]}Y`;
    }
  }
  return `${cuts[cuts.length - 1]}Y+`;
}

export function computeExpectedCarryBps(
  spreadBps: number,
  rating: string,
  cfg?: CarryConfig
): number {
  const useCfg = cfg ? { ...DEFAULT_CFG, ...cfg, pd: { ...DEFAULT_PD, ...(cfg.pd || {}) } } : DEFAULT_CFG;
  const pd = useCfg.pd || DEFAULT_PD;
  const pdForRating = pd[rating] !== undefined ? pd[rating] : (pd["UNK"] || DEFAULT_PD["UNK"]);
  // expected carry in bps = market spread (bps) minus expected loss (annualized, bps)
  // expected loss (bps) = PD * LGD * 10,000
  const expectedLossBps = pdForRating * useCfg.lgd * 10_000;
  return spreadBps - expectedLossBps;
}

/**
 * Main transformer
 */
export function creditSpreadCarry(
  rows: CreditRowIn[],
  cfg?: CarryConfig
): CreditRowOut[] {
  const useCfg = cfg ? { ...DEFAULT_CFG, ...cfg, pd: { ...DEFAULT_PD, ...(cfg.pd || {}) } } : DEFAULT_CFG;

  const out: CreditRowOut[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];

    const rating = cleanRating(r.rating || undefined);
    const maturityY = r.maturityY === null || r.maturityY === undefined
      ? null
      : toNumber(r.maturityY, NaN);

    const spreadBps = toNumber(r.spreadBps, NaN);
    const expectedCarryBps = Number.isFinite(spreadBps)
      ? computeExpectedCarryBps(spreadBps, rating, useCfg)
      : NaN;

    const tenorLabel =
      r.tenor !== null && r.tenor !== undefined && String(r.tenor).trim() !== ""
        ? String(r.tenor)
        : (maturityY === null ? "UNK" : `${maturityY.toFixed(2)}Y`);

    const bucket = bucketFromMaturityY(maturityY, useCfg.tenorBuckets || DEFAULT_CFG.tenorBuckets!);

    out.push({
      ts: r.ts,
      id: String(r.id),
      issuer: String((r.issuer ?? "") || ""),
      rating,
      tenor: tenorLabel,
      maturityY,
      spreadBps,
      expectedCarryBps,
      bucketKey: `${rating}|${bucket}`,
    });
  }
  return out;
}

// Example helper to compute simple bucket stats (optional).
export type BucketStat = {
  bucketKey: string;
  count: number;
  avgSpreadBps: number;
  avgExpectedCarryBps: number;
};

export function summarizeByBucket(rows: CreditRowOut[]): BucketStat[] {
  const acc: { [k: string]: { c: number; s: number; e: number } } = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const k = r.bucketKey;
    if (!acc[k]) acc[k] = { c: 0, s: 0, e: 0 };
    acc[k].c += 1;
    acc[k].s += Number.isFinite(r.spreadBps) ? r.spreadBps : 0;
    acc[k].e += Number.isFinite(r.expectedCarryBps) ? r.expectedCarryBps : 0;
  }
  const out: BucketStat[] = [];
  const keys = Object.keys(acc);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = acc[k];
    const c = v.c || 1;
    out.push({
      bucketKey: k,
      count: v.c,
      avgSpreadBps: v.s / c,
      avgExpectedCarryBps: v.e / c,
    });
  }
  return out;
}
