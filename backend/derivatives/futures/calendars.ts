// futures/calenders.ts
// Pure TS utilities to build futures expiration calendars and roll schedules.
// No imports. Self-contained date + business-day engine with configurable rules.

/** ==== Types ==== */
export type ISODate = string; // "YYYY-MM-DD"

export type BizCalendar = {
  /** Optional set of holiday ISO dates (YYYY-MM-DD). Weekends are always non-business days. */
  holidays?: Record<ISODate, true>;
  /** Human name (just metadata) */
  name?: string;
};

export type ExpiryRule = (year: number, month1to12: number, cal?: BizCalendar) => Date;

export type ContractCalendar = {
  /** Root symbol, e.g., "ES", "CL", "6E", "SR3" */
  root: string;
  /** Month codes map (1..12 -> letter), e.g., CME standard codes */
  monthCodes: { [m: number]: string };
  /** Allowed listing months (1..12). For IMM quarterly, use [3,6,9,12]. For monthly, use [1..12]. */
  cycle: number[];
  /** Function computing the LAST trading day/expiration (exchange-local). */
  expiry: ExpiryRule;
  /** Name (metadata) */
  name?: string;
};

/** ==== CME Month Codes (common) ==== */
export const CME_MONTH_CODES: { [m: number]: string } = {
  1: "F", 2: "G", 3: "H", 4: "J", 5: "K", 6: "M",
  7: "N", 8: "Q", 9: "U", 10: "V", 11: "X", 12: "Z",
};

export function monthCodeToNumber(code: string): number {
  const up = code.toUpperCase();
  for (const m in CME_MONTH_CODES) {
    if (CME_MONTH_CODES[+m] === up) return +m;
  }
  return NaN;
}

/** ==== Date helpers (no timezone shenanigans; use UTC parts only) ==== */
export function ymd(date: Date): { y: number; m: number; d: number } {
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}
export function toISO(date: Date): ISODate {
  const { y, m, d } = ymd(date);
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}
export function fromYMD(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}
export function addDays(date: Date, delta: number): Date {
  const t = new Date(date.getTime());
  t.setUTCDate(t.getUTCDate() + delta);
  return t;
}
export function startOfMonth(y: number, m: number): Date {
  return fromYMD(y, m, 1);
}
export function endOfMonth(y: number, m: number): Date {
  const d = fromYMD(y, m, 1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0); // move to last day of previous month
  return d;
}
export function weekday(date: Date): number {
  // 0 = Sun, 1 = Mon, ..., 6 = Sat (UTC)
  return date.getUTCDay();
}
export function isWeekend(date: Date): boolean {
  const w = weekday(date);
  return w === 0 || w === 6;
}
export function isBusinessDay(date: Date, cal?: BizCalendar): boolean {
  if (isWeekend(date)) return false;
  if (cal?.holidays && cal.holidays[toISO(date)]) return false;
  return true;
}
export function nextBusinessDay(date: Date, cal?: BizCalendar): Date {
  let d = date;
  do { d = addDays(d, 1); } while (!isBusinessDay(d, cal));
  return d;
}
export function prevBusinessDay(date: Date, cal?: BizCalendar): Date {
  let d = date;
  do { d = addDays(d, -1); } while (!isBusinessDay(d, cal));
  return d;
}
export function addBusinessDays(date: Date, n: number, cal?: BizCalendar): Date {
  let d = date;
  const step = n >= 0 ? 1 : -1;
  for (let k = 0; k < Math.abs(n); k++) {
    do { d = addDays(d, step); } while (!isBusinessDay(d, cal));
  }
  return d;
}

/** Nth weekday of a month: weekday: 0=Sun..6=Sat, n>=1 */
export function nthWeekdayOfMonth(y: number, m: number, weekday0Sun: number, n: number): Date {
  const first = startOfMonth(y, m);
  const firstW = weekday(first);
  const diff = (weekday0Sun - firstW + 7) % 7;
  const day = 1 + diff + (n - 1) * 7;
  return fromYMD(y, m, day);
}

/** Third Wednesday of a given month (IMM date) */
export function thirdWednesday(y: number, m: number): Date {
  return nthWeekdayOfMonth(y, m, 3, 3); // 3 = Wed
}

/** Third Friday */
export function thirdFriday(y: number, m: number): Date {
  return nthWeekdayOfMonth(y, m, 5, 3); // 5 = Fri
}

