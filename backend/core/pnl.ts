// core/pnl.ts
// Self-contained P&L/accounting helpers. No imports.
// Tracks realized/unrealized PnL, equity curve, drawdowns, per-position attribution,
// simple cost model, and summary stats (Sharpe/Sortino/Calmar, hit rate, turnover).
// Designed to be called from your engine (on execs, on ticks, on revalues).

/* ======================= Types ======================= */
type Num = number
type Str = string
type Ts  = number

export type Position = {
  symbol: Str
  qty: Num              // signed (+ long, - short)
  avgPx: Num            // average entry price (signed qty-weighted)
}

export type Ledger = {
  cash: Num             // base currency
  positions: Position[]
  ts: Ts
}

export type Fill = {
  symbol: Str
  qty: Num              // signed; + buy, - sell
  px: Num               // execution price (all-in if fees/ slippage baked in)
  ts: Ts
  clientOrderId?: Str
}

export type Mark = { symbol: Str; px: Num; ts: Ts }

export type CostModel = {
  // Per-side linear costs measured in bps of notional; applied on trade.
  // Example: slippageBps=5, feesBps=2 => total 7 bps of |qty|*px
  slippageBps: Num
  feesBps: Num
}

export type EquityPoint = { t: Ts; nav: Num; dd: Num } // dd = drawdown (negative or zero)
export type TradeRecord = {
  tOpen: Ts; tClose?: Ts
  symbol: Str
  side: 'LONG'|'SHORT'
  entryPx: Num; exitPx?: Num
  qty: Num                     // absolute entry size
  realized: Num                // realized PnL on close (net of costs)
}

export type AttributionKey = {
  strategy?: Str
  region?: Str
  sector?: Str
}

export type Attribution = {
  // sum of realized/unrealized by key
  realized: Record<Str, Num>
  unrealized: Record<Str, Num>
}

/* ======================= Internal State ======================= */
const st = {
  lastPx: {} as Record<Str, Num>,                  // last mark per symbol
  ledger: { cash: 100_000, positions: [], ts: Date.now() } as Ledger,
  equity: [] as EquityPoint[],
  highWater: 100_000 as Num,
  costs: { slippageBps: 0, feesBps: 0 } as CostModel,
  // trade book (per round-trip) — best-effort (fifo, not tax-lot precise)
  openLots: new Map<Str, { qty: Num; px: Num; tOpen: Ts }[]>(),
  closed: [] as TradeRecord[],
  // running stats
  tradedNotional: 0 as Num,
  filledCount: 0 as Num,
  winners: 0 as Num,
  losers: 0 as Num
}

/* ======================= Helpers ======================= */
function sum(a:number[], f=(x:number)=>x){ let s=0; for(const v of a) s+=f(v); return s }
function abs(x:number){ return x<0? -x : x }
function sign(x:number){ return x===0? 0 : (x>0? 1 : -1) }
function toBps(n:number){ return n/10_000 }

function findPos(symbol:Str){
  const i = st.ledger.positions.findIndex(p=>p.symbol===symbol)
  return { i, p: i>=0 ? st.ledger.positions[i] : null as Position|null }
}

function pushEquity(t:Ts, nav:Num){
  st.highWater = Math.max(st.highWater, nav)
  const dd = nav - st.highWater // <= 0
  st.equity.push({ t, nav, dd })
  if(st.equity.length > 100_000) st.equity.splice(0, st.equity.length - 100_000)
}

/* ======================= Config ======================= */
export function setCostModel(cm: Partial<CostModel>){
  st.costs.slippageBps = cm.slippageBps ?? st.costs.slippageBps
  st.costs.feesBps     = cm.feesBps     ?? st.costs.feesBps
}

export function setInitialCash(cash:number){
  st.ledger.cash = cash
  st.highWater = cash
  pushEquity(Date.now(), cash)
}

/* ======================= Marking to Market ======================= */
export function mark(m: Mark){
  st.lastPx[m.symbol] = m.px
  st.ledger.ts = m.ts
}

export function markMany(marks: Mark[]){
  for(const m of marks) mark(m)
}

export function nav(): Num {
  let nav = st.ledger.cash
  for(const p of st.ledger.positions){
    const px = st.lastPx[p.symbol]
    if(px>0) nav += p.qty * px
  }
  return nav
}

export function unrealizedPnL(symbol?:Str){
  const calc = (p:Position)=> {
    const px = st.lastPx[p.symbol] ?? 0
    return (px - p.avgPx) * p.qty
  }
  if(symbol){
    const { p } = findPos(symbol); return p? calc(p): 0
  }
  let sumu=0
  for(const p of st.ledger.positions) sumu += calc(p)
  return sumu
}

