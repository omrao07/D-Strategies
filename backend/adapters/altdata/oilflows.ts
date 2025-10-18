// altdata/oilflows.ts
// Self-contained TypeScript toolkit for normalizing and analyzing crude/product oil flows (no imports).

/** ===== Types ===== */

type JSONValue = string | number | boolean | null | JSONValue[] | { [k: string]: JSONValue }

type Method = "seaborne" | "pipeline" | "rail" | "truck" | "unknown"
type Product = "crude" | "condensate" | "fuel_oil" | "gasoil_diesel" | "gasoline" | "jet" | "lng" | "lpg" | "other"
type Side = "load" | "discharge"

type RawShipment = {
  // Often messy fields from AIS/port agents/lineups/customs
  shipmentId?: string
  method?: string
  product?: string
  grade?: string
  tonnes?: number | string
  barrels?: number | string
  density?: number | string // kg/m3 at 15C if known
  vesselName?: string
  imo?: string | number
  mmsi?: string | number
  flag?: string
  owner?: string
  operator?: string
  yearBuilt?: number | string

  loadPort?: string
  loadCountry?: string
  loadLat?: number | string
  loadLon?: number | string
  loadTime?: string // ISO-ish
  loadTerminal?: string

  dischargePort?: string
  dischargeCountry?: string
  dischargeLat?: number | string
  dischargeLon?: number | string
  dischargeTime?: string
  dischargeTerminal?: string

  // AIS-derived telemetry
  avgSpeedKts?: number | string
  maxSpeedKts?: number | string
  draughtStartM?: number | string
  draughtEndM?: number | string
  stsEvents?: number | string // ship-to-ship count during voyage
  darkActivityHours?: number | string // AIS gaps near hot zones
  loiterEvents?: number | string
  flagChangeCount?: number | string
  ownershipChangeCount?: number | string

  source?: "ais" | "port" | "customs" | "broker" | "other"
  note?: string
}

type Shipment = {
  id: string
  method: Method
  product: Product
  grade?: string
  barrels: number
  tonnes?: number
  density?: number // kg/m3

  vesselName?: string
  imo?: string
  mmsi?: string
  flag?: string
  owner?: string
  operator?: string
  yearBuilt?: number

  load: {
    port?: string
    country?: string
    lat?: number
    lon?: number
    time?: string
    terminal?: string
  }
  discharge: {
    port?: string
    country?: string
    lat?: number
    lon?: number
    time?: string
    terminal?: string
  }

  telemetry: {
    avgSpeedKts?: number
    maxSpeedKts?: number
    draughtStartM?: number
    draughtEndM?: number
    stsEvents?: number
    darkActivityHours?: number
    loiterEvents?: number
    flagChangeCount?: number
    ownershipChangeCount?: number
  }

  routeKey: string // originCountry->destCountry (or port->port if both known)
  daysTransit?: number
  source?: RawShipment["source"]
  note?: string

  // heuristics
  riskFlags: string[]
}

type FlowFilter = {
  from?: string // ISO date (inclusive), compared to discharge.time if present else load.time
  to?: string   // ISO date (inclusive)
  method?: Method
  product?: Product
  originCountry?: string
  destCountry?: string
  originPort?: string
  destPort?: string
}

type DailyFlow = {
  date: string
  barrels: number
  shipments: number
}

type RouteFlow = {
  routeKey: string
  originCountry?: string
  destCountry?: string
  originPort?: string
  destPort?: string
  barrels: number
  shipments: number
  avgShipmentKb: number
  first?: string
  last?: string
}

type Anomaly = {
  key: string // date|route|origin/dest
  window: { start: string; end: string; days: number }
  actual: number
  baseline: number
  zScore?: number
  note?: string
}

/** ===== Store ===== */

class OilFlowStore {
  private rows: Shipment[] = []

  add(s: Shipment | Shipment[]): void {
    if (Array.isArray(s)) this.rows.push(...s)
    else this.rows.push(s)
  }
  clear(): void { this.rows = [] }
  size(): number { return this.rows.length }

