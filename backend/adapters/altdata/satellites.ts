// altdata/satellites.ts
// Self-contained TypeScript toolkit for normalizing, indexing, and analyzing satellite scene metadata.
// No imports. Pure TS utilities for AOI filtering, cloud screening, simple NDVI stats, and change flags.

/** ===================== Types ===================== **/

type JSONValue = string | number | boolean | null | JSONValue[] | { [k: string]: JSONValue }

type Provider = "SENTINEL" | "LANDSAT" | "PLANET" | "MAXAR" | "OTHER"
type Sensor =
  | "S2-MSI"   // Sentinel-2
  | "L8-OLI"   // Landsat-8
  | "L9-OLI"   // Landsat-9
  | "PLANET-SCOPE"
  | "WV3"
  | "OTHER"

type ProductType = "L1C" | "L2A" | "SR" | "TOA" | "ANALYTIC" | "PANSHARP" | "OTHER"

type BandName =
  | "blue" | "green" | "red" | "rededge" | "nir" | "nir2" | "swir1" | "swir2"
  | "pan" | "coastal" | "cirrus" | "alpha"

type CRS = "EPSG:4326" | "EPSG:3857" | string

/** Bounding box in EPSG:4326 (lon/lat) */
type BBox = { minLon: number; minLat: number; maxLon: number; maxLat: number }

/** Optional coarse stats per band for quick analytics (not per-pixel rasters). */
type BandStats = {
  mean?: number
  min?: number
  max?: number
  std?: number
  validPct?: number // 0..100
}

/** Raw provider scene as commonly found in STAC-like catalogs (incomplete / messy). */
type RawScene = {
  id?: string
  provider?: string
  sensor?: string
  productType?: string
  acquired?: string // ISO datetime
  bbox?: [number, number, number, number] | BBox
  footprintWKT?: string // POLYGON((...)) optional
  cloudCover?: number | string // 0..100
  sunAzimuth?: number | string
  sunElevation?: number | string
  offNadir?: number | string
  gsAltitudeKm?: number | string // ground sampling altitude hint
  gsDistanceM?: number | string // GSD in meters (if present)

  // Optional center coordinates if bbox missing
  centerLat?: number | string
  centerLon?: number | string

  // Band presence flags or hrefs if needed upstream
  bands?: Partial<Record<BandName, string | true>>
  bandStats?: Partial<Record<BandName, BandStats>>

  // QA fields
  tileId?: string
  crs?: CRS
  note?: string
  sourceId?: string
}

/** Normalized scene */
type Scene = {
  id: string
  provider: Provider
  sensor: Sensor
  productType: ProductType
  acquired: string // ISO
  date: string // YYYY-MM-DD
  bbox: BBox // EPSG:4326
  centroid: { lon: number; lat: number }
  cloudCover: number // 0..100
  sunAzimuth?: number
  sunElevation?: number
  offNadir?: number
  gsdM?: number
  crs: CRS
  tileXYZ?: { z: number; x: number; y: number } // WebMercator tile @ default Z for indexing
  bands: Partial<Record<BandName, boolean>>
  bandStats?: Partial<Record<BandName, BandStats>>
  quicklook?: string // optional URL if provided upstream
  note?: string
  sourceId?: string
}

/** Area of Interest */
type AOI =
  | { type: "bbox"; bbox: BBox }
  | { type: "point"; lon: number; lat: number; radiusM?: number }

/** Query filter */
type SceneFilter = {
  from?: string // ISO date/time (inclusive)
  to?: string   // ISO date/time (inclusive)
  maxCloud?: number // 0..100
  provider?: Provider
  sensor?: Sensor
  productType?: ProductType
  hasBands?: BandName[] // require all
  anyBand?: BandName[]  // require any
  aoi?: AOI
}

/** Aggregations */
type DailyCount = { date: string; scenes: number; medianCloud: number }
type ProviderShare = { provider: Provider; scenes: number; avgCloud: number }
type NDVIStat = { id: string; date: string; ndviMean?: number; ndviQuality?: number /*0..1*/ }

/** Change detection between two dates (coarse, metadata + NDVI stats only) */
type ChangeFlag = {
  key: string // location key (tile or centroid bin)
  dateA: string
  dateB: string
  ndviDelta?: number
  cloudNote?: string
}

/** ===================== Store ===================== **/

