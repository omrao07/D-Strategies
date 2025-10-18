// regions/japan.ts
// Region configuration for Japan (JST +09:00). Pure TypeScript, no imports.
// Fixed offsets (no DST). Holiday rules are approximations; override per year for production.

export type HHMM = `${number}${number}:${number}${number}`;

export type ExchangeHours = {
  name: string;
  tzOffsetMinutes: number; // JST = +540
  sessions: { open: HHMM; close: HHMM }[]; // split sessions supported
  weekend: { sat: boolean; sun: boolean };
  earlyClose?: HHMM[];
};

export type Holiday = {
  date: string; // YYYY-MM-DD local
  name: string;
  exchanges: string[]; // ["*"] for all
};

export type RegionConfig = {
  region: "JP";
  displayName: "Japan";
  currencies: string[]; // ["JPY"]
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

const JST = 540; // +09:00

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

// Vernal/Autumnal Equinox approximations (valid-ish 2000–2099)
function vernalEquinoxJP(year: number): string {
  // Approx: March 20 most years; March 21 on some leap-related years.
  const day = year % 4 === 0 ? 20 : 20; // keep 20 as anchor; override per-year if needed
  return `${year}-03-${pad(day)}`;
}
function autumnalEquinoxJP(year: number): string {
  // Approx: Sept 23 most years.
  const day = 23;
  return `${year}-09-${pad(day)}`;
}

// nth weekday helper (e.g., 2nd Monday of January)
function nthWeekdayOfMonth(year: number, month1to12: number, weekday0Sun6Sat: number, n: number): string {
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const firstW = first.getUTCDay();
  const diff = (7 + weekday0Sun6Sat - firstW) % 7;
  const day = 1 + diff + (n - 1) * 7;
  return `${year}-${pad(month1to12)}-${pad(day)}`;
}

// ---------- Holidays (approx anchors) ----------

function staticJPHolidays(year: number): Holiday[] {
  return [
    { date: `${year}-01-01`, name: "New Year’s Day", exchanges: ["*"] },
    { date: nthWeekdayOfMonth(year, 1, 1, 2), name: "Coming of Age Day (2nd Mon Jan)", exchanges: ["*"] },
    { date: `${year}-02-11`, name: "National Foundation Day", exchanges: ["*"] },
    { date: `${year}-02-23`, name: "Emperor’s Birthday", exchanges: ["*"] },
    { date: vernalEquinoxJP(year), name: "Vernal Equinox (approx)", exchanges: ["*"] },
    { date: `${year}-04-29`, name: "Showa Day", exchanges: ["*"] },
    { date: `${year}-05-03`, name: "Constitution Memorial Day", exchanges: ["*"] },
    { date: `${year}-05-04`, name: "Greenery Day", exchanges: ["*"] },
    { date: `${year}-05-05`, name: "Children’s Day", exchanges: ["*"] },
    { date: nthWeekdayOfMonth(year, 7, 1, 3), name: "Marine Day (3rd Mon Jul)", exchanges: ["*"] },
    { date: `${year}-08-11`, name: "Mountain Day", exchanges: ["*"] },
    { date: nthWeekdayOfMonth(year, 9, 1, 3), name: "Respect for the Aged Day (3rd Mon Sep)", exchanges: ["*"] },
    { date: autumnalEquinoxJP(year), name: "Autumnal Equinox (approx)", exchanges: ["*"] },
    { date: nthWeekdayOfMonth(year, 10, 1, 2), name: "Sports Day (2nd Mon Oct)", exchanges: ["*"] },
    { date: `${year}-11-03`, name: "Culture Day", exchanges: ["*"] },
    { date: `${year}-11-23`, name: "Labor Thanksgiving Day", exchanges: ["*"] },
    // Year-end (exchanges typically close around Dec 31/Jan 1–3)
    { date: `${year}-12-31`, name: "Year-end Close (anchor)", exchanges: ["*"] },
  ];
}

function buildHolidayTable(startYear: number, years: number): Holiday[] {
  const out: Holiday[] = [];
  for (let y = 0; y < years; y++) out.push(...staticJPHolidays(startYear + y));
  return out;
}

const HOLIDAYS: Holiday[] = buildHolidayTable(2024, 6);

// ---------- Exchanges ----------

const TSE: ExchangeHours = {
  name: "TSE", // Tokyo Stock Exchange (cash equities)
  tzOffsetMinutes: JST,
  sessions: [
    { open: "09:00", close: "11:30" },
    { open: "12:30", close: "15:00" },
  ],
  weekend: { sat: true, sun: true },
};

const OSE: ExchangeHours = {
  name: "OSE", // Osaka Exchange (derivatives)
  tzOffsetMinutes: JST,
  sessions: [
    { open: "09:00", close: "15:15" }, // day session anchor (night session not modeled)
  ],
  weekend: { sat: true, sun: true },
};

const TOCOM: ExchangeHours = {
  name: "TOCOM", // JPX commodities (anchor)
  tzOffsetMinutes: JST,
  sessions: [
    { open: "08:45", close: "15:15" },
  ],
  weekend: { sat: true, sun: true },
};

// ---------- Tickers, mapping & utils ----------

function normalizeTickerJP(raw: string): string {
  const x = (raw || "").trim().toUpperCase();
  // Common suffixes: .T (TSE), .OS (Osaka legacy)
  if (/\.(T|OS)$/.test(x)) return x;
  // Numeric TSE codes (4 digits)
  if (/^\d{4}$/.test(x)) return `${x}.T`;
  return x;
}

function venueFor(ticker: string): string {
  const t = normalizeTickerJP(ticker);
  if (t.endsWith(".T")) return "TSE";
  if (t.endsWith(".OS")) return "OSE";
  if (t.startsWith("OSE:")) return "OSE";
  if (t.startsWith("TOCOM:")) return "TOCOM";
  return "TSE";
}

function defaultLotSize(ticker: string): number {
  const v = venueFor(ticker);
  if (v === "TSE") return 100; // many JP equities board lot 100 (some 1; use 100 as conservative default)
  return 1;
}

function getExchange(name: string): ExchangeHours {
  if (name === "TSE") return TSE;
  if (name === "OSE") return OSE;
  if (name === "TOCOM") return TOCOM;
  return TSE;
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

const JAPAN: RegionConfig = {
  region: "JP",
  displayName: "Japan",
  currencies: ["JPY"],
  tzOffsetMinutes: JST,
  exchanges: [TSE, OSE, TOCOM],
  holidays: HOLIDAYS,
  symbols: {
    equityIndices: ["NIKKEI225", "TOPIX", "JPXNK400"],
    govvies: ["JGB10Y", "JGB5Y", "JGB2Y"],
    moneyMarket: ["TONA_O/N", "TIBOR_JPY_3M"],
    credit: ["ITRAXX_JP_IG", "ITRAXX_JP_HY"],
    fxPairs: ["USDJPY", "EURJPY", "GBPJPY", "AUDJPY", "CNHJPY"],
    commodities: ["TOCOM:GOLD", "TOCOM:CRUDE"],
    futures: ["OSE:NK225", "OSE:NK225MINI", "OSE:TOPIX", "OSE:JGB"],
  },
  isTradingDay: function (d: Date, exchName?: string): boolean {
    const ex = getExchange(exchName || "TSE");
    if (isWeekendLocal(d, ex.tzOffsetMinutes, ex.weekend)) return false;
    if (isHolidayLocal(d, ex.name)) return false;
    return true;
  },
  isOpenNow: function (when?: Date, exchName?: string): boolean {
    const now = when || new Date();
    const ex = getExchange(exchName || "TSE");
    if (!this.isTradingDay(now, ex.name)) return false;
    return inSessionLocal(now, ex.sessions, ex.tzOffsetMinutes);
  },
  nextTradingDay: function (d: Date, exchName?: string): Date {
    const ex = getExchange(exchName || "TSE");
    let t = new Date(d.getTime());
    for (let i = 0; i < 30; i++) {
      t = addDaysLocal(t, 1, ex.tzOffsetMinutes);
      if (this.isTradingDay(t, ex.name)) return t;
    }
    return t;
  },
  normalizeTicker: function (raw: string): string {
    return normalizeTickerJP(raw);
  },
  mapSecurityToVenue: function (ticker: string): string {
    return venueFor(ticker);
  },
  isOnshore: function (_ticker: string): boolean {
    return true;
  },
  lotSize: function (ticker: string): number {
    return defaultLotSize(ticker);
  },
};

export default JAPAN;
