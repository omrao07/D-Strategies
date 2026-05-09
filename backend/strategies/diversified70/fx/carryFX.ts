// fx/carryfx.ts
// FX Carry signals: long the high-yield currency vs. the low-yield one.
// Works from a currency->short-rate map (e.g., policy/overnight rate in %),
// optionally blended with a simple spot-momentum filter. Pure TS, no imports.

type Str = string
type Num = number
type Ts  = number

/* ================== Public Types ================== */
export type FxPair = `${string}${string}${string}${string}${string}${string}` | string // e.g., "EURUSD", "USDINR"
export type FxQuote = { t: Ts; pair: FxPair; px: Num } // spot; Y per X (e.g., EURUSD = USD per EUR)

export type Signal = { id: Str; symbol: Str; value: Num; ts: Ts } // value in [-3, +3]

/** Currency short-rate map: e.g., { USD: 5.33, EUR: 2.6 } in PERCENT (not decimals). */
export type CcyRates = Record<Str, Num>

/* ================== Config ================== */
const ID = 'carryfx'
const DAY = 86_400_000

// Normalization: a 4% annual rate differential -> about |3| signal.
const DIFF_FOR_FULL = 0.04 // 4% as decimal

/* ================== Helpers ================== */
const clamp = (v:number,a:number,b:number)=> Math.max(a, Math.min(b, v))
const abs   = (x:number)=> x<0? -x:x

/** Split "EURUSD" -> { base:"EUR", quote:"USD" }. Also supports "USD/INR", "USD-INR". */
export function splitPair(pair: FxPair): { base:Str; quote:Str }{
  const s = pair.replace(/[^A-Za-z]/g,'').toUpperCase()
  if(s.length>=6){
    return { base: s.slice(0,3), quote: s.slice(3,6) }
  }
  // fallback (e.g., "EURUSD" in weird casing)
  return { base: s.substring(0,3), quote: s.substring(3,6) }
}

/** Interest rate differential (annual, decimal): i_base - i_quote. */
export function rateDifferential(pair: FxPair, rates: CcyRates): number {
  const { base, quote } = splitPair(pair)
  const ib = (rates[base] ?? NaN) / 100
  const iq = (rates[quote] ?? NaN) / 100
  if(!isFinite(ib) || !isFinite(iq)) return NaN
  return ib - iq
}

/** Map differential to signal in [-3, +3]. Positive diff -> long base vs quote. */
export function diffToSignalVal(diffDec: number): number {
  // linear mapping with clip; 4% diff => ±3
  return clamp((diffDec / DIFF_FOR_FULL) * 3, -3, 3)
}

/** Simple momentum filter on spot: k-day return; returns +1 / -1 / 0 weight. */
export function momentumFilter(quotes: FxQuote[], lookbackDays=60): number {
  if(quotes.length<2) return 1
  const last = quotes[quotes.length-1]
  const cutoff = last.t - lookbackDays*DAY
  // find earliest bar at/after cutoff
  let i0 = -1
  for(let i=0;i<quotes.length;i++){ if(quotes[i].t >= cutoff){ i0 = i; break } }
  if(i0<0) i0 = Math.max(0, quotes.length-2)
  const base = quotes[i0]
  if(!(base && base.px>0)) return 1
  const ret = (last.px - base.px) / base.px
  // If return agrees with carry sign, keep 1; if opposite and strong, damp.
  if(ret > 0.002) return +1
  if(ret < -0.002) return -1
  return 0.5 // flat-ish; mild weight
}

/* ================== Core: build signal ================== */
/**
 * Create one carry signal for a pair from rates (+ optional spot quotes for momentum blend).
 * - `rates` are in PERCENT (e.g., 5.25).
 * - If `spotQuotes` provided (chronological), we blend carry with a momentum gate to reduce whipsaw.
 *   final = carryVal * (0.6 + 0.4 * momWeight), where momWeight in {-1, 0.5, +1}
 */
export function carrySignalForPair(args:{
  pair: FxPair
  ts: Ts
  rates: CcyRates
  spotQuotes?: FxQuote[]      // optional, for filter
}): Signal | null {
  const diff = rateDifferential(args.pair, args.rates)
  if(!isFinite(diff)) return null

  let val = diffToSignalVal(diff) // base-positive -> long pair
  if(args.spotQuotes && args.spotQuotes.length>=2){
    const w = momentumFilter(args.spotQuotes)
    val = clamp(val * (0.6 + 0.4 * w), -3, +3)
  }
  return { id: ID, symbol: String(args.pair).toUpperCase(), value: val, ts: args.ts }
}

/** Batch for many pairs. `spotMap` optional: { "EURUSD": FxQuote[] } */
export function carrySignalsForPairs(pairs: FxPair[], ts: Ts, rates: CcyRates, spotMap?: Record<string, FxQuote[]>): Signal[] {
  const out: Signal[] = []
  for(const p of pairs){
    const sig = carrySignalForPair({ pair:p, ts, rates, spotQuotes: spotMap?.[String(p).toUpperCase()] })
    if(sig) out.push(sig)
  }
  return out
}

/* ================== Optional: derive CcyRates from macro rows ================== */
/**
 * If you're reading rows like your `data/packs/rates small.csv` or `macro small.csv`,
 * you can map them into currency short rates here.
 * Supported fields (case-insensitive contains): "PolicyRate", "FedFunds_Effective", "Repo".
 */
export type MacroRow = { date: string|number; symbol: Str; field: Str; value: Num }
export function ccyRatesFromMacroRows(rows: MacroRow[]): CcyRates {
  const rates: CcyRates = {}
  for(const r of rows){
    const f = r.field.toUpperCase()
    const cc = regionToCcy((r.symbol||'').toUpperCase())
    if(!cc) continue
    if(
      f.includes('POLICYRATE') ||
      f.includes('REPO') ||
      f.includes('FEDFUNDS_EFFECTIVE') ||
      f.includes('CASHRATE') ||
      f.includes('OVERNIGHT') ||
      f.includes('SOFR_OIS_1M')
    ){
      rates[cc] = r.value // value is in percent in your packs
    }
  }
  return rates
}

/** Map region/country code to currency code (edit to taste). */
export function regionToCcy(region: string): string | null {
  switch(region){
    case 'US': return 'USD'
    case 'EU': return 'EUR'
    case 'IN': return 'INR'
    case 'JP': return 'JPY'
    case 'CN': return 'CNY'
    case 'UK': return 'GBP'
    default:   return null
  }
}

/* ================== Convenience: quick example ================== */
/*
const rates = { USD: 5.33, EUR: 2.60, JPY: 0.10, INR: 6.50 }
const t = Date.now()
console.log(
  carrySignalsForPairs(['EURUSD','USDJPY','USDINR'], t, rates)
)
*/

/* ================== Extras (optional risk guardrails) ================== */
/**
 * If you want to disable trades when carry is tiny, call this.
 * E.g., minDiffPct = 0.5 => require |i_base - i_quote| >= 0.5% to trade.
 */
export function zeroOutTinyCarry(sig: Signal, minDiffPct=0.5, rates?: CcyRates): Signal {
  if(!rates) return sig
  const { base, quote } = splitPair(sig.symbol)
  const diffPct = abs((rates[base]??NaN) - (rates[quote]??NaN))
  if(!isFinite(diffPct) || diffPct < minDiffPct) return { ...sig, value: 0 }
  return sig
}