// core/execution.ts
// Execution gateway + order simulator (partials, queue, rejects, cancels, latency, slippage).
// Pure TS, no imports. Plug into Engine via Engine.setGateway(createMockBroker(...))

/* ======================= Types (align with engine.ts) ======================= */
type Num = number
type Str = string
type Ts  = number

export type OrderSide = 'BUY'|'SELL'
export type Order = {
  clientOrderId: Str
  symbol: Str
  side: OrderSide
  qty: Num
  limitPx?: Num
  ts: Ts
}

export type ExecStatus = 'PARTIAL'|'FILLED'|'REJECTED'|'CANCELLED'
export type ExecReport = {
  clientOrderId: Str
  symbol: Str
  filledQty: Num
  avgPx: Num
  status: ExecStatus
  ts: Ts
}

export type ExecutionGateway = {
  submit: (o: Order) => void
  cancel: (clientOrderId: Str) => void
}

/* ======================= Utilities ======================= */
const now = () => Date.now()
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const id = (p='x') => `${p}_${now()}_${Math.random().toString(36).slice(2,8)}`
const sign = (side: OrderSide) => side === 'BUY' ? 1 : -1

/* ======================= Price & Clock Interfaces ======================= */
export type PriceFn = (symbol: Str) => Num // must return last tradable price (>0) for symbol
export type MarketClock = { isOpen:(d:Date)=>boolean }

/* ======================= Options ======================= */
export type BrokerOptions = {
  venueLatencyMs?: number           // base latency per fill event
  latencyJitterMs?: number          // +/- jitter
  partialFill?: boolean             // enable partial fills
  minSlices?: number                // min partial slices
  maxSlices?: number                // max partial slices
  rejectRate?: number               // 0..1 probability of immediate reject
  cancelLatencyMs?: number          // latency to honor cancel
  feeBps?: number                   // fees per notional (positive bps)
  slippageBps?: number              // per-leg slippage (buy pays up, sell down)
  respectMarketHours?: boolean      // if true, reject when market closed
}

/* ======================= Internal Order State ======================= */
type QItem = {
  order: Order
  remaining: number
  avgPxAcc: number                 // sum(price*qty) accumulator
  filled: number
  cancelled: boolean
  timers: any[]
}

