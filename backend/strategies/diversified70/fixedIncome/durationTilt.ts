// fixed_income/duration_tilt.ts
// ------------------------------------------------------------
// Duration Tilt (carry + roll-down) signal for rates instruments.
// Pure TS, no imports.
//
// What it does (per curve & date):
// 1) For each instrument (bond/future/swap bucket), compute:
//    • Carry over horizon ≈ yield * horizonYears
//    • Roll-down: Δy if the instrument "slides" down the curve by horizonYears
//      Expected price ≈ -Duration * Δy
//    • Total expected return ≈ carry + (-Duration * Δy)
// 2) Z-score the expected return cross-sectionally (by curve or globally).
// 3) Optional map to an overlay target DV01 with caps.
//
// Inputs:
//  - Yields are DECIMAL (0.072 = 7.2%)
//  - Durations in years (modified duration)
//  - Tenor in years
//
// Typical use:
//  - Feed government/swap curve points for a date and a set of tradeable
//    instruments (e.g., 2y/5y/10y futures, bond buckets).
//
// ------------------------------------------------------------

type Num = number
type Ts  = number
type Str = string

export type CurvePoint = {
  ts: Ts
  curve: Str             // e.g., 'IN_GSEC', 'US_UST', 'EU_SWAP'
  tenorY: Num            // e.g., 0.25, 2, 5, 10
  yield: Num             // DECIMAL
}

export type Instrument = {
  ts: Ts
  curve: Str
  id: Str                // e.g., 'IN_2Y_FUT', 'US_10Y'
  tenorY: Num            // effective tenor the instrument references
  yield?: Num            // if not given, we’ll interpolate from curve
  modDur: Num           // modified duration (years)
  // optional: custom label/bucket
  bucket?: Str
}

export type Params = {
  horizonYears?: Num     // how far you “roll” down the curve (default 0.5)
  clip?: Num             // clip final z-scores (abs) (default 3)
  winsorPct?: Num        // winsorization for stats (default 0.02)
  zByCurve?: boolean     // z-score within each curve (default true)
  minObsPerCurve?: number// required instruments per curve to z-score (default 3)
}

export type DurationTiltSignal = {
  ts: Ts
  curve: Str
  id: Str
  tenorY: Num
  modDur: Num
  carry: Num            // yield*horizon (in DECIMAL return, e.g., 0.02 = 2%)
  dY_roll: Num          // Δy due to roll-down over horizon (DECIMAL)
  priceFromRoll: Num    // ≈ -modDur * dY_roll  (DECIMAL)
  expReturn: Num        // carry + priceFromRoll (DECIMAL)
  score: Num            // clipped z-score (higher => better tilt)
}

/* ----------------------------- defaults & utils ----------------------------- */

const DEF: Required<Params> = {
  horizonYears: 0.5,
  clip: 3,
  winsorPct: 0.02,
  zByCurve: true,
  minObsPerCurve: 3
}

const clamp = (v:number,a:number,b:number)=> Math.max(a, Math.min(b, v))
const up    = (s:any)=> String(s ?? '').toUpperCase()

function groupBy<T extends { [k in K]: string }, K extends keyof T>(rows: T[], key: K){
  const m: Record<string, T[]> = {}
  for(const r of rows){
    const k = up(r[key])
    ;(m[k] ||= []).push(r)
  }
  return m
}

function byTs<T extends { ts: Ts }>(rows: T[]){
  const m: Record<string, T[]> = {}
  for(const r of rows){
    const k = String(r.ts)
    ;(m[k] ||= []).push(r)
  }
  return m
}

function sortNumAsc(a:number,b:number){ return a-b }

function interpYield(tenor: number, pts: Array<{ tenorY:number; yield:number }>): number | undefined {
  if(!pts.length) return undefined
  const arr = pts.slice().sort((a,b)=> a.tenorY - b.tenorY)
  if(tenor <= arr[0].tenorY) return arr[0].yield
  if(tenor >= arr[arr.length-1].tenorY) return arr[arr.length-1].yield
  for(let i=1;i<arr.length;i++){
    const lo = arr[i-1], hi = arr[i]
    if(tenor >= lo.tenorY && tenor <= hi.tenorY){
      const t = (tenor - lo.tenorY) / Math.max(1e-9, (hi.tenorY - lo.tenorY))
      return lo.yield + t*(hi.yield - lo.yield)
    }
  }
  return arr[arr.length-1].yield
}