  query(f: FlowFilter = {}): Shipment[] {
    const fromTs = f.from ? Date.parse(f.from) : Number.NEGATIVE_INFINITY
    const toTs = f.to ? Date.parse(f.to) : Number.POSITIVE_INFINITY
    return this.rows.filter(r => {
      if (f.method && r.method !== f.method) return false
      if (f.product && r.product !== f.product) return false
      if (f.originCountry && (r.load.country || "").toUpperCase() !== f.originCountry.toUpperCase()) return false
      if (f.destCountry && (r.discharge.country || "").toUpperCase() !== f.destCountry.toUpperCase()) return false
      if (f.originPort && (r.load.port || "").toUpperCase() !== f.originPort.toUpperCase()) return false
      if (f.destPort && (r.discharge.port || "").toUpperCase() !== f.destPort.toUpperCase()) return false

      const dateISO = r.discharge.time || r.load.time
      if (!dateISO) return false
      const ts = Date.parse(dateISO)
      return ts >= fromTs && ts <= toTs
    })
  }

  /** Daily totals (by discharge date if available else load date). */
  dailyTotals(f: FlowFilter = {}): DailyFlow[] {
    const rows = this.query(f)
    const map = new Map<string, { barrels: number; shipments: number }>()
    for (const r of rows) {
      const d = day((r.discharge.time || r.load.time)!)
      const cur = map.get(d) || { barrels: 0, shipments: 0 }
      cur.barrels += r.barrels
      cur.shipments += 1
      map.set(d, cur)
    }
    const out: DailyFlow[] = []
    for (const [date, v] of map) out.push({ date, barrels: v.barrels, shipments: v.shipments })
    out.sort((a, b) => a.date.localeCompare(b.date))
    return out
  }

  /** Route totals (country->country, port->port if both known). */
  routeTotals(f: FlowFilter = {}): RouteFlow[] {
    const rows = this.query(f)
    const map = new Map<string, { barrels: number; shipments: number; oc?: string; dc?: string; op?: string; dp?: string; first?: string; last?: string }>()
    for (const r of rows) {
      const k = r.routeKey
      const cur = map.get(k) || { barrels: 0, shipments: 0 }
      cur.barrels += r.barrels
      cur.shipments += 1
      cur.oc = r.load.country
      cur.dc = r.discharge.country
      cur.op = r.load.port
      cur.dp = r.discharge.port
      const d = day((r.discharge.time || r.load.time)!)
      cur.first = !cur.first || d < cur.first ? d : cur.first
      cur.last = !cur.last || d > cur.last ? d : cur.last
      map.set(k, cur)
    }
    const out: RouteFlow[] = []
    for (const [routeKey, v] of map) {
      out.push({
        routeKey,
        originCountry: v.oc,
        destCountry: v.dc,
        originPort: v.op,
        destPort: v.dp,
        barrels: v.barrels,
        shipments: v.shipments,
        avgShipmentKb: v.shipments ? v.barrels / v.shipments / 1_000 : 0,
        first: v.first,
        last: v.last,
      })
    }
    out.sort((a, b) => b.barrels - a.barrels)
    return out
  }

  /** Simple moving average (SMA) of daily flows. */
  smaDaily(f: FlowFilter = {}, windowDays = 7): DailyFlow[] {
    const d = this.dailyTotals(f)
    return rollingSMA(d, windowDays)
  }

  /** Detect anomalies on daily totals vs SMA baseline. */
  anomaliesDaily(f: FlowFilter = {}, windowDays = 14, zCut = 2): Anomaly[] {
    const d = this.dailyTotals(f)
    if (d.length === 0) return []
    const xs = d.map(x => x.barrels)
    const mu = mean(xs)
    const sd = stddev(xs)
    const out: Anomaly[] = []
    for (const row of d) {
      const z = sd > 0 ? (row.barrels - mu) / sd : 0
      if (Math.abs(z) >= zCut) {
        out.push({
          key: row.date,
          window: { start: d[0].date, end: d[d.length - 1].date, days: d.length },
          actual: row.barrels,
          baseline: mu,
          zScore: z,
          note: z > 0 ? "spike in barrels" : "drop in barrels",
        })
      }
    }
    return out
  }

  /** Risk flag distribution for current filtered set. */
  riskSummary(f: FlowFilter = {}): Record<string, number> {
    const rows = this.query(f)
    const cnt: Record<string, number> = {}
    for (const r of rows) {
      for (const flag of r.riskFlags) {
        cnt[flag] = (cnt[flag] || 0) + 1
      }
    }
    return cnt
  }
}

/** ===== Normalization ===== */

