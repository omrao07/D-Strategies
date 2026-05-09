// commodities/commodity carry.ts
// Strategy: Futures Carry (front vs next). Positive carry (backwardation) → long; negative (contango) → short.
// Pure TS, no imports.

type Str = string
type Num = number
type Ts  = number

/* ================= Types ================= */
export type FutQuote = { contract: Str; root: Str; px: Num; ts: Ts }
export type CurvePoint = { contract: Str; expiry: Ts; px: Num }
export type TermStructure = { root: Str; points: CurvePoint[] }

export type CarryObs = {
  root: Str
  ts: Ts
  near: { contract: Str; px: Num; expiry: Ts }
  far:  { contract: Str; px: Num; expiry: Ts } | null
  carryAnn: Num // annualized (far/near - 1) / yearFrac ; negative = contango
}

export type Signal = { id: Str; symbol: Str; value: Num; ts: Ts }

/* ================= Expiry parsing (same heuristic as agri.ts) ================= */
function guessExpiryFromCode(code:Str): Ts|undefined {
  let m = code.match(/(\d{4})[-_]?(\d{2})/)
  if(m){ const y=+m[1], mm=+m[2]; return Date.UTC(y, mm-1, new Date(Date.UTC(y, mm, 0)).getUTCDate()) }
  const m2 = code.match(/(\d{2})(\d{2})$/)
  if(m2){ const yy=+m2[1], mm=+m2[2]; const y = 2000+yy; return Date.UTC(y, mm-1, new Date(Date.UTC(y, mm, 0)).getUTCDate()) }
  return undefined
}

/* ================= Helpers ================= */
function latestByContract(quotes: FutQuote[]){
  const m = new Map<Str, FutQuote>()
  for(const q of quotes){
    const prev = m.get(q.contract)
    if(!prev || prev.ts < q.ts) m.set(q.contract, q)
  }
  return Array.from(m.values())
}

function groupByRoot(quotes: FutQuote[]){
  const g = new Map<Str, FutQuote[]>()
  for(const q of quotes){
    const arr = g.get(q.root) ?? []
    arr.push(q)
    g.set(q.root, arr)
  }
  return g
}

function yearFrac(a:Ts, b:Ts){ return (b-a) / (365*86_400_000) }

/* ================= Term structure from quotes ================= */
export function termStructureFromQuotes(quotes: FutQuote[]): TermStructure[] {
  const latest = latestByContract(quotes)
  const byRoot = groupByRoot(latest)
  const out: TermStructure[] = []
  for(const [root, arr] of byRoot){
    const pts: CurvePoint[] = arr.map(q => ({
      contract: q.contract,
      expiry: guessExpiryFromCode(q.contract) ?? (q.ts + 30*86_400_000),
      px: q.px
    }))
    pts.sort((a,b)=> a.expiry - b.expiry)
    out.push({ root, points: pts })
  }
  return out
}

/* ================= Carry calculation (front vs next) ================= */
export function carryFromCurve(curve: TermStructure, ts: Ts): CarryObs | null {
  if(curve.points.length < 1) return null
  const near = curve.points[0]
  const far  = curve.points[1] ?? null
  if(!(near.px>0)) return null

  let carryAnn = 0
  if(far && far.px>0 && far.expiry>near.expiry){
    const yf = yearFrac(near.expiry, far.expiry) || 1e-9
    carryAnn = (far.px/near.px - 1) / yf   // >0 contango, <0 backwardation
  } else {
    // If no next, use a tiny window to avoid NaN; interpret as flat carry
    carryAnn = 0
  }

  return {
    root: curve.root,
    ts,
    near: { contract: near.contract, px: near.px, expiry: near.expiry },
    far:  far ? { contract: far.contract, px: far.px, expiry: far.expiry } : null,
    carryAnn
  }
}

/* ================= Normalize → signal ================= */
/**
 * Map annualized carry to [-3,+3]. Heuristic:
 *   - Backwardation (carryAnn < 0) is positive signal (long).
 *   - Contango (carryAnn > 0) is negative signal (short).
 * Scaling: ±20%/yr → about ±3.
 */
export function carryToSignal(obs: CarryObs, symbolMap?: Record<string,string>): Signal {
  const slope = -obs.carryAnn                    // invert: backwardation => positive
  const z = Math.max(-3, Math.min(3, slope / 0.20 * 3)) // 20% → ±3
  const sym = symbolMap?.[obs.root] ?? `${obs.root}_CONT`
  return { id: 'commodity_carry', symbol: sym, value: z, ts: obs.ts }
}

/* ================= One-shot convenience ================= */
/**
 * Directly compute signals from a pile of quotes:
 * - Dedup to latest per contract
 * - Build term structures
 * - Compute carry per root
 * - Return signals
 */
export function carrySignalsFromQuotes(
  quotes: FutQuote[],
  ts?: Ts,
  symbolMap?: Record<string,string>
): Signal[] {
  const t = ts ?? (quotes.length ? quotes[quotes.length-1].ts : Date.now())
  const curves = termStructureFromQuotes(quotes)
  const out: Signal[] = []
  for(const c of curves){
    const obs = carryFromCurve(c, t)
    if(!obs) continue
    out.push(carryToSignal(obs, symbolMap))
  }
  return out
}

/* ================= Example =================
const quotes: FutQuote[] = [
  { contract:'CHANA-2025-11', root:'CHANA', px:5600, ts: Date.UTC(2025,9,1) },
  { contract:'CHANA-2026-01', root:'CHANA', px:5710, ts: Date.UTC(2025,9,1) },
  { contract:'JEERA-2025-11', root:'JEERA', px:42000, ts: Date.UTC(2025,9,1) },
  { contract:'JEERA-2026-01', root:'JEERA', px:41800, ts: Date.UTC(2025,9,1) }
]
console.log(carrySignalsFromQuotes(quotes))
*/