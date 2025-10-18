// fixed_income/curve_steepener.ts
// ------------------------------------------------------------
// Clean TS module to compute a “curve steepener” signal per rate curve.
// Idea: if the long end rises vs the front end (slope widens), a steepener
// (pay long-end / receive front-end, instrumented via futures/swaps) benefits.
//
// We compute for each curve:
//  - Slope (bps) = y(backTenor) − y(frontTenor)
//  - Momentum of the slope over a lookback window (bps change)
//  - Z-normalize both (using each curve’s own history), then blend
//
// Inputs are generic government (or swap) curve points across dates.
// Yields are DECIMAL (e.g., 0.072 = 7.2%). Tenors in YEARS.
//
// No imports. Drop into your fixed_income/ folder.
//
// ------------------------------------------------------------

type Num = number
type Ts  = number
type Str = string

export type CurvePointRow = {
  ts: Ts                 // timestamp (ms since epoch)
  curve: Str             // curve id, e.g., 'IN_GSEC', 'US_UST', 'EU_SWAP'
  tenorY: Num            // years (e.g., 0.25, 2, 5, 10, 30)
  yield: Num             // DECIMAL (e.g., 0.071 = 7.1%)
}

export type SteepenerParams = {
  frontTenor?: Num       // e.g., 2 (2y)
  backTenor?: Num        // e.g., 10 (10y)
  lookbackDays?: number  // momentum lookback in calendar days (default 60)
  clip?: number          // clip final score (abs) (default 3)
  winsorPct?: number     // winsorization for stats (default 0.02)
  minObs?: number        // min historical observations per curve (default 20)
}

export type SteepenerSignal = {
  ts: Ts
  curve: Str
  frontTenor: Num
  backTenor: Num
  slopeBps: Num          // current y(back)-y(front) in bps
  momBps: Num            // change in slope vs lookback in bps
  zSlope: Num            // z of slope within curve history
  zMom: Num              // z of mom within curve history
  score: Num             // blended score (higher = stronger steepener)
}

const DAY = 86_400_000

const DEF: Required<SteepenerParams> = {
  frontTenor: 2,
  backTenor: 10,
  lookbackDays: 60,
  clip: 3,
  winsorPct: 0.02,
  minObs: 20
}

const clamp = (v:number,a:number,b:number)=> Math.max(a, Math.min(b, v))

/* ------------------------------ helpers ------------------------------ */

function groupByCurve(rows: CurvePointRow[]){
  const m: Record<Str, CurvePointRow[]> = {}
  for(const r of rows){
    const c = String(r.curve||'').toUpperCase()
    if(!c) continue
    ;(m[c] ||= []).push(r)
  }
  for(const k in m) m[k].sort((a,b)=> a.ts - b.ts)
  return m
}

function interpYield(tenor: number, pts: CurvePointRow[]): number | undefined {
  if(!pts.length) return undefined
  // assume pts are for a single curve+date here
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
    return { mean:m, sd: Math.sqrt(v)||1e-6 }
  }
  const s = xs.slice().sort((a,b)=>a-b)
  const lo = s[Math.floor(p*(s.length-1))]
  const hi = s[Math.ceil((1-p)*(s.length-1))]
  const w = xs.map(v => clamp(v, lo, hi))
  const m = w.reduce((a,b)=>a+b,0)/w.length
  const v = w.reduce((a,b)=>a+(b-m)*(b-m),0)/w.length
  return { mean:m, sd: Math.sqrt(v)||1e-6 }
}

/* ------------------------------ core ------------------------------ */
/**
 * For each curve, build a daily/dated time-series of the *slope* between two tenors.
 * Then compute the current slope and its momentum vs a lookback date.
 * Finally z-normalize within the curve history and blend into a single score.
 *
 * Score definition (simple, robust):
 *   score = 0.6 * zMom + 0.4 * zSlope, clipped to [-clip, +clip]
 * (Use zMom to capture directional impulse, zSlope to avoid extremes.)
 */