/* ======================= Trade / Fill Application ======================= */
function applyCosts(notional:Num){
  const bps = st.costs.slippageBps + st.costs.feesBps
  return notional * toBps(bps)
}

/**
 * Applies a signed fill to the ledger and open-lot book.
 * - qty > 0 => buy; qty < 0 => sell
 * - px is all-in execution price (pre-costs); costs are applied to cash
 */
export function onFill(f: Fill){
  const { symbol, qty, px, ts } = f
  if(!(px>0) || qty===0) return

  // track traded notional and fill count
  st.tradedNotional += abs(qty) * px
  st.filledCount += 1

  const cost = applyCosts(abs(qty) * px)
  st.ledger.cash -= cost // pay costs from cash

  const { p, i } = findPos(symbol)
  const newQty = (p?.qty ?? 0) + qty
  const sideBefore = sign(p?.qty ?? 0)
  const sideAfter  = sign(newQty)

  // Update avgPx & qty
  if(!p){
    st.ledger.positions.push({ symbol, qty: newQty, avgPx: px })
  } else {
    if(sideBefore === 0 || sideBefore === sideAfter){
      // increasing on same side (or from flat)
      const oldNotional = abs(p.qty) * p.avgPx
      const addNotional = abs(qty) * px
      const totalQty = abs(p.qty) + abs(qty)
      p.avgPx = totalQty>0 ? (oldNotional + addNotional) / totalQty : px
      p.qty = newQty
    } else {
      // reducing / flipping
      p.qty = newQty
      if(sideAfter === 0){
        // flat -> keep avgPx as is (not used anymore)
      } else {
        // flipped to other side -> reset avgPx to trade px
        p.avgPx = px
      }
    }
  }

  // Open-lot book for round-trip PnL (FIFO per symbol)
  const lots = st.openLots.get(symbol) ?? []
  if(qty > 0){ // buy adds lot
    lots.push({ qty: qty, px, tOpen: ts })
  } else {     // sell closes existing lots
    let remain = -qty
    while(remain > 1e-12 && lots.length){
      const lot = lots[0]
      const take = Math.min(lot.qty, remain)
      lot.qty -= take
      remain  -= take

      const side: 'LONG'|'SHORT' = 'LONG'
      const realized = (px - lot.px) * take - applyCosts((take*px) + (take*lot.px)) // include both sides costs
      st.closed.push({ tOpen: lot.tOpen, tClose: ts, symbol, side, entryPx: lot.px, exitPx: px, qty: take, realized })

      if(realized >= 0) st.winners++; else st.losers++
      if(lot.qty <= 1e-12) lots.shift()
    }
  }
  st.openLots.set(symbol, lots)

  st.ledger.cash += -qty * px // pay/receive cash for trade (buy reduces cash)
  st.ledger.ts = ts

  // Clean zero positions
  const j = st.ledger.positions.findIndex(x=>x.symbol===symbol && Math.abs(x.qty) < 1e-10)
  if(j>=0) st.ledger.positions.splice(j,1)
}

/* ======================= Equity / Drawdown ======================= */
export function updateEquity(ts?:Ts){
  const t = ts ?? Date.now()
  const e = nav()
  pushEquity(t, e)
  return e
}

export function equityCurve(): EquityPoint[]{ return st.equity.slice() }
export function lastEquity(): EquityPoint|undefined { return st.equity[st.equity.length-1] }

export function maxDrawdown(): Num {
  let peak = -Infinity, mdd = 0
  for(const p of st.equity){
    if(p.nav > peak) peak = p.nav
    const dd = (p.nav - peak)
    if(dd < mdd) mdd = dd
  }
  return mdd // negative number (e.g., -2500)
}

/* ======================= Stats / Attribution ======================= */
export function turnover(): Num {
  // annualized-ish if you choose; here we just return tradedNotional / avg NAV
  const n = st.equity.length
  const avgNav = n ? sum(st.equity.map(e=>e.nav))/n : nav()
  return avgNav>0 ? st.tradedNotional / avgNav : 0
}

export function hitRate(): Num {
  const n = st.winners + st.losers
  return n ? st.winners / n : 0
}

function returnsFromEquity(): number[] {
  const r: number[] = []
  for(let i=1;i<st.equity.length;i++){
    const a = st.equity[i-1].nav
    const b = st.equity[i].nav
    if(a>0) r.push((b-a)/a)
  }
  return r
}

