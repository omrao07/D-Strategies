// damodaran/models.ts
// Typed models + tiny validators + mappers for Damodaran-style datasets.
// Zero deps. ESM/NodeNext.

// ---------- Shared ----------
export type Num = number;
export type IsoDate = string; // YYYY-MM-DD (or generic ISO)

export type SeriesPoint = { ts: number; value: number };
export type Series = SeriesPoint[];

export type TableLike = {
  name?: string;
  headers: string[];
  rows: Record<string, any>[];
  source: string;
};

const isNum = (x: any): x is number => typeof x === "number" && Number.isFinite(x);
const isStr = (x: any): x is string => typeof x === "string" && x.length > 0;
const toISO = (d: Date | string | number): IsoDate => {
  const ts = d instanceof Date ? d.getTime() : (typeof d === "string" ? new Date(d).getTime() : d);
  return new Date(ts).toISOString().slice(0, 10);
};
const asTs = (x: any): number | null => {
  if (x instanceof Date) return x.getTime();
  const s = String(x ?? "").trim();
  if (!s) return null;
  if (/^\d{4}$/.test(s)) return Date.UTC(+s, 0, 1);
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
};
const cleanPct = (x: any): number | null => {
  if (isNum(x)) return x;
  const s = String(x ?? "").trim().replace(/%$/, "");
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? (/%$/.test(String(x)) ? n / 100 : n) : null;
};
const cleanNum = (x: any): number | null => {
  if (isNum(x)) return x;
  const s = String(x ?? "").trim();
  if (!s) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

// ---------- 1) Country Risk Premiums ----------
export type CountryRiskPremium = {
  country: string;
  rating?: string | null;
  defaultSpread?: Num | null;     // as fraction (e.g., 0.03)
  erp?: Num | null;               // equity risk premium (fraction)
  cdsSpread?: Num | null;         // optional if present
  updated?: IsoDate | null;
};

export function mapCountryRiskPremiums(table: TableLike): CountryRiskPremium[] {
  // header names are assumed normalized by loader (lower_snake)
  const H = new Set(table.headers);
  const col = (cands: string[], fallback?: string) =>
    cands.find(c => H.has(c)) ?? fallback ?? cands[0];

  const C_COUNTRY = col(["country", "country_name"]);
  const C_RATING  = col(["rating", "sovereign_rating", "moodys_rating"]);
  const C_DEFSPR  = col(["default_spread", "spread", "bond_spread", "default_spread_pct"]);
  const C_ERP     = col(["equity_risk_premium", "erp", "total_equity_risk_premium"]);
  const C_CDS     = col(["cds_spread", "cds"]);
  const C_DATE    = col(["date", "updated", "as_of"]);

  const out: CountryRiskPremium[] = [];
  for (const r of table.rows) {
    const country = String(r[C_COUNTRY] ?? "").trim();
    if (!country) continue;
    const rating = r[C_RATING] ? String(r[C_RATING]).trim() : null;

    const defPct = cleanPct(r[C_DEFSPR]);
    const erpPct = cleanPct(r[C_ERP]);
    const cdsPct = cleanPct(r[C_CDS]);
    const ts = r[C_DATE] != null ? asTs(r[C_DATE]) : null;

    out.push({
      country,
      rating,
      defaultSpread: defPct,
      erp: erpPct,
      cdsSpread: cdsPct,
      updated: ts != null ? toISO(ts) : null,
    });
  }
  return out;
}

// ---------- 2) Implied ERP time-series ----------
export type ImpliedERP = { date: IsoDate; erp: Num };

export function mapImpliedERPSeries(table: TableLike): ImpliedERP[] {
  // Try common column pairs: (date, erp) or (month, implied_equity_risk_premium)
  const H = new Set(table.headers);
  const dateCol = ["date", "month", "period"].find(h => H.has(h)) ?? "date";
  const erpCol  = ["erp", "implied_equity_risk_premium", "implied_risk_premium"].find(h => H.has(h)) ?? "erp";

  const out: ImpliedERP[] = [];
  for (const r of table.rows) {
    const ts = asTs(r[dateCol]);
    const erp = cleanPct(r[erpCol]);
    if (ts != null && erp != null) out.push({ date: toISO(ts), erp });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---------- 3) Cost of Capital by sector ----------
export type SectorCostOfCapital = {
  sector: string;
  count?: number | null;
  unleveredBeta?: number | null;
  leveredBeta?: number | null;
  equityCost?: number | null;  // fraction
  debtCost?: number | null;    // fraction
  taxRate?: number | null;     // fraction
  wacc?: number | null;        // fraction
};

export function mapSectorWACC(table: TableLike): SectorCostOfCapital[] {
  const H = new Set(table.headers);
  const col = (c: string[]) => c.find(h => H.has(h)) ?? c[0];

  const C_SECTOR = col(["sector", "industry", "sector_name"]);
  const C_COUNT  = col(["count", "firms"]);
  const C_UBETA  = col(["unlevered_beta", "unleveredbeta"]);
  const C_LBETA  = col(["levered_beta", "leveredbeta"]);
  const C_COE    = col(["cost_of_equity", "equity_cost", "coe"]);
  const C_COD    = col(["cost_of_debt", "debt_cost", "cod"]);
  const C_TAX    = col(["tax_rate", "marginal_tax_rate"]);
  const C_WACC   = col(["wacc", "weighted_average_cost_of_capital"]);

  const out: SectorCostOfCapital[] = [];
  for (const r of table.rows) {
    const sector = String(r[C_SECTOR] ?? "").trim();
    if (!sector) continue;
    out.push({
      sector,
      count: cleanNum(r[C_COUNT]),
      unleveredBeta: cleanNum(r[C_UBETA]),
      leveredBeta: cleanNum(r[C_LBETA]),
      equityCost: cleanPct(r[C_COE]),
      debtCost: cleanPct(r[C_COD]),
      taxRate: cleanPct(r[C_TAX]),
      wacc: cleanPct(r[C_WACC]),
    });
  }
  return out;
}

// ---------- 4) Industry Margins & Multiples (wide → tidy) ----------
export type IndustryMetricRow = {
  industry: string;
  metric: string;        // e.g., "oper_margin", "net_margin", "ev_ebitda"
  date?: IsoDate | null; // if header carries a date (wide time dimension)
  value: number | null;
};

export function mapIndustryMetricsWide(table: TableLike, opts?: {
  keyCol?: string;            // default "industry" | "sector"
  metricCols?: string[];      // if provided, only extract these headers
  treatHeadersAsDates?: boolean; // if true, every non-key header parsed as date; metric name from table.name
}): IndustryMetricRow[] {
  const keyCol = opts?.keyCol ?? (table.headers.includes("industry") ? "industry" : "sector");
  if (!table.headers.includes(keyCol)) throw new Error(`Key column "${keyCol}" not found`);
  const out: IndustryMetricRow[] = [];

  const nonKey = table.headers.filter(h => h !== keyCol);
  const metrics = (opts?.metricCols && opts.metricCols.length) ? opts.metricCols : nonKey;

  for (const r of table.rows) {
    const key = String(r[keyCol] ?? "").trim();
    if (!key) continue;

    for (const h of metrics) {
      const raw = r[h];
      // Detect if header is a date (e.g., “2023”, “2023-06”); else treat as metric label.
      const maybeTs = opts?.treatHeadersAsDates ? asTs(h) : null;
      const val = cleanNum(raw) ?? cleanPct(raw);
      out.push({
        industry: key,
        metric: maybeTs != null ? (table.name ?? "metric") : h,
        date: maybeTs != null ? toISO(maybeTs) : null,
        value: val,
      });
    }
  }
  return out;
}

// ---------- 5) Mini “schema” helpers (no deps) ----------
export type Validator<T> = (x: any) => x is T;

export function arrayOf<T>(guard: Validator<T>) {
  return (arr: any): arr is T[] => Array.isArray(arr) && arr.every(guard);
}

export const isCountryRiskPremium: Validator<CountryRiskPremium> = (x: any): x is CountryRiskPremium =>
  x && isStr(x.country);

export const isImpliedERP: Validator<ImpliedERP> = (x: any): x is ImpliedERP =>
  x && isStr(x.date) && isNum(x.erp);

export const isSectorWACC: Validator<SectorCostOfCapital> = (x: any): x is SectorCostOfCapital =>
  x && isStr(x.sector);

// ---------- 6) Convenience bundle ----------
export const DamodaranModels = {
  mapCountryRiskPremiums,
  mapImpliedERPSeries,
  mapSectorWACC,
  mapIndustryMetricsWide,
  guards: {
    isCountryRiskPremium,
    isImpliedERP,
    isSectorWACC,
  }
};

// ---------- Optional demo when run directly ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    // This block is just illustrative if you import loader at runtime.
    try {
      const { DamodaranLoader }: any = await import("./loader.js").catch(() => ({}));
      if (DamodaranLoader) {
        const loader = new DamodaranLoader({ cache: true });
        const crp = await loader.loadCSV("http://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/ctryprem.csv", "crp");
        const rows = mapCountryRiskPremiums(crp);
        console.log("CRP sample:", rows.slice(0, 3));
      }
    } catch {}
  })();
}