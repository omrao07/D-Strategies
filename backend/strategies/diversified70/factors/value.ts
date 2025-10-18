// factors/value.ts
// Composite VALUE factor: “cheaper is better”.
// Supports flexible field names for common valuation ratios & yields.
// Pure TS, no imports. Produces cross-sectional scores in [-3,+3].
//
// Positive-to-better metrics (higher = cheaper):
//   EarningsYield (EPS/Price), FCFYield, DividendYield, EBIT/EV, NetProfit/EV
// Negative-to-better metrics (lower = cheaper):
//   PE, PB, PS, EV/EBITDA, EV/Sales, EV/EBIT
//
// Feed any subset; the factor blends what’s available per symbol.

type Str = string
type Num = number
type Ts  = number

export type FundRow = { date: string|number; symbol: Str; field: Str; value: Num }
export type ValueSignal = { id: Str; symbol: Str; value: Num; ts: Ts }

const ID = 'factor_value'

/* -------------------------- Field matchers -------------------------- */
function U(x:string){ return (x||'').toUpperCase() }

function isPE(f:Str){ return /(^|[^A-Z])P\/?E([^A-Z]|$)|PRICE\s*EARN|PE_RATIO|PE$/.test(U(f)) }
function isPB(f:Str){ return /(^|[^A-Z])P\/?B([^A-Z]|$)|PRICE\s*BOOK|PB_RATIO|PB$/.test(U(f)) }
function isPS(f:Str){ return /(^|[^A-Z])P\/?S([^A-Z]|$)|PRICE\s*SALES|PS_RATIO|PS$/.test(U(f)) }

function isEVEBITDA(f:Str){ return /EV\s*\/\s*EBITDA|EVEBITDA/.test(U(f)) }
function isEVSales(f:Str){  return /EV\s*\/\s*SALES|EVSALES|EV\/REV/.test(U(f)) }
function isEVEBIT(f:Str){   return /EV\s*\/\s*EBIT|EVEBIT/.test(U(f)) }

function isEY(f:Str){       return /EARN(ING)?S?\s*YIELD|E\/P|EARN.*\/\s*PRICE|EYIELD/.test(U(f)) }
function isFCFYield(f:Str){ return /FCF\s*YIELD|FREE\s*CASH\s*FLOW\s*YIELD|FCFY/.test(U(f)) }
function isDivYld(f:Str){   return /DIV(IDEND)?\s*YIELD|DYIELD|DIV\/PRICE/.test(U(f)) }
function isEBITonEV(f:Str){ return /(EBIT|OPERAT(ING)?\s*PROFIT)\s*\/\s*EV|EBIT\/EV/.test(U(f)) }
function isNPonEV(f:Str){   return /(NET\s*PROFIT|NET\s*INCOME|PAT)\s*\/\s*EV/.test(U(f)) }

/* -------------------------- Helpers -------------------------- */
const clamp = (v:number,a:number,b:number)=> Math.max(a, Math.min(b, v))
const toMs  = (d:string|number)=> typeof d==='number'? d : Date.parse(d)

type Buck = {
  // cheaper if LOWER:
  pe?: Num[]; pb?: Num[]; ps?: Num[]; ev_ebitda?: Num[]; ev_sales?: Num[]; ev_ebit?: Num[];
  // cheaper if HIGHER:
  ey?: Num[]; fcfy?: Num[]; divy?: Num[]; ebit_ev?: Num[]; np_ev?: Num[];
  ts?: Ts[];
}

/** last valid value from an array */
function lastNum(xs?:Num[]){ return xs && xs.length ? xs[xs.length-1] : undefined }

/** Simple winsorization for robustness */
function winsorize(vals:number[], p=0.02){
  if(!(p>0) || vals.length<3) return vals.slice()
  const s = vals.slice().sort((a,b)=>a-b)
  const lo = s[Math.floor(p*(s.length-1))]
  const hi = s[Math.ceil((1-p)*(s.length-1))]
  return vals.map(v=> clamp(v, lo, hi))
}

