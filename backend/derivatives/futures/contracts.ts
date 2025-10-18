// futures/contracts.ts
// Contract symbol helpers, parsing, ladders, and roll plans.
// Pure TS. No imports. Compatible with futures/calenders.ts shapes.

/** ===== Types (mirror the minimal shapes from futures/calenders.ts) ===== */
export type ISODate = string; // "YYYY-MM-DD"

export type BizCalendar = {
  holidays?: Record<ISODate, true>;
  name?: string;
};

export type ExpiryRule = (year: number, month1to12: number, cal?: BizCalendar) => Date;

export type ContractCalendar = {
  root: string;                              // e.g., "ES", "CL", "6E"
  monthCodes: { [m: number]: string };       // 1..12 -> letter
  cycle: number[];                           // allowed listing months
  expiry: ExpiryRule;                        // computes last trade/expiration (exchange-local)
  name?: string;
};

export type Contract = {
  root: string;
  month: number;     // 1..12
  year: number;      // four-digit
  symbol: string;    // root + code + yy (e.g., ESZ25)
  expiryISO: ISODate;
};

export type RollSpec = {
  symbol: string;
  expiryISO: ISODate;
  rollISO: ISODate;
};

/** ===== Month codes (CME standard) ===== */
export const CME_MONTH_CODES: { [m: number]: string } = {
  1: "F", 2: "G", 3: "H", 4: "J", 5: "K", 6: "M",
  7: "N", 8: "Q", 9: "U", 10: "V", 11: "X", 12: "Z",
};

export function monthCodeToNumber(code: string, map: { [m: number]: string } = CME_MONTH_CODES): number {
  const up = code.toUpperCase();
  for (const m in map) if (map[+m] === up) return +m;
  return NaN;
}

