// commodities/gold.ts
// Gold (futures) helpers + tiny signal scaffolds.
// Pre-configured for MCX/COMEX-style contracts. Pure TS, no imports.

type Str = string
type Num = number
type Ts  = number

/* ===================== Types ===================== */
export type DeliveryType = 'PHYSICAL'|'CASH'

export type GoldSpec = {
  root: Str                // "GOLD" / "XAU"
  venue: 'MCX'|'COMEX'|'ICE'|'OTHER'
  multiplier: Num          // notional = price * lots * multiplier
  tickValue?: Num
  months: number[]         // usually all months
  delivery: DeliveryType
  rollDaysBeforeExpiry: number
  tz?: Str
}

export type FutContract = {
  contract: Str            // e.g., "GOLD-2025-12" or "GCZ5"
  root: Str                // "GOLD"
  expiry: Ts
  mult: Num
  venue: GoldSpec['venue']
  delivery: DeliveryType
}

export type FutQuote   = { contract: Str; root: Str; px: Num; ts: Ts; oi?: Num; vol?: Num }
export type ContPoint  = { t: Ts; px: Num; contract: Str; rolled?: boolean }
export type CurvePoint = { contract: Str; expiry: Ts; px: Num }
export type TermStructure = { root: Str; points: CurvePoint[] }

/* ===================== Default Spec (edit as needed) ===================== */
// MCX GOLD (1 kg) uses INR/10g quoting; COMEX GC is 100 troy oz.
// We keep a neutral multiplier (100) so notional = px * 100 * lots by default.
// Adjust in your adapter for venue-accurate values.
export const GOLD_SPEC: GoldSpec = {
  root: 'GOLD',
  venue: 'COMEX',
  multiplier: 100,
  tickValue: 10,                          // placeholder
  months: [1,2,3,4,5,6,7,8,9,10,11,12],
  delivery: 'PHYSICAL',
  rollDaysBeforeExpiry: 5,
  tz: 'America/New_York'
}

/* ===================== Helpers ===================== */
const DAY = 86_400_000
const clamp = (v:number,a:number,b:number)=> Math.max(a, Math.min(b, v))

function monthEnd(y:number, m:number){ return new Date(Date.UTC(y, m, 0)).getUTCDate() }
function daysBetween(a:Ts,b:Ts){ return Math.max(0, Math.round((b-a)/DAY)) }

/** Parse expiry from common codes:
 *  - ROOT-YYYY-MM / ROOT_YYYY_MM
 *  - ...YYYYMM
 *  - ...YYMM
 *  - CME month code form like "GCZ5" (Z = Dec, 5 = 2025)
 */
function guessExpiryFromCode(code:Str): Ts|undefined {
  let m = code.match(/(\d{4})[-_]?(\d{2})/)
  if(m){ const y=+m[1], mm=+m[2]; return Date.UTC(y, mm-1, monthEnd(y,mm)) }

  const m2 = code.match(/(\d{2})([FGHJKMNQUVXZ])$/i) // e.g., 25Z
  if(m2){
    const yy = +m2[1]; const mc = m2[2].toUpperCase()
    const map: Record<string,number> = {F:1,G:2,H:3,J:4,K:5,M:6,N:7,Q:8,U:9,V:10,X:11,Z:12}
    const mm = map[mc] ?? 12
    const y  = 2000 + yy
    return Date.UTC(y, mm-1, monthEnd(y,mm))
  }

  const m3 = code.match(/(\d{2})(\d{2})$/) // YYMM
  if(m3){ const y=2000+(+m3[1]), mm=+m3[2]; return Date.UTC(y, mm-1, monthEnd(y,mm)) }

  return undefined
}

