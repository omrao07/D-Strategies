// core/risk.ts
// Centralized risk gates & exposure accounting. Pure TS, no imports.
// - MDD gate (equity high-water vs. current NAV)
// - Gross / net / single-name caps
// - Correlation cap (avg |corr| from rolling returns)
// - Per-bucket (sector/region) caps
// - Staleness (price age) gate
// - Kill switch
// - Plan validator to prune/scale trades before execution

type Num = number
type Str = string
type Ts  = number

/* ========================= Types ========================= */
export type Position = { symbol: Str; qty: Num; avgPx: Num }
export type Prices   = Record<Str, Num>
export type Trade    = { symbol: Str; fromQty: Num; toQty: Num; deltaQty: Num; notional: Num }
export type Plan     = { targets: Record<Str,Num>; trades: Trade[]; estGross: Num; estCashAfter: Num }

export type Meta = { sector?: Str; region?: Str }
export type MetaMap = Record<Str, Meta>

export type Limits = {
  maxDrawdown: Num          // e.g., 0.25  (25%)
  maxGross: Num             // e.g., 1.50  (150% gross)
  maxSingle: Num            // e.g., 0.08  (8% NAV per name)
  correlationCap: Num       // e.g., 0.80  (avg |corr| soft cap)
  stalenessMs: Num          // e.g., 30_000 (30s max)
  bucketCaps?: {            // optional caps per sector/region
    sector?: Record<Str, Num> // % of NAV (gross) per sector
    region?: Record<Str, Num> // % of NAV (gross) per region
  }
}

export type Context = {
  nav: Num
  prices: Prices
  positions: Position[]
}

export type Breach = { code: Str; msg: Str; data?: any; ts: Ts }
export type GateResult = { ok: boolean; reason?: Breach }

/* ========================= State ========================= */
const cfg: Limits = {
  maxDrawdown: 0.25,
  maxGross: 1.50,
  maxSingle: 0.08,
  correlationCap: 0.80,
  stalenessMs: 30_000,
  bucketCaps: undefined
}

const meta: MetaMap = {}                    // symbol → {sector,region}
const lastPx: Prices = {}                   // last price per symbol
const lastTs: Record<Str, Ts> = {}          // last tick ts per symbol
const returns: Record<Str, number[]> = {}   // rolling returns window
const WIN = 256                             // rolling window length

let equityHW = 0                            // high-water NAV
let lastEquity = 0
let killed: { on: boolean; reason?: Str } = { on: false }

/* ========================= Utils ========================= */
const now = ()=> Date.now()
const abs = (x:number)=> x<0 ? -x : x
const sum = (a:number[]) => a.reduce((p,c)=>p+c,0)
const clamp = (v:number,a:number,b:number)=> Math.max(a, Math.min(b, v))

function bucket(key:'sector'|'region', symbol:Str){ return meta[symbol]?.[key] ?? 'UNKNOWN' }

function pushReturn(symbol:Str, ret:number){
  const buf = returns[symbol] ?? (returns[symbol] = [])
  buf.push(ret)
  if(buf.length > WIN) buf.splice(0, buf.length - WIN)
}

function cov(x:number[], y:number[]){
  const n = Math.min(x.length, y.length)
  if(n<2) return 0
  let sx=0, sy=0; for(let i=0;i<n;i++){ sx+=x[i]; sy+=y[i] }
  const mx = sx/n, my = sy/n
  let c=0; for(let i=0;i<n;i++){ c += (x[i]-mx)*(y[i]-my) }
  return c/(n-1)
}
function variance(x:number[]){ return cov(x,x) }
function corr(x:number[], y:number[]){
  const vx = variance(x), vy = variance(y)
  if(vx<=0 || vy<=0) return 0
  return cov(x,y) / Math.sqrt(vx*vy)
}

