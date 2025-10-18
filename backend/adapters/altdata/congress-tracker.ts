// altdata/congress tracker.ts
// Pure TypeScript toolkit for tracking U.S. Congress trading disclosures.
// No imports. Self-contained & ready to plug into your data pipeline.

/** ===== Types ===== */

type TradeSide = "buy" | "sell" | "unknown"

type Party = "D" | "R" | "I" | "U" // Democrat, Republican, Independent, Unknown

type SecurityType =
  | "stock"
  | "etf"
  | "option"
  | "bond"
  | "crypto"
  | "mutual_fund"
  | "other"

type AmountRange =
  | "$1-$1,000"
  | "$1,001-$15,000"
  | "$15,001-$50,000"
  | "$50,001-$100,000"
  | "$100,001-$250,000"
  | "$250,001-$500,000"
  | "$500,001-$1,000,000"
  | "$1,000,001-$5,000,000"
  | "$5,000,001-$25,000,000"
  | "$25,000,001+"
  | "unknown"

/** Raw disclosure as might be parsed from a CSV/JSON feed (fields optional/inconsistent). */
type RawDisclosure = {
  member?: string
  chamber?: "House" | "Senate"
  party?: Party | string
  ticker?: string
  securityName?: string
  securityType?: SecurityType | string
  transactionDate?: string // e.g., "2025-09-18"
  filedDate?: string
  type?: string // "Purchase" | "Sale (Full)" | "Sale (Partial)" | "Exchange" | ...
  amount?: string // textual range
  comments?: string
  owner?: "self" | "spouse" | "child" | "joint" | string
  sourceId?: string // external id
}

/** Normalized trade record */
type CongressTrade = {
  id: string
  member: string
  chamber: "House" | "Senate" | "Unknown"
  party: Party
  ticker: string
  securityName: string
  securityType: SecurityType
  side: TradeSide
  transactionDate: string // ISO
  filedDate?: string // ISO
  amountRange: AmountRange
  estNotional: { min: number; max: number; mid: number } // USD
  owner: "self" | "spouse" | "child" | "joint" | "unknown"
  comments?: string
  sourceId?: string
}

/** Filters for querying */
type TradeFilter = {
  member?: string
  party?: Party
  chamber?: "House" | "Senate" | "Unknown"
  ticker?: string
  side?: TradeSide
  from?: string // ISO date inclusive
  to?: string // ISO date inclusive
}

/** Aggregated stats */
type TickerStats = {
  ticker: string
  trades: number
  buys: number
  sells: number
  net: number // buys - sells
  members: number
  notional: { min: number; max: number; mid: number }
  firstDate?: string
  lastDate?: string
}

type MemberStats = {
  member: string
  party: Party
  chamber: "House" | "Senate" | "Unknown"
  trades: number
  tickers: number
  net: number
  notional: { min: number; max: number; mid: number }
  firstDate?: string
  lastDate?: string
}

/** Unusual activity detection result */
type UnusualActivity = {
  key: string // ticker or member
  window: { start: string; end: string; days: number }
  trades: number
  distinctMembers: number
  buys: number
  sells: number
  net: number
  notionalMid: number
  zScore?: number
  note?: string
}

/** ===== In-memory store ===== */

class CongressTradeStore {
  private trades: CongressTrade[] = []

  clear(): void {
    this.trades = []
  }

  add(trade: CongressTrade | CongressTrade[]): void {
    if (Array.isArray(trade)) this.trades.push(...trade)
    else this.trades.push(trade)
  }

  size(): number {
    return this.trades.length
  }

  query(filter: TradeFilter = {}): CongressTrade[] {
    const fromTs = filter.from ? Date.parse(filter.from) : Number.NEGATIVE_INFINITY
    const toTs = filter.to ? Date.parse(filter.to) : Number.POSITIVE_INFINITY

    return this.trades.filter(t => {
      if (filter.member && t.member !== filter.member) return false
      if (filter.party && t.party !== filter.party) return false
      if (filter.chamber && t.chamber !== filter.chamber) return false
      if (filter.ticker && t.ticker !== filter.ticker) return false
      if (filter.side && t.side !== filter.side) return false
      const txTs = Date.parse(t.transactionDate)
      return txTs >= fromTs && txTs <= toTs
    })
  }

