// fx/volatility.ts
// FX volatility utilities: realized vol, EWMA vol, simple GARCH(1,1) step,
// ATR-like range vol, z-scores, bands, percentile ranks, and vol-target sizing.
// Pure TS, no imports.

type Num = number
type Ts  = number
type Str = string

export type FxPair  = `${string}${string}${string}${string}${string}${string}` | string
export type FxQuote = { t: Ts; pair: FxPair; px: Num }                 // close-only
export type FxBar   = { t: Ts; pair: FxPair; o:Num; h:Num; l:Num; c:Num } // OHLC
export type VolPoint = { t: Ts; vol: Num }
export type Band = { t: Ts; mid: Num; upper: Num; lower: Num }
export type Alert = { t: Ts; pair: FxPair; kind: 'sigma-move'|'vol-spike'; msg: Str; value: Num; ref?: Num }

const DAY = 86_400_000

/* ================= Helpers ================= */
const clamp = (v:number,a:number,b:number)=> Math.max(a, Math.min(b, v))
function sortByTime<T extends {t:Ts}>(arr:T[]): T[]{ return arr.slice().sort((a,b)=> a.t-b.t) }
function logret(a:number,b:number){ return (a>0 && b>0) ? Math.log(b/a) : 0 }
function mean(x:number[]){ if(!x.length) return 0; let s=0; for(const v of x) s+=v; return s/x.length }
function stdev(x:number[]){ if(x.length<2) return 0; const m=mean(x); let v=0; for(const xi of x){ const d=xi-m; v+=d*d } return Math.sqrt(v/(x.length-1)) }
function rolling<T>(x:T[], n:number, f:(win:T[], i:number)=>void){
  const N = Math.max(1, n)
  for(let i=N-1;i<x.length;i++){ f(x.slice(i-N+1,i+1), i) }
}

/* ================= Realized vol (close-to-close, annualized) ================= */
/** k-day realized vol from log returns. Returns array aligned to the last point of each window. */
export function realizedVol(quotes: FxQuote[], lookback=20, tradingDaysPerYear=252): VolPoint[] {
  const q = sortByTime(quotes)
  const rets: number[] = []
  for(let i=1;i<q.length;i++) rets.push(logret(q[i-1].px, q[i].px))
  const out: VolPoint[] = []
  rolling(rets, lookback, (win, i)=>{
    const sd = stdev(win)
    const ann = sd * Math.sqrt(tradingDaysPerYear)
    const t = q[i+1].t // align to end bar
    out.push({ t, vol: ann })
  })
  return out
}

/* ================= EWMA vol (RiskMetrics-style) ================= */
export function ewmaVol(quotes: FxQuote[], lambda=0.94, tradingDaysPerYear=252): VolPoint[] {
  const q = sortByTime(quotes)
  if(q.length<2) return []
  let prev = 0
  const out: VolPoint[] = []
  for(let i=1;i<q.length;i++){
    const r = logret(q[i-1].px, q[i].px)
    const sigma2 = lambda*prev + (1-lambda)*r*r
    prev = sigma2
    const ann = Math.sqrt(sigma2) * Math.sqrt(tradingDaysPerYear)
    out.push({ t:q[i].t, vol: ann })
  }
  return out
}

/* ================= Simple GARCH(1,1) one-pass estimate ================= */
export function garch11Vol(
  quotes: FxQuote[],
  params = { omega: 1e-6, alpha: 0.05, beta: 0.9 },
  tradingDaysPerYear=252
): VolPoint[] {
  const { omega, alpha, beta } = params
  const q = sortByTime(quotes)
  if(q.length<2) return []
  let sigma2 = 0
  const out: VolPoint[] = []
  for(let i=1;i<q.length;i++){
    const r = logret(q[i-1].px, q[i].px)
    sigma2 = omega + alpha*(r*r) + beta*sigma2
    const ann = Math.sqrt(Math.max(sigma2,0)) * Math.sqrt(tradingDaysPerYear)
    out.push({ t:q[i].t, vol: ann })
  }
  return out
}

/* ================= ATR-like range vol (Parkinson-style proxy) ================= */
export function rangeVol(bars: FxBar[], lookback=14, tradingDaysPerYear=252): VolPoint[] {
  const b = sortByTime(bars)
  const rngRets = b.map(x => x.h>0 && x.l>0 ? Math.log(x.h/x.l) : 0)
  const out: VolPoint[] = []
  rolling(rngRets, lookback, (win, i)=>{
    // Parkinson estimator: sigma^2 ≈ (1/(4 ln2)) * mean((ln(H/L))^2)
    const c = 1/(4*Math.log(2))
    const m2 = mean(win.map(w=> w*w))
    const daily = Math.sqrt(c * m2)
    const ann = daily * Math.sqrt(tradingDaysPerYear)
    out.push({ t: b[i].t, vol: ann })
  })
  return out
}

