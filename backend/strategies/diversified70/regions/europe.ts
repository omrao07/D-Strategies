// regions/europe.ts
// Region configuration for Europe. Pure TypeScript, no imports.
// Note: Uses fixed offsets (no DST). If you need DST, extend `getExchange()`
// to adjust `tzOffsetMinutes` seasonally per venue.

export type HHMM = `${number}${number}:${number}${number}`;

export type ExchangeHours = {
  name: string;
  tzOffsetMinutes: number; // CET=+60, GMT=0, etc. (no DST in this minimal build)
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
  region: "EU";
  displayName: "Europe";
  currencies: string[]; // ["EUR","GBP","CHF","SEK","NOK","DKK"]
  tzOffsetMinutes: number; // default anchor (CET +60)
  exchanges: ExchangeHours[];
  holidays: Holiday[];
  symbols: {
    equityIndices: string[];
    govvies: string[];       // sovereign rates proxies
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
  const wd = new Date(msLocal).getUTCDay(); // 0 Sun .. 6 Sat
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

// Gregorian Easter (Computus) -> month/day
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
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=Mar, 4=Apr
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function ymdStr(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function staticEUHolidays(year: number): Holiday[] {
  const easter = easterMD(year);
  // Good Friday = Easter - 2 days, Easter Monday = Easter + 1 day
  const easterDate = new Date(Date.UTC(year, easter.month - 1, easter.day));
  const goodFri = new Date(easterDate.getTime() - 2 * 24 * 3600 * 1000);
  const easMon = new Date(easterDate.getTime() + 1 * 24 * 3600 * 1000);

  return [
    { date: `${year}-01-01`, name: "New Year’s Day", exchanges: ["*"] },
    { date: ymdStr(goodFri.getUTCFullYear(), goodFri.getUTCMonth() + 1, goodFri.getUTCDate()), name: "Good Friday", exchanges: ["*"] },
    { date: ymdStr(easMon.getUTCFullYear(), easMon.getUTCMonth() + 1, easMon.getUTCDate()), name: "Easter Monday", exchanges: ["*"] },
    { date: `${year}-05-01`, name: "Labor Day", exchanges: ["*"] },
    { date: `${year}-12-25`, name: "Christmas Day", exchanges: ["*"] },
    { date: `${year}-12-26`, name: "Boxing/St. Stephen’s Day", exchanges: ["*"] },
  ];
}

function buildHolidayTable(startYear: number, years: number): Holiday[] {
  const out: Holiday[] = [];
  for (let y = 0; y < years; y++) {
    out.push(...staticEUHolidays(startYear + y));
  }
  return out;
}

// ---------- Exchanges (fixed offsets; extend if you need DST) ----------

const CET = 60;   // Paris, Frankfurt, Milan, Madrid, Zurich (standard time)
const GMT = 0;    // London (standard time)

const XETRA: ExchangeHours = {
  name: "XETRA",
  tzOffsetMinutes: CET,
  sessions: [{ open: "09:00", close: "17:30" }],
  weekend: { sat: true, sun: true },
};

const EURONEXT_PARIS: ExchangeHours = {
  name: "ENX_PAR",
  tzOffsetMinutes: CET,
  sessions: [{ open: "09:00", close: "17:30" }],
  weekend: { sat: true, sun: true },
};

const BORSA_ITALIANA: ExchangeHours = {
  name: "BIT",
  tzOffsetMinutes: CET,
  sessions: [{ open: "09:00", close: "17:30" }],
  weekend: { sat: true, sun: true },
};

const BME_MADRID: ExchangeHours = {
  name: "BME",
  tzOffsetMinutes: CET,
  sessions: [{ open: "09:00", close: "17:30" }],
  weekend: { sat: true, sun: true },
};

const SIX_ZURICH: ExchangeHours = {
  name: "SIX",
  tzOffsetMinutes: CET,
  sessions: [{ open: "09:00", close: "17:30" }],
  weekend: { sat: true, sun: true },
};

const LSE: ExchangeHours = {
  name: "LSE",
  tzOffsetMinutes: GMT,
  sessions: [{ open: "08:00", close: "16:30" }],
  weekend: { sat: true, sun: true },
};

const HOLIDAYS: Holiday[] = buildHolidayTable(2024, 6);

// ---------- Tickers, mapping & utils ----------

function normalizeTickerEU(raw: string): string {
  const x = (raw || "").trim().toUpperCase();
  // Recognize common suffixes
  if (/\.(DE|PA|MI|MC|AS|BR|LS|SW|L)$/.test(x)) return x;
  // Try to infer from leading letters
  if (/^[A-Z0-9]{1,5}$/.test(x)) return x; // leave vanilla symbols as-is
  return x;
}

function venueFor(ticker: string): string {
  const t = normalizeTickerEU(ticker);
  if (t.endsWith(".DE")) return "XETRA";
  if (t.endsWith(".PA")) return "ENX_PAR";
  if (t.endsWith(".MI")) return "BIT";
  if (t.endsWith(".MC")) return "BME";
  if (t.endsWith(".SW")) return "SIX";
  if (t.endsWith(".L")) return "LSE";
  return "XETRA";
}

function defaultLotSize(ticker: string): number {
  const v = venueFor(ticker);
  if (v === "LSE") return 1;
  return 1; // European equities typically 1 share lot
}

function getExchange(name: string): ExchangeHours {
  if (name === "XETRA") return XETRA;
  if (name === "ENX_PAR") return EURONEXT_PARIS;
  if (name === "BIT") return BORSA_ITALIANA;
  if (name === "BME") return BME_MADRID;
  if (name === "SIX") return SIX_ZURICH;
  if (name === "LSE") return LSE;
  return XETRA;
}

function isHolidayLocal(date: Date, exchName: string): boolean {
  const ex = getExchange(exchName);
  const tag = toYYYYMMDD(date, ex.tzOffsetMinutes);
  for (let i = 0; i < HOLIDAYS.length; i++) {
    const h = HOLIDAYS[i];
    if (h.date === tag && (h.exchanges.includes("*") || h.exchanges.includes(ex.name))) {
      return true;
    }
  }
  return false;
}

// ---------- Exported Config ----------

const EUROPE: RegionConfig = {
  region: "EU",
  displayName: "Europe",
  currencies: ["EUR", "GBP", "CHF", "SEK", "NOK", "DKK"],
  tzOffsetMinutes: CET,
  exchanges: [XETRA, EURONEXT_PARIS, BORSA_ITALIANA, BME_MADRID, SIX_ZURICH, LSE],
  holidays: HOLIDAYS,
  symbols: {
    equityIndices: [
      "SX5E",       // Euro Stoxx 50
      "DAX",        // Germany
      "CAC40",      // France
      "FTSE100",    // UK
      "IBEX35",     // Spain
      "FTSEMIB",    // Italy
      "SMI",        // Switzerland
    ],
    govvies: ["DE10Y", "FR10Y", "IT10Y", "ES10Y", "GB10Y", "CH10Y"],
    moneyMarket: ["EURIBOR3M", "EONIA", "€STR", "SONIA", "SARON"],
    credit: ["ITRAXX_EU_IG", "ITRAXX_EU_HY"],
    fxPairs: ["EURUSD", "GBPUSD", "EURGBP", "EURCHF", "EURJPY"],
    commodities: ["BRENT", "TTF_GAS"],
    futures: ["FESX", "FDAX", "FCE", "FTSE", "FGBL"], // ESX50, DAX, CAC, FTSE100, Bund
  },
  isTradingDay: function (d: Date, exchName?: string): boolean {
    const ex = getExchange(exchName || "XETRA");
    if (isWeekendLocal(d, ex.tzOffsetMinutes, ex.weekend)) return false;
    if (isHolidayLocal(d, ex.name)) return false;
    return true;
  },
  isOpenNow: function (when?: Date, exchName?: string): boolean {
    const now = when || new Date();
    const ex = getExchange(exchName || "XETRA");
    if (!this.isTradingDay(now, ex.name)) return false;
    return inSessionLocal(now, ex.sessions, ex.tzOffsetMinutes);
  },
  nextTradingDay: function (d: Date, exchName?: string): Date {
    const ex = getExchange(exchName || "XETRA");
    let t = new Date(d.getTime());
    for (let i = 0; i < 30; i++) {
      t = addDaysLocal(t, 1, ex.tzOffsetMinutes);
      if (this.isTradingDay(t, ex.name)) return t;
    }
    return t;
  },
  normalizeTicker: function (raw: string): string {
    return normalizeTickerEU(raw);
  },
  mapSecurityToVenue: function (ticker: string): string {
    return venueFor(ticker);
  },
  isOnshore: function (_ticker: string): boolean {
    // Onshore concept is less relevant; treat all listed EU venues as onshore.
    return true;
  },
  lotSize: function (ticker: string): number {
    return defaultLotSize(ticker);
  },
};

export default EUROPE;