/** Z-score helper */
function zscore(x:number, mean:number, sd:number){ return (x-mean)/(sd||1e-6) }

/* -------------------------- Core -------------------------- */
/**
 * Build composite VALUE score per symbol by blending available metrics:
 *  - Normalize each metric cross-sectionally (winsorized z)
 *  - For “lower is cheaper” metrics, invert sign so higher score = cheaper
 *  - Average across metrics present for that symbol
 *  - Clip to [-3, +3]
 */
export function valueSignalsFromFundamentals(rows: FundRow[], clipAbs=3, winsorPct=0.02): ValueSignal[] {
  // 1) Bucket by symbol with arrays of values keeping temporal order
  const by: Record<Str, Buck> = {}
  for(const r of rows){
    const sym = String(r.symbol||'').toUpperCase(); if(!sym) continue
    const v = Number(r.value); if(!isFinite(v)) continue
    const b = (by[sym] ||= { ts:[] })
    ;(b.ts ||= []).push(toMs(r.date))

    const f = r.field||''
    if(isPE(f))        (b.pe ||= []).push(v)
    else if(isPB(f))   (b.pb ||= []).push(v)
    else if(isPS(f))   (b.ps ||= []).push(v)
    else if(isEVEBITDA(f)) (b.ev_ebitda ||= []).push(v)
    else if(isEVSales(f))  (b.ev_sales  ||= []).push(v)
    else if(isEVEBIT(f))   (b.ev_ebit   ||= []).push(v)
    else if(isEY(f))       (b.ey   ||= []).push(v)
    else if(isFCFYield(f)) (b.fcfy ||= []).push(v)
    else if(isDivYld(f))   (b.divy ||= []).push(v)
    else if(isEBITonEV(f)) (b.ebit_ev ||= []).push(v)
    else if(isNPonEV(f))   (b.np_ev   ||= []).push(v)
  }

  // 2) Collect “latest” snapshot vectors per metric for cross-sectional standardization
  const vecs: Record<string, number[]> = {
    pe:[], pb:[], ps:[], ev_ebitda:[], ev_sales:[], ev_ebit:[],
    ey:[], fcfy:[], divy:[], ebit_ev:[], np_ev:[]
  }
  const syms = Object.keys(by)
  const latestTs: Record<Str, Ts> = {}

  for(const s of syms){
    const bk = by[s]
    latestTs[s] = (bk.ts && bk.ts.length) ? bk.ts[bk.ts.length-1]! : Date.now()
    if(bk.pe)        vecs.pe.push(lastNum(bk.pe)!)
    if(bk.pb)        vecs.pb.push(lastNum(bk.pb)!)
    if(bk.ps)        vecs.ps.push(lastNum(bk.ps)!)
    if(bk.ev_ebitda) vecs.ev_ebitda.push(lastNum(bk.ev_ebitda)!)
    if(bk.ev_sales)  vecs.ev_sales.push(lastNum(bk.ev_sales)!)
    if(bk.ev_ebit)   vecs.ev_ebit.push(lastNum(bk.ev_ebit)!)
    if(bk.ey)        vecs.ey.push(lastNum(bk.ey)!)
    if(bk.fcfy)      vecs.fcfy.push(lastNum(bk.fcfy)!)
    if(bk.divy)      vecs.divy.push(lastNum(bk.divy)!)
    if(bk.ebit_ev)   vecs.ebit_ev.push(lastNum(bk.ebit_ev)!)
    if(bk.np_ev)     vecs.np_ev.push(lastNum(bk.np_ev)!)
  }

  // 3) Pre-compute winsorized means & sds per metric for z-scoring
  type Stat = { mean:number; sd:number }
  const stats: Record<string, Stat> = {}
  for(const k in vecs){
    const arr = vecs[k]
    if(!arr.length){ stats[k] = { mean:0, sd:1 }; continue }
    const w = winsorize(arr, winsorPct)
    const mean = w.reduce((a,b)=>a+b,0)/w.length
    const varSum = w.reduce((a,b)=> a+(b-mean)*(b-mean), 0)
    const sd = Math.sqrt(varSum / Math.max(1, w.length)) || 1
    stats[k] = { mean, sd }
  }

  // 4) Per symbol: compute per-metric z (with correct sign) and blend
  const out: ValueSignal[] = []
  for(const s of syms){
    const bk = by[s]
    const parts: number[] = []

    // Lower-better metrics -> invert sign
    const pushInv = (k:keyof Buck, keyStat:string)=>{
      const v = lastNum(bk[k] as number[] | undefined)
      if(isFinite(v as number)){
        const st = stats[keyStat]
        parts.push(-zscore(v as number, st.mean, st.sd))
      }
    }
    // Higher-better metrics -> keep sign
    const pushPos = (k:keyof Buck, keyStat:string)=>{
      const v = lastNum(bk[k] as number[] | undefined)
      if(isFinite(v as number)){
        const st = stats[keyStat]
        parts.push(zscore(v as number, st.mean, st.sd))
      }
    }

    pushInv('pe','pe')
    pushInv('pb','pb')
    pushInv('ps','ps')
    pushInv('ev_ebitda','ev_ebitda')
    pushInv('ev_sales','ev_sales')
    pushInv('ev_ebit','ev_ebit')

    pushPos('ey','ey')
    pushPos('fcfy','fcfy')
    pushPos('divy','divy')
    pushPos('ebit_ev','ebit_ev')
    pushPos('np_ev','np_ev')

    if(!parts.length) continue
    const avg = parts.reduce((a,b)=>a+b,0)/parts.length
    out.push({ id: ID, symbol: s, value: clamp(avg, -3, 3), ts: latestTs[s] || Date.now() })
  }

  return out
}

