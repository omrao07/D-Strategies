// alpha15/yieldcurve.ts
// Strategy: Yield Curve Shock
// Uses spread between long-term (10Y) and short-term (2Y) yields.
// Flattening/inversion → risk-off for equities, risk-on for duration.
// Steepening → risk-on for equities, risk-off for duration.
// Pure TS, no imports.

type Ts = number
type Str = string
type Num = number

export type Signal = { id: Str; symbol: Str; value: Num; ts: Ts }

export type YieldCurveRelease = {
  ts: Ts
  region: 'US'|'IN'|'EU'|'JP'|'CN'
  shortRate: Num   // e.g., 2Y yield in %
  longRate: Num    // e.g., 10Y yield in %
  prevSlope?: Num  // optional previous slope (long-short)
}

const ID = 'yieldcurve'

/* ============== Helpers ============== */

/** Compute slope: long - short. */
function slope(shortRate: Num, longRate: Num): Num {
  return longRate - shortRate
}

/** Normalize slope or slope change to [-3,+3]. */
function zFromSlopeChange(cur: Num, prev?: Num) {
  if(prev==null) {
    // map slope directly: 0% → 0, +1.0% → +2, -1.0% → -2
    return Math.max(-3, Math.min(3, cur * 2))
  }
  const d = cur - prev
  // 25 bps change = ~1σ
  const z = d / 0.25
  return Math.max(-3, Math.min(3, z))
}

/** Map region to benchmark equity and bond proxy. */
function regionMaps(region: YieldCurveRelease['region']){
  const eq: Record<YieldCurveRelease['region'], Str> = {
    US: 'SPY',
    IN: 'NIFTY',
    EU: 'STOXX50',
    JP: 'N225',
    CN: 'CSI300'
  }
  const bond: Record<YieldCurveRelease['region'], Str> = {
    US: 'IEF', IN: 'GSEC10', EU: 'BUND10', JP: 'JGB10', CN: 'CGB10'
  }
  return { eq: eq[region], bond: bond[region] }
}

/* ============== Strategy ============== */

export function onYieldCurveRelease(rel: YieldCurveRelease): Signal[] {
  const t = rel.ts
  const curSlope = slope(rel.shortRate, rel.longRate)
  const z = zFromSlopeChange(curSlope, rel.prevSlope)

  // Interpretation:
  // Steepening (z>0) → equities positive, bonds negative.
  // Flattening/inversion (z<0) → equities negative, bonds positive.
  let eqVal  = Math.max(-3, Math.min(3, z))
  let bondVal= Math.max(-3, Math.min(3, -z))

  // If curve is inverted (long < short), apply extra penalty to equities.
  if(curSlope < 0) {
    eqVal = Math.min(eqVal - 1, -3)
    bondVal = Math.max(bondVal + 0.5, -3)
  }

  const { eq, bond } = regionMaps(rel.region)
  return [
    { id: ID, symbol: eq,   value: eqVal,   ts: t },
    { id: ID, symbol: bond, value: bondVal, ts: t }
  ]
}

/* ============== Macro-row mapper (optional) ============== */
/**
 * Use with rows like: { date,symbol,field,value }
 * Expected fields: "UST_2Y","UST_10Y", "GSEC_10Y", etc. Pair them outside, then feed here.
 */
export type MacroRow = { date: string|number; symbol: Str; field: Str; value: Num }
export function makeYieldCurveRelease(ts: Ts, region: YieldCurveRelease['region'], short: Num, long: Num, prevSlope?: Num): YieldCurveRelease {
  return { ts, region, shortRate: short, longRate: long, prevSlope }
}

/* ============== Example ============== */
/*
const rel: YieldCurveRelease = { ts: Date.now(), region:'US', shortRate: 4.8, longRate: 4.2, prevSlope: -0.5 }
console.log(onYieldCurveRelease(rel))
*/