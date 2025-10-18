// core/recompute.ts
// Deterministic, idempotent recomputation pass.
// Rebuilds portfolio state (cash, positions, NAV, equity, PnL stats) from an event journal.
// Pure TS, no imports.

/* ======================= Types ======================= */
type Num = number
type Str = string
type Ts  = number

export type Position = { symbol: Str; qty: Num; avgPx: Num }
export type Ledger   = { cash: Num; positions: Position[]; ts: Ts; nav?: Num }
export type EquityPt = { t: Ts; nav: Num; dd: Num }

export type EventBase = { id: Str; ts: Ts; type: Str } // id must be unique (idempotency)
export type CashEvent = EventBase & { type:'cash'; delta: Num; note?: Str }
export type FillEvent = EventBase & { type:'fill'; symbol: Str; qty: Num; px: Num; clientOrderId?: Str }
export type MarkEvent = EventBase & { type:'mark'; symbol: Str; px: Num }
export type SplitEvent= EventBase & { type:'split'; symbol: Str; ratio: Num }          // e.g., 2 = 2-for-1
export type DivEvent  = EventBase & { type:'div'; symbol: Str; amount: Num }           // cash dividend per share
export type CAEvent   = SplitEvent | DivEvent

export type AnyEvent  = CashEvent | FillEvent | MarkEvent | CAEvent

export type RecomputeInput = {
  initialCash: Num
  events: AnyEvent[]        // unsorted; may contain duplicates (same id) → deduped
  endTs?: Ts                // optional cutoff (inclusive)
  costBps?: Num             // optional per-side costs applied to fills (bps of notional)
}

export type RecomputeOutput = {
  ledger: Ledger
  equity: EquityPt[]
  lastPx: Record<Str, Num>
  stats: {
    maxDrawdown: Num
    trades: number
  }
}

/* ======================= Helpers ======================= */
function deepClone<T>(x:T):T{ return JSON.parse(JSON.stringify(x)) }
function sum(a:number[]){ let s=0; for(const v of a) s+=v; return s }
function abs(x:number){ return x<0? -x: x }
function toBps(n:number){ return n/10_000 }
function sortStable<T>(arr:T[], key:(x:T)=>number|string){
  return arr.slice().sort((a,b)=> {
    const ka = key(a), kb = key(b)
    if(ka<kb) return -1; if(ka>kb) return 1; return 0
  })
}

function upsertPos(positions:Position[], symbol:Str){
  const i = positions.findIndex(p=>p.symbol===symbol)
  if(i>=0) return { p: positions[i], i }
  const p = { symbol, qty: 0, avgPx: 0 }; positions.push(p)
  return { p, i: positions.length-1 }
}

function markToMarket(ledger:Ledger, lastPx:Record<Str,Num>){
  let nav = ledger.cash
  for(const p of ledger.positions) nav += (lastPx[p.symbol] ?? 0) * p.qty
  ledger.nav = nav
}

/* ======================= Drawdown ======================= */
function pushEquity(equity:EquityPt[], t:Ts, nav:Num, hw:{v:Num}){
  hw.v = Math.max(hw.v, nav)
  const dd = nav - hw.v
  equity.push({ t, nav, dd })
  if(equity.length>100_000) equity.splice(0, equity.length-100_000)
}

function maxDrawdown(equity:EquityPt[]){
  let peak = -Infinity, mdd = 0
  for(const p of equity){
    if(p.nav>peak) peak=p.nav
    const dd = p.nav - peak
    if(dd<mdd) mdd = dd
  }
  return mdd
}

/* ======================= Corporate Actions ======================= */
function applySplit(positions:Position[], symbol:Str, ratio:Num){
  if(!(ratio>0)) return
  const p = positions.find(x=>x.symbol===symbol); if(!p) return
  // 2-for-1 (ratio=2): qty doubles, avgPx halves
  p.qty   *= ratio
  p.avgPx /= ratio
}

function applyDividend(ledger:Ledger, positions:Position[], symbol:Str, amount:Num){
  if(!(amount>0)) return
  const p = positions.find(x=>x.symbol===symbol); if(!p) return
  ledger.cash += p.qty * amount
}