export function sharpe(rfPerPeriod=0): Num {
  const rets = returnsFromEquity()
  if(rets.length<2) return 0
  const ex = rets.map(x=>x - rfPerPeriod)
  const avg = sum(ex)/ex.length
  const var_ = sum(ex.map(x=>x*x))/ex.length - avg*avg
  const sd = Math.sqrt(Math.max(0,var_))
  return sd>0 ? avg/sd : 0
}

export function sortino(rfPerPeriod=0): Num {
  const rets = returnsFromEquity()
  if(rets.length<2) return 0
  const ex = rets.map(x=>x - rfPerPeriod)
  const neg = ex.filter(x=>x<0)
  const avg = sum(ex)/ex.length
  const denom = Math.sqrt(sum(neg.map(x=>x*x))/ (neg.length || 1))
  return denom>0 ? avg/denom : 0
}

export function calmar(): Num {
  const eq = st.equity
  if(eq.length<2) return 0
  const start = eq[0].nav, end = eq[eq.length-1].nav
  const ret = start>0 ? (end - start)/start : 0
  const mdd = Math.abs(maxDrawdown()) || 1
  return ret / (mdd / start)
}

/* ======================= Snapshots & Reports ======================= */
export type PnLSnapshot = {
  ts: Ts
  cash: Num
  nav: Num
  unrealized: Num
  positions: { symbol:Str; qty:Num; avgPx:Num; px:Num; uPnL:Num }[]
  stats: {
    maxDrawdown: Num
    sharpe: Num
    sortino: Num
    calmar: Num
    turnover: Num
    hitRate: Num
    trades: number
  }
}

export function snapshot(): PnLSnapshot {
  const positions = st.ledger.positions.map(p=>{
    const px = st.lastPx[p.symbol] ?? 0
    const u  = (px - p.avgPx) * p.qty
    return { symbol:p.symbol, qty:p.qty, avgPx:p.avgPx, px, uPnL:u }
  })
  const u = positions.reduce((a,b)=>a+b.uPnL,0)
  const n = nav()
  return {
    ts: st.ledger.ts,
    cash: st.ledger.cash,
    nav: n,
    unrealized: u,
    positions,
    stats: {
      maxDrawdown: maxDrawdown(),
      sharpe: sharpe(),
      sortino: sortino(),
      calmar: calmar(),
      turnover: turnover(),
      hitRate: hitRate(),
      trades: st.closed.length
    }
  }
}

/* ======================= Weekly Summary ======================= */
export function weeklySummary(): { start:Ts; end:Ts; ret:Num; trades:number } {
  if(st.equity.length<2) return { start:0,end:0,ret:0,trades:0 }
  const end = st.equity[st.equity.length-1].t
  const weekMs = 7*24*3600*1000
  const start = end - weekMs
  const eq = st.equity.filter(p=>p.t>=start)
  const a = eq[0]?.nav ?? st.equity[0].nav
  const b = eq[eq.length-1]?.nav ?? st.equity[st.equity.length-1].nav
  const ret = a>0 ? (b-a)/a : 0
  const tcount = st.closed.filter(t=> (t.tClose ?? 0) >= start).length
  return { start, end, ret, trades: tcount }
}

/* ======================= Reset / Clear ======================= */
export function reset(all:boolean=false){
  st.lastPx = {}
  if(all){
    st.ledger = { cash: 100_000, positions: [], ts: Date.now() }
    st.equity = []
    st.highWater = st.ledger.cash
    st.openLots.clear()
    st.closed = []
    st.tradedNotional = 0
    st.filledCount = 0
    st.winners = 0
    st.losers = 0
  }
}

/* ======================= Minimal Attribution (optional) ======================= */
// You can call bumpAttribution() whenever you compute per-symbol keys externally.
const attr: Attribution = { realized:{}, unrealized:{} }
export function bumpRealized(key:Str, amt:Num){ attr.realized[key] = (attr.realized[key]??0) + amt }
export function bumpUnrealized(key:Str, amt:Num){ attr.unrealized[key] = (attr.unrealized[key]??0) + amt }
export function getAttribution(){ return { realized: { ...attr.realized }, unrealized: { ...attr.unrealized } } }

/* ======================= Wiring tips ======================= */
/*
Engine side:
- On each tick: PnL.mark({symbol, px, ts}); const e = PnL.updateEquity(ts); emit('equity', e)
- On each exec: PnL.onFill({symbol, qty: side==='BUY'?+q:-q, px:avgPx, ts})
- For dashboard: const snap = PnL.snapshot()

Cost model:
- setCostModel({ slippageBps: 5, feesBps: 2 })

Initialization:
- setInitialCash(100_000)
*/