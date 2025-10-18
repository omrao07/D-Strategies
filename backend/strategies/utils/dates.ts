// utils/dates.ts
// Pure TypeScript date helpers (no imports). Timezone-agnostic by using UTC methods only.

export type DayCount =
  | "ACT/365"
  | "ACT/360"
  | "30/360"
  | "30E/360"; // Euro 30/360

// -------------------- Core UTC helpers --------------------
export function ymd(
  date: Date
): { y: number; m: number; d: number } {
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

export function fromYMD(y: number, m: number, d: number): Date {
  // Clamp month/day sensibly; Date will roll overflow automatically.
  const dt = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  return dt;
}

export function startOfUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addDays(date: Date, days: number): Date {
  const dt = startOfUTC(date);
  dt.setUTCDate(dt.getUTCDate() + Math.trunc(days));
  return dt;
}

export function diffDays(a: Date, b: Date): number {
  const A = startOfUTC(a).getTime();
  const B = startOfUTC(b).getTime();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((A - B) / MS_PER_DAY);
}

export function toISO(date: Date): string {
  const { y, m, d } = ymd(date);
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

export function parseISO(s: string): Date | null {
  // Accepts YYYY-MM-DD or YYYY/MM/DD
  const t = s.trim().replace(/\//g, "-");
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = fromYMD(y, mo, d);
  // Validate round-trip
  const ok = dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === mo && dt.getUTCDate() === d;
  return ok ? dt : null;
}

// -------------------- Business day utilities --------------------
export function isWeekend(date: Date): boolean {
  const wd = startOfUTC(date).getUTCDay(); // 0 Sun … 6 Sat
  return wd === 0 || wd === 6;
}

export function isBusinessDay(date: Date, holidays: Date[] = []): boolean {
  const iso = toISO(startOfUTC(date));
  if (isWeekend(date)) return false;
  for (let i = 0; i < holidays.length; i++) {
    if (toISO(holidays[i]) === iso) return false;
  }
  return true;
}

export function nextBusinessDay(date: Date, holidays: Date[] = []): Date {
  let d = addDays(date, 1);
  while (!isBusinessDay(d, holidays)) d = addDays(d, 1);
  return d;
}

export function prevBusinessDay(date: Date, holidays: Date[] = []): Date {
  let d = addDays(date, -1);
  while (!isBusinessDay(d, holidays)) d = addDays(d, -1);
  return d;
}

export function addBusinessDays(date: Date, count: number, holidays: Date[] = []): Date {
  let d = startOfUTC(date);
  const step = count >= 0 ? 1 : -1;
  let left = Math.abs(Math.trunc(count));
  while (left > 0) {
    d = addDays(d, step);
    if (isBusinessDay(d, holidays)) left -= 1;
  }
  return d;
}

export function countBusinessDays(start: Date, end: Date, holidays: Date[] = []): number {
  if (diffDays(end, start) < 0) return -countBusinessDays(end, start, holidays);
  let d = startOfUTC(start);
  let cnt = 0;
  while (diffDays(end, d) > 0) {
    if (isBusinessDay(d, holidays)) cnt += 1;
    d = addDays(d, 1);
  }
  return cnt;
}

// -------------------- Year fractions (day count) --------------------
export function yearFraction(
  start: Date,
  end: Date,
  basis: DayCount = "ACT/365"
): number {
  switch (basis) {
    case "ACT/365":
      return Math.abs(diffDays(end, start)) / 365;
    case "ACT/360":
      return Math.abs(diffDays(end, start)) / 360;
    case "30/360":
      return thirty360US(start, end) / 360;
    case "30E/360":
      return thirty360EU(start, end) / 360;
    default:
      return Math.abs(diffDays(end, start)) / 365;
  }
}

// US 30/360 (Bond Basis)
function thirty360US(start: Date, end: Date): number {
  let { y: y1, m: m1, d: d1 } = ymd(start);
  let { y: y2, m: m2, d: d2 } = ymd(end);

  const d1Adj = d1 === 31 ? 30 : d1;
  let d2Adj = d2;
  if (d1Adj === 30 && d2 === 31) d2Adj = 30;

  return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2Adj - d1Adj);
}

// Euro 30E/360
function thirty360EU(start: Date, end: Date): number {
  let { y: y1, m: m1, d: d1 } = ymd(start);
  let { y: y2, m: m2, d: d2 } = ymd(end);

  if (d1 === 31) d1 = 30;
  if (d2 === 31) d2 = 30;

  return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
}

// -------------------- Convenience --------------------
/** Fractional years using ACT/365; handy for small-T carry math. */
export function yearsBetween(start: Date, end: Date): number {
  return yearFraction(start, end, "ACT/365");
}

/** Convert horizon in days to years using ACT/365. */
export function daysToYears(days: number): number {
  const d = Number.isFinite(days) ? Math.max(0, Math.trunc(days)) : 0;
  return d / 365;
}

/** Today in UTC (midnight). */
export function todayUTC(): Date {
  const now = new Date();
  return startOfUTC(now);
}
