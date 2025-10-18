// factors/momentum.ts
// Cross-sectional Momentum factor.
// Computes k-day momentum per ticker (optionally vol-scaled + MA gate)
// and returns clipped z-style scores in [-3, +3]. Pure TS, no imports.

type Num = number
type Ts  = number

export type PxRow = {
  ts: Ts            // ms since epoch (can be unsorted; we'll sort)
  ticker: string
  px: Num           // close price (>0)
}

export type MomParams = {
  lookbackDays?: number      // k: momentum lookback horizon (default 60 calendar days)
  gapDays?: number           // skip recent 'gap' days to avoid short-term reversal (default 1)
  volLookbackDays?: number   // window for stdev of daily log returns (default 30)
  useVolScale?: boolean      // scale by volatility (default true)
  useMaGate?: boolean        // MA(fast)>MA(slow) gate (default true)
  fastDays?: number          // fast MA length (default 20)
  slowDays?: number          // slow MA length (default 60)
  annTradingDays?: number    // annualization base for info-style scaling (default 252)
  clip?: number              // clip final score (abs) (default 3)
  minPoints?: number         // min rows per ticker (default 20)
}

export type MomentumScore = {
  ts: Ts
  ticker: string
  ret: Num                 // k-day log return from base->eval point
  score: Num               // higher is better; clipped to [-clip, +clip]
}

/* =================== Defaults & Helpers =================== */
const DEF = {
  lookbackDays: 60,
  gapDays: 1,
  volLookbackDays: 30,
  useVolScale: true,
  useMaGate: true,
  fastDays: 20,
  slowDays: 60,
  annTradingDays: 252,
  clip: 3,
  minPoints: 20
}

const DAY = 86_400_000
const clamp = (v:number,a:number,b:number)=> Math.max(a, Math.min(b, v))

function groupByTicker(rows: PxRow[]){
  const m: Record<string, PxRow[]> = {}
  for(const r of rows){
    const k = String(r.ticker||'').toUpperCase()
    if(!k) continue
    ;(m[k] ||= []).push(r)
  }
  for(const k in m) m[k].sort((a,b)=> a.ts-b.ts)
  return m
}

function logret(a:number,b:number){ return (a>0 && b>0) ? Math.log(b/a) : 0 }

/** SMA of last N closes (return NaN if not enough). */
function sma(px: number[], n: number){
  if(px.length < n || n<=0) return NaN
  let s=0; for(let i=px.length-n;i<px.length;i++) s += px[i]
  return s/n
}

/** stdev over last N daily log returns (population-ish). */
function stdevDailyRets(px:number[], n:number){
  if(px.length<2 || n<=1) return NaN
  const rets:number[] = []
  for(let i=Math.max(1, px.length-n); i<px.length; i++){
    rets.push(logret(px[i-1], px[i]))
  }
  if(!rets.length) return NaN
  const m = rets.reduce((a,b)=>a+b,0)/rets.length
  let v=0; for(const r of rets){ const d=r-m; v += d*d }
  v /= rets.length
  return Math.sqrt(Math.max(0,v))
}

/* =================== Core =================== */
/**
 * Momentum score per ticker:
 * 1) Base time = last.ts - gapDays - lookbackDays (calendar days)
 * 2) k-day log return = ln(P_eval / P_base)
 * 3) Optional vol scaling: divide by (sd_daily * sqrt(lookbackDays/annTradingDays))
 * 4) Optional MA gate: if SMA(fast) < SMA(slow), flip/dampen sign (×0.5)
 * 5) Cross-sectional standardize? (Not required here; keep absolute, then clip)
 */
export function momentumScores(rows: PxRow[], params: MomParams = {}): MomentumScore[] {
  const cfg = { ...DEF, ...params }
  const buckets = groupByTicker(rows)

  const out: MomentumScore[] = []
  for(const ticker in buckets){
    const series = buckets[ticker]
    if(series.length < cfg.minPoints) continue

    const closes = series.map(r=>r.px)
    const last = series[series.length-1]
    if(!(last && last.px>0)) continue

    // Determine eval time with gap (avoid using T-0 close if you want T-1)
    const evalTs = last.ts - cfg.gapDays*DAY
    // Find base index at/after (evalTs - lookbackDays*DAY)
    const baseCut = evalTs - cfg.lookbackDays*DAY
    let baseIdx = -1
    for(let i=0;i<series.length;i++){ if(series[i].ts >= baseCut){ baseIdx = i; break } }
    if(baseIdx < 0) baseIdx = Math.max(0, series.length-1 - cfg.lookbackDays) // fallback by count
    // Find evaluation index (closest at/after evalTs)
    let evalIdx = series.length-1
    for(let i=series.length-1;i>=0;i--){ if(series[i].ts <= evalTs){ evalIdx = i; break } }

    const p0 = series[baseIdx]?.px
    const p1 = series[evalIdx]?.px
    if(!(p0>0 && p1>0)) continue
    let kret = logret(p0, p1)

    // Vol scaling
    if(cfg.useVolScale){
      const sd = stdevDailyRets(closes, cfg.volLookbackDays) || 1e-6
      // scale by sqrt(k/ann) to approximate info-ratio flavor
      const kOverAnn = Math.sqrt(Math.max(1, cfg.lookbackDays)/cfg.annTradingDays)
      kret = kret / (sd * kOverAnn)
    }

    // MA gate (trend confirmation)
    if(cfg.useMaGate){
      const f = sma(closes, cfg.fastDays)
      const s = sma(closes, cfg.slowDays)
      if(isFinite(f) && isFinite(s)){
        if(f < s) kret *= 0.5  // damp if trend disagrees
      }
    }

    // Clip to [-clip, +clip] and push
    const score = clamp(kret, -Math.abs(cfg.clip), Math.abs(cfg.clip))
    out.push({ ts: series[evalIdx].ts, ticker, ret: logret(p0,p1), score })
  }

  return out
}

/* =================== Example (remove in prod) ===================

const t0 = Date.UTC(2025,8,1)
const mk = (i:number, px:number, tkr:string):PxRow => ({ ts: t0 + i*DAY, px, ticker: tkr })
const demo: PxRow[] = []
for(let i=0;i<90;i++){
  demo.push(mk(i, 100 + i*0.15 + Math.sin(i/5)*0.8, 'ALFA')) // trending up
  demo.push(mk(i, 100 + Math.sin(i/2)*3, 'BETA'))           // choppy
  demo.push(mk(i, 100 - i*0.1, 'GAMA'))                      // trending down
}
console.log(momentumScores(demo, { lookbackDays:60, useVolScale:true, useMaGate:true }))

*/