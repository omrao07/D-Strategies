// regions/us.ts
// Region configuration for United States (fixed offsets, no DST).
// Pure TypeScript, no imports. Approximated holiday rules; override per-year for prod.

export type HHMM = `${number}${number}:${number}${number}`;

export type ExchangeHours = {
  name: string;
  tzOffsetMinutes: number; // ET = -300 (no DST modeled)
  sessions: { open: HHMM; close: HHMM }[];
  weekend: { sat: boolean; sun: boolean };
  earlyClose?: HHMM[];
};

export type Holiday = {
  date: string; // YYYY-MM-DD local
  name: string;
  exchanges: string[]; // ["*"] for all
};

export type RegionConfig = {
  region: "US";
  displayName: "United States";
  currencies: string[]; // ["USD"]
  tzOffsetMinutes: number;
  exchanges: ExchangeHours[];
  holidays: Holiday[];
  symbols: {
    equityIndices: string[];
    govvies: string[];
    moneyMarket: string[];
    credit: string[];
    fxPairs: string[];
    commodities: string[];
    futures: string[];
  };
  isTradingDay: (d: Date, exchName?: string) => boolean;
  isOpenNow: (when?: Date, exchName?: string) => boolean;
  nextTradingDay: (d: Date, exchName?: string) => Date;
  normalizeTicker: (raw: string) => string;
  mapSecurityToVenue: (ticker: string) => string;
  isOnshore: (ticker: string) => boolean;
  lotSize: (ticker: string) => number;
};

// ---------- Helpers ----------

const ET = -300; // UTC-5 (no DST)
const CT = -360; // UTC-6 (no DST) — for CME/CBOT if needed

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function ymd(d: Date, tzOffsetMin: number): { y: number; m: number; dd: number } {
  const ms = d.getTime() + tzOffsetMin * 60_000;
  const ld = new Date(ms);
  return { y: ld.getUTCFullYear(), m: ld.getUTCMonth() + 1, dd: ld.getUTCDate() };
}

function toYYYYMMDD(d: Date, tzOffsetMin: number): string {
  const { y, m, dd } = ymd(d, tzOffsetMin);
  return `${y}-${pad(m)}-${pad(dd)}`;
}

function parseHHMM(hhmm: HHMM): { h: number; m: number } {
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  return { h, m };
}

function inSessionLocal(now: Date, sessions: { open: HHMM; close: HHMM }[], tzOffsetMin: number): boolean {
  const msLocal = now.getTime() + tzOffsetMin * 60_000;
  const ld = new Date(msLocal);
  const minutes = ld.getUTCHours() * 60 + ld.getUTCMinutes();
  for (let i = 0; i < sessions.length; i++) {
    const { h: oh, m: om } = parseHHMM(sessions[i].open);
    const { h: ch, m: cm } = parseHHMM(sessions[i].close);
    const oMin = oh * 60 + om;
    const cMin = ch * 60 + cm;
    if (minutes >= oMin && minutes < cMin) return true;
  }
  return false;
}

function isWeekendLocal(d: Date, tzOffsetMin: number, weekend: { sat: boolean; sun: boolean }): boolean {
  const msLocal = d.getTime() + tzOffsetMin * 60_000;
  const wd = new Date(msLocal).getUTCDay(); // 0=Sun..6=Sat
  if (wd === 6) return weekend.sat;
  if (wd === 0) return weekend.sun;
  return false;
}

function addDaysLocal(d: Date, days: number, tzOffsetMin: number): Date {
  const msLocal = d.getTime() + tzOffsetMin * 60_000;
  const out = new Date(msLocal);
  out.setUTCDate(out.getUTCDate() + days);
  return new Date(out.getTime() - tzOffsetMin * 60_000);
}

