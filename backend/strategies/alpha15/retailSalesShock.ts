// alpha15/retailsalesshock.ts
// Strategy: Retail Sales Surprise Shock
// Uses monthly Retail Sales MoM releases. Positive surprise → risk-on tilt to equities/consumer.
// Pure TS, no imports.

type Ts = number
type Str = string
type Num = number

export type Signal = { id: Str; symbol: Str; value: Num; ts: Ts }

export type RetailSalesRelease = {
  ts: Ts
  region: 'US'|'IN'|'EU'|'JP'|'CN'
  actual: Num            // MoM %, e.g., +0.3
  consensus?: Num        // MoM % expected, optional
}

const ID = 'retailsalesshock'

/* ================= Helpers ================= */

/** Convert surprise (actual - consensus) into a clipped z in [-3, +3]. */
function normalizeSurprise(actual:Num, consensus?:Num){
  if(consensus==null) return 0
  const surprise = actual - consensus // percentage points
  // Heuristic scale: 1.0 pp surprise → ≈ 2.0 sigma → map to ~2
  const z = surprise * 2.0
  return Math.max(-3, Math.min(3, z))
}

/** Bias toward expansion if actual > 0 (growth), contraction if < 0. */
function growthBias(actual:Num){
  return actual >= 0 ? +1 : -1
}

/** Region → benchmark equity + consumer proxy (if available). */
function regionMaps(region: RetailSalesRelease['region']){
  const eq: Record<RetailSalesRelease['region'], Str> = {
    US: 'SPY',
    IN: 'NIFTY',
    EU: 'STOXX50',
    JP: 'N225',
    CN: 'CSI300'
  }
  // Secondary “consumer” tilts; customize to your symbols/universe
  const cons: Record<RetailSalesRelease['region'], Str> = {
    US: 'XLY',         // US Consumer Discretionary ETF (or use sector index)
    IN: 'NIFTYCONS',   // placeholder; swap to your consumer index if you have one
    EU: 'SXQP',        // STOXX Europe Consumer Discretionary (placeholder)
    JP: 'TPXCONS',     // TOPIX Consumer Discretionary (placeholder)
    CN: 'CSI_CONS'     // placeholder
  }
  return { eq: eq[region], cons: cons[region] }
}

/* ================= Strategy ================= */

export function onRetailSalesRelease(rel: RetailSalesRelease): Signal[] {
  const t = rel.ts
  const surpriseZ = normalizeSurprise(rel.actual, rel.consensus)         // [-3..+3]
  const bias      = growthBias(rel.actual)                               // +1 / -1

  // Combine surprise with growth bias. If no consensus, use bias-only lean.
  const base = (rel.consensus==null) ? 1.0 : Math.max(0.75, Math.min(1.5, 1 + Math.abs(surpriseZ)/3))
  let val = bias * (rel.consensus==null ? 1.0 : surpriseZ * base)

  // Clip final signal
  val = Math.max(-3, Math.min(3, val))

  const { eq, cons } = regionMaps(rel.region)
  const sigs: Signal[] = [
    { id: ID, symbol: eq,   value: val,         ts: t },
    { id: ID, symbol: cons, value: val * 1.25,  ts: t } // slightly stronger tilt to consumer
  ]
  return sigs
}

/* ================= Convenience: simple mapper from generic macro row ================= */
/**
 * If you read rows like { date, symbol, field, value } from data/packs/macro small.csv,
 * call mapMacroRowToRetailRelease(row) and then onRetailSalesRelease(release).
 */
export type MacroRow = { date: string|number; symbol: Str; field: Str; value: Num; consensus?: Num }
export function mapMacroRowToRetailRelease(row: MacroRow): RetailSalesRelease | null {
  const f = String(row.field || '').toUpperCase()
  if(f!=='RETAILSALES_MOM') return null
  const ts = typeof row.date==='number' ? row.date : Date.parse(row.date)
  const region = (String(row.symbol).toUpperCase() as RetailSalesRelease['region'])
  return { ts, region, actual: row.value, consensus: row.consensus }
}

/* ================= Example ================= */
/*
const r: RetailSalesRelease = { ts: Date.now(), region:'US', actual: 0.3, consensus: 0.1 }
console.log(onRetailSalesRelease(r))
*/