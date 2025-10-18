// commodities/agri.ts
// Agri (futures) helpers: contract specs, front-month selection, continuous series,
// basic carry calc, lot/notional utils, and a tiny seasonality signal scaffold.
// Pure TS, no imports.

type Str = string
type Num = number
type Ts  = number

export type DeliveryType = 'PHYSICAL'|'CASH'

export type AgriSpec = {
  root: Str
  venue: 'MCX'|'NCDEX'|'CME'|'ICE'|'OTHER'
  multiplier: Num
  tickValue?: Num
  pointValue?: Num
  months: number[]
  tz?: Str
  delivery: DeliveryType
  rollDaysBeforeExpiry: number
}

export type FutContract = {
  contract: Str
  root: Str
  expiry: Ts
  mult: Num
  tickValue?: Num
  delivery: DeliveryType
}

export type FutQuote = { contract: Str; root: Str; px: Num; ts: Ts; oi?: Num; vol?: Num }
export type ContPoint = { t: Ts; px: Num; contract: Str; rolled?: boolean }
export type CurvePoint = { contract: Str; expiry: Ts; px: Num }
export type TermStructure = { root: Str; points: CurvePoint[] }

export const AGRI_SPECS: Record<Str, AgriSpec> = {
  CHANA: { root:'CHANA', venue:'NCDEX', multiplier:100, pointValue:100, months:[1,2,3,4,5,6,7,8,9,10,11,12], delivery:'PHYSICAL', rollDaysBeforeExpiry: 3 },
  JEERA: { root:'JEERA', venue:'NCDEX', multiplier:100, pointValue:100, months:[1,3,5,7,9,11], delivery:'PHYSICAL', rollDaysBeforeExpiry: 4 },
  SOY:   { root:'SOY',   venue:'CME',   multiplier:5000, tickValue:12.5, months:[1,3,5,7,8,9,11], delivery:'PHYSICAL', rollDaysBeforeExpiry: 5 }
}

export function registerSpec(spec: AgriSpec){ AGRI_SPECS[spec.root] = spec }

function daysBetween(a:Ts, b:Ts){ return Math.max(0, Math.round((b-a)/86_400_000)) }

export function selectFront(contracts: FutContract[], t: Ts, rollDays: number): FutContract|null {
  const live = contracts.filter(c=> c.expiry > t).sort((a,b)=> a.expiry - b.expiry)
  if(live.length===0) return null
  const first = live[0]
  if(daysBetween(t, first.expiry) > rollDays) return first
  return live[1] ?? first
}

/** Build a continuous series (front with time-based roll).
 *  rollDaysOverride: either a fixed number, or a function (root) => number
 */
export function makeContinuous(
  quotes: FutQuote[],
  specs: Record<Str,AgriSpec>,
  rollDaysOverride?: number | ((root: string)=>number)
): ContPoint[] {
  // group quotes by contract
  const byContract = new Map<Str, FutQuote[]>()
  for(const q of quotes){
    const arr = byContract.get(q.contract) ?? []
    arr.push(q)
    byContract.set(q.contract, arr)
  }
  for(const arr of byContract.values()) arr.sort((a,b)=> a.ts - b.ts)

  // unique sorted timestamps
  const allTs: Ts[] = Array.from(new Set(quotes.map(q=>q.ts))).sort((a,b)=>a-b)

  // build meta for contracts (expiry/mult/etc.)
  const meta = new Map<Str, FutContract>()
  for(const q of quotes){
    if(!meta.has(q.contract)){
      const sp = specs[q.root] || AGRI_SPECS[q.root]
      const exp = guessExpiryFromCode(q.contract) ?? (q.ts + 30*86_400_000)
      meta.set(q.contract, {
        contract: q.contract,
        root: q.root,
        expiry: exp,
        mult: sp?.multiplier ?? 1,
        tickValue: sp?.tickValue,
        delivery: sp?.delivery ?? 'PHYSICAL'
      })
    }
  }

  const allContracts = Array.from(meta.values())
  const out: ContPoint[] = []
  let lastFront: string|undefined

  for(const t of allTs){
    // we don't know which root will be front *before* selection, so first pick with a safe default (3)
    // then recompute with per-root rollDays if needed; to keep it simple, compute rd using the soonest contract's root
    const provisional = selectFront(allContracts, t, 3)
    if(!provisional) continue

    const rd = resolveRollDays(provisional.root, rollDaysOverride)
    const front = selectFront(allContracts, t, rd)
    if(!front) continue

    const book = byContract.get(front.contract)
    if(!book) continue

    const px = lastAtOrBefore(book, t)
    if(px==null) continue

    const rolled = !!(lastFront && lastFront !== front.contract)
    out.push({ t, px, contract: front.contract, rolled })
    lastFront = front.contract
  }
  return out
}