/* ================= Z-score & Bands ================= */
export function zScores(quotes: FxQuote[], lookback=20): { t:Ts; z:number }[] {
  const q = sortByTime(quotes)
  const out: {t:Ts; z:number}[] = []
  const px = q.map(x=>x.px)
  rolling(px, lookback, (win, i)=>{
    const m = mean(win)
    const s = stdev(win)
    const z = s>0 ? (px[i] - m)/s : 0
    out.push({ t: q[i].t, z })
  })
  return out
}

export function bollingerBands(quotes: FxQuote[], lookback=20, k=2): Band[] {
  const q = sortByTime(quotes)
  const out: Band[] = []
  const px = q.map(x=>x.px)
  rolling(px, lookback, (win, i)=>{
    const m = mean(win)
    const s = stdev(win)
    out.push({ t:q[i].t, mid:m, upper:m + k*s, lower:m - k*s })
  })
  return out
}

/* ================= Percentile rank of rolling vol ================= */
export function volPercentile(volSeries: VolPoint[], lookback=252): { t:Ts; pct:number }[] {
  const v = sortByTime(volSeries)
  const out: {t:Ts; pct:number}[] = []
  for(let i=0;i<v.length;i++){
    const start = Math.max(0, i - lookback + 1)
    const win = v.slice(start, i+1).map(x=>x.vol)
    const cur = v[i].vol
    let rank = 0
    for(const x of win) if(x <= cur) rank++
    const pct = win.length ? rank / win.length : 0
    out.push({ t:v[i].t, pct })
  }
  return out
}

/* ================= Vol-target position sizing ================= */
/**
 * Return a weight in [-1,1] to hit target annualized volatility on a position.
 * Example: if realized vol is 10% and target is 8%, weight = 0.8.
 */
export function volTargetWeight(currentAnnVol:number, targetAnnVol=0.08, cap=1.0){
  if(!(currentAnnVol>0)) return 0
  return clamp(targetAnnVol / currentAnnVol, -cap, cap)
}

/* ================= Sigma-move alerts ================= */
/**
 * Detect moves larger than N sigma (based on rolling stdev of daily returns).
 * Returns alert objects with magnitude in sigma.
 */
export function sigmaMoveAlerts(quotes: FxQuote[], lookback=20, threshold=2.5): Alert[] {
  const q = sortByTime(quotes)
  if(q.length<lookback+1) return []
  // daily returns
  const rets: number[] = []
  for(let i=1;i<q.length;i++) rets.push(logret(q[i-1].px, q[i].px))
  const out: Alert[] = []
  // rolling stdev up to previous day
  for(let i=lookback; i<rets.length; i++){
    const win = rets.slice(i-lookback, i)
    const sd = stdev(win) || 1e-9
    const z = rets[i] / sd
    if(Math.abs(z) >= threshold){
      out.push({ t: q[i+1].t, pair: q[i+1].pair, kind:'sigma-move', msg:`${z.toFixed(2)}σ move`, value: z })
    }
  }
  return out
}

/* ================= Vol spike alerts (EWMA change) ================= */
export function volSpikeAlerts(quotes: FxQuote[], lambda=0.94, spikeFactor=1.75): Alert[] {
  const q = sortByTime(quotes)
  if(q.length<3) return []
  let prev=0
  const out: Alert[] = []
  for(let i=1;i<q.length;i++){
    const r = logret(q[i-1].px, q[i].px)
    const sigma2 = lambda*prev + (1-lambda)*r*r
    const sigma = Math.sqrt(Math.max(sigma2,0))
    if(prev>0){
      const prevSigma = Math.sqrt(prev)
      if(sigma > prevSigma * spikeFactor){
        out.push({ t:q[i].t, pair:q[i].pair, kind:'vol-spike', msg:`EWMA vol x${(sigma/prevSigma).toFixed(2)}`, value: sigma, ref: prevSigma })
      }
    }
    prev = sigma2
  }
  return out
}

/* ================= Convenience: build quotes from arrays ================= */
export function zipToQuotes(pair: FxPair, t0:Ts, stepMs:number, prices:number[]): FxQuote[] {
  return prices.map((p,i)=> ({ t: t0 + i*stepMs, pair, px: p }))
}

/* ================= Example (comment out in prod) =================
const t0 = Date.UTC(2025,8,1)
const series = zipToQuotes('EURUSD', t0, DAY, [1.09,1.10,1.11,1.10,1.12,1.13,1.14,1.145,1.15,1.14,1.13,1.135])
console.log('realized', realizedVol(series).slice(-1))
console.log('ewma', ewmaVol(series).slice(-1))
console.log('bands', bollingerBands(series).slice(-1))
console.log('sigma alerts', sigmaMoveAlerts(series))
*/