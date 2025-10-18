// alpha15/unemployementdelta.ts
// Strategy: Unemployment Δ (level change & surprise)
// Rising unemployment → risk-off for equities, risk-on for duration. Pure TS, no imports.

type Ts = number
type Str = string
type Num = number

export type Signal = { id: Str; symbol: Str; value: Num; ts: Ts }

export type UnemploymentRelease = {
  ts: Ts
  region: 'US'|'IN'|'EU'|'JP'|'CN'
  rate: Num          // current unemployment rate in %
  prev?: Num         // previous reading in %
  consensus?: Num    // expected rate in %
}

const ID = 'unemployment_delta'

/* ============== Helpers ============== */
function zFromSurprise(actual:Num, consensus?:Num){
  if(consensus==null) return 0
  const s = actual - consensus                 // pct-pts
  const z = s / 0.3                            // ~0.3pp ≈ 1σ (heuristic)
  return Math.max(-3, Math.min(3, z))
}

function zFromDelta(actual:Num, prev?:Num){
  if(prev==null) return 0
  const d = actual - prev                      // pct-pts (↑ = worse)
  const z = d / 0.2
  return Math.max(-3, Math.min(3, z))
}

function regionBenchmark(region: UnemploymentRelease['region']): Str {
  const map: Record<UnemploymentRelease['region'], Str> = {
    US: 'SPY', IN: 'NIFTY', EU: 'STOXX50', JP: 'N225', CN: 'CSI300'
  }
  return map[region]
}

function regionRatesProxy(region: UnemploymentRelease['region']): Str {
  const map: Record<UnemploymentRelease['region'], Str> = {
    US: 'IEF', IN: 'GSEC10', EU: 'BUND10', JP: 'JGB10', CN: 'CGB10'
  }
  return map[region]
}

/* ============== Strategy ============== */
export function onUnemploymentRelease(rel: UnemploymentRelease): Signal[] {
  const t = rel.ts
  const zSurp  = zFromSurprise(rel.rate, rel.consensus) // [+] worse than exp.
  const zDelta = zFromDelta(rel.rate, rel.prev)         // [+] worsening vs prev

  let z = 0
  if(rel.consensus!=null && rel.prev!=null) z = (zSurp*0.6 + zDelta*0.8) / 1.4
  else if(rel.consensus!=null) z = zSurp
  else if(rel.prev!=null) z = zDelta

  const eqVal  = Math.max(-3, Math.min(3, -z)) // equities inverse
  const durVal = Math.max(-3, Math.min(3,  z)) // duration same sign

  const eqSym  = regionBenchmark(rel.region)
  const durSym = regionRatesProxy(rel.region)

  return [
    { id: ID, symbol: eqSym,  value: eqVal,  ts: t },
    { id: ID, symbol: durSym, value: durVal, ts: t }
  ]
}

/* ============== Macro-row mapper (optional) ============== */
export type MacroRow = { date: string|number; symbol: Str; field: Str; value: Num; consensus?: Num; prev?: Num }
export function mapMacroRowToUnemployment(row: MacroRow): UnemploymentRelease | null {
  const f = String(row.field||'').toUpperCase().replace(/[^A-Z]/g,'')
  if(!(f==='UNEMPLOYMENTRATE' || f==='UNEMPLOYRATE' || f==='JOBLESSRATE')) return null
  const ts = typeof row.date==='number' ? row.date : Date.parse(row.date)
  const region = (String(row.symbol).toUpperCase() as UnemploymentRelease['region'])
  return { ts, region, rate: row.value, consensus: row.consensus, prev: row.prev }
}