  /** Stats grouped by ticker */
  statsByTicker(filter: TradeFilter = {}): TickerStats[] {
    const rows = this.query(filter)
    const byTicker = new Map<string, CongressTrade[]>()
    for (const r of rows) {
      if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, [])
      byTicker.get(r.ticker)!.push(r)
    }
    const out: TickerStats[] = []
    for (const [ticker, list] of byTicker) {
      const buys = list.filter(x => x.side === "buy").length
      const sells = list.filter(x => x.side === "sell").length
      const members = new Set(list.map(x => x.member)).size
      const notional = sumNotional(list)
      const dates = list.map(x => Date.parse(x.transactionDate))
      out.push({
        ticker,
        trades: list.length,
        buys,
        sells,
        net: buys - sells,
        members,
        notional,
        firstDate: dates.length ? toISO(Math.min(...dates)) : undefined,
        lastDate: dates.length ? toISO(Math.max(...dates)) : undefined,
      })
    }
    // sort by trades desc then net desc
    out.sort((a, b) => (b.trades - a.trades) || (b.net - a.net))
    return out
  }

  /** Stats grouped by member */
  statsByMember(filter: TradeFilter = {}): MemberStats[] {
    const rows = this.query(filter)
    const byMember = new Map<string, CongressTrade[]>()
    for (const r of rows) {
      if (!byMember.has(r.member)) byMember.set(r.member, [])
      byMember.get(r.member)!.push(r)
    }
    const out: MemberStats[] = []
    for (const [member, list] of byMember) {
      const party = mode(list.map(x => x.party)) || "U"
      const chamber = mode(list.map(x => x.chamber)) || "Unknown"
      const net = list.filter(x => x.side === "buy").length - list.filter(x => x.side === "sell").length
      const notional = sumNotional(list)
      const tickers = new Set(list.map(x => x.ticker)).size
      const dates = list.map(x => Date.parse(x.transactionDate))
      out.push({
        member,
        party,
        chamber,
        trades: list.length,
        tickers,
        net,
        notional,
        firstDate: dates.length ? toISO(Math.min(...dates)) : undefined,
        lastDate: dates.length ? toISO(Math.max(...dates)) : undefined,
      })
    }
    out.sort((a, b) => b.trades - a.trades)
    return out
  }

  /** Unusual activity by ticker within rolling window. */
  detectUnusualByTicker(opts: {
    days?: number
    minTrades?: number
    minMembers?: number
    from?: string
    to?: string
  } = {}): UnusualActivity[] {
    const days = opts.days ?? 14
    const fromTs = opts.from ? Date.parse(opts.from) : Number.NEGATIVE_INFINITY
    const toTs = opts.to ? Date.parse(opts.to) : Number.POSITIVE_INFINITY
    const within = this.trades.filter(t => {
      const ts = Date.parse(t.transactionDate)
      return ts >= fromTs && ts <= toTs
    })
    const byTicker = groupBy(within, t => t.ticker)
    const result: UnusualActivity[] = []
    for (const [ticker, list] of byTicker) {
      if (list.length === 0) continue
      // Sliding window endpoints
      const times = list.map(t => Date.parse(t.transactionDate)).sort((a, b) => a - b)
      let i = 0
      for (let j = 0; j < times.length; j++) {
        while (times[j] - times[i] > days * 86400000) i++
        const windowTrades = list.filter(t => {
          const ts = Date.parse(t.transactionDate)
          return ts >= times[i] && ts <= times[j]
        })
        const buys = windowTrades.filter(x => x.side === "buy").length
        const sells = windowTrades.filter(x => x.side === "sell").length
        const members = new Set(windowTrades.map(x => x.member)).size
        const notionalMid = sumNotional(windowTrades).mid
        if (
          windowTrades.length >= (opts.minTrades ?? 3) &&
          members >= (opts.minMembers ?? 2)
        ) {
          result.push({
            key: ticker,
            window: {
              start: toISO(times[i]),
              end: toISO(times[j]),
              days: Math.max(1, Math.round((times[j] - times[i]) / 86400000)),
            },
            trades: windowTrades.length,
            distinctMembers: members,
            buys,
            sells,
            net: buys - sells,
            notionalMid,
            note: buys > sells ? "clustered buys" : sells > buys ? "clustered sells" : "heavy mixed flow",
          })
        }
      }
    }
    // Deduplicate near-identical windows by key + end
    const seen = new Set<string>()
    const dedup: UnusualActivity[] = []
    for (const r of result.sort((a, b) => Date.parse(b.window.end) - Date.parse(a.window.end))) {
      const sig = `${r.key}|${r.window.start}|${r.window.end}|${r.trades}`
      if (!seen.has(sig)) {
        seen.add(sig)
        dedup.push(r)
      }
    }
    return dedup
  }
}

