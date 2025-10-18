// factors/quality.ts
// Multi-pillar QUALITY factor (profitability, safety/leverage, earnings quality, stability).
// Pure TS, no imports. Works with generic fundamentals "rows" from your schema.
//
// Expected flexible fields (case-insensitive, partial matches ok):
//  Profitability: ROE, ROA, GrossMargin, OperatingMargin, NetMargin, EBIT/Assets
//  Safety: Debt/Equity, Leverage, InterestCoverage, CurrentRatio
//  Earnings quality: CFO, OCF, FCF, NetIncome, TotalAssets, TotalEquity
//  (You can feed any subset; the factor uses what's available.)

type Str = string
type Num = number
type Ts  = number

export type FundRow = { date: string|number; symbol: Str; field: Str; value: Num }
export type SeriesPt = { t: Ts; v: Num }
export type QualitySignal = { id: Str; symbol: Str; value: Num; ts: Ts }

const ID = 'factor_quality'
const DAY = 86_400_000

/* ===================== Field matchers ===================== */
function has(f:Str, rx:RegExp){ return rx.test(f.toUpperCase()) }
function isROE(f:Str){ return has(f, /ROE|RETURN\s*ON\s*EQUITY/) }
function isROA(f:Str){ return has(f, /ROA|RETURN\s*ON\s*ASSETS/) }
function isGM(f:Str){ return has(f, /GROSS\s*MARGIN|GMARGIN|GPM/) }
function isOPM(f:Str){ return has(f, /OPERAT(ING)?\s*MARGIN|OPM|EBIT\s*MARGIN/) }
function isNPM(f:Str){ return has(f, /NET\s*MARGIN|NPM/) }
function isEBITonA(f:Str){ return has(f, /EBIT.*ASSETS|EBIT\/ASSETS|EBITDA.*ASSETS/) }

function isDE(f:Str){ return has(f, /(DEBT.*EQUITY|D\/E|DE\/RATIO|LEVERAGE)/) }
function isIC(f:Str){ return has(f, /INTEREST\s*COVER|ICR|TIMES\s*INTEREST\s*EARN/) }
function isCR(f:Str){ return has(f, /CURRENT\s*RATIO|LIQUIDITY\s*RATIO/) }

function isCFO(f:Str){ return has(f, /(CASH\s*FLOW\s*FROM\s*OPER|CFO|OCF)/) }
function isFCF(f:Str){ return has(f, /FREE\s*CASH\s*FLOW|FCF/) }
function isNI(f:Str){ return has(f, /(NET\s*INCOME|PAT|EARNINGS)$/) }
function isTA(f:Str){ return has(f, /(TOTAL\s*ASSET|TA)$/) }
function isTE(f:Str){ return has(f, /(TOTAL\s*EQUIT|SHAREHOLDERS.*EQUIT)/) }

/* ===================== Helpers ===================== */
const clamp = (v:number,a:number,b:number)=> Math.max(a, Math.min(b, v))
const toMs = (d:string|number)=> typeof d==='number'? d : Date.parse(d)
function sortByT<T extends {t:Ts}>(a:T[]){ return a.sort((x,y)=> x.t-y.t) }
function last<T>(arr:T[]){ return arr.length? arr[arr.length-1]: undefined }

/** Resample to quarterly cadence (keep last point in each ~92d bin) */
function resampleQuarterly(xs: SeriesPt[]): SeriesPt[] {
  if(xs.length===0) return []
  const out: SeriesPt[] = []
  let binStart = xs[0].t
  let cur: SeriesPt | null = null
  for(const p of xs){
    if(p.t - binStart > 92*DAY){ if(cur) out.push(cur); binStart = p.t; cur = p }
    else cur = p
  }
  if(cur) out.push(cur)
  return out
}

/** Robust z-like map: centers reference around 0, scales by a heuristic. */
function zmap(x:number, ref:number, scale:number, hardClip=3){
  if(!isFinite(x)) return 0
  const z = (x - ref) / (scale || 1e-6)
  return clamp(z, -hardClip, hardClip)
}

/** Positive-to-better (already a % margin/return). Assumes typical ranges. */
function scoreProfitMetric(pct:number, median=0.10, scale=0.07){
  return zmap(pct, median, scale, 3) // e.g., 10% median, 7% scale
}

/** Negative-to-worse (e.g., D/E higher is worse) */
function scoreInverseMetric(x:number, targetLow=0.5, scale=0.4){
  // smaller is better ⇒ invert around a target
  return zmap(-x, -targetLow, scale, 3)
}