class SceneStore {
  private rows: Scene[] = []

  add(s: Scene | Scene[]): void {
    if (Array.isArray(s)) this.rows.push(...s)
    else this.rows.push(s)
  }
  clear(): void { this.rows = [] }
  size(): number { return this.rows.length }

  query(f: SceneFilter = {}): Scene[] {
    const fromTs = f.from ? Date.parse(f.from) : Number.NEGATIVE_INFINITY
    const toTs = f.to ? Date.parse(f.to) : Number.POSITIVE_INFINITY
    const needAll = f.hasBands?.length ? new Set(f.hasBands) : undefined
    const needAny = f.anyBand?.length ? new Set(f.anyBand) : undefined

    return this.rows.filter(s => {
      const ts = Date.parse(s.acquired)
      if (ts < fromTs || ts > toTs) return false
      if (typeof f.maxCloud === "number" && s.cloudCover > f.maxCloud) return false
      if (f.provider && s.provider !== f.provider) return false
      if (f.sensor && s.sensor !== f.sensor) return false
      if (f.productType && s.productType !== f.productType) return false
      if (needAll && !everyBand(needAll, s.bands)) return false
      if (needAny && !anyBand(needAny, s.bands)) return false
      if (f.aoi && !intersectsAOI(f.aoi, s.bbox, s.centroid)) return false
      return true
    })
  }

  /** Daily counts & cloud medians for the current filter */
  daily(f: SceneFilter = {}): DailyCount[] {
    const rows = this.query(f)
    const byDay = new Map<string, number[]>()
    for (const s of rows) {
      const list = byDay.get(s.date) || []
      list.push(s.cloudCover)
      byDay.set(s.date, list)
    }
    const out: DailyCount[] = []
    for (const [date, cc] of byDay) {
      out.push({ date, scenes: cc.length, medianCloud: median(cc) })
    }
    out.sort((a, b) => a.date.localeCompare(b.date))
    return out
  }

  /** Provider share table */
  providerShare(f: SceneFilter = {}): ProviderShare[] {
    const rows = this.query(f)
    const map = new Map<Provider, { n: number; cloud: number }>()
    for (const s of rows) {
      const cur = map.get(s.provider) || { n: 0, cloud: 0 }
      cur.n++
      cur.cloud += s.cloudCover
      map.set(s.provider, cur)
    }
    const out: ProviderShare[] = []
    for (const [provider, v] of map) {
      out.push({ provider, scenes: v.n, avgCloud: v.n ? v.cloud / v.n : 0 })
    }
    out.sort((a, b) => b.scenes - a.scenes)
    return out
  }

  /** Best-scene mosaic index: pick lowest-cloud scene per XYZ tile (@z=8) for each day. */
  bestMosaicIndex(f: SceneFilter = {}, z = 8): Record<string, Scene> {
    const rows = this.query(f)
    const best: Record<string, Scene> = {}
    for (const s of rows) {
      const { x, y } = s.tileXYZ ?? lonLatToTile(s.centroid.lon, s.centroid.lat, z)
      const key = `${s.date}/${z}/${x}/${y}`
      const cur = best[key]
      if (!cur || s.cloudCover < cur.cloudCover) best[key] = s
    }
    return best
  }

  /** NDVI stats for scenes that have red & nir band stats. */
  ndviStats(f: SceneFilter = {}): NDVIStat[] {
    const rows = this.query(f)
    const out: NDVIStat[] = []
    for (const s of rows) {
      const ndvi = ndviFromStats(s.bandStats?.red, s.bandStats?.nir)
      out.push({ id: s.id, date: s.date, ndviMean: ndvi?.mean, ndviQuality: ndvi?.quality })
    }
    return out
  }