/* ======================= Mock Broker Factory ======================= */
export function createMockBroker(
  getPrice: PriceFn,
  onExec: (r: ExecReport) => void,
  clock?: MarketClock,
  opts?: BrokerOptions
): ExecutionGateway {
  const cfg = {
    venueLatencyMs: opts?.venueLatencyMs ?? 180,
    latencyJitterMs: opts?.latencyJitterMs ?? 120,
    partialFill: opts?.partialFill ?? true,
    minSlices: opts?.minSlices ?? 2,
    maxSlices: opts?.maxSlices ?? 5,
    rejectRate: clamp(opts?.rejectRate ?? 0.01, 0, 0.25),
    cancelLatencyMs: opts?.cancelLatencyMs ?? 80,
    feeBps: opts?.feeBps ?? 1,
    slippageBps: opts?.slippageBps ?? 2,
    respectMarketHours: opts?.respectMarketHours ?? false
  }

  const inflight = new Map<Str, QItem>()  // clientOrderId -> state
  const seen = new Set<Str>()             // idempotency

  function emitExec(q: QItem, qty: number, px: number, status: ExecStatus){
    const { clientOrderId, symbol } = q.order
    const filledQty = qty
    // accumulate VWAP
    q.filled += filledQty
    q.avgPxAcc += px * filledQty
    const avgPx = q.filled > 0 ? q.avgPxAcc / q.filled : 0
    const rep: ExecReport = { clientOrderId, symbol, filledQty, avgPx, status, ts: now() }
    onExec(rep)
  }

  function effectivePx(side: OrderSide, mktPx: number, limit?: number){
    const slip = mktPx * (cfg.slippageBps/10_000) * sign(side)
    let px = mktPx + slip
    if(limit != null){
      if(side === 'BUY' && px > limit) px = limit
      if(side === 'SELL' && px < limit) px = limit
    }
    return Math.max(0.0001, px)
  }

  function schedule(fn: ()=>void, base: number){
    const t = setTimeout(fn, Math.max(0, base + rnd(-cfg.latencyJitterMs, cfg.latencyJitterMs)))
    return t
  }

  function fillInSlices(q: QItem){
    const { order } = q
    const slices = cfg.partialFill ? Math.floor(rnd(cfg.minSlices, cfg.maxSlices+1)) : 1
    let remaining = q.remaining
    const sliceQtys: number[] = []
    if(slices<=1){ sliceQtys.push(remaining) }
    else{
      // split remaining into random slices summing to remaining
      let leftover = remaining
      for(let i=0;i<slices-1;i++){
        const part = Math.max(0.01, rnd(0.1, 0.35) * leftover)
        sliceQtys.push(part); leftover -= part
      }
      sliceQtys.push(leftover)
    }

    sliceQtys.forEach((qty, idx)=>{
      const t = schedule(()=> {
        if(q.cancelled) return
        // price check
        const mkt = getPrice(order.symbol) || 0
        if(mkt <= 0){
          // treat as reject if price missing
          emitExec(q, 0, 0, 'REJECTED')
          cleanup(order.clientOrderId)
          return
        }
        let px = effectivePx(order.side, mkt, order.limitPx)
        // enforce limit fillability
        if(order.limitPx != null){
          if(order.side === 'BUY' && px > order.limitPx) { emitExec(q, 0, px, 'REJECTED'); cleanup(order.clientOrderId); return }
          if(order.side === 'SELL' && px < order.limitPx){ emitExec(q, 0, px, 'REJECTED'); cleanup(order.clientOrderId); return }
        }
        const qExec = Math.min(q.remaining, Math.max(0.01, qty))
        q.remaining = Math.max(0, q.remaining - qExec)

        // fees baked into avgPx (for simplicity); adjust sign-wise
        const feePxAdj = px * (cfg.feeBps/10_000) * (order.side==='BUY' ? 1 : -1)
        px += feePxAdj

        const status: ExecStatus = (idx === sliceQtys.length-1 || q.remaining <= 0) ? 'FILLED' : 'PARTIAL'
        emitExec(q, qExec, px, status)

        if(status === 'FILLED' || q.remaining <= 0){
          cleanup(order.clientOrderId)
        }
      }, cfg.venueLatencyMs)
      q.timers.push(t)
    })
  }

  function cleanup(id: Str){
    const q = inflight.get(id)
    if(!q) return
    q.timers.forEach(clearTimeout)
    inflight.delete(id)
  }

  function submit(order: Order){
    if(seen.has(order.clientOrderId)) return // idempotent
    seen.add(order.clientOrderId)

    // market hours gate
    if(cfg.respectMarketHours && clock && !clock.isOpen(new Date())){
      const px = getPrice(order.symbol) || 0
      onExec({ clientOrderId: order.clientOrderId, symbol: order.symbol, filledQty: 0, avgPx: px, status: 'REJECTED', ts: now() })
      return
    }

    // probabilistic reject (e.g., risk check)
    if(Math.random() < cfg.rejectRate){
      const px = getPrice(order.symbol) || 0
      onExec({ clientOrderId: order.clientOrderId, symbol: order.symbol, filledQty: 0, avgPx: px, status: 'REJECTED', ts: now() })
      return
    }

    // enqueue
    const qi: QItem = { order, remaining: order.qty, avgPxAcc: 0, filled: 0, cancelled: false, timers: [] }
    inflight.set(order.clientOrderId, qi)
    fillInSlices(qi)
  }

  function cancel(clientOrderId: Str){
    const q = inflight.get(clientOrderId)
    if(!q) return
    q.cancelled = true
    const t = setTimeout(()=>{
      cleanup(clientOrderId)
      // send CANCELLED for the leftover (qty=0 to indicate no additional fill)
      const px = getPrice(q.order.symbol) || 0
      onExec({ clientOrderId, symbol: q.order.symbol, filledQty: 0, avgPx: px, status: 'CANCELLED', ts: now() })
    }, cfg.cancelLatencyMs)
    q.timers.push(t)
  }

  return { submit, cancel }
}

/* ======================= Live Broker Template ======================= */
/* 
Usage:
const gw = createLiveBroker(
  (rep)=> Engine._onExec(rep) // forward reports to engine
)
Engine.setGateway(gw)
*/

export function createLiveBroker(
  onExec: (r: ExecReport) => void
): ExecutionGateway {
  // Placeholder; implement with real broker SDK/REST/WebSocket
  const pend = new Set<string>()
  function submit(o: Order){
    // TODO: map to broker order; listen for fills; call onExec per fill
    pend.add(o.clientOrderId)
    // until implemented:
    onExec({ clientOrderId:o.clientOrderId, symbol:o.symbol, filledQty:0, avgPx:0, status:'REJECTED', ts: now() })
  }
  function cancel(id: Str){
    // TODO: cancel via broker; on cancel event:
    if(pend.has(id)){
      onExec({ clientOrderId:id, symbol:'', filledQty:0, avgPx:0, status:'CANCELLED', ts: now() })
      pend.delete(id)
    }
  }
  return { submit, cancel }
}

/* ======================= Dedupe Wrapper (optional) ======================= */
export function withDedupe(base: ExecutionGateway){
  const seen = new Set<string>()
  const wrap: ExecutionGateway = {
    submit(o){ if(seen.has(o.clientOrderId)) return; seen.add(o.clientOrderId); base.submit(o) },
    cancel(id){ base.cancel(id) }
  }
  return wrap
}