function winsorStats(xs: number[], p=0.02){
  if(!xs.length) return { mean:0, sd:1 }
  if(!(p>0) || xs.length<3){
    const m = xs.reduce((a,b)=>a+b,0)/xs.length
    const v = xs.reduce((a,b)=>a+(b-m)*(b-m),0)/xs.length
    return { mean:m, sd: Math.sqrt(v) || 1e-6 }
  }
  const s = xs.slice().sort((a,b)=>a-b)
  const lo = s[Math.floor(p*(s.length-1))]
  const hi = s[Math.ceil((1-p)*(s.length-1))]
  const w = xs.map(v => clamp(v, lo, hi))
  const m = w.reduce((a,b)=>a+b,0)/w.length
  const v = w.reduce((a,b)=>a+(b-m)*(b-m),0)/w.length
  return { mean:m, sd: Math.sqrt(v) || 1e-6 }
}

/* ----------------------------- core API ----------------------------- */
/**
 * Build duration-tilt signals (carry+roll) for instruments given a curve snapshot.
 * - rowsCurve: multiple points on the curve for the same ts (per curve)
 * - rowsInstruments: tradeables at (ts, curve)
 */
export function durationTiltSignals(
  rowsCurve: CurvePoint[],
  rowsInstruments: Instrument[],
  params: Params = {}
): DurationTiltSignal[] {
  const cfg = { ...DEF, ...params }

  // partition by curve then by ts (we assume instruments/curve points share ts)
  const curvesByCurve = groupBy(rowsCurve, 'curve')
  const instByCurve   = groupBy(rowsInstruments, 'curve')

  const out: DurationTiltSignal[] = []

  for(const curve in instByCurve){
    const instAll = instByCurve[curve]
    const curveAll = curvesByCurve[curve] || []
    if(!instAll.length || !curveAll.length) continue

    const instByDate = byTs(instAll)
    const curveByDate = byTs(curveAll)

    const dates = Object.keys(instByDate).map(Number).sort(sortNumAsc)

    for(const ts of dates){
      const insts = instByDate[String(ts)]
      const curvePts = curveByDate[String(ts)] || []
      if(!insts || !curvePts.length) continue

      // Prepare helper list for interpolation (tenor/yield only)
      const curveForInterp = curvePts.map(p => ({ tenorY: p.tenorY, yield: p.yield }))

      // Compute per-instrument expected return
      const raw: DurationTiltSignal[] = []
      for(const k of insts){
        const tenor = k.tenorY
        // current yield: instrument.yield or from curve
        const yNow = isFinite(k.yield as number) ? (k.yield as number)
                                                 : interpYield(tenor, curveForInterp)
        if(!isFinite(yNow as number)) continue

        // roll-down: compare y(tenor - horizon) vs y(tenor)
        const tFuture = Math.max(0, tenor - cfg.horizonYears)
        const yFuture = interpYield(tFuture, curveForInterp)
        const dY = (isFinite(yFuture as number) ? (yFuture as number) : yNow as number) - (yNow as number)

        const carry = (yNow as number) * cfg.horizonYears           // income component (DECIMAL)
        const priceFromRoll = -(k.modDur) * dY                       // price change approx (DECIMAL)
        const expReturn = carry + priceFromRoll

        raw.push({
          ts, curve, id: String(k.id), tenorY: tenor, modDur: k.modDur,
          carry, dY_roll: dY, priceFromRoll, expReturn, score: 0
        })
      }
      if(!raw.length) continue

      // z-score either by curve/date (here) or globally later
      const xs = raw.map(r => r.expReturn)
      const { mean, sd } = winsorStats(xs, cfg.winsorPct)
      for(const r of raw){
        r.score = clamp((r.expReturn - mean) / sd, -Math.abs(cfg.clip), Math.abs(cfg.clip))
        out.push(r)
      }
    }
  }

  // If zByCurve=false, recompute z over all signals at same ts (global cross-section)
  if(!cfg.zByCurve && out.length){
    // group by ts
    const byDate = byTs(out)
    const remap: DurationTiltSignal[] = []
    for(const k in byDate){
      const arr = byDate[k]
      const xs = arr.map(r => r.expReturn)
      const { mean, sd } = winsorStats(xs, cfg.winsorPct)
      for(const r of arr){
        remap.push({ ...r, score: clamp((r.expReturn - mean)/sd, -Math.abs(cfg.clip), Math.abs(cfg.clip)) })
      }
    }
    return remap
  }

  return out
}