  /** Coarse change flags across two windows (A then B). */
  changeByTile(opts: {
    a: SceneFilter
    b: SceneFilter
    z?: number
    minAbsDelta?: number // NDVI delta threshold
  }): ChangeFlag[] {
    const z = opts.z ?? 8
    const minAbs = opts.minAbsDelta ?? 0.1
    const idx = (rows: Scene[]) => {
      const map = new Map<string, { n: number; ndviSum?: number; date?: string; cloud: number }>()
      for (const s of rows) {
        const t = s.tileXYZ ?? lonLatToTile(s.centroid.lon, s.centroid.lat, z)
        const k = `${z}/${t.x}/${t.y}`
        const ndvi = ndviFromStats(s.bandStats?.red, s.bandStats?.nir)?.mean
        const cur = map.get(k) || { n: 0, ndviSum: undefined, date: s.date, cloud: s.cloudCover }
        cur.n++
        cur.cloud = Math.min(cur.cloud, s.cloudCover)
        cur.date = !cur.date || s.date > cur.date ? s.date : cur.date
        if (typeof ndvi === "number") cur.ndviSum = (cur.ndviSum ?? 0) + ndvi
        map.set(k, cur)
      }
      return map
    }
    const A = idx(this.query(opts.a))
    const B = idx(this.query(opts.b))

    const out: ChangeFlag[] = []
    const keys = new Set<string>([...A.keys(), ...B.keys()])
    for (const k of keys) {
      const a = A.get(k), b = B.get(k)
      const ndviA = a?.ndviSum !== undefined && a.n ? a.ndviSum / a.n : undefined
      const ndviB = b?.ndviSum !== undefined && b.n ? b.ndviSum / b.n : undefined
      const delta = (ndviA !== undefined && ndviB !== undefined) ? (ndviB - ndviA) : undefined
      const pass = delta !== undefined && Math.abs(delta) >= minAbs
      if (pass || (a && b)) {
        out.push({
          key: k,
          dateA: a?.date || (opts.a.to || opts.a.from || "unknown"),
          dateB: b?.date || (opts.b.to || opts.b.from || "unknown"),
          ndviDelta: delta,
          cloudNote: cloudNote(a?.cloud, b?.cloud),
        })
      }
    }
    return out
  }
}

/** ===================== API Surface ===================== **/

const Satellites = {
  store: new SceneStore(),

  ingest(rows: RawScene[]): number {
    const norm = normalizeMany(rows)
    this.store.add(norm)
    return norm.length
  },

  query(filter: SceneFilter = {}): Scene[] {
    return this.store.query(filter)
  },

  daily(filter: SceneFilter = {}): DailyCount[] {
    return this.store.daily(filter)
  },

  providerShare(filter: SceneFilter = {}): ProviderShare[] {
    return this.store.providerShare(filter)
  },

  bestMosaicIndex(filter: SceneFilter = {}, z = 8): Record<string, Scene> {
    return this.store.bestMosaicIndex(filter, z)
  },

  ndviStats(filter: SceneFilter = {}): NDVIStat[] {
    return this.store.ndviStats(filter)
  },

  changeByTile(opts: { a: SceneFilter; b: SceneFilter; z?: number; minAbsDelta?: number }): ChangeFlag[] {
    return this.store.changeByTile(opts)
  },

  // Helpers exposed
  normalize,
  normalizeMany,
  intersectsAOI,
  lonLatToTile,
  ndviFromStats,
}

/** ===================== Normalization ===================== **/

function normalizeMany(rows: RawScene[]): Scene[] {
  const out: Scene[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const s = normalize(r)
    const sig = `${s.provider}|${s.sensor}|${s.date}|${Math.round(s.centroid.lon*100)}|${Math.round(s.centroid.lat*100)}`
    if (!seen.has(sig)) {
      seen.add(sig)
      out.push(s)
    }
  }
  return out
}