function normalize(raw: RawShipment): Shipment {
  const method = normMethod(raw.method)
  const product = normProduct(raw.product)
  const density = numOrUndefined(raw.density)
  const tonnes = numOrUndefined(raw.tonnes)
  let barrels = numOrUndefined(raw.barrels)

  if (!barrels && tonnes) barrels = tonnesToBarrels(tonnes, density)
  if (!barrels) barrels = 0

  const load = {
    port: cleanStr(raw.loadPort),
    country: cleanStr(raw.loadCountry),
    lat: numOrUndefined(raw.loadLat),
    lon: numOrUndefined(raw.loadLon),
    time: toISOorUndefined(raw.loadTime),
    terminal: cleanStr(raw.loadTerminal),
  }
  const discharge = {
    port: cleanStr(raw.dischargePort),
    country: cleanStr(raw.dischargeCountry),
    lat: numOrUndefined(raw.dischargeLat),
    lon: numOrUndefined(raw.dischargeLon),
    time: toISOorUndefined(raw.dischargeTime),
    terminal: cleanStr(raw.dischargeTerminal),
  }

  const routeKey = makeRouteKey(load, discharge)

  const telemetry = {
    avgSpeedKts: numOrUndefined(raw.avgSpeedKts),
    maxSpeedKts: numOrUndefined(raw.maxSpeedKts),
    draughtStartM: numOrUndefined(raw.draughtStartM),
    draughtEndM: numOrUndefined(raw.draughtEndM),
    stsEvents: intOrUndefined(raw.stsEvents),
    darkActivityHours: numOrUndefined(raw.darkActivityHours),
    loiterEvents: intOrUndefined(raw.loiterEvents),
    flagChangeCount: intOrUndefined(raw.flagChangeCount),
    ownershipChangeCount: intOrUndefined(raw.ownershipChangeCount),
  }

  const id =
    (raw.shipmentId && String(raw.shipmentId)) ||
    hash(
      [
        method,
        product,
        cleanStr(raw.vesselName) || "",
        String(raw.imo || ""),
        String(raw.mmsi || ""),
        load.country || "",
        discharge.country || "",
        (discharge.time || load.time || ""),
        String(Math.round(barrels || 0)),
      ].join("|")
    )

  const daysTransit = computeTransitDays(load.time, discharge.time)

  const s: Shipment = {
    id,
    method,
    product,
    grade: cleanStr(raw.grade),
    barrels,
    tonnes: tonnes || (density ? barrelsToTonnes(barrels, density) : undefined),
    density,
    vesselName: cleanStr(raw.vesselName),
    imo: raw.imo ? String(raw.imo) : undefined,
    mmsi: raw.mmsi ? String(raw.mmsi) : undefined,
    flag: cleanStr(raw.flag),
    owner: cleanStr(raw.owner),
    operator: cleanStr(raw.operator),
    yearBuilt: intOrUndefined(raw.yearBuilt),
    load,
    discharge,
    telemetry,
    routeKey,
    daysTransit,
    source: raw.source,
    note: raw.note,
    riskFlags: [], // filled below
  }

  s.riskFlags = riskFlags(s)
  return s
}

function normalizeMany(rows: RawShipment[]): Shipment[] {
  const out: Shipment[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const n = normalize(r)
    const sig = `${n.routeKey}|${day(n.discharge.time || n.load.time || new Date().toISOString())}|${n.vesselName || n.imo || "?"}|${Math.round(n.barrels / 1_000)}`
    if (!seen.has(sig)) {
      seen.add(sig)
      out.push(n)
    }
  }
  return out
}

/** ===== Heuristics / Risk ===== */

function riskFlags(s: Shipment): string[] {
  const flags: string[] = []
  const t = s.telemetry

  // Dark activity / STS patterns
  if ((t.darkActivityHours || 0) >= 48) flags.push("dark_48h_plus")
  else if ((t.darkActivityHours || 0) >= 24) flags.push("dark_24h_plus")
  if ((t.stsEvents || 0) >= 2) flags.push("repeated_sts")
  else if ((t.stsEvents || 0) === 1) flags.push("sts_once")

  // Draught swing suggests cargo ops at sea
  const swing = draughtSwing(s)
  if (swing >= 4) flags.push("draught_swing_4m_plus")
  else if (swing >= 2) flags.push("draught_swing_2m_plus")

  // Frequent flag/ownership changes
  if ((t.flagChangeCount || 0) >= 2) flags.push("frequent_flag_change")
  if ((t.ownershipChangeCount || 0) >= 1) flags.push("ownership_change_recent")

  // Vintage / substandard risk
  if ((s.yearBuilt || 0) > 0 && s.yearBuilt! <= yearUTC() - 20) flags.push("vintage_20y_plus")

  // Price-cap evasion heuristic (route to cap-enforcing destination with dark+sts)
  if (
    hasCapDestination(s.discharge.country) &&
    ((t.darkActivityHours || 0) >= 24 || (t.stsEvents || 0) >= 1)
  ) {
    flags.push("pricecap_evasion_risk")
  }

  // Route-based: sanctioned-origin to distant hub
  if (isSanctionHotOrigin(s.load.country) && isBlendingHub(s.discharge.country)) {
    flags.push("sanction_risk_blend_route")
  }

  // Extremely large single move
  if (s.barrels >= 2_000_000) flags.push("vlcc_2mbbl_plus")

  return flags
}

