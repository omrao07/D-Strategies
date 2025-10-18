// regions/india.ts
// Region configuration for India (IST +05:30). Pure TypeScript, no imports.
// Fixed offsets (no DST). Extend if you need more precise calendars.

export type HHMM = `${number}${number}:${number}${number}`;

export type ExchangeHours = {
  name: string;
  tzOffsetMinutes: number; // IST = +330
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
  region: "IN";
  displayName: "India";
  currencies: string[]; // ["INR"]
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

// ---------- Helpers (no imports) ----------

const IST = 330; // +05:30

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

// Gregorian Easter (for Good Friday approx)
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

// Core nationwide holiday anchors (approx; exchanges publish exact yearly lists)
function staticINHolidays(year: number): Holiday[] {
  const eas = easterMD(year);
  const easter = new Date(Date.UTC(year, eas.month - 1, eas.day));
  const goodFri = new Date(easter.getTime() - 2 * 24 * 3600 * 1000);

  return [
    { date: `${year}-01-26`, name: "Republic Day", exchanges: ["*"] },
    { date: ymdStr(goodFri.getUTCFullYear(), goodFri.getUTCMonth() + 1, goodFri.getUTCDate()), name: "Good Friday (approx)", exchanges: ["*"] },
    { date: `${year}-08-15`, name: "Independence Day", exchanges: ["*"] },
    { date: `${year}-10-02`, name: "Gandhi Jayanti", exchanges: ["*"] },
    // Festival anchors (vary by lunar calendar; set common anchors so systems can override per-year):
    { date: `${year}-03-10`, name: "Holi (anchor)", exchanges: ["*"] },
    { date: `${year}-11-01`, name: "Diwali/Laxmi Pujan (anchor)", exchanges: ["*"] },
    { date: `${year}-12-25`, name: "Christmas", exchanges: ["*"] },
  ];
}

function buildHolidayTable(startYear: number, years: number): Holiday[] {
  const out: Holiday[] = [];
  for (let y = 0; y < years; y++) out.push(...staticINHolidays(startYear + y));
  return out;
}

// ---------- Exchanges ----------

const NSE: ExchangeHours = {
  name: "NSE",
  tzOffsetMinutes: IST,
  sessions: [{ open: "09:15", close: "15:30" }],
  weekend: { sat: true, sun: true },
};

const BSE: ExchangeHours = {
  name: "BSE",
  tzOffsetMinutes: IST,
  sessions: [{ open: "09:15", close: "15:30" }],
  weekend: { sat: true, sun: true },
};

// MCX timings vary by product; we give a broad window.
const MCX: ExchangeHours = {
  name: "MCX",
  tzOffsetMinutes: IST,
  sessions: [
    { open: "09:00", close: "23:30" },
  ],
  weekend: { sat: true, sun: true },
};

const HOLIDAYS: Holiday[] = buildHolidayTable(2024, 6);

// ---------- Tickers, mapping & utils ----------

function normalizeTickerIN(raw: string): string {
  const x = (raw || "").trim().toUpperCase();
  // Common suffixes: .NS (NSE), .BO (BSE)
  if (/\.(NS|BO)$/.test(x)) return x;
  // Numeric BSE codes -> append .BO
  if (/^\d{4,6}$/.test(x)) return `${x}.BO`;
  // Plain alpha -> assume NSE
  if (/^[A-Z0-9]{1,10}$/.test(x)) return `${x}.NS`;
  return x;
}

function venueFor(ticker: string): string {
  const t = normalizeTickerIN(ticker);
  if (t.endsWith(".NS")) return "NSE";
  if (t.endsWith(".BO")) return "BSE";
  if (t.startsWith("MCX:")) return "MCX";
  return "NSE";
}

function defaultLotSize(ticker: string): number {
  const v = venueFor(ticker);
  if (v === "NSE" || v === "BSE") return 1; // equities: 1 share lot
  return 1; // contracts vary; default 1
}

function getExchange(name: string): ExchangeHours {
  if (name === "NSE") return NSE;
  if (name === "BSE") return BSE;
  if (name === "MCX") return MCX;
  return NSE;
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

const INDIA: RegionConfig = {
  region: "IN",
  displayName: "India",
  currencies: ["INR"],
  tzOffsetMinutes: IST,
  exchanges: [NSE, BSE, MCX],
  holidays: HOLIDAYS,
  symbols: {
    equityIndices: ["NIFTY50", "NIFTYBANK", "NIFTYFIN", "SENSEX", "NIFTY500"],
    govvies: ["IN10Y", "IN5Y", "IN2Y"],
    moneyMarket: ["MIBOR_O/N", "MIBOR_3M", "TREPS"],
    credit: ["CDS_INDIA_5Y", "NIFTYCP_INDEX"],
    fxPairs: ["USDINR", "EURINR", "GBPINR", "JPYINR"],
    commodities: ["MCX:GOLD", "MCX:SILVER", "MCX:CRUDEOIL", "MCX:NATURALGAS"],
    futures: ["NSE:NIFTY", "NSE:BANKNIFTY", "NSE:FINNIFTY", "NSE:USDINR"],
  },
  isTradingDay: function (d: Date, exchName?: string): boolean {
    const ex = getExchange(exchName || "NSE");
    if (isWeekendLocal(d, ex.tzOffsetMinutes, ex.weekend)) return false;
    if (isHolidayLocal(d, ex.name)) return false;
    return true;
  },
  isOpenNow: function (when?: Date, exchName?: string): boolean {
    const now = when || new Date();
    const ex = getExchange(exchName || "NSE");
    if (!this.isTradingDay(now, ex.name)) return false;
    return inSessionLocal(now, ex.sessions, ex.tzOffsetMinutes);
  },
  nextTradingDay: function (d: Date, exchName?: string): Date {
    const ex = getExchange(exchName || "NSE");
    let t = new Date(d.getTime());
    for (let i = 0; i < 30; i++) {
      t = addDaysLocal(t, 1, ex.tzOffsetMinutes);
      if (this.isTradingDay(t, ex.name)) return t;
    }
    return t;
  },
  normalizeTicker: function (raw: string): string {
    return normalizeTickerIN(raw);
  },
  mapSecurityToVenue: function (ticker: string): string {
    return venueFor(ticker);
  },
  isOnshore: function (_ticker: string): boolean {
    return true; // Indian listed instruments treated as onshore
  },
  lotSize: function (ticker: string): number {
    return defaultLotSize(ticker);
  },
};

export default INDIA;