/* ======================= Fills ======================= */
function applyFill(ledger:Ledger, p:Position, qty:Num, px:Num, costBps:Num){
  if(!(px>0) || qty===0) return
  const notional = abs(qty)*px
  const cost = notional * toBps(costBps)
  ledger.cash += -qty*px - cost

  // avgPx update
  const sameSide = (p.qty===0) || (Math.sign(p.qty)===Math.sign(qty))
  if(sameSide){
    const oldNotional = abs(p.qty)*p.avgPx
    const newNotional = abs(qty)*px
    const totQty = abs(p.qty) + abs(qty)
    p.avgPx = totQty>0 ? (oldNotional + newNotional)/totQty : px
    p.qty += qty
  } else {
    // reducing / flipping
    const newQty = p.qty + qty
    p.qty = newQty
    if(Math.sign(newQty) !== Math.sign(p.qty)) p.avgPx = px
  }

  // prune flat
  if(Math.abs(p.qty) < 1e-12){ p.qty = 0; p.avgPx = 0 }
}

/* ======================= Recompute ======================= */
export function recompute(input: RecomputeInput): RecomputeOutput {
  const { initialCash, costBps=0 } = input
  const cutoff = input.endTs ?? Number.MAX_SAFE_INTEGER

  // 1) Dedupe by id (last one wins on same id)
  const map = new Map<Str, AnyEvent>()
  for(const ev of input.events){ if(ev.ts<=cutoff) map.set(ev.id, ev) }
  const events = sortStable(Array.from(map.values()), e=> e.ts*1_000 + typeOrder(e.type))

  // 2) State
  const ledger: Ledger = { cash: initialCash, positions: [], ts: 0 }
  const lastPx: Record<Str, Num> = {}
  const equity: EquityPt[] = []
  const hw = { v: initialCash }
  let trades = 0

  // 3) Replay deterministically
  for(const ev of events){
    ledger.ts = ev.ts

    if(ev.type==='cash'){
      ledger.cash += (ev as CashEvent).delta
    }
    else if(ev.type==='split'){
      const { symbol, ratio } = ev as SplitEvent
      applySplit(ledger.positions, symbol, ratio)
    }
    else if(ev.type==='div'){
      const { symbol, amount } = ev as DivEvent
      applyDividend(ledger, ledger.positions, symbol, amount)
    }
    else if(ev.type==='fill'){
      const f = ev as FillEvent
      const { p } = upsertPos(ledger.positions, f.symbol)
      applyFill(ledger, p, f.qty, f.px, costBps)
      trades++
    }
    else if(ev.type==='mark'){
      const m = ev as MarkEvent
      lastPx[m.symbol] = m.px
    }

    markToMarket(ledger, lastPx)
    pushEquity(equity, ev.ts, ledger.nav||0, hw)
  }

  return {
    ledger,
    equity,
    lastPx,
    stats: { maxDrawdown: maxDrawdown(equity), trades }
  }
}

/* ======================= Ordering within same timestamp ======================= */
// Ensures deterministic effect when multiple events share the same ts.
// E.g., splits should apply before marks; fills should apply before marks to avoid mid-tick lookahead.
function typeOrder(t: Str){
  switch(t){
    case 'split': return 10
    case 'div'  : return 20
    case 'cash' : return 30
    case 'fill' : return 40
    case 'mark' : return 50
    default: return 99
  }
}

/* ======================= Utilities / Manifests ======================= */
export function manifestHash(input: RecomputeInput){
  // non-crypto quick hash for reproducibility tags
  const s = JSON.stringify({
    initialCash: input.initialCash,
    endTs: input.endTs ?? null,
    costBps: input.costBps ?? 0,
    ids: input.events.map(e=>e.id).sort(), // order-insensitive
    n: input.events.length
  })
  let h=0; for(let i=0;i<s.length;i++){ h = (h*131 + s.charCodeAt(i)) >>> 0 }
  return `M${h.toString(16)}`
}

export function emptyOutput(initialCash=100_000): RecomputeOutput {
  const ts = Date.now()
  return {
    ledger: { cash: initialCash, positions: [], ts, nav: initialCash },
    equity: [{ t: ts, nav: initialCash, dd: 0 }],
    lastPx: {},
    stats: { maxDrawdown: 0, trades: 0 }
  }
}

/* ======================= Example (remove if not needed) ======================= */
/*
const out = recompute({
  initialCash: 100000,
  costBps: 7,
  events: [
    { id:'c1', ts: 1, type:'cash', delta: 10000 },
    { id:'m1', ts: 2, type:'mark', symbol:'AAPL', px:100 },
    { id:'f1', ts: 3, type:'fill', symbol:'AAPL', qty: 50, px:100 },
    { id:'m2', ts: 4, type:'mark', symbol:'AAPL', px:103 },
    { id:'d1', ts: 5, type:'div',  symbol:'AAPL', amount:0.2 },
    { id:'s1', ts: 6, type:'split',symbol:'AAPL', ratio:2 },
    { id:'m3', ts: 7, type:'mark', symbol:'AAPL', px:52 }
  ]
})
console.log(out.ledger, out.stats, out.equity[out.equity.length-1])
*/