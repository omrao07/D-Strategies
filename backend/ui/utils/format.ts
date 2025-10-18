// utils/format.ts
// Zero-dependency formatting helpers for numbers, currency, percent, dates, durations, bytes,
// casing, ordinals, signed values, compact/abbreviated values, and more.
// All functions are defensive: they handle null/undefined/NaN gracefully.

export type Nullable<T> = T | null | undefined;

/* ----------------------------- Number utilities ---------------------------- */

export function clamp(n: number, min: number, max: number): number {
  if (!isFinite(n)) return n;
  return Math.min(Math.max(n, min), max);
}

export function round(n: Nullable<number>, decimals = 0): number {
  const x = toNum(n);
  if (!isFinite(x)) return x;
  const f = Math.pow(10, decimals);
  return Math.round((x + Number.EPSILON) * f) / f;
}

export function toFixedTrim(n: Nullable<number>, decimals = 2): string {
  const x = toNum(n);
  if (!isFinite(x)) return String(x);
  const s = x.toFixed(decimals);
  // Trim trailing zeros and possible trailing dot
  return s.replace(/\.?0+$/, "");
}

export function withCommas(n: Nullable<number>, decimals?: number): string {
  const x = toNum(n);
  if (!isFinite(x)) return String(x);
  const opts: Intl.NumberFormatOptions = { maximumFractionDigits: decimals ?? 20 };
  if (typeof decimals === "number") opts.minimumFractionDigits = decimals;
  return new Intl.NumberFormat("en-US", opts).format(x);
}

/** Abbreviate large absolute values: 12.3K, 4.5M, 1.2B, 3.4T. */
export function abbreviate(n: Nullable<number>, decimals = 1): string {
  const x = toNum(n);
  if (!isFinite(x)) return String(x);
  const abs = Math.abs(x);
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (let i = 0; i < units.length; i++) {
    const [v, s] = units[i];
    if (abs >= v) return `${round(x / v, decimals).toFixed(decimals).replace(/\.0+$/, "")}${s}`;
  }
  return toFixedTrim(x, Math.max(0, decimals - 1));
}

/** Compact number using Intl (e.g., 12K, 3.4M). */
export function compactNumber(n: Nullable<number>, decimals = 1, locale = "en"): string {
  const x = toNum(n);
  if (!isFinite(x)) return String(x);
  try {
    return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: decimals }).format(x);
  } catch {
    return abbreviate(x, decimals);
  }
}

/** Signed wrapper: +1.23%, -5, +₹1.2K */
export function signed(s: string | number): string {
  if (typeof s === "string") {
    if (/^[+-]/.test(s)) return s;
    return (s.startsWith("0") || s.startsWith("NaN")) ? s : `+${s}`;
  }
  const x = toNum(s);
  if (!isFinite(x)) return String(x);
  if (x === 0) return "0";
  return x > 0 ? `+${x}` : String(x);
}

/** Basis points formatter from a decimal (0.0123 -> "123 bps") */
export function bps(n: Nullable<number>, decimals = 0): string {
  const x = toNum(n);
  if (!isFinite(x)) return String(x);
  const val = round(x * 10000, decimals).toFixed(decimals);
  return `${val.replace(/\.0+$/, "")} bps`;
}

/** Percent formatter from a decimal (0.123 -> "12.3%"). */
export function percent(n: Nullable<number>, decimals = 2, opts?: { signed?: boolean }): string {
  const x = toNum(n);
  if (!isFinite(x)) return String(x);
  const raw = (x * 100).toFixed(decimals).replace(/\.0+$/, (decimals ? "" : ""));
  const s = `${raw}${raw.includes(".") ? "" : (decimals ? "" : "")}%`;
  return opts?.signed ? (x === 0 ? "0%" : (x > 0 ? `+${s}` : s)) : s;
}

/* -------------------------------- Currency -------------------------------- */

export interface CurrencyOptions {
  currency?: string;               // e.g. "INR", "USD"
  locale?: string;                  // default "en-IN" for INR, else "en-US"
  minimumFractionDigits?: number;   // default per currency
  maximumFractionDigits?: number;   // default per currency
  compact?: boolean;                // use Intl compact notation where supported
  stripMinorIfInt?: boolean;        // show no decimals for whole numbers
}