/** ===== Normalization utilities ===== */

function normalizeDisclosure(d: RawDisclosure): CongressTrade {
  const member = (d.member || "Unknown").trim()
  const chamber = (d.chamber === "House" || d.chamber === "Senate") ? d.chamber : "Unknown"
  const party = normalizeParty(d.party)
  const ticker = (d.ticker || "UNKNOWN").trim().toUpperCase()
  const securityName = (d.securityName || ticker || "Unknown Security").trim()
  const securityType = normalizeSecurityType(d.securityType)
  const side = normalizeSide(d.type)
  const txISO = toISO(Date.parse(d.transactionDate || d.filedDate || new Date().toISOString()))
  const filedISO = d.filedDate ? toISO(Date.parse(d.filedDate)) : undefined
  const amt = normalizeAmountRange(d.amount)
  const est = estimateNotional(amt)
  const owner = normalizeOwner(d.owner)
  const id = [
    hash(member),
    hash(ticker),
    txISO.slice(0, 10),
    side[0] || "u",
    hash(d.sourceId || ""),
    hash(amt),
  ].join("-")

  return {
    id,
    member,
    chamber,
    party,
    ticker,
    securityName,
    securityType,
    side,
    transactionDate: txISO,
    filedDate: filedISO,
    amountRange: amt,
    estNotional: est,
    owner,
    comments: d.comments?.trim() || undefined,
    sourceId: d.sourceId,
  }
}

/** Bulk normalize with basic de-duplication on (member, ticker, date, side, amountRange). */
function normalizeMany(rows: RawDisclosure[]): CongressTrade[] {
  const out: CongressTrade[] = []
  const sigs = new Set<string>()
  for (const r of rows) {
    const t = normalizeDisclosure(r)
    const sig = `${t.member}|${t.ticker}|${t.transactionDate.slice(0,10)}|${t.side}|${t.amountRange}`
    if (!sigs.has(sig)) {
      sigs.add(sig)
      out.push(t)
    }
  }
  return out
}

/** ===== Risk / Heuristics ===== */

/** Flag potential issues: very late filings, large size, concentrated flow, derivatives. */
function riskFlags(trade: CongressTrade): string[] {
  const flags: string[] = []
  if (trade.filedDate) {
    const lagDays = Math.round((Date.parse(trade.filedDate) - Date.parse(trade.transactionDate)) / 86400000)
    if (lagDays > 30) flags.push(`late_filing_${lagDays}d`)
  }
  if (trade.estNotional.mid >= 1_000_000) flags.push("large_size_1m+")
  if (trade.securityType === "option") flags.push("derivative_option")
  if (trade.owner !== "self") flags.push(`owner_${trade.owner}`)
  return flags
}

