// commodities/copper.ts
// Copper (futures) helpers + tiny signal scaffolds.
// Works similarly to commodities/agri.ts but pre-configured for Copper on MCX/LME.
// Pure TS, no imports.

type Str = string
type Num = number
type Ts  = number

/* ===================== Types ===================== */
export type DeliveryType = 'PHYSICAL'|'CASH'

export type MetalSpec = {
  root: Str                // "COPPER"
  venue: 'MCX'|'LME'|'CME'|'OTHER'
  multiplier: Num          // notional = price * qtyLots * multiplier
  tickValue?: Num
  months: number[]         // tradable months (1..12)
  delivery: DeliveryType
  rollDaysBeforeExpiry: number
  tz?: Str
}

export type FutContract = {
  contract: Str            // e.g., "COPPER-2025-11" or "CUZ5"
  root: Str                // "COPPER"
  expiry: Ts
  mult: Num
  venue: MetalSpec['venue']
  delivery: DeliveryType
}

export type FutQuote = { contract: Str; root: Str; px: Num; ts: Ts; oi?: Num; vol?: Num }
export type ContPoint = { t: Ts; px: Num; contract: Str; rolled?: boolean }
export type CurvePoint = { contract: Str; expiry: Ts; px: Num }
export type TermStructure = { root: Str; points: CurvePoint[] }

/* ===================== Spec (edit for your venue) ===================== */
// NOTE: MCX lot for Copper is commonly 1,000 kg; treat as placeholder—adjust to your adapter.
export const COPPER_SPEC: MetalSpec = {
  root: 'COPPER',
  venue: 'MCX',
  multiplier: 1000,
  tickValue: 5,                 // placeholder
  months: [1,2,3,4,5,6,7,8,9,10,11,12],
  delivery: 'PHYSICAL',
  rollDaysBeforeExpiry: 4,
  tz: 'Asia/Kolkata'
}

/* ===================== Helpers ===================== */
const DAY = 86_400_000
const abs = (x:number)=> x<0? -x:x
const clamp = (v:number,a:number,b:number)=> Math.max(a, Math.min(b, v))

function monthEnd(y:number, m:number){ return new Date(Date.UTC(y, m, 0)).getUTCDate() }
function daysBetween(a:Ts,b:Ts){ return Math.max(0, Math.round((b-a)/DAY)) }

function guessExpiryFromCode(code:Str): Ts|undefined {
  // Accept ROOT-YYYY-MM / ROOT_YYYY_MM / ...YYYYMM / ...YYMM (e.g., CUZ5 won't match; pass explicit)
  let m = code.match(/(\d{4})[-_]?(\d{2})/)
  if(m){ const y=+m[1], mm=+m[2]; return Date.UTC(y, mm-1, monthEnd(y,mm)) }
  const m2 = code.match(/(\d{2})(\d{2})$/)
  if(m2){ const yy=+m2[1], mm=+m2[2]; const y = 2000+yy; return Date.UTC(y, mm-1, monthEnd(y,mm)) }
  return undefined
}

/* ===================== Contracts ===================== */
export function buildCopperContract(year:number, month:number, spec:MetalSpec=COPPER_SPEC): FutContract {
  const exp = Date.UTC(year, month-1, monthEnd(year, month))
  return {
    contract: `COPPER-${year}-${String(month).padStart(2,'0')}`,
    root: 'COPPER',
    expiry: exp,
    mult: spec.multiplier,
    venue: spec.venue,
    delivery: spec.delivery
  }
}

/* ===================== Front selection & Continuous ===================== */
export function selectFront(contracts: FutContract[], t:Ts, rollDays:number): FutContract|null {
  const live = contracts.filter(c=> c.expiry>t).sort((a,b)=> a.expiry-b.expiry)
  if(!live.length) return null
  const first = live[0]
  return daysBetween(t, first.expiry) > rollDays ? first : (live[1] ?? first)
}

export function makeContinuousCopper(
  quotes: FutQuote[],
  spec: MetalSpec = COPPER_SPEC,
  rollDaysOverride?: number
): ContPoint[] {
  // group quotes by contract
  const byC = new Map<Str, FutQuote[]>()
  for(const q of quotes){
    const a = byC.get(q.contract) ?? []
    a.push(q); byC.set(q.contract, a)
  }
  for(const a of byC.values()) a.sort((x,y)=> x.ts-y.ts)

  // meta from quotes
  const meta = new Map<Str, FutContract>()
  for(const q of quotes){
    if(!meta.has(q.contract)){
      meta.set(q.contract, {
        contract: q.contract, root:'COPPER',
        expiry: guessExpiryFromCode(q.contract) ?? (q.ts + 30*DAY),
        mult: spec.multiplier, venue: spec.venue, delivery: spec.delivery
      })
    }
  }
  const allContracts = Array.from(meta.values())
  const allTs = Array.from(new Set(quotes.map(q=>q.ts))).sort((a,b)=>a-b)

  const out: ContPoint[] = []
  let lastFront: string|undefined
  const rollDays = rollDaysOverride ?? spec.rollDaysBeforeExpiry

  for(const t of allTs){
    const front = selectFront(allContracts, t, rollDays)
    if(!front) continue
    const tape = byC.get(front.contract); if(!tape) continue
    const px = lastAtOrBefore(tape, t); if(px==null) continue
    const rolled = !!(lastFront && lastFront!==front.contract)
    out.push({ t, px, contract: front.contract, rolled })
    lastFront = front.contract
  }
  return out
}

