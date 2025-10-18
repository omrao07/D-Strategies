// alpha15/tradebalance.ts
// Strategy: Trade Balance Shock
// Idea: Positive surprise (higher surplus / smaller deficit) → risk-on tilt for export-heavy markets.
// Negative surprise (worse deficit / smaller surplus) → risk-off tilt.
// Pure TS, no imports.

type Ts = number
type Str = string
type Num = number

export type Signal = { id: Str; symbol: Str; value: Num; ts: Ts }

export type TradeBalanceRelease = {
  ts: Ts
  region: 'US'|'IN'|'EU'|'JP'|'CN'
  actual: Num          // level surprise basis (e.g., $bn or % GDP)
  consensus?: Num      // same unit as actual
  prev?: Num           // optional previous release, same unit
}

const ID = 'tradebalance'

/* ================= Helpers ================= */

/**
 * Normalize a (actual - consensus) shock to [-3, +3].
 * If consensus is near zero (common for % of GDP), fall back to prev as a scale.
 * If both missing, fall back to a soft clamp on absolute actual.
 */
function normalizeSurprise(actual: Num, consensus?: Num, prev?: Num){
  let base = 0
  if (consensus != null) {
    const denom = Math.max(1e-6, Math.abs(consensus) || Math.abs(prev ?? 0) || 1)
    base = (actual - consensus) / denom
  } else if (prev != null) {
    const denom = Math.max(1e-6, Math.abs(prev))
    base = (actual - prev) / denom
  } else {
    // Only one number? treat as small shock
    base = Math.sign(actual) * 0.5
  }

  // Gentle scaling: ±50% surprise ≈ ±2, ±100% ≈ ±3 (clip)
  const z = Math.max(-3, Math.min(3, base * 2))
  return z
}

/**
 * Directional bias:
 * - Higher trade balance (more surplus / less deficit) is generally favorable for exporters and currency.
 * - Lower trade balance (more deficit / less surplus) is unfavorable.
 * We treat "actual > 0" as surplus, "< 0" as deficit. For US (structural deficit), a *smaller* deficit (actual less negative vs. prev/consensus) is positive.
 */
function directionalBias(actual: Num, consensus?: Num, prev?: Num){
  const ref = (consensus != null) ? consensus : (prev != null ? prev : 0)
  const improvement = (actual - ref) // >0 = better (more surplus / less deficit)
  return improvement >= 0 ? +1 : -1
}

function regionMaps(region: TradeBalanceRelease['region']){
  // Benchmarks (edit to your universe)
  const eq: Record<TradeBalanceRelease['region'], Str> = {
    US: 'SPY',
    IN: 'NIFTY',
    EU: 'STOXX50',
    JP: 'N225',
    CN: 'CSI300'
  }
  // Exporter/industrial tilt proxies (placeholders; swap with your tickers)
  const exporters: Record<TradeBalanceRelease['region'], Str> = {
    US: 'XLI',        // Industrials
    IN: 'NIFTY_AUTO', // Autos as export proxy (placeholder)
    EU: 'SXNP',       // STOXX Industrial Goods (placeholder)
    JP: 'TOPIX_MFG',  // Manufacturing (placeholder)
    CN: 'CSI_EXPORT'  // Exporters basket (placeholder)
  }
  return { eq: eq[region], exporters: exporters[region] }
}

/* ================= Strategy ================= */

export function onTradeBalanceRelease(rel: TradeBalanceRelease): Signal[] {
  const t = rel.ts
  const z  = normalizeSurprise(rel.actual, rel.consensus, rel.prev)  // [-3..+3]
  const dir = directionalBias(rel.actual, rel.consensus, rel.prev)   // +1/-1

  // Combine: surprise magnitude times direction. If no consensus/prev, bias-only mild tilt.
  const intensity = (rel.consensus==null && rel.prev==null) ? 0.8 : 1.0
  let val = dir * Math.max(0.75, Math.min(1.25, 1 + Math.abs(z)/4)) * (Math.abs(z) > 0 ? z : dir)
  val *= intensity

  // Clip final signal
  val = Math.max(-3, Math.min(3, val))

  const { eq, exporters } = regionMaps(rel.region)
  const sigs: Signal[] = [
    { id: ID, symbol: eq,         value: val,         ts: t },
    { id: ID, symbol: exporters,  value: val * 1.2,   ts: t } // exporters get a bit more weight
  ]
  return sigs
}

/* ================= Convenience: macro-row mapper ================= */
/**
 * Use with rows from data/packs/macro small.csv-like files:
 * expects fields named like "TradeBalance", "Trade_Balance", "TRADE_BALANCE", or "..._USDbn".
 */
export type MacroRow = { date: string|number; symbol: Str; field: Str; value: Num; consensus?: Num; prev?: Num }
export function mapMacroRowToTradeBalance(row: MacroRow): TradeBalanceRelease | null {
  const f = String(row.field || '').toUpperCase().replace(/[^A-Z]/g,'')
  if(!(f==='TRADEBALANCE' || f==='TRADEBALANCEUSDBN' || f==='TBALANCE' || f==='NETEXPORTS')){
    return null
  }
  const ts = typeof row.date==='number' ? row.date : Date.parse(row.date)
  const region = (String(row.symbol).toUpperCase() as TradeBalanceRelease['region'])
  return { ts, region, actual: row.value, consensus: row.consensus, prev: row.prev }
}

/* ================= Example ================= */
/*
const rel: TradeBalanceRelease = {
  ts: Date.now(), region:'JP', actual: 7.2, consensus: 5.0, prev: 4.8 // e.g., ¥tn or $bn
}
console.log(onTradeBalanceRelease(rel))
*/