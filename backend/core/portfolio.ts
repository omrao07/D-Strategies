// core/portfolio.ts
// Allocation & rebalancing utilities. Pure TS, no imports.
// - Converts signals/weights → position targets
// - Applies constraints (cash buffer, max single pos, gross cap, floors/ceilings)
// - Generates trade deltas from current positions + prices
// - Optional turnover cap and min-trade threshold
//
// You can use this from engine.ts like:
//   const tgt = Portfolio.targetsFromSignals(lastSignals, prices)
//   const plan = Portfolio.rebalance({ positions, prices, nav }, tgt)

type Num = number
type Str = string

/* ======================= Types ======================= */
export type Position = { symbol: Str; qty: Num; avgPx: Num }
export type Prices   = Record<Str, Num>             // last price per symbol
export type Weights  = Record<Str, Num>             // target portfolio weights (-1..+1)
export type Signals  = Record<Str, Num>             // normalized signals (-3..+3 preferred)
export type Bounds   = { floor?: Num; cap?: Num }   // per-symbol weight bounds
export type Universe = { symbols: Str[]; prices: Prices }

export type Constraints = {
  cashBuffer: Num             // fraction of NAV to keep in cash (e.g., 0.05)
  maxSingle: Num              // max |weight| per symbol (e.g., 0.08)
  maxGross: Num               // max gross exposure (sum |w|) <= maxGross (e.g., 1.5)
  minTradeNotional: Num       // skip tiny trades below this notional
  roundLots: Num              // share/contract rounding increment (e.g., 1 for stocks, 75 for NIFTY lot)
  turnoverCap?: Num           // optional: cap turnover as fraction of NAV per rebalance
}

export type Context = {
  positions: Position[]
  prices: Prices
  nav: Num
}

export type Trade = {
  symbol: Str
  fromQty: Num
  toQty: Num
  deltaQty: Num
  notional: Num
}

export type Plan = {
  targets: Weights
  trades: Trade[]
  estGross: Num
  estCashAfter: Num
}

/* ======================= Config / State ======================= */

const cfg: Constraints = {
  cashBuffer: 0.02,
  maxSingle: 0.08,
  maxGross: 1.50,
  minTradeNotional: 50,   // $50 default; adjust per venue
  roundLots: 1,
  turnoverCap: undefined
}

let perSymbolBounds: Record<Str, Bounds> = {} // optional tighter bounds per symbol

/* ======================= Helpers ======================= */

function clamp(v:number, a:number, b:number){ return Math.max(a, Math.min(b, v)) }
function abs(x:number){ return x<0 ? -x : x }
function sum(arr:number[]){ let s=0; for(const v of arr) s+=v; return s }


function currentWeights(positions:Position[], prices:Prices, nav:number): Weights {
  const w: Weights = {}
  if(!(nav>0)) return w
  for(const p of positions){
    const px = prices[p.symbol] ?? 0
    if(px>0) w[p.symbol] = (p.qty * px) / nav
  }
  return w
}

function roundTo(v:number, step:number){
  if(step<=0) return v
  return Math.round(v/step)*step
}

/* ======================= Public API: Configure ======================= */

