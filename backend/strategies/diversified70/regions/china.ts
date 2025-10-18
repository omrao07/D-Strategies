// regions/china.ts
// Region configuration for Mainland China (+08:00). Pure TypeScript, no imports.

export type HHMM = `${number}${number}:${number}${number}`;

export type ExchangeHours = {
  name: string;
  tzOffsetMinutes: number; // +08:00 => 480
  // Mainland China has split sessions (morning + afternoon)
  sessions: { open: HHMM; close: HHMM }[];
  weekend: { sat: boolean; sun: boolean };
  // Optional early close in HH:MM local
  earlyClose?: HHMM[];
};

export type Holiday = {
  date: string; // YYYY-MM-DD local
  name: string;
  exchanges: string[]; // names this applies to. Use ["*"] for all
};

export type RegionConfig = {
  region: "CN";
  displayName: "China (Mainland)";
  currencies: string[]; // ["CNY","CNH"]
  tzOffsetMinutes: number;
  exchanges: ExchangeHours[];
  // Built-in holidays (weekends are handled separately).
  holidays: Holiday[];
  // Symbols & references commonly used across the stack.
  symbols: {
    equityIndices: string[];
    govvies: string[]; // government bonds & rates proxies
    moneyMarket: string[];
    credit: string[];
    fxPairs: string[];
    commodities: string[];
    futures: string[];
  };
  // Utilities
  isTradingDay: (d: Date, exchName?: string) => boolean;
  isOpenNow: (when?: Date, exchName?: string) => boolean;
  nextTradingDay: (d: Date, exchName?: string) => Date;
  normalizeTicker: (raw: string) => string;
  mapSecurityToVenue: (ticker: string) => string;
  isOnshore: (ticker: string) => boolean;
  lotSize: (ticker: string) => number;
};

// ---------- Helpers (no imports) ----------

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function ymd(d: Date, tzOffsetMin: number): { y: number; m: number; dd: number } {
  // Convert to local by offset minutes
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
  const wd = new Date(msLocal).getUTCDay(); // 0=Sun..6=Sat (localized by msLocal)
  if (wd === 6) return weekend.sat;
  if (wd === 0) return weekend.sun;
  return false;
}

// Mainland China movable Qingming approximation (Gregorian rule):
// From 2008 onwards: falls on April 4 if year mod 4 is 0, otherwise April 5.
// (Good enough for trading backtests where exact makeup days are handled by explicit calendars)
function qingmingApprox(year: number): string {
  const day = year % 4 === 0 ? 4 : 5;
  return `${year}-04-${pad(day)}`;
}

// Static National Day & Spring Festival ranges are complicated due to makeup days.
// We provide single anchor days (first official day). Users may extend via overrides.
function staticCNHolidays(year: number): Holiday[] {
  const list: Holiday[] = [
    { date: `${year}-01-01`, name: "New Year’s Day", exchanges: ["*"] },
    { date: qingmingApprox(year), name: "Qingming Festival", exchanges: ["*"] },
    { date: `${year}-05-01`, name: "Labor Day", exchanges: ["*"] },
    { date: `${year}-10-01`, name: "National Day (Golden Week start)", exchanges: ["*"] },
  ];
  // Mid-Autumn (approx; true date is lunar, we include a placeholder anchor = 9/21)
  list.push({ date: `${year}-09-21`, name: "Mid-Autumn (anchor)", exchanges: ["*"] });
  // Spring Festival anchor = year’s Lunar New Year is variable; use late Jan anchor 01-31.
  list.push({ date: `${year}-01-31`, name: "Spring Festival (anchor)", exchanges: ["*"] });
  return list;
}

function buildHolidayTable(startYear: number, years: number): Holiday[] {
  const out: Holiday[] = [];
  for (let y = 0; y < years; y++) {
    const yr = startYear + y;
    out.push(...staticCNHolidays(yr));
  }
  return out;
}

function addDaysLocal(d: Date, days: number, tzOffsetMin: number): Date {
  const msLocal = d.getTime() + tzOffsetMin * 60_000;
  const out = new Date(msLocal);
  out.setUTCDate(out.getUTCDate() + days);
  // Convert back to UTC reference
  return new Date(out.getTime() - tzOffsetMin * 60_000);
}

// ---------- Region Definition ----------

const TZ = 480; // +08:00

const SSE: ExchangeHours = {
  name: "SSE",
  tzOffsetMinutes: TZ,
  sessions: [
    { open: "09:30", close: "11:30" },
    { open: "13:00", close: "15:00" },
  ],
  weekend: { sat: true, sun: true },
};

const SZSE: ExchangeHours = {
  name: "SZSE",
  tzOffsetMinutes: TZ,
  sessions: [
    { open: "09:30", close: "11:30" },
    { open: "13:00", close: "15:00" },
  ],
  weekend: { sat: true, sun: true },
};

const CFFEX: ExchangeHours = {
  name: "CFFEX",
  tzOffsetMinutes: TZ,
  sessions: [
    { open: "09:30", close: "11:30" },
    { open: "13:00", close: "15:00" },
  ],
  weekend: { sat: true, sun: true },
};