function draughtSwing(s: Shipment): number {
  const a = s.telemetry.draughtStartM || 0
  const b = s.telemetry.draughtEndM || 0
  return Math.abs(b - a)
}

/** ===== Public API ===== */

const OilFlows = {
  store: new OilFlowStore(),

  ingest(rows: RawShipment[]): number {
    const norm = normalizeMany(rows)
    this.store.add(norm)
    return norm.length
  },

  query(filter: FlowFilter = {}): Shipment[] {
    return this.store.query(filter)
  },

  dailyTotals(filter: FlowFilter = {}): DailyFlow[] {
    return this.store.dailyTotals(filter)
  },

  routeTotals(filter: FlowFilter = {}): RouteFlow[] {
    return this.store.routeTotals(filter)
  },

  smaDaily(filter: FlowFilter = {}, windowDays = 7): DailyFlow[] {
    return this.store.smaDaily(filter, windowDays)
  },

  anomaliesDaily(filter: FlowFilter = {}, windowDays = 14, zCut = 2): Anomaly[] {
    return this.store.anomaliesDaily(filter, windowDays, zCut)
  },

  riskSummary(filter: FlowFilter = {}): Record<string, number> {
    return this.store.riskSummary(filter)
  },

  // Helpers
  normalize,
  normalizeMany,
  tonnesToBarrels,
  barrelsToTonnes,
}

/** ===== Utilities ===== */

function normMethod(x?: string): Method {
  const s = (x || "").toLowerCase()
  if (s.includes("sea") || s.includes("vessel") || s.includes("ship")) return "seaborne"
  if (s.includes("pipe")) return "pipeline"
  if (s.includes("rail")) return "rail"
  if (s.includes("truck") || s.includes("road")) return "truck"
  return "unknown"
}

function normProduct(x?: string): Product {
  const s = (x || "").toLowerCase()
  if (s.includes("crude")) return "crude"
  if (s.includes("cond")) return "condensate"
  if (s.includes("fuel") && s.includes("oil")) return "fuel_oil"
  if (s.includes("diesel") || s.includes("gasoil")) return "gasoil_diesel"
  if (s.includes("gasoline") || s.includes("mogas")) return "gasoline"
  if (s.includes("jet")) return "jet"
  if (s.includes("lng")) return "lng"
  if (s.includes("lpg")) return "lpg"
  return "other"
}

function cleanStr(v?: string): string | undefined {
  if (!v) return undefined
  const t = v.trim()
  return t.length ? t : undefined
}

function toISOorUndefined(s?: string): string | undefined {
  if (!s) return undefined
  const ts = Date.parse(s)
  if (!isFinite(ts)) return undefined
  // clamp to date-time with seconds
  return new Date(ts).toISOString()
}

function day(iso: string): string {
  const d = new Date(iso)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10)
}

function numOrUndefined(x: unknown): number | undefined {
  if (x === null || x === undefined) return undefined
  const n = typeof x === "number" ? x : parseFloat(String(x).replace(/,/g, ""))
  return isFinite(n) ? n : undefined
}

function intOrUndefined(x: unknown): number | undefined {
  if (x === null || x === undefined) return undefined
  const n = typeof x === "number" ? x : parseInt(String(x).replace(/,/g, ""), 10)
  return isFinite(n) ? n : undefined
}

function computeTransitDays(loadISO?: string, dischargeISO?: string): number | undefined {
  if (!loadISO || !dischargeISO) return undefined
  const a = Date.parse(loadISO)
  const b = Date.parse(dischargeISO)
  if (!isFinite(a) || !isFinite(b)) return undefined
  return Math.max(0, Math.round((b - a) / 86400000))
}