function resolveRollDays(root: string, override?: number | ((root:string)=>number)){
  if(typeof override === 'number') return override
  if(typeof override === 'function') return override(root)
  const sp = AGRI_SPECS[root]
  return sp?.rollDaysBeforeExpiry ?? 3
}

function lastAtOrBefore(arr:FutQuote[], t:Ts): number|null{
  let lo=0, hi=arr.length-1, ans=-1
  while(lo<=hi){
    const m = (lo+hi) >> 1
    if(arr[m].ts<=t){ ans=m; lo=m+1 } else hi=m-1
  }
  return ans>=0 ? arr[ans].px : null
}

function guessExpiryFromCode(code:Str): Ts|undefined {
  // Accept ROOT-YYYY-MM / ROOT_YYYY_MM / ...YYYYMM / ...YYMM
  let m = code.match(/(\d{4})[-_]?(\d{2})/)
  if(m){
    const y = Number(m[1]), mm = Number(m[2])
    return Date.UTC(y, mm-1, monthEnd(y,mm))
  }
  const m2 = code.match(/(\d{2})(\d{2})$/)
  if(m2){
    const yy = Number(m2[1]), mm = Number(m2[2])
    const yyyy = 2000 + yy
    return Date.UTC(yyyy, mm-1, monthEnd(yyyy,mm))
  }
  return undefined
}
function monthEnd(y:number, m:number){ return new Date(Date.UTC(y, m, 0)).getUTCDate() }

/** Build a simple term structure from latest quotes per contract. */
export function termStructure(quotes: FutQuote[]): TermStructure[] {
  const latest = new Map<Str, FutQuote>()
  for(const q of quotes){
    const k = q.contract
    if(!latest.has(k) || latest.get(k)!.ts < q.ts) latest.set(k, q)
  }
  const byRoot = new Map<Str, CurvePoint[]>()
  for(const q of latest.values()){
    const exp = guessExpiryFromCode(q.contract) ?? (q.ts + 30*86_400_000)
    const arr = byRoot.get(q.root) ?? []
    arr.push({ contract: q.contract, expiry: exp, px: q.px })
    byRoot.set(q.root, arr)
  }
  const out: TermStructure[] = []
  for(const [root, pts] of byRoot){
    pts.sort((a,b)=> a.expiry - b.expiry)
    out.push({ root, points: pts })
  }
  return out
}

/** Annualized carry between two maturities (simple). */
export function carryAnnualized(fNear:Num, tNear:Ts, fFar:Num, tFar:Ts){
  if(!(fNear>0 && fFar>0) || tFar<=tNear) return 0
  const yf = (tFar - tNear) / (365*86_400_000)
  return (fFar/fNear - 1) / (yf || 1e-9)
}

export function lotsToNotional(qtyLots:Num, px:Num, mult:Num){ return qtyLots * px * mult }
export function notionalToLots(notional:Num, px:Num, mult:Num){ return (notional / (px*mult)) }
export function roundLots(qty:Num, lotStep:Num){ return Math.round(qty/lotStep)*lotStep }

/** Seasonality helpers omitted here for brevity—keep your previous ones; they compile fine. */