// Computus for Easter (Gregorian) -> month/day
function easterMD(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function ymdStr(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

// nth weekday of month (e.g., 3rd Monday of February)
function nthWeekdayOfMonth(year: number, month1to12: number, weekday0Sun6Sat: number, n: number): string {
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const firstW = first.getUTCDay();
  const diff = (7 + weekday0Sun6Sat - firstW) % 7;
  const day = 1 + diff + (n - 1) * 7;
  return ymdStr(year, month1to12, day);
}

// last weekday of month that is a given weekday (e.g., last Monday of May)
function lastWeekdayOfMonth(year: number, month1to12: number, weekday0Sun6Sat: number): string {
  const last = new Date(Date.UTC(year, month1to12, 0)); // last day of month
  const w = last.getUTCDay();
  const diff = (7 + w - weekday0Sun6Sat) % 7;
  const day = last.getUTCDate() - diff;
  return ymdStr(year, month1to12, day);
}

// ---------- Holidays (approx; equities focus) ----------

function staticUSHolidays(year: number): Holiday[] {
  const eas = easterMD(year);
  const easter = new Date(Date.UTC(year, eas.month - 1, eas.day));
  const goodFri = new Date(easter.getTime() - 2 * 24 * 3600 * 1000);

  return [
    { date: `${year}-01-01`, name: "New Year’s Day", exchanges: ["*"] },
    { date: nthWeekdayOfMonth(year, 1, 1, 3), name: "Martin Luther King Jr. Day (3rd Mon Jan)", exchanges: ["*"] },
    { date: nthWeekdayOfMonth(year, 2, 1, 3), name: "Presidents’ Day (3rd Mon Feb)", exchanges: ["*"] },
    { date: ymdStr(goodFri.getUTCFullYear(), goodFri.getUTCMonth() + 1, goodFri.getUTCDate()), name: "Good Friday", exchanges: ["*"] },
    { date: lastWeekdayOfMonth(year, 5, 1), name: "Memorial Day (last Mon May)", exchanges: ["*"] },
    { date: `${year}-06-19`, name: "Juneteenth National Independence Day", exchanges: ["*"] },
    { date: `${year}-07-04`, name: "Independence Day", exchanges: ["*"] },
    { date: nthWeekdayOfMonth(year, 9, 1, 1), name: "Labor Day (1st Mon Sep)", exchanges: ["*"] },
    { date: nthWeekdayOfMonth(year, 11, 4, 4), name: "Thanksgiving Day (4th Thu Nov)", exchanges: ["*"] },
    { date: `${year}-12-25`, name: "Christmas Day", exchanges: ["*"] },
  ];
}

function buildHolidayTable(startYear: number, years: number): Holiday[] {
  const out: Holiday[] = [];
  for (let y = 0; y < years; y++) out.push(...staticUSHolidays(startYear + y));
  return out;
}

const HOLIDAYS: Holiday[] = buildHolidayTable(2024, 6);

// ---------- Exchanges ----------

const NYSE: ExchangeHours = {
  name: "NYSE",
  tzOffsetMinutes: ET,
  sessions: [{ open: "09:30", close: "16:00" }],
  weekend: { sat: true, sun: true },
};

const NASDAQ: ExchangeHours = {
  name: "NASDAQ",
  tzOffsetMinutes: ET,
  sessions: [{ open: "09:30", close: "16:00" }],
  weekend: { sat: true, sun: true },
};

const CBOE: ExchangeHours = {
  name: "CBOE",
  tzOffsetMinutes: ET,
  sessions: [{ open: "09:30", close: "16:00" }],
  weekend: { sat: true, sun: true },
};

const CME: ExchangeHours = {
  name: "CME",
  tzOffsetMinutes: CT,
  // Day-session anchor only (Globex extended hours not modeled in this minimal build)
  sessions: [{ open: "08:30", close: "15:00" }],
  weekend: { sat: true, sun: true },
};

const CBOT: ExchangeHours = {
  name: "CBOT",
  tzOffsetMinutes: CT,
  sessions: [{ open: "08:30", close: "15:00" }],
  weekend: { sat: true, sun: true },
};

// ---------- Mapping & utils ----------

function normalizeTickerUS(raw: string): string {
  const x = (raw || "").trim().toUpperCase();
  // Recognize suffixes: .N (NYSE), .O/.Q (NASDAQ), .ARCA (NYSE Arca)
  if (/\.(N|O|Q|ARCA)$/.test(x)) return x;
  // Futures namespace pass-throughs
  if (/^(CME|CBOT|NYMEX|COMEX|CFE|CBOE):/.test(x)) return x;
  // Plain equities, leave as-is (venue inference below)
  return x;
}

function venueFor(ticker: string): string {
  const t = normalizeTickerUS(ticker);
  if (t.endsWith(".N")) return "NYSE";
  if (t.endsWith(".ARCA")) return "NYSE";
  if (t.endsWith(".O") || t.endsWith(".Q")) return "NASDAQ";
  if (t.startsWith("CBOE:") || t.startsWith("CFE:")) return "CBOE";
  if (t.startsWith("CME:")) return "CME";
  if (t.startsWith("CBOT:")) return "CBOT";
  if (t.startsWith("NYMEX:") || t.startsWith("COMEX:")) return "CME";
  // Default equities -> NYSE (arbitrary anchor)
  return "NYSE";
}

function defaultLotSize(ticker: string): number {
  const v = venueFor(ticker);
  if (v === "NYSE" || v === "NASDAQ") return 1; // US equities: 1 share
  return 1; // derivatives vary; 1 contract default
}

function getExchange(name: string): ExchangeHours {
  if (name === "NYSE") return NYSE;
  if (name === "NASDAQ") return NASDAQ;
  if (name === "CBOE") return CBOE;
  if (name === "CME") return CME;
  if (name === "CBOT") return CBOT;
  return NYSE;
}

function isHolidayLocal(date: Date, exchName: string): boolean {
  const ex = getExchange(exchName);
  const tag = toYYYYMMDD(date, ex.tzOffsetMinutes);
  for (let i = 0; i < HOLIDAYS.length; i++) {
    const h = HOLIDAYS[i];
    if (h.date === tag && (h.exchanges.includes("*") || h.exchanges.includes(ex.name))) return true;
  }
  return false;
}

// ---------- Exported Config ----------

const US: RegionConfig = {
  region: "US",
  displayName: "United States",
  currencies: ["USD"],
  tzOffsetMinutes: ET,
  exchanges: [NYSE, NASDAQ, CBOE, CME, CBOT],
  holidays: HOLIDAYS,
  symbols: {
    equityIndices: ["SPX", "NDX", "DJI", "RUT"],
    govvies: ["UST10Y", "UST5Y", "UST2Y", "UST30Y"],
    moneyMarket: ["EFFR", "SOFR_O/N", "BILLS_3M"],
    credit: ["CDX_IG_5Y", "CDX_HY_5Y"],
    fxPairs: ["EURUSD", "USDJPY", "GBPUSD", "USDCAD", "USDCHF"],
    commodities: ["WTI", "HH_NG", "GOLD_COMEX", "SILVER_COMEX"],
    futures: ["CME:ES", "CME:NQ", "CME:RTY", "CBOT:ZB", "CBOT:ZN", "NYMEX:CL", "NYMEX:NG"],
  },
  isTradingDay: function (d: Date, exchName?: string): boolean {
    const ex = getExchange(exchName || "NYSE");
    if (isWeekendLocal(d, ex.tzOffsetMinutes, ex.weekend)) return false;
    if (isHolidayLocal(d, ex.name)) return false;
    return true;
  },
  isOpenNow: function (when?: Date, exchName?: string): boolean {
    const now = when || new Date();
    const ex = getExchange(exchName || "NYSE");
    if (!this.isTradingDay(now, ex.name)) return false;
    return inSessionLocal(now, ex.sessions, ex.tzOffsetMinutes);
  },
  nextTradingDay: function (d: Date, exchName?: string): Date {
    const ex = getExchange(exchName || "NYSE");
    let t = new Date(d.getTime());
    for (let i = 0; i < 30; i++) {
      t = addDaysLocal(t, 1, ex.tzOffsetMinutes);
      if (this.isTradingDay(t, ex.name)) return t;
    }
    return t;
  },
  normalizeTicker: function (raw: string): string {
    return normalizeTickerUS(raw);
  },
  mapSecurityToVenue: function (ticker: string): string {
    return venueFor(ticker);
  },
  isOnshore: function (_ticker: string): boolean {
    return true; // US-listed treated as onshore
  },
  lotSize: function (ticker: string): number {
    return defaultLotSize(ticker);
  },
};

export default US;
