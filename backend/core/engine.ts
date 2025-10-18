// core/engine.ts
// Self-contained trading engine. No imports.
// Wire it from app/main.ts by calling: Engine.setFeed(...); Engine.setGateway(...); Engine.start()

/* ======================= Types & Contracts ======================= */

type Num = number
type Str = string
type Ts  = number // epoch ms

export type Tick = { t:Ts; symbol:Str; px:Num }
export type Bar  = { t:Ts; symbol:Str; o:Num; h:Num; l:Num; c:Num; v?:Num }

export type Signal = { id:Str; symbol:Str; value:Num; ts:Ts } // normalized [-3..+3] preferred
export type StrategyFn = (ctx:{ now:Ts; symbol:Str; lastPrice:Num }) => Signal|null

export type Position = { symbol:Str; qty:Num; avgPx:Num }
export type Ledger   = { cash:Num; positions:Position[]; ts:Ts; nav?:Num }

export type OrderSide = 'BUY'|'SELL'
export type Order = {
  clientOrderId: Str
  symbol: Str
  side: OrderSide
  qty: Num
  limitPx?: Num
  ts: Ts
}

export type ExecReport = {
  clientOrderId: Str
  symbol: Str
  filledQty: Num
  avgPx: Num
  status: 'PARTIAL'|'FILLED'|'REJECTED'|'CANCELLED'
  ts: Ts
}

export type ExecutionGateway = {
  submit:(ord:Order)=>void
  cancel:(clientOrderId:Str)=>void
}

export type Feed = {
  connect:()=>void
  disconnect:()=>void
  onTick:(h:(k:Tick)=>void)=>void
}

/* ======================= Tiny Event Bus ======================= */

type Handler<T=any> = (p:T)=>void
const bus: Record<string, Handler[]> = {}

function on<T=any>(ev:string, h:Handler<T>){
  (bus[ev]??=[]).push(h); return ()=> bus[ev]= (bus[ev]||[]).filter(x=>x!==h)
}
function emit<T=any>(ev:string, p:T){
  (bus[ev]||[]).forEach(h=>{ try{ h(p) }catch(e){ /* swallow */ } })
}

/* ======================= Engine State ======================= */

const state = {
  feed: null as Feed|null,
  gw:   null as ExecutionGateway|null,

  // strategies
  strategies: {} as Record<Str, StrategyFn>,
  enabled: [] as Str[],

  // recent ticks per symbol
  lastPx: {} as Record<Str, Num>,

  // signals by strategy -> symbol
  lastSignals: {} as Record<Str, Record<Str, Signal>>,

  // portfolio / ledger
  ledger: { cash: 100_000, positions: [], ts: Date.now(), nav: 100_000 } as Ledger,

  // config-lite (you can overwrite via setConfig)
  config: {
    rebalanceMs: 60_000,
    maxDrawdown: 0.25,
    maxGrossExposure: 1.5,
    maxSinglePosition: 0.08,
    correlationCap: 0.8,     // placeholder; aggregator uses as soft cap
    slippageBps: 5,
    tcBps: 2
  },

  // persistence hooks (optional)
  persistence: {
    save: (l:Ledger)=>{},
    load: ():Ledger|null=>null
  }
}

/* ======================= Helpers ======================= */

function now(){ return Date.now() }
function id(prefix='o'){ return `${prefix}_${now()}_${Math.random().toString(36).slice(2,8)}` }

function findPos(symbol:Str){
  const i = state.ledger.positions.findIndex(p=>p.symbol===symbol)
  return { i, p: i>=0 ? state.ledger.positions[i] : null as Position|null }
}

function markToMarket(){
  let nav = state.ledger.cash
  for(const p of state.ledger.positions){
    const px = state.lastPx[p.symbol]; if(px>0) nav += p.qty * px
  }
  state.ledger.nav = nav
}

/* ======================= Strategy Registry ======================= */

function registerStrategy(id:Str, fn:StrategyFn){
  state.strategies[id] = fn
  if(!state.enabled.includes(id)) state.enabled.push(id)
  state.lastSignals[id] ||= {}
}

function enableStrategy(id:Str, onOff:boolean){
  const i = state.enabled.indexOf(id)
  if(onOff && i<0) state.enabled.push(id)
  if(!onOff && i>=0) state.enabled.splice(i,1)
}

/* ======================= Signal Aggregation ======================= */

function runStrategiesFor(symbol:Str, px:Num){
  const ts = now()
  for(const id of state.enabled){
    const fn = state.strategies[id]; if(!fn) continue
    const sig = fn({ now: ts, symbol, lastPrice: px })
    if(sig){ (state.lastSignals[id] ||= {})[symbol] = sig; emit('signal', sig) }
  }
}

/* ======================= Risk Gates (simple) ======================= */

function grossExposure(pxMap:Record<Str,Num>){
  let gross=0
  for(const p of state.ledger.positions){
    const px = pxMap[p.symbol] ?? 0
    gross += Math.abs(p.qty * px)
  }
  return gross / (state.ledger.nav||1)
}

function canTrade(symbol:Str, targetNotional:Num){
  // MDD gate not computed here (needs equity curve) — use placeholder always true.
  const ge = grossExposure(state.lastPx)
  if(ge + Math.abs(targetNotional)/(state.ledger.nav||1) > state.config.maxGrossExposure) return false
  // single-position cap
  if(Math.abs(targetNotional)/(state.ledger.nav||1) > state.config.maxSinglePosition) return false
  return true
}

/* ======================= Targeting & Orders ======================= */