function normalize(r: RawScene): Scene {
  const provider = normProvider(r.provider)
  const sensor = normSensor(r.sensor)
  const productType = normProductType(r.productType)
  const acquiredISO = toISO(r.acquired) || new Date().toISOString()
  const date = acquiredISO.slice(0, 10)

  const bbox = toBBox(r.bbox, r.centerLon, r.centerLat) || {
    minLon: clampLon(num(r.centerLon) ?? 0) - 0.0005,
    minLat: clampLat(num(r.centerLat) ?? 0) - 0.0005,
    maxLon: clampLon(num(r.centerLon) ?? 0) + 0.0005,
    maxLat: clampLat(num(r.centerLat) ?? 0) + 0.0005,
  }
  const centroid = {
    lon: clampLon((bbox.minLon + bbox.maxLon) / 2),
    lat: clampLat((bbox.minLat + bbox.maxLat) / 2),
  }

  const cloudCover = clamp01(num(r.cloudCover) ?? 0) * 100
  const sunAzimuth = num(r.sunAzimuth)
  const sunElevation = num(r.sunElevation)
  const offNadir = num(r.offNadir)
  const gsdM = num(r.gsDistanceM) ?? (provider === "SENTINEL" ? 10 : provider === "LANDSAT" ? 30 : undefined)

  const bands: Scene["bands"] = {}
  if (r.bands) {
    for (const k of Object.keys(r.bands) as BandName[]) {
      bands[k] = !!r.bands[k]
    }
  }
  // Lightweight quicklook: if any band value looks like URL, prefer "red" or "alpha"
  const quicklook = bestQuicklookUrl(r.bands)

  const id =
    r.id ||
    r.sourceId ||
    hash([
      provider,
      sensor,
      productType,
      date,
      bbox.minLon.toFixed(4),
      bbox.minLat.toFixed(4),
      bbox.maxLon.toFixed(4),
      bbox.maxLat.toFixed(4),
      Math.round(cloudCover),
    ].join("|"))

  const tileXYZ = lonLatToTile(centroid.lon, centroid.lat, 8)

  const scene: Scene = {
    id,
    provider,
    sensor,
    productType,
    acquired: acquiredISO,
    date,
    bbox,
    centroid,
    cloudCover,
    sunAzimuth,
    sunElevation,
    offNadir,
    gsdM,
    crs: (r.crs as CRS) || "EPSG:4326",
    tileXYZ,
    bands,
    bandStats: r.bandStats,
    quicklook,
    note: r.note,
    sourceId: r.sourceId,
  }
  return scene
}

/** ===================== Analytics helpers ===================== **/

function ndviFromStats(red?: BandStats, nir?: BandStats): { mean: number; quality: number } | undefined {
  if (!red || !nir) return undefined
  // Very coarse approximation using band means and valid% overlap as quality proxy.
  const R = red.mean
  const N = nir.mean
  if (typeof R !== "number" || typeof N !== "number") return undefined
  const ndvi = (N - R) / (N + R + 1e-6)
  const qR = (red.validPct ?? 100) / 100
  const qN = (nir.validPct ?? 100) / 100
  return { mean: clamp(-1, ndvi, 1), quality: clamp(0, Math.min(qR, qN), 1) }
}

function cloudNote(a?: number, b?: number): string | undefined {
  if (a === undefined || b === undefined) return undefined
  const delta = b - a
  if (delta > 15) return "much cloudier in B"
  if (delta < -15) return "much clearer in B"
  return undefined
}

/** ===================== Geometry / Tiles ===================== **/

function intersectsAOI(aoi: AOI, bbox: BBox, centroid: { lon: number; lat: number }): boolean {
  if (aoi.type === "bbox") return bboxesIntersect(aoi.bbox, bbox)
  // point radius: check centroid within radius or bbox any corner within radius
  const r = aoi.radiusM ?? 500
  const d = haversine(aoi.lon, aoi.lat, centroid.lon, centroid.lat)
  if (d <= r) return true
  // If centroid outside, allow bbox corner within radius
  const corners: [number, number][] = [
    [bbox.minLon, bbox.minLat],
    [bbox.minLon, bbox.maxLat],
    [bbox.maxLon, bbox.minLat],
    [bbox.maxLon, bbox.maxLat],
  ]
  return corners.some(([lon, lat]) => haversine(aoi.lon, aoi.lat, lon, lat) <= r)
}

function bboxesIntersect(a: BBox, b: BBox): boolean {
  return !(a.minLon > b.maxLon || a.maxLon < b.minLon || a.minLat > b.maxLat || a.maxLat < b.minLat)
}