export const Portfolio = {
  setConstraints(next: Partial<Constraints>){ Object.assign(cfg, next) },
  setBounds(bounds: Record<Str, Bounds>){ perSymbolBounds = bounds || {} },

  /* Map signals (-3..+3) → target weights, scaled and constrained. */
  targetsFromSignals(signals: Signals, prices: Prices): Weights {
    // 1) raw map signals to weights in [-0.5..+0.5] (soft); you can swap this for your allocator
    const raw: Weights = {}
    for(const s in signals){
      const z = signals[s]
      const w = clamp(z/3 * 0.5, -0.5, 0.5)
      raw[s] = w
    }
    // 2) apply single-name caps & per-symbol bounds
    const bounded: Weights = {}
    for(const s in raw){
      const b = perSymbolBounds[s]
      const maxAbs = Math.min(cfg.maxSingle, b?.cap ?? cfg.maxSingle)
      const floor = b?.floor ?? -maxAbs
      bounded[s] = clamp(raw[s], floor, maxAbs)
    }
    // 3) scale to maxGross and reserve cashBuffer
    const gross = sum(Object.values(bounded).map(abs))
    const targetGross = Math.max(0, cfg.maxGross - cfg.cashBuffer) // reserve cash
    const scale = gross>targetGross && gross>0 ? (targetGross/gross) : 1
    const scaled: Weights = {}
    for(const s in bounded) scaled[s] = bounded[s] * scale
    return scaled
  },

  /* Rebalance: from current positions → trades to reach target weights. */
  rebalance(ctx: Context, target: Weights): Plan {
    const { positions, prices, nav } = ctx
    const curW = currentWeights(positions, prices, nav)
    const trades: Trade[] = []

    // compute desired qty per symbol
    const desireQty: Record<Str, Num> = {}
    for(const s in target){
      const px = prices[s] ?? 0
      if(px<=0) continue
      const tgtNotional = target[s] * nav
      let qty = tgtNotional / px
      // round to lots
      qty = roundTo(qty, cfg.roundLots)
      desireQty[s] = qty
    }

    // existing symbols not in target → target 0
    for(const p of positions){
      if(!(p.symbol in desireQty)) desireQty[p.symbol] = 0
    }

    // build trades
    for(const s in desireQty){
      const px = prices[s] ?? 0
      if(px<=0) continue
      const cur = positions.find(p=>p.symbol===s)?.qty ?? 0
      const to  = desireQty[s]
      let delta = to - cur
      if(Math.abs(delta*px) < cfg.minTradeNotional) continue
      // apply turnover cap (optional): prune proportionally if sum exceeds cap
      trades.push({ symbol:s, fromQty:cur, toQty:to, deltaQty:delta, notional: Math.abs(delta)*px })
    }

    // Optional turnover cap: scale down all deltas if over cap
    if(cfg.turnoverCap && cfg.turnoverCap>0){
      const tot = sum(trades.map(t=>t.notional))
      const cap = cfg.turnoverCap * nav
      if(tot > cap && tot>0){
        const k = cap/tot
        for(const t of trades){
          t.deltaQty *= k
          // re-round to lots, and drop tiny
          t.deltaQty = roundTo(t.deltaQty, cfg.roundLots)
          t.toQty = t.fromQty + t.deltaQty
          t.notional = Math.abs(t.deltaQty) * (prices[t.symbol] ?? 0)
        }
        // drop tiny after scaling
        for(let i=trades.length-1;i>=0;i--) if(trades[i].notional < cfg.minTradeNotional) trades.splice(i,1)
      }
    }

    // Estimate post-trade cash: current cash is unknown here, so approximate by cashBuffer target
    const estGross = sum(Object.values(target).map(abs))
    const estCashAfter = cfg.cashBuffer * nav

    return { targets: target, trades, estGross, estCashAfter }
  },

  /* Convenience: combine signals → targets → plan */
  planFromSignals(ctx: Context, signals: Signals): Plan {
    const tgt = this.targetsFromSignals(signals, ctx.prices)
    return this.rebalance(ctx, tgt)
  }
}

/* ======================= Extras (optional helpers) ======================= */

/** Convert a weights map into desired quantities given nav & prices (respects rounding). */
export function weightsToQty(target: Weights, prices: Prices, nav: number, lot: number = cfg.roundLots){
  const out: Record<Str, Num> = {}
  for(const s in target){
    const px = prices[s] ?? 0
    if(px<=0) continue
    out[s] = roundTo((target[s]*nav)/px, lot)
  }
  return out
}

/** Compute gross exposure from weights. */
export function grossFromWeights(w: Weights){
  return sum(Object.values(w).map(abs))
}

/** Merge two weight maps (e.g., multiple strategies) with simple average or weighted average. */
export function mergeWeights(wList: Weights[], wts?: number[]): Weights {
  const out: Weights = {}
  const ww = (wts && wts.length===wList.length) ? wts : new Array(wList.length).fill(1)
  const total = sum(ww)
  const syms = new Set<string>()
  for(const w of wList) for(const k in w) syms.add(k)
  for(const s of syms){
    let acc = 0
    for(let i=0;i<wList.length;i++) acc += (wList[i][s] ?? 0) * ww[i]
    out[s] = total>0 ? acc/total : 0
  }
  return out
}