/** Volatility penalty: lower vol is better. */
function penaltyFromStdev(values:number[], scale=0.05, cap=2){
  if(values.length<3) return 0
  const m = values.reduce((a,b)=>a+b,0)/values.length
  const v = values.reduce((a,b)=> a+(b-m)*(b-m), 0)/values.length
  const sd = Math.sqrt(Math.max(0,v))
  return -clamp(sd/scale, 0, cap) // penalize up to -cap
}

/* ===================== Core ===================== */
export function qualitySignalsFromFundamentals(rows: FundRow[]): QualitySignal[] {
  // 1) Bucket points by symbol
  type Buck = {
    roe: SeriesPt[]; roa: SeriesPt[]; gm: SeriesPt[]; opm: SeriesPt[]; npm: SeriesPt[]; ebitA: SeriesPt[];
    de: SeriesPt[]; ic: SeriesPt[]; cr: SeriesPt[];
    cfo: SeriesPt[]; fcf: SeriesPt[]; ni: SeriesPt[]; ta: SeriesPt[]; te: SeriesPt[];
  }
  const bySym: Record<Str, Buck> = {}
  for(const r of rows){
    const t = toMs(r.date); if(!isFinite(t)) continue
    const sym = String(r.symbol||'').toUpperCase(); if(!sym) continue
    const v = Number(r.value); if(!isFinite(v)) continue
    const b = (bySym[sym] ||= { roe:[],roa:[],gm:[],opm:[],npm:[],ebitA:[], de:[],ic:[],cr:[], cfo:[],fcf:[],ni:[],ta:[],te:[] })
    const f = r.field || ''
    if(isROE(f)) b.roe.push({t,v})
    else if(isROA(f)) b.roa.push({t,v})
    else if(isGM(f)) b.gm.push({t,v})
    else if(isOPM(f)) b.opm.push({t,v})
    else if(isNPM(f)) b.npm.push({t,v})
    else if(isEBITonA(f)) b.ebitA.push({t,v})
    else if(isDE(f)) b.de.push({t,v})
    else if(isIC(f)) b.ic.push({t,v})
    else if(isCR(f)) b.cr.push({t,v})
    else if(isCFO(f)) b.cfo.push({t,v})
    else if(isFCF(f)) b.fcf.push({t,v})
    else if(isNI(f)) b.ni.push({t,v})
    else if(isTA(f)) b.ta.push({t,v})
    else if(isTE(f)) b.te.push({t,v})
  }

  const out: QualitySignal[] = []

  // 2) Build per-symbol quality score
  for(const sym in bySym){
    const bk = bySym[sym]
    const q = (xs:SeriesPt[]) => sortByT(resampleQuarterly(xs))
    const roe = q(bk.roe), roa = q(bk.roa), gm = q(bk.gm), opm = q(bk.opm), npm = q(bk.npm), eba = q(bk.ebitA)
    const de  = q(bk.de), ic = q(bk.ic), cr = q(bk.cr)
    const cfo = q(bk.cfo), fcf = q(bk.fcf), ni = q(bk.ni), ta = q(bk.ta), te = q(bk.te)

    // Skip if we have literally no information
    const latestTs = Math.max(
      last(roe)?.t ?? 0, last(roa)?.t ?? 0, last(gm)?.t ?? 0, last(opm)?.t ?? 0,
      last(npm)?.t ?? 0, last(eba)?.t ?? 0, last(de)?.t ?? 0, last(ic)?.t ?? 0,
      last(cr)?.t ?? 0, last(cfo)?.t ?? 0, last(fcf)?.t ?? 0, last(ni)?.t ?? 0,
      last(ta)?.t ?? 0, last(te)?.t ?? 0
    )
    if(!latestTs) continue

    /* ---------- 2.1 Profitability pillar ---------- */
    const p_last = (arr:SeriesPt[])=> last(arr)?.v
    // Use what's available; weight breadth
    const pScores: number[] = []
    const pushP = (v:number|undefined, median:number, scale:number)=>{ if(isFinite(v as number)) pScores.push(scoreProfitMetric(v as number, median, scale)) }
    pushP(p_last(roe), 0.12, 0.08)  // ROE median ~12%
    pushP(p_last(roa), 0.06, 0.04)  // ROA median ~6%
    pushP(p_last(gm),  0.35, 0.12)  // GM ~35%
    pushP(p_last(opm), 0.12, 0.07)  // OPM ~12%
    pushP(p_last(npm), 0.09, 0.06)  // NPM ~9%
    pushP(p_last(eba), 0.10, 0.06)  // EBIT/Assets ~10%
    const profitScore = pScores.length ? pScores.reduce((a,b)=>a+b,0)/pScores.length : 0

    // Stability penalty: margin volatility over trailing 8 quarters
    function takeVals(arr:SeriesPt[], n=8){ return arr.slice(-n).map(x=>x.v) }
    const stabPen = (
      penaltyFromStdev(takeVals(gm), 0.08, 2) +
      penaltyFromStdev(takeVals(opm), 0.06, 2) +
      penaltyFromStdev(takeVals(npm), 0.06, 2)
    ) / 3 || 0

    /* ---------- 2.2 Safety / Leverage pillar ---------- */
    // Lower D/E better; higher Interest coverage better; CR around >=1.5 better
    const deVal = p_last(de)
    const icVal = p_last(ic)
    const crVal = p_last(cr)

    const deScore = isFinite(deVal as number) ? scoreInverseMetric(deVal as number, 0.6, 0.5) : 0
    const icScore = isFinite(icVal as number) ? zmap(icVal as number, 4.0, 2.0, 3) : 0 // 4x coverage median
    const crScore = isFinite(crVal as number) ? zmap(crVal as number, 1.6, 0.5, 3) : 0  // >=1.6 good

    const safetyScore = (deScore + icScore + crScore) / ( (isFinite(deScore)?1:0) + (isFinite(icScore)?1:0) + (isFinite(crScore)?1:0) || 1 )

    /* ---------- 2.3 Earnings Quality pillar ---------- */
    // Accruals proxy: (NI - CFO)/TA  — smaller magnitude is better (cash-backed earnings)
    function latestCommon(arrA:SeriesPt[], arrB:SeriesPt[]){
      if(!arrA.length || !arrB.length) return undefined
      const a = last(arrA)!, b = last(arrB)!
      return (Math.abs(a.t - b.t) <= 120*DAY) ? { a:a.v, b:b.v } : undefined
    }
    let accr = NaN
    const niCfo = latestCommon(ni, cfo)
    const taLast = p_last(ta)
    if(niCfo && isFinite(taLast as number) && (taLast as number) !== 0){
      accr = (niCfo.a - niCfo.b) / (taLast as number)
    }
    // FCF coverage proxy: FCF / NI (>=1 is good). If NI near 0, skip.
    let fcfCov = NaN
    const niFcf = latestCommon(ni, fcf)
    if(niFcf && Math.abs(niFcf.a) > 1e-9){
      fcfCov = niFcf.b / niFcf.a
    }

    const accrScore = isFinite(accr) ? zmap(-Math.abs(accr), -0.02, 0.05, 3) : 0 // smaller |accruals| better
    const fcfScore  = isFinite(fcfCov) ? zmap(fcfCov, 1.0, 0.7, 3) : 0           // >=1 ≈ good

    const eqScore = ( (isFinite(accrScore)?accrScore:0) + (isFinite(fcfScore)?fcfScore:0) ) /
                    ( (isFinite(accrScore)?1:0) + (isFinite(fcfScore)?1:0) || 1 )

    /* ---------- 2.4 Combine ---------- */
    // Heuristic weights: Profitability 45%, Safety 25%, EarningsQuality 20%, Stability 10%
    // (Stability enters as a penalty already; add directly)
    const combined = 0.45*profitScore + 0.25*safetyScore + 0.20*eqScore + 0.10*(stabPen)
    // Final clip to [-3, +3]
    const value = clamp(combined, -3, 3)

    out.push({ id: ID, symbol: sym, value, ts: latestTs })
  }

  return out
}