/* -------------------------- Convenience: build rows -------------------------- */
/**
 * Handy helper to construct rows if you have a per-symbol snapshot of ratios.
 * Values should be decimals for yields (e.g., 0.08 = 8%), raw ratios for multiples.
 */
export function rowsFromSnapshot(ts:Ts, snap: Array<{
  symbol: Str
  PE?: Num; PB?: Num; PS?: Num; EV_EBITDA?: Num; EV_Sales?: Num; EV_EBIT?: Num
  EarningsYield?: Num; FCFYield?: Num; DividendYield?: Num; EBIT_over_EV?: Num; NP_over_EV?: Num
}>): FundRow[] {
  const out: FundRow[] = []
  for(const s of snap){
    const S = String(s.symbol).toUpperCase()
    const p = (field:Str, value?:Num)=> { if(isFinite(value as number)) out.push({ date: ts, symbol: S, field, value: value as number }) }
    p('PE', s.PE); p('PB', s.PB); p('PS', s.PS)
    p('EV/EBITDA', s.EV_EBITDA); p('EV/Sales', s.EV_Sales); p('EV/EBIT', s.EV_EBIT)
    p('EarningsYield', s.EarningsYield); p('FCFYield', s.FCFYield); p('DividendYield', s.DividendYield)
    p('EBIT/EV', s.EBIT_over_EV); p('NP/EV', s.NP_over_EV)
  }
  return out
}

/* -------------------------- Example (remove in prod) --------------------------
const ts = Date.now()
const rows: FundRow[] = rowsFromSnapshot(ts, [
  { symbol:'AAA', PE:10, PB:1.2, EV_EBITDA:6, EarningsYield:0.12, FCFYield:0.08 },
  { symbol:'BBB', PE:22, PB:3.5, EV_EBITDA:12, EarningsYield:0.05, FCFYield:0.02, DividendYield:0.01 },
  { symbol:'CCC', PS:1.1, EV_Sales:1.2, EV_EBIT:8, NP_over_EV:0.09 }
])
console.log(valueSignalsFromFundamentals(rows))
------------------------------------------------------------------------------- */