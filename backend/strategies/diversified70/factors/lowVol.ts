// factors/lowvol.ts
// Cross-sectional Low Volatility factor (a.k.a. defensive).
// Computes realized volatility per ticker over a lookback window,
// then scores stocks by *lower* vol = higher score.
// Pure TS, no imports.

type Num = number
type Ts  = number

export type PxRow = {
  ts: Ts           // timestamp in ms (ascending or mixed; we sort inside)
  ticker: string
  px: Num          // close price
}

export type LowVolParams = {
  lookback?: number          // trading days for realized vol (default 60)
  annFactor?: number         // annualization (default 252)
  minPoints?: number         // minimum points per ticker (default 40)
  clip?: number              // clip final z-scores (default 3)
  winsorPct?: number         // winsorize vol at pct tails (0..0.2, default 0.02)
}

export type LowVolScore = {
  ts: Ts
  ticker: string
  volAnn: Num               // annualized realized vol (e.g., 0.22 = 22%)
  score: Num               // higher is better (lower vol => higher score), z-scored & clipped
}

const DEF: Required<LowVolParams> = {
  lookback: 60,
  annFactor: 252,
  minPoints: 40,
  clip: 3,
  winsorPct: 0.02
}

const clamp = (v:number,a:number,b:number)=> Math.max(a, Math.min(b, v))

/** Compute per-ticker realized (close-to-close) annualized volatility. */
function realizedVolAnn(rows: PxRow[], lookback: number, ann: number, minPts: number): LowVolScore[] {
  // group by ticker
  const byT: Record<string, PxRow[]> = {}
  for(const r of rows){
    const k = String(r.ticker).toUpperCase()
    ;(byT[k] ||= []).push(r)
  }

  const out: LowVolScore[] = []
  for(const t in byT){
    const s = byT[t].slice().sort((a,b)=> a.ts - b.ts)
    if(s.length < minPts) continue

    // compute log returns
    const rets: number[] = []
    for(let i=1;i<s.length;i++){
      const a = s[i-1].px, b = s[i].px
      if(a>0 && b>0) rets.push(Math.log(b/a))
    }
    if(rets.length < Math.max(lookback, minPts-1)) continue

    // window = last `lookback` returns (or all if shorter)
    const win = rets.slice(-lookback)
    const m = win.reduce((acc,x)=>acc+x,0)/win.length
    let v = 0
    for(const x of win){ const d = x - m; v += d*d }
    v /= Math.max(1, win.length) // population-like
    const sd = Math.sqrt(Math.max(0, v))
    const volAnn = sd * Math.sqrt(ann)

    out.push({ ts: s[s.length-1].ts, ticker: t, volAnn, score: 0 })
  }
  return out
}

/** Winsorize vol values to reduce outlier impact. */
function winsorize(vols: number[], p: number){
  if(!(p>0)) return vols.slice()
  const arr = vols.slice().sort((a,b)=>a-b)
  const loIdx = Math.floor(p * (arr.length-1))
  const hiIdx = Math.ceil((1-p) * (arr.length-1))
  const lo = arr[loIdx], hi = arr[hiIdx]
  return vols.map(x => clamp(x, lo, hi))
}

/**
 * Main API: compute LowVol factor scores.
 * - Lower volatility -> higher score.
 * - Cross-sectional z-score of negative vol (or inverse vol).
 */
export function lowVolScores(rows: PxRow[], params: LowVolParams = {}): LowVolScore[] {
  const cfg = { ...DEF, ...params }
  const vols = realizedVolAnn(rows, cfg.lookback, cfg.annFactor, cfg.minPoints)
  if(!vols.length) return []

  // winsorize volAnn before scoring
  const w = winsorize(vols.map(x=>x.volAnn), cfg.winsorPct)
  const mean = w.reduce((a,b)=>a+b,0)/w.length
  const varSum = w.reduce((a,b)=> a + (b-mean)*(b-mean), 0)
  const sd = Math.sqrt(varSum / Math.max(1, w.length)) || 1e-6

  // Convert to scores: lower vol => higher score.
  // score_raw = -(vol - mean)/sd  => z of *negative* vol
  const clip = Math.max(0.5, cfg.clip)
  return vols.map((r, i) => {
    const z = -((w[i] - mean) / sd)
    return { ...r, score: clamp(z, -clip, clip) }
  })
}

/* ===================== Example (remove in prod) =====================

const DAY = 86_400_000
const mk = (t:number, px:number, ticker:string):PxRow => ({ ts:t, px, ticker })
const t0 = Date.UTC(2025,8,1)
const sample: PxRow[] = []
for(let i=0;i<90;i++){
  sample.push(mk(t0+i*DAY, 100+Math.sin(i/4)*2 + i*0.05, 'AAA'))
  sample.push(mk(t0+i*DAY, 100+Math.sin(i/2)*5, 'BBB'))
  sample.push(mk(t0+i*DAY, 100+Math.random()*1.5, 'CCC'))
}
console.log(lowVolScores(sample, { lookback:60 }))

*/