/*
|--------------------------------------------------------------------------
| Time Utilities
|--------------------------------------------------------------------------
| Centralized helpers for timestamps, ranges & intervals
|--------------------------------------------------------------------------
*/

/* ---------------- Timestamps ---------------- */

export function nowISO(): string {
  return new Date().toISOString()
}

export function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

/* ---------------- Date Ranges ---------------- */

export function daysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

export function hoursAgo(hours: number): string {
  const d = new Date()
  d.setHours(d.getHours() - hours)
  return d.toISOString()
}

export function minutesAgo(minutes: number): string {
  const d = new Date()
  d.setMinutes(d.getMinutes() - minutes)
  return d.toISOString()
}

/* ---------------- Unix Ranges ---------------- */

export function unixDaysAgo(days: number): number {
  return unixNow() - days * 24 * 60 * 60
}

export function unixHoursAgo(hours: number): number {
  return unixNow() - hours * 60 * 60
}

/* ---------------- Market Intervals ---------------- */

export function intervalToSeconds(
  interval:
    | "1m"
    | "5m"
    | "15m"
    | "30m"
    | "1h"
    | "4h"
    | "1d"
): number {
  switch (interval) {
    case "1m":
      return 60
    case "5m":
      return 300
    case "15m":
      return 900
    case "30m":
      return 1800
    case "1h":
      return 3600
    case "4h":
      return 14400
    case "1d":
      return 86400
    default:
      return 60
  }
}

/* ---------------- Formatting ---------------- */

export function formatDate(
  date: Date | string
): string {
  return new Date(date).toISOString()
}