/* ========================= Public API ========================= */
export const Risk = {
  /* ---- Configuration ---- */
  setLimits(next: Partial<Limits>){ Object.assign(cfg, next) },
  setMeta(map: MetaMap){ for(const s in map) meta[s] = map[s] },

  /* ---- Lifecycle hooks ---- */
  recordEquity(nav:number){
    if(equityHW===0) equityHW = nav
    equityHW = Math.max(equityHW, nav)
    lastEquity = nav
  },

  mark(symbol:Str, px:Num, ts:Ts){
    const prev = lastPx[symbol]
    if(prev>0 && px>0){
      const r = (px - prev) / prev
      pushReturn(symbol, r)
    }
    lastPx[symbol] = px
    lastTs[symbol] = ts
  },

  /* ---- Kill switch ---- */
  setKill(on:boolean, reason?:Str){ killed.on = on; killed.reason = reason },
  isKilled(){ return killed.on },
  killReason(){ return killed.reason },

  /* ---- Exposure accounting ---- */
  gross(ctx: Context){
    if(!(ctx.nav>0)) return 0
    let g=0; for(const p of ctx.positions){ const px=ctx.prices[p.symbol]??0; if(px>0) g += abs(p.qty*px) }
    return g / ctx.nav
  },
  singleWeight(ctx: Context, symbol:Str, qty:Num){
    const px = ctx.prices[symbol] ?? 0
    if(!(ctx.nav>0) || !(px>0)) return 0
    return (abs(qty)*px) / ctx.nav
  },
  buckets(ctx: Context){
    const sector: Record<Str,Num> = {}, region: Record<Str,Num> = {}
    for(const p of ctx.positions){
      const px = ctx.prices[p.symbol] ?? 0; if(px<=0) continue
      const w = abs(p.qty*px)/(ctx.nav||1)
      const s = bucket('sector', p.symbol); sector[s] = (sector[s]??0)+w
      const r = bucket('region', p.symbol); region[r] = (region[r]??0)+w
    }
    return { sector, region }
  },

  /* ---- Risk metrics ---- */
  mdd(): number {
    if(equityHW<=0) return 0
    return Math.min(0, lastEquity - equityHW) / (equityHW||1) // negative fraction
  },
  avgAbsCorr(symbols?: Str[]): number {
    const syms = symbols ?? Object.keys(returns)
    if(syms.length<2) return 0
    let total=0, count=0
    for(let i=0;i<syms.length;i++){
      for(let j=i+1;j<syms.length;j++){
        const c = abs(corr(returns[syms[i]]||[], returns[syms[j]]||[]))
        if(!isNaN(c)) { total+=c; count++ }
      }
    }
    return count? total/count : 0
  },

  /* ---- Gates for a single order/target ---- */
  gateTarget(ctx: Context, symbol:Str, targetNotional:Num): GateResult {
    const t = now()
    if(killed.on) return { ok:false, reason:{ code:'KILL', msg: killed.reason || 'kill switch active', ts:t } }

    // staleness
    const seen = lastTs[symbol] ?? 0
    if(seen && (t - seen) > cfg.stalenessMs){
      return { ok:false, reason:{ code:'STALE', msg:`${symbol} price stale ${t-seen}ms`, data:{ttl:cfg.stalenessMs}, ts:t } }
    }

    // MDD
    const mddFrac = -this.mdd() // positive number like 0.12 for -12%
    if(mddFrac >= cfg.maxDrawdown){
      return { ok:false, reason:{ code:'MDD', msg:`max drawdown breached ${mddFrac.toFixed(3)} ≥ ${cfg.maxDrawdown}`, ts:t } }
    }

    // max gross after trade (approx)
    const curGross = this.gross(ctx)
    const addGross = abs(targetNotional)/(ctx.nav||1)
    if(curGross + addGross > cfg.maxGross){
      return { ok:false, reason:{ code:'GROSS', msg:`gross ${ (curGross+addGross).toFixed(3) } > ${cfg.maxGross}`, ts:t } }
    }

    // single name
    if(abs(targetNotional)/(ctx.nav||1) > cfg.maxSingle){
      return { ok:false, reason:{ code:'SINGLE', msg:`single-name ${ (abs(targetNotional)/(ctx.nav||1)).toFixed(3) } > ${cfg.maxSingle}`, ts:t } }
    }

    // buckets (post-trade approx)
    if(cfg.bucketCaps){
      const px = ctx.prices[symbol] ?? 0
      const wAdd = px>0 ? abs(targetNotional)/(ctx.nav||1) : 0
      const { sector, region } = this.buckets(ctx)
      const s = bucket('sector', symbol), r = bucket('region', symbol)
      if(cfg.bucketCaps.sector){
        const cap = cfg.bucketCaps.sector[s] ?? Infinity
        if((sector[s]??0)+wAdd > cap) return { ok:false, reason:{ code:'SECTOR', msg:`sector ${s} ${(sector[s]??0+wAdd).toFixed(3)} > ${cap}`, ts:t } }
      }
      if(cfg.bucketCaps.region){
        const cap = cfg.bucketCaps.region[r] ?? Infinity
        if((region[r]??0)+wAdd > cap) return { ok:false, reason:{ code:'REGION', msg:`region ${r} ${(region[r]??0+wAdd).toFixed(3)} > ${cap}`, ts:t } }
      }
    }

    // correlation (soft gate) — uses currently tracked universe returns
    const aac = this.avgAbsCorr()
    if(aac > cfg.correlationCap){
      return { ok:false, reason:{ code:'CORR', msg:`avg|corr| ${aac.toFixed(2)} > ${cfg.correlationCap}`, ts:t } }
    }

    return { ok:true }
  },

  /* ---- Validate/Prune a full plan ---- */
  validatePlan(ctx: Context, plan: Plan){
    const pruned: Trade[] = []
    const reasons: Breach[] = []
    for(const tr of plan.trades){
      const px = ctx.prices[tr.symbol] ?? 0
      const targetNotional = abs(tr.toQty) * px
      const g = this.gateTarget(ctx, tr.symbol, targetNotional)
      if(g.ok) pruned.push(tr)
      else reasons.push(g.reason!)
    }

    // Recompute gross estimate
    const estGross = pruned.reduce((acc,t)=> {
      const px = ctx.prices[t.symbol] ?? 0
      return acc + (abs(t.toQty) * px)/(ctx.nav||1)
    }, 0)

    return { ok: reasons.length===0, trades: pruned, reasons, estGross }
  }
}