/** Last business day of month */
export function lastBusinessDayOfMonth(y: number, m: number, cal?: BizCalendar): Date {
  let d = endOfMonth(y, m);
  while (!isBusinessDay(d, cal)) d = addDays(d, -1);
  return d;
}

/** Count business days between two dates inclusive of end if includeEnd=true (default false) */
export function businessDaysBetween(start: Date, end: Date, cal?: BizCalendar, includeEnd = false): number {
  if (end < start) return -businessDaysBetween(end, start, cal, includeEnd);
  let d = new Date(start.getTime());
  let count = 0;
  while (d < end) {
    if (isBusinessDay(d, cal)) count++;
    d = addDays(d, 1);
  }
  if (includeEnd && isBusinessDay(end, cal)) count++;
  return count;
}

/** ==== Common expiry rules (parameterized) ==== */

/** Rule: Two business days prior to IMM date (3rd Wed) of the contract month. (Typical FX futures simplification). */
export function twoBizDaysBeforeIMM(y: number, m: number, cal?: BizCalendar): Date {
  const imm = thirdWednesday(y, m);
  // "two business days prior": subtract 2 business days from IMM date
  return addBusinessDays(imm, -2, cal);
}

/** Rule: Third Friday of the contract month. (Typical equity index futures simplification). */
export function onThirdFriday(y: number, m: number, _cal?: BizCalendar): Date {
  return thirdFriday(y, m);
}

/** Rule: CL-style — 3rd business day prior to the 25th calendar day of the month preceding the contract month. */
export function threeBizDaysBefore25thPrevMonth(y: number, m: number, cal?: BizCalendar): Date {
  // Determine the reference month = month prior to contract month
  let refY = y, refM = m - 1;
  if (refM === 0) { refM = 12; refY = y - 1; }
  let ref = fromYMD(refY, refM, Math.min(25, daysInMonth(refY, refM)));
  // If 25th falls on weekend/holiday, rule refers to calendar 25th, then subtract 3 biz days from the "third business day prior to 25th"
  // Start from one day before 25th and go backwards counting 3 business days.
  let d = addDays(ref, -1);
  let count = 0;
  while (count < 3) {
    if (isBusinessDay(d, cal)) count++;
    if (count === 3) break;
    d = addDays(d, -1);
  }
  return d;
}

export function daysInMonth(y: number, m: number): number {
  return endOfMonth(y, m).getUTCDate();
}

/** ==== Prebuilt calendars (generic rules; adjust if your venue requires) ==== */

/** Equity Index Quarterly IMM (e.g., ES): contracts Mar/Jun/Sep/Dec, expire on Third Friday. */
export const CAL_EQ_INDEX_IMM: ContractCalendar = {
  root: "ES",
  monthCodes: CME_MONTH_CODES,
  cycle: [3, 6, 9, 12],
  expiry: onThirdFriday,
  name: "Equity Index (IMM Quarters) — Third Friday",
};

/** FX IMM (e.g., EUR/USD futures 6E): monthly or quarterly depending on product; here we model quarterly IMM using 2BD before IMM. */
export const CAL_FX_IMM: ContractCalendar = {
  root: "6E",
  monthCodes: CME_MONTH_CODES,
  cycle: [3, 6, 9, 12],
  expiry: twoBizDaysBeforeIMM,
  name: "FX (IMM Quarters) — 2BD before IMM (3rd Wed)",
};

/** WTI Crude Oil (CL) monthly style: 3BD before 25th of prior month (simplified). */
export const CAL_CL_MONTHLY: ContractCalendar = {
  root: "CL",
  monthCodes: CME_MONTH_CODES,
  cycle: [1,2,3,4,5,6,7,8,9,10,11,12],
  expiry: threeBizDaysBefore25thPrevMonth,
  name: "WTI Crude (Monthly) — 3BD before 25th of prior month",
};

/** ==== Symbol helpers ==== */
export function contractCode(root: string, year: number, month: number, monthCodes: { [m: number]: string } = CME_MONTH_CODES): string {
  const yy = String(year % 100).padStart(2, "0");
  const code = monthCodes[month] || "?";
  return `${root}${code}${yy}`;
}