/** ===== Date utils (UTC-only) ===== */
export function toISO(d: Date): ISODate {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
export function fromYMD(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}
export function weekday(d: Date): number { return d.getUTCDay(); } // 0=Sun..6=Sat
export function isWeekend(d: Date): boolean { const w = weekday(d); return w === 0 || w === 6; }
export function isBusinessDay(d: Date, cal?: BizCalendar): boolean {
  if (isWeekend(d)) return false;
  if (cal?.holidays && cal.holidays[toISO(d)]) return false;
  return true;
}
export function addBusinessDays(date: Date, n: number, cal?: BizCalendar): Date {
  let d = new Date(date.getTime());
  const step = n >= 0 ? 1 : -1;
  for (let k = 0; k < Math.abs(n); k++) {
    do { d = new Date(d.getTime() + step * 86400000); } while (!isBusinessDay(d, cal));
  }
  return d;
}

/** ===== Symbol build/parse ===== */
export function buildSymbol(root: string, year: number, month: number, monthCodes: { [m: number]: string } = CME_MONTH_CODES): string {
  const yy = String(year % 100).padStart(2, "0");
  const code = monthCodes[month] || "?";
  return `${root}${code}${yy}`;
}

export function parseSymbol(
  symbol: string,
  monthCodes: { [m: number]: string } = CME_MONTH_CODES
): { root: string; year: number; month: number } | null {
  // Root = leading letters; MonthCode = single letter in codes; Year = 1-2 digits at end.
  // Examples: ESZ25, CLF6, 6EH26
  if (!symbol || symbol.length < 3) return null;
  const letters = /^[A-Za-z]+/;
  const m = letters.exec(symbol);
  if (!m) return null;
  const root = m[0];
  const rest = symbol.slice(root.length);
  if (rest.length < 2) return null;

  // Month code is the first char of 'rest'
  const code = rest[0].toUpperCase();
  const month = monthCodeToNumber(code, monthCodes);
  if (!(month >= 1 && month <= 12)) return null;

  // Remaining digits are year (1 or 2 digits typical). If 1 digit, 2010->2019 mapping is ambiguous; assume 2020..2029 style if single digit.
  const yearDigits = rest.slice(1);
  if (!/^\d{1,2}$/.test(yearDigits)) return null;
  const yy = parseInt(yearDigits, 10);
  const now = new Date();
  const centuryBase = Math.floor(now.getUTCFullYear() / 100) * 100;
  // Heuristic: map 00..49 -> this century, 50..99 -> previous century
  const fullYear = yy <= 49 ? centuryBase + yy : centuryBase - 100 + yy;

  return { root, year: fullYear, month };
}

/** ===== Ladders / front chain ===== */

/** Advance (year, month) to the next allowed month in a cycle. */
export function nextInCycle(year: number, month: number, cycle: number[]): { year: number; month: number } {
  const sorted = [...cycle].sort((a, b) => a - b);
  let idx = sorted.indexOf(month);
  if (idx === -1) {
    // choose next cycle month after 'month'
    for (let i = 0; i < sorted.length; i++) if (sorted[i] > month) { idx = i; break; }
    if (idx === -1) idx = 0, year++;
  } else {
    idx++;
    if (idx >= sorted.length) { idx = 0; year++; }
  }
  return { year, month: sorted[idx] };
}

/** Move forward from an anchor date to the first contract whose expiry >= anchor. */
export function firstActiveFromAnchor(
  cal: ContractCalendar,
  anchor: Date,
  bizCal?: BizCalendar
): { year: number; month: number } {
  // iterate at most 24 steps to find the first future expiry
  const aY = anchor.getUTCFullYear();
  const aM = anchor.getUTCMonth() + 1;
  // start from current month (or next cycle month if not listed)
  let y = aY;
  // If current month is part of cycle, begin with it; else pick nearest forward cycle month.
  const sorted = [...cal.cycle].sort((x, y) => x - y);
  let m = sorted.find(mm => mm === aM) ?? sorted.find(mm => mm > aM) ?? sorted[0];
  if (m < aM && m === sorted[0]) y++; // wrapped to next year

  for (let i = 0; i < 24; i++) {
    const expiry = cal.expiry(y, m, bizCal);
    if (expiry >= anchor) return { year: y, month: m };
    const nxt = nextInCycle(y, m, cal.cycle);
    y = nxt.year; m = nxt.month;
  }
  // Fallback (shouldn't happen): return immediate next
  return { year: aY, month: aM };
}

/** Generate the next N listed contracts from anchor (expiry >= anchor). */
export function ladderFromAnchor(
  cal: ContractCalendar,
  anchor: Date,
  count: number,
  bizCal?: BizCalendar
): Contract[] {
  const out: Contract[] = [];
  const first = firstActiveFromAnchor(cal, anchor, bizCal);
  let y = first.year, m = first.month;

  for (let i = 0; i < count; i++) {
    const exp = cal.expiry(y, m, bizCal);
    const symbol = buildSymbol(cal.root, y, m, cal.monthCodes);
    out.push({ root: cal.root, month: m, year: y, symbol, expiryISO: toISO(exp) });
    const nxt = nextInCycle(y, m, cal.cycle);
    y = nxt.year; m = nxt.month;
  }
  return out;
}

/** Convenience: list N contracts starting from a specific (year, month), ignoring anchor. */
export function ladderFromYM(
  cal: ContractCalendar,
  startYear: number,
  startMonth: number,
  count: number,
  bizCal?: BizCalendar
): Contract[] {
  const out: Contract[] = [];
  let y = startYear, m = startMonth;
  for (let i = 0; i < count; i++) {
    const exp = cal.expiry(y, m, bizCal);
    out.push({ root: cal.root, month: m, year: y, symbol: buildSymbol(cal.root, y, m, cal.monthCodes), expiryISO: toISO(exp) });
    const nxt = nextInCycle(y, m, cal.cycle);
    y = nxt.year; m = nxt.month;
  }
  return out;
}

/** Days remaining to expiry (weekends count as calendar days). Negative if already expired. */
export function daysToExpiry(expiryISO: ISODate, onDate: ISODate): number {
  const e = new Date(expiryISO + "T00:00:00Z").getTime();
  const d = new Date(onDate + "T00:00:00Z").getTime();
  const ms = e - d;
  return Math.floor(ms / 86400000);
}

/** Find the 'k-th' front contract (k=0 is front, 1 is next, ...) from an anchor. */
export function kthFront(
  cal: ContractCalendar,
  anchor: Date,
  k: number,
  bizCal?: BizCalendar
): Contract {
  const ladder = ladderFromAnchor(cal, anchor, k + 1, bizCal);
  return ladder[Math.min(k, ladder.length - 1)];
}

/** Build a naive roll plan: roll N business days before each contract's expiry (weekends-only unless holiday set provided). */
export function rollPlanFromAnchor(
  cal: ContractCalendar,
  anchor: Date,
  count: number,
  bizDaysBefore: number,
  bizCal?: BizCalendar
): RollSpec[] {
  const ladder = ladderFromAnchor(cal, anchor, count, bizCal);
  const out: RollSpec[] = [];
  for (let i = 0; i < ladder.length - 1; i++) {
    const eISO = ladder[i].expiryISO;
    const e = new Date(eISO + "T00:00:00Z");
    const rollDate = addBusinessDays(e, -Math.max(0, bizDaysBefore), bizCal);
    out.push({ symbol: ladder[i].symbol, expiryISO: eISO, rollISO: toISO(rollDate) });
  }
  return out;
}

/** Choose front by minimum non-negative days-to-expiry among listed cycle of current year/month onward. */
export function pickFrontByMinDays(
  cal: ContractCalendar,
  anchor: Date,
  lookAhead: number = 6,
  bizCal?: BizCalendar
): Contract {
  const ladder = ladderFromAnchor(cal, anchor, Math.max(lookAhead, 1), bizCal);
  const isoToday = toISO(anchor);
  let best = ladder[0];
  let bestDays = daysToExpiry(best.expiryISO, isoToday);
  for (let i = 1; i < ladder.length; i++) {
    const dte = daysToExpiry(ladder[i].expiryISO, isoToday);
    if (dte >= 0 && (bestDays < 0 || dte < bestDays)) { best = ladder[i]; bestDays = dte; }
  }
  return best;
}

/** Sort contracts by expiry date ascending. */
export function sortByExpiry(contracts: Contract[]): Contract[] {
  return contracts.slice().sort((a, b) => (a.expiryISO < b.expiryISO ? -1 : a.expiryISO > b.expiryISO ? 1 : 0));
}

/** Deduce (year, month) progression given a parsed symbol and a cycle. Useful for walking chains when you only have symbols. */
export function nextFromSymbol(symbol: string, cal: ContractCalendar): { symbol: string; year: number; month: number } | null {
  const p = parseSymbol(symbol, cal.monthCodes);
  if (!p) return null;
  const n = nextInCycle(p.year, p.month, cal.cycle);
  const s = buildSymbol(cal.root, n.year, n.month, cal.monthCodes);
  return { symbol: s, year: n.year, month: n.month };
}

/** Validate that a symbol conforms to a calendar's root + month codes. */
export function validateSymbol(symbol: string, cal: ContractCalendar): boolean {
  const p = parseSymbol(symbol, cal.monthCodes);
  return !!p && p.root === cal.root && cal.cycle.indexOf(p.month) >= 0;
}

/** Lightweight self-check (can be removed). */
export function _selfCheck(cal: ContractCalendar): string {
  const today = new Date();
  const chain = ladderFromAnchor(cal, today, 4);
  return `${cal.root} -> ${chain.map(c => `${c.symbol}@${c.expiryISO}`).join(", ")}`;
}