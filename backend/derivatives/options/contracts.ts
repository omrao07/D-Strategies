// options/contracts.ts
// Pure TS (no imports). Option contract symbology + expiries + strike ladders.
// - OCC-style symbol builders/parsers (SHORT: AAPL  250117C00100000)
// - Compact broker-style symbols (e.g., AAPL-2025-01-17-C-100)
// - Expiry calendars (third Friday monthlies, weekly Fridays, custom holidays)
// - Strike grid helpers, ITM/OTM tags, moneyness utilities.

export type ISODate = string; // "YYYY-MM-DD"
export type Right = "C" | "P";

export type OccSymbol = string;     // OCC 21-char series key
export type CompactSymbol = string; // UNDERLYING-YYYY-MM-DD-RIGHT-STRIKE (e.g., AAPL-2025-01-17-C-100)

export type OptionContract = {
  underlying: string;
  expiry: ISODate;
  right: Right;
  strike: number;
  symOCC: OccSymbol;
  symCompact: CompactSymbol;
};

export type Calendar = {
  name?: string;
  holidays?: Record<ISODate, true>; // non-trading holidays
};

export type CycleRule = "MONTHLY_THIRD_FRIDAY" | "WEEKLY_FRIDAY" | "CUSTOM";

/** ===== Date utils (UTC only) ===== */
function fromYMD(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}
function toISO(d: Date): ISODate {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function weekday(d: Date): number { return d.getUTCDay(); } // 0=Sun..6=Sat
function isWeekend(d: Date): boolean { const w = weekday(d); return w === 0 || w === 6; }
function isBiz(d: Date, cal?: Calendar): boolean {
  if (isWeekend(d)) return false;
  if (cal?.holidays && cal.holidays[toISO(d)]) return false;
  return true;
}
function thirdFriday(y: number, m: number): Date {
  const first = fromYMD(y, m, 1);
  const w = weekday(first); // 0..6
  const firstFri = 1 + ((5 - w + 7) % 7); // Friday=5
  const day = firstFri + 14; // third Friday
  return fromYMD(y, m, day);
}
function lastBizBeforeOrOn(d: Date, cal?: Calendar): Date {
  let x = d;
  while (!isBiz(x, cal)) x = new Date(x.getTime() - 86400000);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

/** ===== OCC symbology =====
 * OCC 21-char: [ROOT(1-6)][YYMMDD(6)][C/P(1)][Strike*1000 padded 8]
 * ROOT padded with spaces to 6.
 */
function padRight(s: string, n: number, ch = " "): string {
  if (s.length >= n) return s.slice(0, n);
  return s + ch.repeat(n - s.length);
}
function padLeftNum(n: number | string, len: number): string {
  const s = String(n);
  return s.length >= len ? s.slice(-len) : "0".repeat(len - s.length) + s;
}
function yymmdd(iso: ISODate): string {
  const y = iso.slice(2, 4);
  const m = iso.slice(5, 7);
  const d = iso.slice(8, 10);
  return y + m + d;
}
function occStrikeInt(strike: number): number {
  // OCC uses strike * 1000 as integer
  return Math.round(strike * 1000);
}
export function buildOcc(underlying: string, expiry: ISODate, right: Right, strike: number): OccSymbol {
  const root = padRight(underlying.toUpperCase(), 6, " ");
  const date = yymmdd(expiry);
  const cp = right;
  const k = padLeftNum(occStrikeInt(strike), 8);
  return root + date + cp + k;
}
export function parseOcc(sym: OccSymbol): { underlying: string; expiry: ISODate; right: Right; strike: number } | null {
  if (!sym || sym.length !== 21) return null;
  const root = sym.slice(0, 6).trim();
  const yy = sym.slice(6, 8), mm = sym.slice(8, 10), dd = sym.slice(10, 12);
  const cp = sym.slice(12, 13) as Right;
  const kInt = parseInt(sym.slice(13), 10);
  if (!root || isNaN(kInt) || (cp !== "C" && cp !== "P")) return null;
  const year = 2000 + parseInt(yy, 10);
  const iso = `${year}-${mm}-${dd}`;
  return { underlying: root, expiry: iso as ISODate, right: cp, strike: kInt / 1000 };
}

/** ===== Compact symbology ===== */
export function buildCompact(underlying: string, expiry: ISODate, right: Right, strike: number): CompactSymbol {
  const k = String(+strike === strike ? strike : Number(strike.toFixed(6)));
  return `${underlying.toUpperCase()}-${expiry}-${right}-${k}`;
}
export function parseCompact(sym: CompactSymbol): { underlying: string; expiry: ISODate; right: Right; strike: number } | null {
  const parts = sym.split("-");
  if (parts.length < 5) return null;
  const [u, y, m, d, cp, ...krest] = [
    parts[0],
    parts[1],
    parts[2],
    parts[3],
    parts[4],
    ...parts.slice(5),
  ];
  const right = cp as Right;
  const strikeStr = krest.length ? krest.join("-") : parts[5] || "";
  const iso = `${y}-${m}-${d}` as ISODate;
  const K = parseFloat(strikeStr);
  if (!u || !(right === "C" || right === "P") || !isFinite(K)) return null;
  return { underlying: u, expiry: iso, right, strike: K };
}

/** ===== Contract builder ===== */
export function makeContract(underlying: string, expiry: ISODate, right: Right, strike: number): OptionContract {
  return {
    underlying,
    expiry,
    right,
    strike,
    symOCC: buildOcc(underlying, expiry, right, strike),
    symCompact: buildCompact(underlying, expiry, right, strike),
  };
}

/** ===== Expiry calendars =====
 * For equity-style options:
 * - MONTHLY_THIRD_FRIDAY: official monthly expiry (trading typically stops prior biz day; we return ISO of expiry Friday)
 * - WEEKLY_FRIDAY: every Friday (adjust to last business day if holiday)
 * For custom, pass explicit ISO dates.
 */

export function monthliesBetween(
  startISO: ISODate,
  endISO: ISODate,
  cal?: Calendar
): ISODate[] {
  const a = fromYMD(+startISO.slice(0, 4), +startISO.slice(5, 7), +startISO.slice(8, 10));
  const b = fromYMD(+endISO.slice(0, 4), +endISO.slice(5, 7), +endISO.slice(8, 10));
  const out: ISODate[] = [];
  let y = a.getUTCFullYear();
  let m = a.getUTCMonth() + 1;

  while (true) {
    const tf = thirdFriday(y, m);
    const exp = lastBizBeforeOrOn(tf, cal); // if TF is holiday, roll back
    const iso = toISO(exp);
    if (exp >= a && exp <= b) out.push(iso);
    // advance
    m++;
    if (m > 12) { m = 1; y++; }
    const chk = fromYMD(y, m, 1);
    if (chk > b && thirdFriday(y, m) > b) break;
  }
  return out;
}

export function weeklyFridaysBetween(
  startISO: ISODate,
  endISO: ISODate,
  cal?: Calendar
): ISODate[] {
  const a = fromYMD(+startISO.slice(0, 4), +startISO.slice(5, 7), +startISO.slice(8, 10));
  const b = fromYMD(+endISO.slice(0, 4), +endISO.slice(5, 7), +endISO.slice(8, 10));
  // move to first Friday >= a
  let d = a;
  const deltaToFri = (5 - weekday(d) + 7) % 7;
  d = addDays(d, deltaToFri);
  const out: ISODate[] = [];
  while (d <= b) {
    const exp = lastBizBeforeOrOn(d, cal);
    out.push(toISO(exp));
    d = addDays(d, 7);
  }
  return out;
}

/** Generate expiries per rule. If rule=CUSTOM, provide custom list in opts.customExpiries. */
export function expiriesBetween(
  startISO: ISODate,
  endISO: ISODate,
  rule: CycleRule,
  opts?: { cal?: Calendar; customExpiries?: ISODate[] }
): ISODate[] {
  if (rule === "MONTHLY_THIRD_FRIDAY") return monthliesBetween(startISO, endISO, opts?.cal);
  if (rule === "WEEKLY_FRIDAY") return weeklyFridaysBetween(startISO, endISO, opts?.cal);
  const xs = (opts?.customExpiries || []).filter(Boolean).sort();
  return xs.filter(x => x >= startISO && x <= endISO);
}

/** ===== Strike ladders & moneyness ===== */

export type StrikeGridSpec =
  | { mode: "step"; start: number; step: number; count: number }                // arithmetic ladder
  | { mode: "pct"; spot: number; pctSteps: number[] }                           // spot * (1 + p)
  | { mode: "aroundATM"; spot: number; step: number; nEachSide: number };       // symmetric around spot

export function strikeGrid(spec: StrikeGridSpec): number[] {
  const out: number[] = [];
  if (spec.mode === "step") {
    for (let i = 0; i < spec.count; i++) out.push(spec.start + i * spec.step);
  } else if (spec.mode === "pct") {
    for (const p of spec.pctSteps) out.push(spec.spot * (1 + p));
  } else {
    const { spot, step, nEachSide } = spec;
    out.push(spot);
    for (let i = 1; i <= nEachSide; i++) {
      out.push(spot + i * step);
      out.push(spot - i * step);
    }
  }
  // normalize: round to cents, sort, uniq
  const norm = Array.from(new Set(out.map(x => +(+x).toFixed(6)))).sort((a, b) => a - b);
  return norm;
}

/** Tag ITM/OTM given spot. */
export function moneynessTag(spot: number, right: Right, strike: number): "ITM" | "OTM" | "ATM" {
  const eps = Math.max(1e-8, spot * 1e-6);
  if (Math.abs(strike - spot) <= eps) return "ATM";
  if (right === "C") return strike < spot ? "ITM" : "OTM";
  return strike > spot ? "ITM" : "OTM";
}

/** S/K (calls) standard moneyness; for puts we also return S/K (kept consistent). */
export function sOverK(spot: number, strike: number): number {
  if (!(strike > 0)) return NaN;
  return spot / strike;
}

/** Build a contract grid: all (right, strike) for each expiry. */
export function buildContractsGrid(
  underlying: string,
  expiries: ISODate[],
  strikes: number[],
  rights: Right[] = ["C", "P"]
): OptionContract[] {
  const out: OptionContract[] = [];
  for (const exp of expiries) {
    for (const K of strikes) {
      for (const r of rights) out.push(makeContract(underlying, exp, r, K));
    }
  }
  return out;
}

/** Generate monthly chain for N months ahead from anchor date. */
export function monthlyChain(
  underlying: string,
  anchorISO: ISODate,
  months: number,
  strikes: number[],
  cal?: Calendar
): OptionContract[] {
  const a = fromYMD(+anchorISO.slice(0,4), +anchorISO.slice(5,7), +anchorISO.slice(8,10));
  const end = addDays(fromYMD(a.getUTCFullYear(), a.getUTCMonth() + 1 + months, 1), 31); // generous window
  const exps = monthliesBetween(anchorISO, toISO(end), cal).slice(0, months);
  return buildContractsGrid(underlying, exps, strikes, ["C", "P"]);
}

/** ===== Round-trip parse/format helpers ===== */

export function toCompact(c: OptionContract): CompactSymbol { return c.symCompact; }
export function toOcc(c: OptionContract): OccSymbol { return c.symOCC; }

export function fromAnySymbol(sym: string): OptionContract | null {
  const occ = parseOcc(sym);
  if (occ) return makeContract(occ.underlying, occ.expiry, occ.right, occ.strike);
  const cmp = parseCompact(sym);
  if (cmp) return makeContract(cmp.underlying, cmp.expiry, cmp.right, cmp.strike);
  // try tolerant broker variants: UNDERLYING_YYYYMMDDC123.45
  const m = /^([A-Za-z]+)[-_]?(\d{4})[-_]?(\d{2})[-_]?(\d{2})[-_]?([CP])[-_]?(\d+(\.\d+)?)$/.exec(sym);
  if (m) {
    const u = m[1], iso = `${m[2]}-${m[3]}-${m[4]}`, r = m[5] as Right, k = parseFloat(m[6]);
    return makeContract(u, iso as ISODate, r, k);
  }
  return null;
}

/** ===== Quick tests (can be removed) =====
const c = makeContract("AAPL", "2025-01-17", "C", 100);
console.log(c.symOCC);     // "AAPL  250117C00100000"
console.log(c.symCompact); // "AAPL-2025-01-17-C-100"
console.log(parseOcc(c.symOCC));
console.log(parseCompact(c.symCompact));
*/