/* ===================== Example (remove in prod) =====================

const rows: FundRow[] = [
  { date:'2024-06-30', symbol:'ABC', field:'ROE', value:0.14 },
  { date:'2024-06-30', symbol:'ABC', field:'OperatingMargin', value:0.12 },
  { date:'2024-06-30', symbol:'ABC', field:'Debt/Equity', value:0.4 },
  { date:'2024-06-30', symbol:'ABC', field:'InterestCoverage', value:6.0 },
  { date:'2024-06-30', symbol:'ABC', field:'CFO', value:120 },
  { date:'2024-06-30', symbol:'ABC', field:'NetIncome', value:100 },
  { date:'2024-06-30', symbol:'ABC', field:'TotalAssets', value:1500 },

  { date:'2024-06-30', symbol:'XYZ', field:'ROE', value:0.06 },
  { date:'2024-06-30', symbol:'XYZ', field:'OperatingMargin', value:0.05 },
  { date:'2024-06-30', symbol:'XYZ', field:'Debt/Equity', value:1.2 },
  { date:'2024-06-30', symbol:'XYZ', field:'InterestCoverage', value:2.0 },
  { date:'2024-06-30', symbol:'XYZ', field:'CFO', value:20 },
  { date:'2024-06-30', symbol:'XYZ', field:'NetIncome', value:40 },
  { date:'2024-06-30', symbol:'XYZ', field:'TotalAssets', value:800 }
]
console.log(qualitySignalsFromFundamentals(rows))

*/