/* ===================== Contracts ===================== */
export function buildGoldContract(year:number, month:number, spec:GoldSpec=GOLD_SPEC): FutContract {
  const exp = Date.UTC(year, month-1, monthEnd(year, month))
  return {
    contract: `GOLD-${year}-${String(month).padStart(2,'0')}`,
    root: spec.root,
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

export function makeContinuousGold(
  quotes: FutQuote[],
  spec: GoldSpec = GOLD_SPEC,
  rollDaysOverride?: number
): ContPoint[] {
  // group quotes by contract
  const byC = new Map<Str, FutQuote[]>()
  for(const q of quotes){
    const a = byC.get(q.contract) ?? []
    a.push(q); byC.set(q.contract, a)
  }
  for(const a of byC.values()) a.sort((x,y)=> x.ts-y.ts)

  // contract meta
  const meta = new Map<Str, FutContract>()
  for(const q of quotes){
    if(!meta.has(q.contract)){
      meta.set(q.contract, {
        contract: q.contract, root: spec.root,
        expiry: guessExpiryFromCode(q.contract) ?? (q.ts + 30*DAY),
        mult: spec.multiplier, venue: spec.venue, delivery: spec.delivery
      })
    }
  }
  const allContracts = Array.from(meta.values())
  const allTs = Array.from(new Set(quotes.map(q=>q.ts))).sort((a,b)=>a-b)
  const rollDays = rollDaysOverride ?? spec.rollDaysBeforeExpiry

  const out: ContPoint[] = []
  let lastFront: string|undefined
  for(const t of allTs){
    const front = selectFront(allContracts, t, rollDays); if(!front) continue
    const tape = byC.get(front.contract); if(!tape) continue
    const px = lastAtOrBefore(tape, t); if(px==null) continue
    const rolled = !!(lastFront && lastFront!==front.contract)
    out.push({ t, px, contract: front.contract, rolled })
    lastFront = front.contract
  }
  return out
}

function lastAtOrBefore(arr:FutQuote[], t:Ts){
  let lo=0, hi=arr.length-1, ans=-1
  while(lo<=hi){ const m=(lo+hi)>>1; if(arr[m].ts<=t){ ans=m; lo=m+1 } else hi=m-1 }
  return ans>=0 ? arr[ans].px : null
}

/* ===================== Term structure & Carry ===================== */
export function termStructureFromLatest(quotes: FutQuote[], root='GOLD'): TermStructure {
  const latest = new Map<Str, FutQuote>()
  for(const q of quotes){ const p = latest.get(q.contract); if(!p || p.ts<q.ts) latest.set(q.contract, q) }
  const pts: CurvePoint[] = Array.from(latest.values()).map(q=>({
    contract: q.contract,
    expiry: guessExpiryFromCode(q.contract) ?? (q.ts + 30*DAY),
    px: q.px
  })).sort((a,b)=> a.expiry-b.expiry)
  return { root, points: pts }
}

export function carryAnnualized(nearPx:Num, nearExp:Ts, farPx:Num, farExp:Ts){
  if(!(nearPx>0 && farPx>0) || !(farExp>nearExp)) return 0
  const yf = (farExp - nearExp) / (365*DAY) || 1e-9
  return (farPx/nearPx - 1) / yf            // >0 contango, <0 backwardation
}

/* ===================== Signals (scaffolds) ===================== */
export type Signal = { id:string; symbol:string; value:number; ts:number }

/** Carry: backwardation → +, contango → − (normalize to [-3,+3]). */
export function carrySignalFromCurve(curve: TermStructure, ts:Ts, symbol='GOLD_CONT'): Signal|null {
  if(curve.points.length<2) return null
  const n = curve.points[0], f = curve.points[1]
  const ann = carryAnnualized(n.px, n.expiry, f.px, f.expiry)
  // Gold carry tends to be mild; ±12%/yr ~ ±3
  const z = clamp((-ann / 0.12) * 3, -3, 3)
  return { id:'gold_carry', symbol, value: z, ts }
}

/** Momentum on continuous: k-day return mapped to [-3,+3]. */
export function momentumSignal(cont: ContPoint[], lookbackDays=60, symbol='GOLD_CONT'): Signal|null {
  if(cont.length<2) return null
  const last = cont[cont.length-1]
  const cutoff = last.t - lookbackDays*DAY
  let baseIdx = -1
  for(let i=0;i<cont.length;i++){ if(cont[i].t>=cutoff){ baseIdx=i; break } }
  if(baseIdx<=0) baseIdx = Math.max(0, cont.length-2)
  const base = cont[baseIdx]
  const ret = (last.px - base.px) / base.px
  // ±6% → ±3 (tune for your venue)
  const z = clamp((ret / 0.06) * 3, -3, 3)
  return { id:'gold_momo', symbol, value: z, ts: last.t }
}

/** Short-term mean-reversion using 5d return (inverted). */
export function meanRevSignal(cont: ContPoint[], lookbackDays=5, symbol='GOLD_CONT'): Signal|null {
  if(cont.length<2) return null
  const last = cont[cont.length-1]
  const cutoff = last.t - lookbackDays*DAY
  let baseIdx = -1
  for(let i=0;i<cont.length;i++){ if(cont[i].t>=cutoff){ baseIdx=i; break } }
  if(baseIdx<=0) baseIdx = Math.max(0, cont.length-2)
  const base = cont[baseIdx]
  const ret = (last.px - base.px) / base.px
  const z = clamp((-ret / 0.025) * 3, -3, 3) // ±2.5% → ∓3
  return { id:'gold_meanrev', symbol, value: z, ts: last.t }
}

/* ===================== Notional utils ===================== */
export const lotsToNotional = (lots:Num, px:Num, mult:Num=GOLD_SPEC.multiplier)=> lots*px*mult
export const notionalToLots = (notional:Num, px:Num, mult:Num=GOLD_SPEC.multiplier)=> notional/(px*mult)
export const roundLots = (qty:Num, lotStep:Num=1)=> Math.round(qty/lotStep)*lotStep

/* ===================== Example (comment to use) ===================== */
/*
const c1 = buildGoldContract(2025, 12)
const c2 = buildGoldContract(2026, 2)
const quotes: FutQuote[] = [
  { contract:c1.contract, root:'GOLD', px: 2350, ts: Date.UTC(2025,9,1) },
  { contract:c2.contract, root:'GOLD', px: 2360, ts: Date.UTC(2025,9,1) },
  { contract:c1.contract, root:'GOLD', px: 2365, ts: Date.UTC(2025,9,2) },
  { contract:c2.contract, root:'GOLD', px: 2372, ts: Date.UTC(2025,9,2) }
]
const cont = makeContinuousGold(quotes)
console.log(momentumSignal(cont), carrySignalFromCurve(termStructureFromLatest(quotes), cont[cont.length-1].t))
*/