/** Given a sequence of trades for a ticker, compute a simple "consensus intent": buy/sell/neutral */
function consensusIntent(trades: CongressTrade[]): "bullish" | "bearish" | "neutral" {
  const buys = trades.filter(t => t.side === "buy").length
  const sells = trades.filter(t => t.side === "sell").length
  if (buys > sells) return "bullish"
  if (sells > buys) return "bearish"
  return "neutral"
}

/** ===== PnL Estimation (optional) =====
 * Provide a map of prices by ISO date (close) to estimate naive PnL for each trade if held to `asOf`.
 */
type PriceSeries = { [isoDate: string]: number }

function estimatePnL(
  trade: CongressTrade,
  series: PriceSeries,
  asOfISO?: string
): number | undefined {
  const enterDate = trade.transactionDate.slice(0, 10)
  const pxEnter = series[enterDate]
  const asOf = asOfISO ? asOfISO.slice(0, 10) : nearestOrSame(series, new Date())
  const pxExit = series[asOf]
  if (pxEnter === undefined || pxExit === undefined) return undefined
  const q = Math.max(1, Math.round(trade.estNotional.mid / pxEnter))
  const dir = trade.side === "buy" ? +1 : trade.side === "sell" ? -1 : 0
  return dir * (pxExit - pxEnter) * q
}

/** ===== Helpers ===== */

function normalizeParty(p?: string): Party {
  const s = (p || "").trim().toUpperCase()
  if (s.startsWith("D")) return "D"
  if (s.startsWith("R")) return "R"
  if (s.startsWith("I")) return "I"
  return "U"
}

function normalizeSecurityType(t?: string): SecurityType {
  const s = (t || "").toLowerCase()
  if (s.includes("etf")) return "etf"
  if (s.includes("option")) return "option"
  if (s.includes("bond")) return "bond"
  if (s.includes("crypto")) return "crypto"
  if (s.includes("mutual")) return "mutual_fund"
  if (s.includes("stock") || s === "" || s === "equity") return "stock"
  return "other"
}

function normalizeOwner(o?: string): CongressTrade["owner"] {
  const s = (o || "").toLowerCase()
  if (s.includes("spouse")) return "spouse"
  if (s.includes("child")) return "child"
  if (s.includes("joint")) return "joint"
  if (s.includes("self") || s === "") return "self"
  return "unknown"
}

function normalizeSide(t?: string): TradeSide {
  const s = (t || "").toLowerCase()
  if (s.includes("purch")) return "buy"
  if (s.includes("buy")) return "buy"
  if (s.includes("sale") || s.includes("sell")) return "sell"
  return "unknown"
}

function toISO(ts: number): string {
  const d = new Date(isFinite(ts) ? ts : Date.now())
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString()
}

function estimateNotional(range: AmountRange): { min: number; max: number; mid: number } {
  const table: Record<AmountRange, [number, number]> = {
    "$1-$1,000": [1, 1_000],
    "$1,001-$15,000": [1_001, 15_000],
    "$15,001-$50,000": [15_001, 50_000],
    "$50,001-$100,000": [50_001, 100_000],
    "$100,001-$250,000": [100_001, 250_000],
    "$250,001-$500,000": [250_001, 500_000],
    "$500,001-$1,000,000": [500_001, 1_000_000],
    "$1,000,001-$5,000,000": [1_000_001, 5_000_000],
    "$5,000,001-$25,000,000": [5_000_001, 25_000_000],
    "$25,000,001+": [25_000_001, 100_000_000],
    "unknown": [0, 0],
  }
  const [min, max] = table[range] ?? [0, 0]
  return { min, max, mid: (min + max) / 2 }
}