export function currency(n: Nullable<number>, options?: CurrencyOptions): string {
  const x = toNum(n);
  if (!isFinite(x)) return String(x);

  const cur = options?.currency ?? "INR";
  const locale = options?.locale ?? (cur === "INR" ? "en-IN" : "en-US");

  const base: Intl.NumberFormatOptions = {
    style: "currency",
    currency: cur,
  };

  if (options?.compact) (base as any).notation = "compact";

  if (typeof options?.minimumFractionDigits === "number") base.minimumFractionDigits = options.minimumFractionDigits;
  if (typeof options?.maximumFractionDigits === "number") base.maximumFractionDigits = options.maximumFractionDigits;

  if (options?.stripMinorIfInt && Number.isInteger(x)) {
    base.minimumFractionDigits = 0;
    base.maximumFractionDigits = Math.min(base.maximumFractionDigits ?? 0, 0);
  }

  try {
    return new Intl.NumberFormat(locale, base).format(x);
  } catch {
    // Fallback: naive symbol map
    const sym = cur === "INR" ? "₹" : (cur === "USD" ? "$" : `${cur} `);
    return `${sym}${withCommas(x, base.maximumFractionDigits ?? 2)}`;
  }
}

/* --------------------------------- Ordinals -------------------------------- */

export function ordinal(n: Nullable<number>): string {
  const x = toNum(n);
  if (!isFinite(x)) return String(x);
  const v = Math.abs(x);
  const j = v % 10, k = v % 100;
  let suf = "th";
  if (k < 11 || k > 13) {
    if (j === 1) suf = "st";
    else if (j === 2) suf = "nd";
    else if (j === 3) suf = "rd";
  }
  return `${x}${suf}`;
}

/* ----------------------------------- Bytes --------------------------------- */

export function bytes(n: Nullable<number>, decimals = 1): string {
  const x = toNum(n);
  if (!isFinite(x)) return String(x);
  if (x === 0) return "0 B";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(Math.abs(x)) / Math.log(k));
  const val = round(x / Math.pow(k, i), decimals);
  return `${toFixedTrim(val, decimals)} ${units[i]}`;
}

/* --------------------------------- Duration -------------------------------- */

export interface DurationParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  milliseconds: number;
}

export function splitDuration(ms: Nullable<number>): DurationParts {
  const x = toNum(ms);
  if (!isFinite(x)) return { days: 0, hours: 0, minutes: 0, seconds: 0, milliseconds: 0 };
  let rem = Math.max(0, Math.floor(x));
  const days = Math.floor(rem / 86400000); rem -= days * 86400000;
  const hours = Math.floor(rem / 3600000); rem -= hours * 3600000;
  const minutes = Math.floor(rem / 60000); rem -= minutes * 60000;
  const seconds = Math.floor(rem / 1000); rem -= seconds * 1000;
  const milliseconds = rem;
  return { days, hours, minutes, seconds, milliseconds };
}

export function durationHMS(ms: Nullable<number>, opts?: { showMs?: boolean; padHours?: boolean }): string {
  const { hours, minutes, seconds, milliseconds, days } = splitDuration(ms);
  const H = (opts?.padHours ? String(days * 24 + hours).padStart(2, "0") : String(days * 24 + hours));
  const M = String(minutes).padStart(2, "0");
  const S = String(seconds).padStart(2, "0");
  const base = `${H}:${M}:${S}`;
  return opts?.showMs ? `${base}.${String(milliseconds).padStart(3, "0")}` : base;
}

export function durationHuman(ms: Nullable<number>): string {
  const { days, hours, minutes, seconds } = splitDuration(ms);
  const parts: string[] = [];
  if (days) parts.push(plural(days, "day"));
  if (hours) parts.push(plural(hours, "hour"));
  if (minutes) parts.push(plural(minutes, "minute"));
  if (!parts.length) parts.push(plural(seconds, "second"));
  return parts.join(" ");
}

/* ----------------------------------- Dates --------------------------------- */

export interface DateFormatOptions {
  locale?: string;                     // default "en-IN" (user is in India)
  dateStyle?: "full" | "long" | "medium" | "short";
  timeStyle?: "full" | "long" | "medium" | "short";
  timeZone?: string;                   // default system
}

export function dateShort(d: Nullable<Date | number | string>, opts?: DateFormatOptions): string {
  const dt = toDate(d);
  if (!dt) return String(d ?? "");
  try {
    return new Intl.DateTimeFormat(opts?.locale ?? "en-IN", {
      dateStyle: opts?.dateStyle ?? "medium",
      timeZone: opts?.timeZone,
    }).format(dt);
  } catch {
    return dt.toISOString().slice(0, 10);
  }
}