/* ----------------------------- optional: overlay targets ----------------------------- */
/**
 * Convert duration-tilt scores to a DV01-neutral overlay across instruments.
 * - Positive scores get long weights; negative are set to 0 (long-only overlay).
 * - Caps per instrument DV01 and per bucket (optional).
 */
export function overlayTargetsFromSignals(
  sigs: DurationTiltSignal[],
  opts: {
    longOnly?: boolean      // default true
    maxInstrWeight?: number // cap per instrument (fraction of overlay), default 0.3
    bucketKey?: (s:DurationTiltSignal)=> string // e.g., group by tenor bucket '2y/5y/10y'
    maxBucketWeight?: number // default 0.6
  } = {}
){
  const longOnly = opts.longOnly ?? true
  const maxInstr = opts.maxInstrWeight ?? 0.3
  const maxBucket = opts.maxBucketWeight ?? 0.6
  const keyFn = opts.bucketKey ?? ((s:DurationTiltSignal)=> {
    if(s.tenorY < 3) return 'S'
    if(s.tenorY < 7) return 'M'
    return 'L'
  })

  // 1) Raw positive weights from scores
  const raws = sigs
    .map(s => ({ s, w: longOnly ? Math.max(0, s.score) : (s.score + 3) / 6 })) // map [-3,3] -> [0,1]
    .filter(x => x.w > 0)

  const sum = raws.reduce((a,b)=> a + b.w, 0) || 1
  for(const r of raws) r.w /= sum

  // 2) Per-instrument cap
  for(const r of raws) r.w = Math.min(r.w, maxInstr)

  // 3) Per-bucket cap
  const byB: Record<string, number> = {}
  for(const r of raws){
    const k = keyFn(r.s)
    const used = byB[k] || 0
    const space = Math.max(0, maxBucket - used)
    const take = Math.min(space, r.w)
    byB[k] = used + take
    r.w = take
  }

  // 4) Re-normalize to 1.0 overlay notional
  const s2 = raws.reduce((a,b)=> a + b.w, 0) || 1
  return raws.map(r => ({
    id: r.s.id,
    curve: r.s.curve,
    tenorY: r.s.tenorY,
    weight: r.w / s2
  }))
}

/* ----------------------------- Example (remove in prod) -----------------------------
const t = Date.UTC(2025,8,1)
const curve: CurvePoint[] = [
  { ts:t, curve:'IN_GSEC', tenorY:1, yield:0.070 },
  { ts:t, curve:'IN_GSEC', tenorY:2, yield:0.071 },
  { ts:t, curve:'IN_GSEC', tenorY:5, yield:0.073 },
  { ts:t, curve:'IN_GSEC', tenorY:10, yield:0.075 },
]
const inst: Instrument[] = [
  { ts:t, curve:'IN_GSEC', id:'IN_2Y',  tenorY:2,  modDur:1.9 },
  { ts:t, curve:'IN_GSEC', id:'IN_5Y',  tenorY:5,  modDur:4.5 },
  { ts:t, curve:'IN_GSEC', id:'IN_10Y', tenorY:10, modDur:7.8 },
]
const sigs = durationTiltSignals(curve, inst, { horizonYears: 0.5 })
console.log('signals', sigs)
console.log('overlay', overlayTargetsFromSignals(sigs))
-------------------------------------------------------------------------------------- */