function lonLatToTile(lon: number, lat: number, z: number): { z: number; x: number; y: number } {
  // WebMercator XYZ
  const n = Math.pow(2, z)
  const x = Math.floor(((lon + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n
  )
  return { z, x: clampInt(x, 0, n - 1), y: clampInt(y, 0, n - 1) }
}

/** ===================== Small Utilities ===================== **/

function normProvider(p?: string): Provider {
  const s = (p || "").toUpperCase()
  if (s.includes("SENTINEL")) return "SENTINEL"
  if (s.includes("LANDSAT")) return "LANDSAT"
  if (s.includes("PLANET")) return "PLANET"
  if (s.includes("MAXAR") || s.includes("DIGITALGLOBE") || s.includes("WORLDVIEW")) return "MAXAR"
  return "OTHER"
}

function normSensor(s?: string): Sensor {
  const t = (s || "").toUpperCase()
  if (t.includes("S2") || t.includes("MSI")) return "S2-MSI"
  if (t.includes("L8")) return "L8-OLI"
  if (t.includes("L9")) return "L9-OLI"
  if (t.includes("PLANET")) return "PLANET-SCOPE"
  if (t.includes("WV3") || t.includes("WORLDVIEW")) return "WV3"
  return "OTHER"
}

function normProductType(p?: string): ProductType {
  const s = (p || "").toUpperCase()
  if (s.includes("L1C")) return "L1C"
  if (s.includes("L2A") || s.includes("SR")) return "L2A"
  if (s.includes("TOA")) return "TOA"
  if (s.includes("ANALYTIC")) return "ANALYTIC"
  if (s.includes("PANSHARP")) return "PANSHARP"
  return "OTHER"
}

function toISO(s?: string): string | undefined {
  if (!s) return undefined
  const t = Date.parse(s)
  return isFinite(t) ? new Date(t).toISOString() : undefined
}

function toBBox(b?: RawScene["bbox"], centerLon?: number | string, centerLat?: number | string): BBox | undefined {
  if (!b) return undefined
  if (Array.isArray(b)) {
    const [minLon, minLat, maxLon, maxLat] = b
    return fixBBox({ minLon, minLat, maxLon, maxLat })
  }
  return fixBBox(b as BBox) || (num(centerLon) !== undefined && num(centerLat) !== undefined
    ? {
        minLon: clampLon(num(centerLon)! - 0.0005),
        minLat: clampLat(num(centerLat)! - 0.0005),
        maxLon: clampLon(num(centerLon)! + 0.0005),
        maxLat: clampLat(num(centerLat)! + 0.0005),
      }
    : undefined)
}

function fixBBox(bb: BBox): BBox {
  let { minLon, minLat, maxLon, maxLat } = bb
  if (minLon > maxLon) [minLon, maxLon] = [maxLon, minLon]
  if (minLat > maxLat) [minLat, maxLat] = [maxLat, minLat]
  return {
    minLon: clampLon(minLon),
    minLat: clampLat(minLat),
    maxLon: clampLon(maxLon),
    maxLat: clampLat(maxLat),
  }
}

function bestQuicklookUrl(b?: RawScene["bands"]): string | undefined {
  if (!b) return undefined
  const order: BandName[] = ["alpha", "red", "green", "blue", "pan"]
  for (const name of order) {
    const v = b[name]
    if (typeof v === "string" && looksLikeUrl(v)) return v
  }
  for (const k of Object.keys(b) as BandName[]) {
    const v = b[k]
    if (typeof v === "string" && looksLikeUrl(v)) return v
  }
  return undefined
}

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s)
}

function num(x: any): number | undefined {
  if (x === null || x === undefined) return undefined
  const n = typeof x === "number" ? x : parseFloat(String(x).replace(/,/g, ""))
  return isFinite(n) ? n : undefined
}

function clamp01(x: number): number {
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

function clamp(min: number, x: number, max: number): number {
  return Math.max(min, Math.min(max, x))
}

function clampInt(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(x)))
}

function clampLon(lon: number): number {
  if (lon < -180) return -180
  if (lon > 180) return 180
  return lon
}

function clampLat(lat: number): number {
  if (lat < -90) return -90
  if (lat > 90) return 90
  return lat
}

function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const a = xs.slice().sort((p, q) => p - q)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

function everyBand(need: Set<BandName>, bands: Scene["bands"]): boolean {
  for (const b of need) if (!bands[b]) return false
  return true
}

function anyBand(need: Set<BandName>, bands: Scene["bands"]): boolean {
  for (const b of need) if (bands[b]) return true
  return false
}

function hash(s: string): string {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/** ===================== Exports ===================== **/

export {
  // core types
  Provider,
  Sensor,
  ProductType,
  BandName,
  BandStats,
  BBox,
  AOI,
  RawScene,
  Scene,
  SceneFilter,
  DailyCount,
  ProviderShare,
  NDVIStat,
  ChangeFlag,
  // store & api
  SceneStore,
  Satellites,
  // helpers
  normalize,
  normalizeMany,
  intersectsAOI,
  lonLatToTile,
  ndviFromStats,
}
