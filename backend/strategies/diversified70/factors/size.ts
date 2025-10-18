// factors/size.ts
// SIZE factor (a.k.a. “SMB”): smaller market-cap => higher score.
// Pure TS, no imports. Cross-sectional z-scores with optional winsorization & currency scaling.

type Str = string
type Num = number
type Ts  = number

/** You can feed either marketCap directly OR (close * sharesOut). */
export type CapRow = {
  ts: Ts                     // timestamp (ms since epoch)
  ticker: Str
  marketCap?: Num            // in native currency
  close?: Num                // fallback for cap = close * sharesOut
  sharesOut?: Num            // shares outstanding (same date as close)
  ccy?: Str                  // optional, e.g., 'INR','USD' (for FX scaling)
}

export type SizeParams = {
  preferMarketCap?: boolean  // if true, use marketCap when present (default true)
  fxToBase?: Record<Str, Num>// map currency -> FX rate to BASE (e.g., { USD:83, INR:1 })
  logCap?: boolean           // take ln(cap) before scoring (default true)
  winsorPct?: number         // winsorize tails (0..0.2) before z-score (default 0.02)
  clip?: number              // clip final score (abs) (default 3)
  latestPerTicker?: boolean  // use only latest point per ticker (default true)
}

export type SizeScore = {
  ts: Ts
  ticker: Str
  capBase: Num               // market cap converted to base currency
  score: Num                 // higher => smaller size (defensive tilt)
}

const DEF: Required<SizeParams> = {
  preferMarketCap: true,
  fxToBase: { INR: 1, USD: 83, EUR: 90, JPY: 0.55 }, // edit to your setup
  logCap: true,
  winsorPct: 0.02,
  clip: 3,
  latestPerTicker: true
}

const clamp = (v:number,a:number,b:number)=> Math.max(a, Math.min(b, v))

/* ------------------------- helpers ------------------------- */
function groupLatest(rows: CapRow[]): Record<Str, CapRow> {
  const map: Record<Str, CapRow> = {}
  for(const r of rows){
    const k = String(r.ticker||'').toUpperCase()
    if(!k) continue
    if(!map[k] || (map[k].ts < r.ts)) map[k] = r
  }
  return map
}
function groupAll(rows: CapRow[]): Record<Str, CapRow[]> {
  const map: Record<Str, CapRow[]> = {}
  for(const r of rows){
    const k = String(r.ticker||'').toUpperCase()
    if(!k) continue
    ;(map[k] ||= []).push(r)
  }
  for(const k in map) map[k].sort((a,b)=> a.ts - b.ts)
  return map
}
function winsorize(xs:number[], p:number){
  if(!(p>0) || xs.length<3) return xs.slice()
  const s = xs.slice().sort((a,b)=>a-b)
  const lo = s[Math.floor(p*(s.length-1))]
  const hi = s[Math.ceil((1-p)*(s.length-1))]
  return xs.map(v => clamp(v, lo, hi))
}

/* ---------------------- core: compute cap ---------------------- */
function capToBase(r: CapRow, preferMarketCap: boolean, fxToBase: Record<Str,Num>): number | null {
  let cap: number | undefined = undefined
  if(preferMarketCap && r.marketCap && r.marketCap>0){
    cap = r.marketCap
  } else if(r.close && r.close>0 && r.sharesOut && r.sharesOut>0){
    cap = r.close * r.sharesOut
  }
  if(!(cap && cap>0)) return null
  const fx = fxToBase[(r.ccy||'').toUpperCase()] ?? 1
  return cap * fx
}

/* ------------------------- API ------------------------- */
/**
 * Compute SIZE factor scores:
 *  - Convert cap to base currency
 *  - Optionally take ln(cap)
 *  - Winsorize, z-score cross-sectionally
 *  - Return score = -(z) so that *smaller cap => higher score*
 */
export function sizeScores(rows: CapRow[], params: SizeParams = {}): SizeScore[] {
  const cfg = { ...DEF, ...params }

  // 1) choose latest row per ticker or use last observation per ticker from full history
  const universe: CapRow[] = []
  if(cfg.latestPerTicker){
    const latest = groupLatest(rows)
    for(const t in latest) universe.push(latest[t])
  } else {
    const all = groupAll(rows)
    for(const t in all) if(all[t].length) universe.push(all[t][all[t].length-1])
  }
  if(!universe.length) return []

  // 2) map to cap (base) + feature value
  const keep: { ts:Ts; ticker:Str; capBase:number; feat:number }[] = []
  for(const r of universe){
    const capB = capToBase(r, cfg.preferMarketCap, cfg.fxToBase)
    if(capB === null) continue
    const feat = cfg.logCap ? Math.log(capB) : capB
    keep.push({ ts: r.ts, ticker: String(r.ticker).toUpperCase(), capBase: capB, feat })
  }
  if(!keep.length) return []

  // 3) winsorize & z-score
  const feats = keep.map(k=>k.feat)
  const w = winsorize(feats, cfg.winsorPct)
  const mean = w.reduce((a,b)=>a+b,0)/w.length
  const varSum = w.reduce((a,b)=> a+(b-mean)*(b-mean), 0)
  const sd = Math.sqrt(varSum / Math.max(1, w.length)) || 1e-6

  const clipAbs = Math.max(0.5, cfg.clip)
  const out: SizeScore[] = []
  for(let i=0;i<keep.length;i++){
    const z = (w[i] - mean) / sd
    const score = clamp(-z, -clipAbs, clipAbs) // smaller => higher score
    out.push({ ts: keep[i].ts, ticker: keep[i].ticker, capBase: keep[i].capBase, score })
  }
  return out
}

/* --------------------- convenience utils --------------------- */
/** Build rows from price + shares maps (same timestamp). */
export function rowsFromMaps(ts:Ts, prices: Record<Str,Num>, shares: Record<Str,Num>, ccy='INR'): CapRow[] {
  const out: CapRow[] = []
  for(const t in prices){
    const px = prices[t]
    const so = shares[t]
    if(px>0 && so>0) out.push({ ts, ticker: t, close: px, sharesOut: so, ccy })
  }
  return out
}

/* ================= Example (remove in prod) =================
const t = Date.now()
const prices = { AAA: 100, BBB: 50,  CCC: 20 }
const shares = { AAA: 1_000_000, BBB: 5_000_000, CCC: 50_000_000 }
console.log(sizeScores(rowsFromMaps(t, prices, shares, 'INR'), { logCap:true }))
*/