/* ========================= Optional helpers ========================= */
export function resetRisk(){
  for(const k in lastPx) delete lastPx[k]
  for(const k in lastTs) delete lastTs[k]
  for(const k in returns) delete returns[k]
  equityHW=0; lastEquity=0; killed={on:false}
}

export function lastPrice(symbol:Str){ return lastPx[symbol] ?? 0 }
export function lastSeen(symbol:Str){ return lastTs[symbol] ?? 0 }

/* ========================= Wiring tips ========================= */
/*
In your engine/main:
- On each tick:
    Risk.mark(symbol, px, ts)
- After computing NAV each cycle:
    Risk.recordEquity(nav)
- Before submitting orders (or after creating a rebalance plan):
    const { ok, trades, reasons, estGross } = Risk.validatePlan({ nav, prices, positions }, plan)
    // use 'trades' instead of plan.trades; log 'reasons' if any
- For emergency stop:
    Risk.setKill(true, 'manual stop / risk breach')
- Configure limits / buckets:
    Risk.setLimits({ maxDrawdown: 0.20, maxGross: 1.2, maxSingle: 0.06, correlationCap: 0.75, stalenessMs: 15000,
                     bucketCaps: { sector: { TECHNOLOGY: 0.25, ENERGY: 0.20 }, region: { US: 0.8, IN: 0.5 } } })
    Risk.setMeta({ AAPL:{sector:'TECHNOLOGY',region:'US'}, RELIANCE:{sector:'ENERGY',region:'IN'} })
*/