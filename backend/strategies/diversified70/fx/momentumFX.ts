// fx/momentumfx.ts
// FX Momentum signals on spot pairs. Pure TS, no imports.
//
// Produces signals in [-3, +3] per pair using k-day returns,
// with optional volatility scaling and moving-average crossover filter.

type Str = string
type Num = number
type Ts  = number

/* ============== Types ============== */
export type FxPair  = `${string}${string}${string}${string}${string}${string}` | string // "EURUSD", "USDINR"
export type FxQuote = { t: Ts; pair: FxPair; px: Num } // spot; quote units per base (e.g., EURUSD = USD per EUR)
export type Signal  = { id: Str; symbol: Str; value: Num; ts: Ts }

/* ============== Config ============== */
const ID = 'momentumfx'
const DAY = 86_400_000

export type MomConfig = {
  lookbackDays?: number        // window for momentum return (default 60)
  volLookbackDays?: number     // window for stdev of daily returns (default 30)
  targetDailyVol?: number      // target daily vol used for scaling (default 0.007 ~ 0.7%)
  useCrossover?: boolean       // apply fast/slow MA sign as a gate (default true)
  fastDays?: number            // fast MA (default 20)
  slowDays?: number            // slow MA (default 60)
  clip?: number                // absolute clip for final signal (default 3)
}

/* ============== Helpers ============== */
const clamp = (v:number,a:number,b:number)=> Math.max(a, Math.min(b, v))

/** Ensure quotes are for one pair and sorted ascending. */
function normalizeQuotes(quotes: FxQuote[]): FxQuote[] {
  const arr = quotes.slice().sort((a,b)=> a.t - b.t)
  return arr
}

/** Find earliest index with t >= cutoff; if none, fall back to second last. */
function idxAtOrAfter(arr: FxQuote[], cutoff: Ts): number {
  let i0 = -1
  for(let i=0;i<arr.length;i++){ if(arr[i].t >= cutoff){ i0 = i; break } }
  if(i0<0) i0 = Math.max(0, arr.length-2)
  return i0
}

/** Daily log returns from quotes (assumes daily-ish cadence). */
function dailyLogReturns(arr: FxQuote[]): number[] {
  const out:number[] = []
  for(let i=1;i<arr.length;i++){
    const a = arr[i-1].px, b = arr[i].px
    if(a>0 && b>0) out.push(Math.log(b/a))
  }
  return out
}

/** Rolling mean over last N points. Returns NaN if not enough data. */
function rollingMean(x:number[], n:number){
  if(x.length < n || n<=0) return NaN
  let s = 0
  for(let i=x.length-n;i<x.length;i++) s += x[i]
  return s / n
}

/** Rolling stdev over last N points (population). */
function rollingStdev(x:number[], n:number){
  if(x.length < n || n<=0) return NaN
  const m = rollingMean(x, n)
  let v = 0
  for(let i=x.length-n;i<x.length;i++){ const d=x[i]-m; v += d*d }
  v /= n
  return Math.sqrt(Math.max(0,v))
}

/** Simple moving average of price over last N closes. */
function priceSMA(arr: FxQuote[], n:number){
  if(arr.length < n) return NaN
  let s = 0
  for(let i=arr.length-n;i<arr.length;i++) s += arr[i].px
  return s / n
}

/* ============== Core: momentum value ============== */
/**
 * Momentum value (pre-clip) is:
 *   sign = optional MA(fast) > MA(slow) ? +1 : -1 (if useCrossover)
 *   raw  = ln(P_t / P_{t-k})
 *   scaled = raw / (stdev_recent * sqrt(k)) * targetDailyVol * 3
 * Then clipped to [-clip, +clip].
 */
export function momentumValue(
  quotes: FxQuote[],
  cfg: MomConfig = {}
): number {
  const lookbackDays   = cfg.lookbackDays   ?? 60
  const volLookback    = cfg.volLookbackDays?? 30
  const targetDailyVol = cfg.targetDailyVol ?? 0.007
  const useX           = cfg.useCrossover   ?? true
  const fastN          = cfg.fastDays       ?? 20
  const slowN          = cfg.slowDays       ?? 60
  const clipAbs        = Math.max(0.5, cfg.clip ?? 3)

  const arr = normalizeQuotes(quotes)
  if(arr.length < 3) return 0

  const last = arr[arr.length-1]
  const cutoff = last.t - lookbackDays*DAY
  const i0 = idxAtOrAfter(arr, cutoff)
  const base = arr[i0]
  if(!(base && base.px>0)) return 0

  const raw = Math.log(last.px / base.px) // k-day log return

  // Vol scaling
  const rets = dailyLogReturns(arr)
  const sd = rollingStdev(rets, Math.min(volLookback, rets.length)) || 1e-6
  // Approx scale to target vol over sqrt(k) horizon, then map to [-3,3] range
  const horizonScale = Math.sqrt(Math.max(1, lookbackDays))
  const scaled = (raw / (sd * horizonScale)) * (targetDailyVol * 3 / (sd || 1e-6))

  // Optional crossover filter: flips/attenuates if trend disagrees
  let sign = 1
  if(useX){
    const f = priceSMA(arr, fastN)
    const s = priceSMA(arr, slowN)
    if(isFinite(f) && isFinite(s)){
      if(f > s) sign = +1
      else if(f < s) sign = -1
      else sign = 0.5
    }
  }

  return clamp(scaled * sign, -clipAbs, clipAbs)
}

/* ============== One-shot signal builder ============== */
export function momentumSignalForPair(
  pair: FxPair,
  quotes: FxQuote[],
  cfg: MomConfig = {}
): Signal | null {
  if(!quotes.length) return null
  const v = momentumValue(quotes, cfg)
  const ts = quotes[quotes.length-1].t
  return { id: ID, symbol: String(pair).toUpperCase(), value: v, ts }
}

/** Batch helper for many pairs. Expects quotesByPair map with sorted or unsorted arrays. */
export function momentumSignals(
  quotesByPair: Record<string, FxQuote[]>,
  cfg: MomConfig = {}
): Signal[] {
  const out: Signal[] = []
  for(const k in quotesByPair){
    const arr = normalizeQuotes(quotesByPair[k])
    if(!arr.length) continue
    const sig = momentumSignalForPair(k.toUpperCase(), arr, cfg)
    if(sig) out.push(sig)
  }
  return out
}

/* ============== Convenience example ==============
const t0 = Date.UTC(2025,8,1)
const mk = (d:number, p:number):FxQuote=>({ t: t0 + d*DAY, pair:'EURUSD', px:p })
const series = [1.09,1.10,1.11,1.10,1.12,1.13,1.14,1.145,1.15].map((p,i)=> mk(i*7,p))
console.log(momentumSignalForPair('EURUSD', series))
*/