const SHFE: ExchangeHours = {
  name: "SHFE",
  tzOffsetMinutes: TZ,
  sessions: [
    { open: "09:00", close: "10:15" },
    { open: "10:30", close: "11:30" },
    { open: "13:30", close: "15:00" },
  ],
  weekend: { sat: true, sun: true },
};

const HOLIDAYS: Holiday[] = buildHolidayTable(2024, 6);

// ---------- Venue mapping & utils ----------

function normalizeTickerCN(raw: string): string {
  const x = (raw || "").trim().toUpperCase();
  // Normalize common mainland suffix forms
  if (/^\d{6}\.SH$/.test(x) || /^\d{6}\.SZ$/.test(x)) return x;
  if (/^\d{6}$/.test(x)) {
    const code = x;
    // naive route: codes starting with 60/68 => SH, 00/30 => SZ
    if (code.startsWith("60") || code.startsWith("68")) return `${code}.SH`;
    if (code.startsWith("00") || code.startsWith("30")) return `${code}.SZ`;
  }
  return x;
}

function venueFor(ticker: string): string {
  const t = normalizeTickerCN(ticker);
  if (t.endsWith(".SH")) return "SSE";
  if (t.endsWith(".SZ")) return "SZSE";
  if (t.includes("IF") || t.includes("IC") || t.includes("IM")) return "CFFEX"; // index futures codes
  if (t.includes("CU") || t.includes("AU") || t.includes("AL") || t.includes("RB")) return "SHFE";
  // FX / rates defaults (OTC hours not enforced here)
  return "SSE";
}

function isOnshoreTicker(ticker: string): boolean {
  const t = normalizeTickerCN(ticker);
  if (t.endsWith(".SH") || t.endsWith(".SZ")) return true;
  if (t.includes("CNY")) return true;
  if (t.includes("CNH")) return false;
  return true;
}

function defaultLotSize(ticker: string): number {
  const t = normalizeTickerCN(ticker);
  if (t.endsWith(".SH") || t.endsWith(".SZ")) return 100; // A-shares board lot
  if (t.startsWith("IF") || t.startsWith("IC") || t.startsWith("IM")) return 1; // futures contracts
  return 1;
}

function getExchange(name: string): ExchangeHours {
  if (name === "SSE") return SSE;
  if (name === "SZSE") return SZSE;
  if (name === "CFFEX") return CFFEX;
  if (name === "SHFE") return SHFE;
  return SSE;
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

const CHINA: RegionConfig = {
  region: "CN",
  displayName: "China (Mainland)",
  currencies: ["CNY", "CNH"],
  tzOffsetMinutes: TZ,
  exchanges: [SSE, SZSE, CFFEX, SHFE],
  holidays: HOLIDAYS,
  symbols: {
    equityIndices: [
      "000001.SH", // SSE Composite
      "000016.SH", // SSE 50
      "000300.SH", // CSI 300
      "000905.SH", // CSI 500
      "399001.SZ", // SZSE Component
      "399006.SZ", // ChiNext
    ],
    govvies: [
      "CGB10Y", "CGB5Y", "CGB2Y", // China Government Bond yields
      "CNIRS7Y", "CNIRS5Y", "CNIRS2Y",
    ],
    moneyMarket: ["SHIBORON", "SHIBOR3M", "DR007", "R007"],
    credit: ["NCDAAA", "NCDAA", "NCDA", "CREDITA_INDEX", "CREDITBBB_INDEX"],
    fxPairs: ["USDCNH", "USDCNY", "CNHJPY", "CNHEUR", "CNHINR"],
    commodities: ["SHFE:CU", "SHFE:AU", "SHFE:AL", "SHFE:RB"],
    futures: ["CFFEX:IF", "CFFEX:IC", "CFFEX:IM"],
  },
  isTradingDay: function (d: Date, exchName?: string): boolean {
    const ex = getExchange(exchName || "SSE");
    if (isWeekendLocal(d, ex.tzOffsetMinutes, ex.weekend)) return false;
    if (isHolidayLocal(d, ex.name)) return false;
    return true;
    // Note: makeup trading Saturdays/Sundays are not modeled here; add to holidays to override.
  },
  isOpenNow: function (when?: Date, exchName?: string): boolean {
    const now = when || new Date();
    const ex = getExchange(exchName || "SSE");
    if (!this.isTradingDay(now, ex.name)) return false;
    return inSessionLocal(now, ex.sessions, ex.tzOffsetMinutes);
  },
  nextTradingDay: function (d: Date, exchName?: string): Date {
    const ex = getExchange(exchName || "SSE");
    let t = new Date(d.getTime());
    for (let i = 0; i < 30; i++) {
      t = addDaysLocal(t, 1, ex.tzOffsetMinutes);
      if (this.isTradingDay(t, ex.name)) return t;
    }
    return t; // fallback
  },
  normalizeTicker: function (raw: string): string {
    return normalizeTickerCN(raw);
  },
  mapSecurityToVenue: function (ticker: string): string {
    return venueFor(ticker);
  },
  isOnshore: function (ticker: string): boolean {
    return isOnshoreTicker(ticker);
  },
  lotSize: function (ticker: string): number {
    return defaultLotSize(ticker);
  },
};

export default CHINA;