function hash(s: string): string {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

function yearUTC(): number {
  return new Date().getUTCFullYear()
}

/** Unit conversion:
 * If density unknown, use generic conversion 7.33 bbl/tonne for crude as approximation.
 * barrels = tonnes * (1000 / density) * 6.28981, but density kg/m3 -> specific gravity.
 */
function tonnesToBarrels(tonnes: number, density?: number, fallbackBblPerT = 7.33): number {
  if (density && density > 0) {
    const m3 = tonnes * (1000 / density) // m3
    return m3 * 6.28981
  }
  return tonnes * fallbackBblPerT
}

function barrelsToTonnes(barrels: number, density: number, fallbackTPerBbl = 1 / 7.33): number {
  if (density && density > 0) {
    const m3 = barrels / 6.28981
    return (m3 * density) / 1000
  }
  return barrels * fallbackTPerBbl
}

/** Moving average over {date, barrels} */
function rollingSMA(rows: DailyFlow[], windowDays: number): DailyFlow[] {
  if (rows.length === 0) return []
  const out: DailyFlow[] = []
  let acc = 0
  const q: number[] = []
  for (let i = 0; i < rows.length; i++) {
    acc += rows[i].barrels
    q.push(rows[i].barrels)
    if (q.length > windowDays) acc -= q.shift()!
    const avg = acc / Math.min(windowDays, q.length)
    out.push({ date: rows[i].date, barrels: avg, shipments: Math.round(avg / (rows[i].shipments ? rows[i].barrels / rows[i].shipments : 1)) || 0 })
  }
  return out
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

function stddev(xs: number[]): number {
  if (xs.length <= 1) return 0
  const m = mean(xs)
  let v = 0
  for (const x of xs) v += (x - m) * (x - m)
  return Math.sqrt(v / (xs.length - 1))
}

/** Destination subject to price cap enforcement (heuristic list—extend upstream). */
function hasCapDestination(dest?: string): boolean {
  const s = (dest || "").toUpperCase()
  const set = new Set(["USA", "UNITED STATES", "EU", "NETHERLANDS", "GERMANY", "ITALY", "FRANCE", "SPAIN", "UK", "UNITED KINGDOM", "GREECE", "PORTUGAL", "BELGIUM", "POLAND", "ROMANIA", "BULGARIA", "IRELAND", "LITHUANIA", "LATVIA", "ESTONIA"])
  return set.has(s)
}

function isSanctionHotOrigin(origin?: string): boolean {
  const s = (origin || "").toUpperCase()
  const set = new Set(["RUSSIA", "IRAN", "VENEZUELA"])
  return set.has(s)
}

function isBlendingHub(country?: string): boolean {
  const s = (country || "").toUpperCase()
  const set = new Set(["UAE", "UNITED ARAB EMIRATES", "MALAYSIA", "SINGAPORE", "TURKEY", "TÜRKIYE", "OMAN", "INDIA", "CHINA"])
  return set.has(s)
}

/** Route key builder: prefer port->port when both present, else country->country. */
function makeRouteKey(
  load: Shipment["load"],
  discharge: Shipment["discharge"]
): string {
  const lp = load.port?.toUpperCase()
  const dp = discharge.port?.toUpperCase()
  if (lp && dp) return `${lp}->${dp}`
  const lc = (load.country || "UNKNOWN").toUpperCase()
  const dc = (discharge.country || "UNKNOWN").toUpperCase()
  return `${lc}->${dc}`
}

/** ===== Example usage (kept minimal; remove or comment out in production) ===== */
// const added = OilFlows.ingest([
//   { method: "sea", product: "crude", vesselName: "VLCC EXAMPLE", loadCountry: "Russia", dischargeCountry: "UAE", loadTime: "2025-08-01", dischargeTime: "2025-08-20", barrels: 2000000, stsEvents: 1, darkActivityHours: 36 },
//   { method: "pipeline", product: "diesel", loadCountry: "Turkey", dischargeCountry: "Bulgaria", loadTime: "2025-08-05", dischargeTime: "2025-08-06", tonnes: 30_000 },
// ])
// console.log("Added", added, "shipments")
// console.log(OilFlows.routeTotals())
// console.log(OilFlows.anomaliesDaily({}, 7, 1.5))

export {
  // types
  RawShipment,
  Shipment,
  Method,
  Product,
  FlowFilter,
  DailyFlow,
  RouteFlow,
  Anomaly,
  // store/api
  OilFlowStore,
  OilFlows,
  // utils
  normalize,
  normalizeMany,
  riskFlags,
  tonnesToBarrels,
  barrelsToTonnes,
}
