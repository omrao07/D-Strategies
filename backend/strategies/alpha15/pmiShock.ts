// alpha15/pmishock.ts
// Strategy: PMI Surprise Shock
// Reads macro PMI releases, compares actual vs. consensus, produces signal.
// Pure TS, no imports.

type Ts = number
type Str = string
type Num = number

export type Signal = { id: Str; symbol: Str; value: Num; ts: Ts }

export type PMIRelease = {
  ts: Ts
  region: 'US'|'IN'|'EU'|'JP'|'CN'
  actual: Num
  consensus?: Num
}

const ID = 'pmishock'

/* ================= Helpers ================= */
function normalizeSurprise(actual:Num, consensus?:Num){
  if(consensus==null) return 0
  const surprise = actual - consensus
  // scale surprises to -3..+3 range
  const z = surprise/5 // 5 points surprise = full swing
  return Math.max(-3, Math.min(3, z))
}

/* ================= Strategy ================= */
export function onPMIRelease(rel: PMIRelease): Signal[] {
  const sigs: Signal[] = []
  const t = rel.ts
  const reg = rel.region

  const base = normalizeSurprise(rel.actual, rel.consensus)

  // Directional bias: >50 = expansion, <50 = contraction
  const bias = rel.actual >= 50 ? +1 : -1

  // Combine
  const val = bias * (Math.abs(base) > 0 ? base : 1)

  // Map region → benchmark equity index
  const map: Record<PMIRelease['region'], Str> = {
    US: 'SPY',
    IN: 'NIFTY',
    EU: 'STOXX50',
    JP: 'N225',
    CN: 'CSI300'
  }
  const sym = map[reg]

  sigs.push({ id: ID, symbol: sym, value: Math.max(-3, Math.min(3, val)), ts: t })
  return sigs
}

/* ================= Example ================= */
/*
const rel: PMIRelease = { ts: Date.now(), region:'US', actual:52.1, consensus:50.0 }
console.log(onPMIRelease(rel))
*/