/** Find the next N listed contracts from a given anchor date (UTC) */
export function generateContracts(
  cal: ContractCalendar,
  anchor: Date,
  count: number,
  bizCal?: BizCalendar
): { symbol: string; month: number; year: number; expiryISO: ISODate }[] {
  const out: { symbol: string; month: number; year: number; expiryISO: ISODate }[] = [];
  const a = ymd(anchor);
  // build list of (year, month) from anchor forward following cycle
  let y = a.y;
  let m = a.m;

  // Ensure m is in the cycle at or after anchor
  const sorted = [...cal.cycle].sort((x, y) => x - y);
  const advanceToNextCycleMonth = (): void => {
    // If current month is allowed and expiry >= anchor, we can use it; else move forward.
    // We'll advance month-by-month to keep logic simple and robust for monthly/quarterly alike.
    const step = () => {
      m++;
      if (m > 12) { m = 1; y++; }
    };
    while (true) {
      if (sorted.indexOf(m) >= 0) {
        const expD = cal.expiry(y, m, bizCal);
        if (expD >= anchor) return; // good candidate
      }
      step();
    }
  };

  advanceToNextCycleMonth();

  // Now accumulate 'count' contracts
  while (out.length < count) {
    const expDate = cal.expiry(y, m, bizCal);
    const symbol = contractCode(cal.root, y, m, cal.monthCodes);
    out.push({ symbol, month: m, year: y, expiryISO: toISO(expDate) });

    // advance to next cycle month
    let idx = sorted.indexOf(m);
    idx = (idx + 1) % sorted.length;
    if (sorted[idx] <= m) y++; // wrapped year
    m = sorted[idx];
  }
  return out;
}

/** Convenience: compute a simple "roll date" = N business days before expiry (non-negative N). */
export function rollDateBeforeExpiry(expiry: Date, businessDaysBefore: number, cal?: BizCalendar): Date {
  return addBusinessDays(expiry, -Math.max(0, businessDaysBefore), cal);
}

/** Build a roll schedule for first K expiries from anchor. */
export function buildRollSchedule(
  cal: ContractCalendar,
  anchor: Date,
  count: number,
  businessDaysBeforeExpiry: number,
  bizCal?: BizCalendar
): { symbol: string; expiryISO: ISODate; rollISO: ISODate }[] {
  const cs = generateContracts(cal, anchor, count, bizCal);
  return cs.map(c => {
    const exp = fromYMD(c.year, c.month, +c.expiryISO.slice(8));
    const expDate = new Date(Date.UTC(c.year, c.month - 1, parseInt(c.expiryISO.slice(8), 10)));
    const roll = rollDateBeforeExpiry(expDate, businessDaysBeforeExpiry, bizCal);
    return { symbol: c.symbol, expiryISO: c.expiryISO, rollISO: toISO(roll) };
  });
}

/** ==== Minimal example holiday calendars (optional) ==== */
/** Create a holiday set from ISO strings. */
export function makeHolidayCalendar(name: string, isoDates: ISODate[]): BizCalendar {
  const set: Record<ISODate, true> = {};
  for (const d of isoDates) set[d] = true;
  return { name, holidays: set };
}

/** Example: empty calendar (weekends only). */
export const WEEKENDS_ONLY: BizCalendar = { name: "Weekends Only", holidays: {} };

/** ==== Quick presets for users ==== */
export const PRESETS = {
  ES_IMM: CAL_EQ_INDEX_IMM,
  FX_IMM_6E: CAL_FX_IMM,
  CL_MONTHLY: CAL_CL_MONTHLY,
};

/** ==== Lightweight self-check (can be removed) ==== */
function _clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
export function sanityCheck(): string {
  const today = new Date(); // UTC now
  const anchor = fromYMD(today.getUTCFullYear(), today.getUTCMonth() + 1, _clamp(today.getUTCDate(), 1, 28));
  const sample = generateContracts(PRESETS.ES_IMM, anchor, 4, WEEKENDS_ONLY);
  return `ES next: ${sample.map(s => `${s.symbol}@${s.expiryISO}`).join(", ")}`;
}

/** ==== Notes ====
 * These rules are simplified for coding convenience:
 *  - FX IMM: "two business days before 3rd Wednesday" as a common approximation.
 *  - Equity Index IMM: "third Friday" convention for last trade/expiration.
 *  - CL: "third business day prior to the 25th of the month preceding the contract month" (approximation).
 * Adjust expiry() for your venue/contract if you require exact exchange timing nuances.
 */