function targetWeights(): Record<Str, Num> {
  // Simple example: average of available strategy signals per symbol, mapped to [-0.5..+0.5]
  // You can replace with your allocator.
  const out: Record<Str, Num> = {}
  const perSymbol: Record<Str, Num[]> = {}
  for(const id of state.enabled){
    const m = state.lastSignals[id]; if(!m) continue
    for(const sym in m){ (perSymbol[sym] ||= []).push(m[sym].value) }
  }
  for(const sym in perSymbol){
    const arr = perSymbol[sym]
    const avg = arr.reduce((a,b)=>a+b,0) / arr.length
    const w = Math.max(-0.5, Math.min(0.5, avg/3)) // assuming value in ~[-3..3]
    out[sym] = w
  }
  return out
}

function rebalance(){
  markToMarket()
  const nav = state.ledger.nav||0
  const w  = targetWeights()
  const orders: Order[] = []

  for(const sym in w){
    const px = state.lastPx[sym]; if(!(px>0)) continue
    const tgtNotional = w[sym] * nav
    if(!canTrade(sym, tgtNotional)) continue

    const { p } = findPos(sym)
    const curQty = p ? p.qty : 0
    const tgtQty = Math.round((tgtNotional/px) * 100) / 100 // 2-dec shares; adapt as needed
    const delta  = tgtQty - curQty
    if(Math.abs(delta) < 0.01) continue

    const side: OrderSide = delta>0 ? 'BUY' : 'SELL'
    const ord: Order = {
      clientOrderId: id('ord'),
      symbol: sym,
      side,
      qty: Math.abs(delta),
      ts: now()
    }
    orders.push(ord)
  }

  // Submit
  for(const o of orders){
    if(state.gw) state.gw.submit(o)
    emit('order', o)
  }
}

/* ======================= Fills & Ledger Updates ======================= */

function onExec(rep: ExecReport){
  const { p, i } = findPos(rep.symbol)
  if(rep.status==='FILLED' || rep.status==='PARTIAL'){
    const signedQty = rep.filledQty * (rep.clientOrderId.includes('_sell')?-1:1) // optional heuristic
    const qty = rep.filledQty
    const px  = rep.avgPx

    if(p){
      const newQty = p.qty + signedQty
      if(Math.abs(newQty) < 1e-8){
        // flat
        state.ledger.cash -= qty * px * (rep.clientOrderId.includes('_sell')? -1 : 1)
        state.ledger.positions.splice(i!,1)
      }else{
        // weighted average
        const dir = signedQty>0 ? 1 : -1
        if((p.qty>0 && dir>0) || (p.qty<0 && dir<0)){
          // add to same side
          p.avgPx = (Math.abs(p.qty)*p.avgPx + qty*px) / (Math.abs(p.qty)+qty)
          p.qty = newQty
        }else{
          // reduce/flip
          p.qty = newQty
          if(Math.sign(newQty)!==Math.sign(p.qty)) p.avgPx = px
        }
        state.ledger.cash += (rep.clientOrderId.includes('_sell')? qty*px : -qty*px)
      }
    } else {
      // open new
      const openQty = rep.filledQty * (rep.clientOrderId.includes('_sell')?-1:1)
      state.ledger.positions.push({ symbol: rep.symbol, qty: openQty, avgPx: px })
      state.ledger.cash += (rep.clientOrderId.includes('_sell')? qty*px : -qty*px)
    }
  }
  state.ledger.ts = rep.ts
  markToMarket()
  emit('ledger', state.ledger)
}

/* ======================= Feed Wiring ======================= */

function setFeed(feed:Feed){
  if(state.feed) state.feed.disconnect()
  state.feed = feed
  feed.onTick(k=>{
    state.lastPx[k.symbol] = k.px
    emit('tick', k)
    // run strategies opportunistically on each symbol update
    runStrategiesFor(k.symbol, k.px)
  })
}

function setGateway(gw:ExecutionGateway){
  state.gw = gw
}

/* ======================= Persistence Hooks ======================= */

function setPersistence(api:{ save:(l:Ledger)=>void, load:()=>Ledger|null }){
  state.persistence = api
}

function loadLedger(){
  const l = state.persistence.load()
  if(l) state.ledger = l
  markToMarket()
  emit('ledger', state.ledger)
}

function saveLedger(){
  state.persistence.save(state.ledger)
}

/* ======================= Scheduler Hooks ======================= */

let rbTimer: any = null
function startRebalanceTimer(ms:number){
  stopRebalanceTimer()
  rbTimer = setInterval(rebalance, ms)
}
function stopRebalanceTimer(){
  if(rbTimer){ clearInterval(rbTimer); rbTimer = null }
}

/* ======================= Public API ======================= */

function start(){
  if(state.feed) state.feed.connect()
  startRebalanceTimer(state.config.rebalanceMs)
}

function stop(){
  stopRebalanceTimer()
  state.feed?.disconnect()
}

function getState(){
  markToMarket()
  return {
    ledger: state.ledger,
    lastPx: { ...state.lastPx },
    lastSignals: state.lastSignals,
    enabled: [...state.enabled],
    config: { ...state.config }
  }
}

/* ======================= Exported Singleton ======================= */

export const Engine = {
  // lifecycle
  start, stop,

  // wiring
  setFeed, setGateway, setPersistence,

  // strategies
  registerStrategy, enableStrategy,

  // actions
  rebalance, loadLedger, saveLedger,

  // subscribe
  on, emit,

  // inspect
  getState,

  // test/help
  _onExec: onExec, // expose for gateway to call on fills
  _id: id
}