function lastAtOrBefore(arr:FutQuote[], t:Ts){ // arr sorted
  let lo=0, hi=arr.length-1, ans=-1
  while(lo<=hi){ const m=(lo+hi)>>1; if(arr[m].ts<=t){ ans=m; lo=m+1 } else hi=m-1 }
  return ans>=0 ? arr[ans].px : null
}

/* ===================== Term structure & Carry ===================== */
export function termStructureFromLatest(quotes: FutQuote[]): TermStructure {
  // pick latest per contract
  const latest = new Map<Str, FutQuote>()
  for(const q of quotes){
    const p = latest.get(q.contract)
    if(!p || p.ts < q.ts) latest.set(q.contract, q)
  }
  const pts: CurvePoint[] = Array.from(latest.values()).map(q=>({
    contract: q.contract,
    expiry: guessExpiryFromCode(q.contract) ?? (q.ts + 30*DAY),
    px: q.px
  })).sort((a,b)=> a.expiry-b.expiry)
  return { root:'COPPER', points: pts }
}

export function carryAnnualized(nearPx:Num, nearExp:Ts, farPx:Num, farExp:Ts){
  if(!(nearPx>0 && farPx>0) || !(farExp>nearExp)) return 0
  const yf = (farExp - nearExp) / (365*DAY) || 1e-9
  return (farPx/nearPx - 1) / yf            // >0 contango, <0 backwardation
}

/* ===================== Signals (small scaffolds) ===================== */
export type Signal = { id:string; symbol:string; value:number; ts:number }

/** Carry signal: backwardation → +, contango → − (normalized to [-3,+3]). */
export function carrySignalFromCurve(curve: TermStructure, ts:Ts, symbol='COPPER_CONT'): Signal|null {
  if(curve.points.length<2) return null
  const n = curve.points[0], f = curve.points[1]
  const ann = carryAnnualized(n.px, n.expiry, f.px, f.expiry)
  const z = clamp((-ann / 0.20) * 3, -3, 3) // ±20%/yr ≈ ±3
  return { id:'copper_carry', symbol, value:z, ts }
}

/** Momentum signal on continuous series: k-day return mapped to [-3,+3]. */
export function momentumSignal(cont: ContPoint[], lookbackDays=60, symbol='COPPER_CONT'): Signal|null {
  if(cont.length<2) return null
  const last = cont[cont.length-1]
  const cutoff = last.t - lookbackDays*DAY
  // find first point >= cutoff
  let baseIdx = -1
  for(let i=0;i<cont.length;i++){ if(cont[i].t>=cutoff){ baseIdx=i; break } }
  if(baseIdx<=0) baseIdx = Math.max(0, cont.length-2)
  const base = cont[baseIdx]
  const ret = (last.px - base.px) / base.px         // e.g., 10% → 0.10
  const z = clamp((ret / 0.05) * 3, -3, 3)          // ±5% → ±3 (tune)
  return { id:'copper_momo', symbol, value: z, ts: last.t }
}

/** Mean-reversion (short-term): last 5d return inverted. */
export function meanRevSignal(cont: ContPoint[], lookbackDays=5, symbol='COPPER_CONT'): Signal|null {
  if(cont.length<2) return null
  const last = cont[cont.length-1]
  const cutoff = last.t - lookbackDays*DAY
  let baseIdx = -1
  for(let i=0;i<cont.length;i++){ if(cont[i].t>=cutoff){ baseIdx=i; break } }
  if(baseIdx<=0) baseIdx = Math.max(0, cont.length-2)
  const base = cont[baseIdx]
  const ret = (last.px - base.px) / base.px
  const z = clamp((-ret / 0.02) * 3, -3, 3)         // ±2% → ∓3 (tune)
  return { id:'copper_meanrev', symbol, value: z, ts: last.t }
}

/* ===================== Notional utils ===================== */
export const lotsToNotional = (lots:Num, px:Num, mult:Num=COPPER_SPEC.multiplier)=> lots*px*mult
export const notionalToLots = (notional:Num, px:Num, mult:Num=COPPER_SPEC.multiplier)=> notional/(px*mult)
export const roundLots = (qty:Num, lotStep:Num=1)=> Math.round(qty/lotStep)*lotStep

/* ===================== Example (comment out in prod) ===================== */
/*
const c1 = buildCopperContract(2025, 11)
const c2 = buildCopperContract(2026, 1)
const quotes: FutQuote[] = [
  { contract:c1.contract, root:'COPPER', px: 805, ts: Date.UTC(2025,9,1) },
  { contract:c2.contract, root:'COPPER', px: 812, ts: Date.UTC(2025,9,1) },
  { contract:c1.contract, root:'COPPER', px: 808, ts: Date.UTC(2025,9,2) },
  { contract:c2.contract, root:'COPPER', px: 815, ts: Date.UTC(2025,9,2) }
]
const cont = makeContinuousCopper(quotes)
console.log(momentumSignal(cont))
*/