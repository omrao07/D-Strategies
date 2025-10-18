// utils/dates.ts
//
// Pure TypeScript date/time helpers. No imports, works in Node + browser.

//
// ---------- Conversions ----------
//

export function toUnix(date: Date): number {
  return Math.floor(date.getTime());
}

export function fromUnix(ts: number): Date {
  return new Date(ts);
}

export function toISO(ts: number): string {
  return new Date(ts).toISOString();
}

export function parseISO(s: string): number {
  return new Date(s).getTime();
}

//
// ---------- Day boundaries ----------
//

export function startOfDay(ts: number, tzOffsetMinutes = 0): number {
  const d = new Date(ts + tzOffsetMinutes * 60_000);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - tzOffsetMinutes * 60_000;
}

export function endOfDay(ts: number, tzOffsetMinutes = 0): number {
  const d = new Date(ts + tzOffsetMinutes * 60_000);
  d.setUTCHours(23, 59, 59, 999);
  return d.getTime() - tzOffsetMinutes * 60_000;
}

export function addDays(ts: number, n: number): number {
  return ts + n * 86_400_000;
}

export function sameDay(a: number, b: number, tzOffsetMinutes = 0): boolean {
  return startOfDay(a, tzOffsetMinutes) === startOfDay(b, tzOffsetMinutes);
}

//
// ---------- Week / Month helpers ----------
//

export function startOfWeek(ts: number, weekStartsOn = 1): number {
  // weekStartsOn: 0=Sunday, 1=Monday
  const d = new Date(ts);
  const day = d.getUTCDay();
  const diff = (day < weekStartsOn ? 7 : 0) + day - weekStartsOn;
  return startOfDay(addDays(d.getTime(), -diff));
}

export function startOfMonth(ts: number): number {
  const d = new Date(ts);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

//
// ---------- Market hours gating ----------
//

export function isWithinMarketHours(
  ts: number,
  startHHMM: string,
  endHHMM: string,
  days: number[]
): boolean {
  const d = new Date(ts);
  const day = d.getUTCDay(); // 0=Sunday
  if (!days.includes(day)) return false;

  const [sh, sm] = startHHMM.split(":").map(Number);
  const [eh, em] = endHHMM.split(":").map(Number);

  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;

  return mins >= startMins && mins <= endMins;
}

//
// ---------- Misc ----------
//

export function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().split("T")[0];
}

export function daysBetween(a: number, b: number): number {
  return Math.floor(Math.abs(b - a) / 86_400_000);
}