export function curveSteepenerSignals(rows: CurvePointRow[], params: SteepenerParams = {}): SteepenerSignal[] {
  const cfg = { ...DEF, ...params }
  const curves = groupByCurve(rows)

  const out: SteepenerSignal[] = []

  for(const curve in curves){
    // 1) Re-bucket by ts (each date ⇒ set of points for that curve)
    const all = curves[curve]
    const byTs: Record<string, CurvePointRow[]> = {}
    for(const p of all){
      const key = String(p.ts)
      ;(byTs[key] ||= []).push(p)
    }
    const dates = Object.keys(byTs).map(x=> +x).sort((a,b)=> a-b)
    if(dates.length < cfg.minObs) continue

    // 2) Build slope series (bps)
    type Pt = { ts:Ts; slopeBps:number }
    const slopeSeries: Pt[] = []
    for(const t of dates){
      const pts = byTs[String(t)]
      const yf = interpYield(cfg.frontTenor, pts)
      const yb = interpYield(cfg.backTenor, pts)
      if(isFinite(yf as number) && isFinite(yb as number)){
        slopeSeries.push({ ts: t, slopeBps: ((yb as number) - (yf as number)) * 10_000 })
      }
    }
    if(slopeSeries.length < cfg.minObs) continue

    // 3) Current & lookback slope
    const cur = slopeSeries[slopeSeries.length-1]
    // find earliest point >= (cur.ts - lookbackDays)
    const baseCut = cur.ts - cfg.lookbackDays*DAY
    let baseIdx = 0
    for(let i=0;i<slopeSeries.length;i++){
      if(slopeSeries[i].ts >= baseCut){ baseIdx = i; break }
    }
    const base = slopeSeries[baseIdx]
    const momBps = cur.slopeBps - base.slopeBps

    // 4) Stats for z-scores (per curve)
    const slopes = slopeSeries.map(p=>p.slopeBps)
    const moms   = slopeSeries
      .map((p,i)=> (i===0? 0 : p.slopeBps - slopeSeries[Math.max(0,i- Math.max(1, Math.round(cfg.lookbackDays/7)))].slopeBps)) // rough history for mom dispersion
      .slice(1) // drop first
    const { mean: mSlope, sd: sdSlope } = winsorStats(slopes, cfg.winsorPct)
    const { mean: mMom,   sd: sdMom   } = winsorStats(moms.length? moms : [0], cfg.winsorPct)

    const zSlope = (cur.slopeBps - mSlope) / (sdSlope || 1e-6)
    const zMom   = (momBps - mMom)       / (sdMom   || 1e-6)

    // 5) Blend and clip
    const raw = 0.6 * zMom + 0.4 * zSlope
    const score = clamp(raw, -Math.abs(cfg.clip), Math.abs(cfg.clip))

    out.push({
      ts: cur.ts,
      curve,
      frontTenor: cfg.frontTenor,
      backTenor:  cfg.backTenor,
      slopeBps: cur.slopeBps,
      momBps,
      zSlope,
      zMom,
      score
    })
  }

  return out
}

/* ------------------------------ Example (remove in prod) ------------------------------
const t0 = Date.UTC(2025,7,1)
function mk(ts:number, curve:Str, xs: Array<[number, number]>): CurvePointRow[] {
  return xs.map(([tenor, y]) => ({ ts, curve, tenorY: tenor, yield: y }))
}
const rows: CurvePointRow[] = []
for(let d=0; d<80; d++){
  const ts = t0 + d*DAY
  // toy IN_GSEC curve gradually steepening: 2y ~ 7.0%→7.2%, 10y ~ 7.0%→7.6%
  rows.push(...mk(ts, 'IN_GSEC', [
    [1, 0.070 + 0.0005*d/80],
    [2, 0.071 + 0.0006*d/80],
    [5, 0.072 + 0.0015*d/80],
    [10,0.070 + 0.0030*d/80]
  ]))
  // toy US_UST flatter
  rows.push(...mk(ts, 'US_UST', [
    [2, 0.040 + 0.0005*d/80],
    [10,0.042 + 0.0006*d/80]
  ]))
}
console.log(curveSteepenerSignals(rows, { frontTenor:2, backTenor:10, lookbackDays:60 }))
----------------------------------------------------------------------------------------- */