function normalizeAmountRange(s?: string): AmountRange {
  if (!s) return "unknown"
  const t = s.replace(/\s/g, "")
  const known: AmountRange[] = [
    "$1-$1,000",
    "$1,001-$15,000",
    "$15,001-$50,000",
    "$50,001-$100,000",
    "$100,001-$250,000",
    "$250,001-$500,000",
    "$500,001-$1,000,000",
    "$1,000,001-$5,000,000",
    "$5,000,001-$25,000,000",
    "$25,000,001+",
  ]
  for (const k of known) {
    if (t.replace(/,/g, "") === k.replace(/[\s,]/g, "")) return k
  }
  // Loose parsing
  const mPlus = t.match(/\$?([\d,]+)\+$/)
  if (mPlus) {
    const n = parseInt(mPlus[1].replace(/,/g, ""), 10)
    if (!isNaN(n)) return "$25,000,001+"
  }
  const mRange = t.match(/\$?([\d,]+)-\$?([\d,]+)/)
  if (mRange) {
    const a = parseInt(mRange[1].replace(/,/g, ""), 10)
    const b = parseInt(mRange[2].replace(/,/g, ""), 10)
    const amt = `$${fmt(a)}-$${fmt(b)}`
    // return closest known bucket if exact not found
    const closest = known.find(k => k.replace(/,/g, "") === amt.replace(/,/g, ""))
    return (closest as AmountRange) || "unknown"
  }
  return "unknown"
}

function fmt(n: number): string {
  return n.toLocaleString("en-US")
}

function sumNotional(list: CongressTrade[]): { min: number; max: number; mid: number } {
  let min = 0, max = 0, mid = 0
  for (const t of list) {
    min += t.estNotional.min
    max += t.estNotional.max
    mid += t.estNotional.mid
  }
  return { min, max, mid }
}

function groupBy<T>(arr: T[], keyFn: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const x of arr) {
    const k = keyFn(x)
    if (!m.has(k)) m.set(k, [])
    m.get(k)!.push(x)
  }
  return m
}

function mode<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined
  const m = new Map<string, { v: T; c: number }>()
  for (const v of arr) {
    const k = String(v)
    const cur = m.get(k)
    if (cur) cur.c++
    else m.set(k, { v, c: 1 })
  }
  let best: { v: T; c: number } | undefined
  for (const x of m.values()) {
    if (!best || x.c > best.c) best = x
  }
  return best?.v
}

function nearestOrSame(series: PriceSeries, date: Date): string {
  const keys = Object.keys(series).sort()
  const target = toISO(date.getTime()).slice(0, 10)
  // exact
  if (series[target] !== undefined) return target
  // find nearest past
  let candidate: string | undefined
  for (const k of keys) {
    if (k <= target) candidate = k
    else break
  }
  return candidate || keys[0]
}

function hash(s: string): string {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/** ===== Example glue / API surface ===== */

const CongressTracker = {
  store: new CongressTradeStore(),

  /** Ingest many raw rows, normalize, and add to store. Returns count added. */
  ingest(rows: RawDisclosure[]): number {
    const norm = normalizeMany(rows)
    this.store.add(norm)
    return norm.length
  },

  /** Query helper */
  query(filter: TradeFilter = {}): CongressTrade[] {
    return this.store.query(filter)
  },

  /** Diagnostics & reporting */
  statsByTicker(filter: TradeFilter = {}): TickerStats[] {
    return this.store.statsByTicker(filter)
  },

  statsByMember(filter: TradeFilter = {}): MemberStats[] {
    return this.store.statsByMember(filter)
  },

  unusualByTicker(opts?: { days?: number; minTrades?: number; minMembers?: number; from?: string; to?: string }): UnusualActivity[] {
    return this.store.detectUnusualByTicker(opts)
  },

  riskFlags,
  consensusIntent,
  estimatePnL,
  normalizeDisclosure,
  normalizeMany,
}

export {
  // Core types
  TradeSide,
  Party,
  SecurityType,
  AmountRange,
  RawDisclosure,
  CongressTrade,
  TradeFilter,
  TickerStats,
  MemberStats,
  UnusualActivity,
  PriceSeries,
  // Store and API
  CongressTradeStore,
  CongressTracker,
  // Utils
  normalizeDisclosure,
  normalizeMany,
  riskFlags,
  consensusIntent,
  estimatePnL,
}
// pipelines/single.ts
// Pure TypeScript single-run pipeline executor with CLI args parsing, equity curve handling, and dynamic strategy loading.