export function timeShort(d: Nullable<Date | number | string>, opts?: DateFormatOptions): string {
  const dt = toDate(d);
  if (!dt) return String(d ?? "");
  try {
    return new Intl.DateTimeFormat(opts?.locale ?? "en-IN", {
      timeStyle: opts?.timeStyle ?? "short",
      timeZone: opts?.timeZone,
    }).format(dt);
  } catch {
    return dt.toTimeString().slice(0, 5);
  }
}

export function dateTime(d: Nullable<Date | number | string>, opts?: DateFormatOptions): string {
  const dt = toDate(d);
  if (!dt) return String(d ?? "");
  try {
    return new Intl.DateTimeFormat(opts?.locale ?? "en-IN", {
      dateStyle: opts?.dateStyle ?? "medium",
      timeStyle: opts?.timeStyle ?? "short",
      timeZone: opts?.timeZone,
    }).format(dt);
  } catch {
    return `${dt.toISOString().slice(0, 10)} ${dt.toTimeString().slice(0, 5)}`;
  }
}

export function dateISO(d: Nullable<Date | number | string>): string {
  const dt = toDate(d);
  return dt ? dt.toISOString() : String(d ?? "");
}

/* ---------------------------------- Casing --------------------------------- */

export function titleCase(s: Nullable<string>): string {
  const x = toStr(s);
  return x.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

export function snakeCase(s: Nullable<string>): string {
  const x = toStr(s);
  return x
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s\-]+/g, "_")
    .toLowerCase();
}

export function kebabCase(s: Nullable<string>): string {
  const x = toStr(s);
  return x
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

export function camelCase(s: Nullable<string>): string {
  const x = toStr(s);
  return x
    .toLowerCase()
    .replace(/[_\-\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
    .replace(/^(.)/, (m) => m.toLowerCase());
}

export function pascalCase(s: Nullable<string>): string {
  const c = camelCase(s);
  return c ? c[0].toUpperCase() + c.slice(1) : c;
}

/* ---------------------------------- Text ---------------------------------- */

export function plural(n: number, unit: string): string {
  return `${n} ${unit}${Math.abs(n) === 1 ? "" : "s"}`;
}

export function truncate(text: Nullable<string>, max = 60, ellipsis = "…"): string {
  const s = toStr(text);
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - ellipsis.length)) + ellipsis;
}

export function padLeft(s: string | number, width: number, fill = "0"): string {
  return String(s).padStart(width, fill);
}

export function padRight(s: string | number, width: number, fill = " "): string {
  return String(s).padEnd(width, fill);
}

/** Simple template interpolation: "Hello, {name}!" -> map { name: "Om" } */
export function interpolate(tpl: string, map: Record<string, any>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => String(map[k] ?? ""));
}

/* ------------------------------- Safe coercion ------------------------------ */

export function toNum(n: Nullable<number | string>): number {
  if (typeof n === "number") return n;
  if (typeof n === "string") {
    const x = Number(n.replace(/,/g, ""));
    return x;
  }
  return NaN;
}

export function toStr(s: Nullable<string | number>): string {
  if (s === null || s === undefined) return "";
  return String(s);
}

export function toDate(d: Nullable<Date | number | string>): Date | null {
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
  if (typeof d === "number") {
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? null : dt;
  }
  if (typeof d === "string") {
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}

/* ----------------------------- Misc composites ----------------------------- */

/** Format a delta with sign and commas, e.g., "+1,234" or "-987". */
export function delta(n: Nullable<number>, decimals = 0): string {
  const x = toNum(n);
  if (!isFinite(x)) return String(x);
  const base = withCommas(Math.abs(x), decimals);
  if (x === 0) return base;
  return x > 0 ? `+${base}` : `-${base}`;
}

/** Format a ratio as "a/b (xx.x%)" */
export function ratio(a: Nullable<number>, b: Nullable<number>, decimals = 1): string {
  const na = toNum(a), nb = toNum(b);
  if (!isFinite(na) || !isFinite(nb) || nb === 0) return `${a}/${b}`;
  const pct = percent(na / nb, decimals);
  return `${withCommas(na)} / ${withCommas(nb)} (${pct})`;
}
