// alpha/centralbanktone.ts
// Module: Central Bank Tone Analyzer
// Purpose: Parse central bank statements / speeches and score their tone as hawkish, dovish, or neutral.
// No external imports – pure TypeScript.

type Tone = "Hawkish" | "Dovish" | "Neutral";

interface ToneResult {
  tone: Tone;
  score: number; // scale -1 (very dovish) to +1 (very hawkish)
  keywords: string[];
  confidence: number; // 0–1 confidence based on density of matched words
}

/**
 * Dictionaries of hawkish and dovish keywords.
 * Expandable based on macroeconomic language.
 */
const hawkishKeywords = [
  "inflation",
  "tightening",
  "rate hike",
  "raise rates",
  "overheating",
  "restrictive",
  "curb demand",
  "control prices",
  "price stability",
  "strong labor",
  "hawkish"
];

const dovishKeywords = [
  "stimulus",
  "easing",
  "cut rates",
  "rate cut",
  "quantitative easing",
  "liquidity",
  "support growth",
  "slowdown",
  "recession risk",
  "accommodative",
  "dovish"
];

/**
 * Normalize input text for matching.
 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z\s]/g, " ");
}

/**
 * Analyze the tone of a central bank statement.
 */
export function analyzeCentralBankTone(text: string): ToneResult {
  const norm = normalize(text);

  let hawkishCount = 0;
  let dovishCount = 0;
  const matched: string[] = [];

  for (const word of hawkishKeywords) {
    if (norm.includes(word)) {
      hawkishCount++;
      matched.push(word);
    }
  }

  for (const word of dovishKeywords) {
    if (norm.includes(word)) {
      dovishCount++;
      matched.push(word);
    }
  }

  const total = hawkishCount + dovishCount;
  let score = 0;
  let tone: Tone = "Neutral";

  if (total > 0) {
    score = (hawkishCount - dovishCount) / total;
    if (score > 0.2) tone = "Hawkish";
    else if (score < -0.2) tone = "Dovish";
  }

  const confidence = total > 0 ? Math.min(1, total / 10) : 0;

  return {
    tone,
    score,
    keywords: matched,
    confidence
  };
}

// Example usage
// const text = "The central bank sees inflation risks and may raise rates to control prices.";
// console.log(analyzeCentralBankTone(text));
// Output: { tone: 'Hawkish', score: 0.5, keywords: [ 'inflation', 'raise rates', 'control prices' ], confidence: 0.3 }

// Exported for use in alpha15 strategy
export const CentralBankTone = {
  analyze: analyzeCentralBankTone
}

// backend/core/portfolio.ts
// Portfolio management: mapping signals to target weights with constraints.
// No external imports – pure TypeScript.

type Str = string
type Num = number

export interface Position { symbol: Str; qty: Num }
export interface Prices { [symbol: Str]: Num } // last prices
export interface Weights { [symbol: Str]: Num } // target weights, e.g. AAPL: 0.1 for +10%
export interface Signals { [symbol: Str]: Num } // e.g. AAPL: +2.5 (buy), MSFT: -1.0 (sell)
export interface Bounds { cap?: Num; floor?: Num } // optional per-symbol bounds

interface Constraints {
  maxGross: Num;      // e.g. 1.0 for 100% gross exposure
  maxSingle: Num;     // e.g. 0.2 for max 20% position in any single name
  cashBuffer: Num;    // e.g. 0.05 for 5% cash buffer
  minTradeNotional: Num; // e.g. $100 minimum trade size
  roundLots: Num;     // e.g. 1 for stocks, 100 for NIFTY lot size
}

interface Context {
  positions: Position[];
  prices: Prices;
  nav: Num; // net asset value
}

interface Trade {
  symbol: Str;
  fromQty: Num;
  toQty: Num;
  deltaQty: Num;
  notional: Num;
}

interface Plan {
  targets: Weights;
  trades: Trade[];
  estGross: Num;
  estCashAfter: Num;
}

/* ======================= Config / State ======================= */

const cfg: Constraints = {
  maxGross: 1.5,
  maxSingle: 0.1,
  cashBuffer: 0.02,
  minTradeNotional: 100,
  roundLots: 1,
}

/* ======================= Helpers ======================= */
function clamp(v:number, a:number, b:number){ return Math.max(a, Math.min(b, v)) }
function abs(x:number){ return x<0 ? -x : x }
function sum(arr:number[]){ let s=0; for(const v of arr) s+=v; return s }

function roundLot(qty:number, lot:number){ return Math.round(qty/lot)*lot }

/* ======================= Main ======================= */
export function planTrades(ctx:Context, signals:Signals, bounds:Record<Str,Bounds>={}):Plan {
  const { positions, prices, nav } = ctx
  const posMap: Record<Str,Num> = {}
  for(const p of positions) posMap[p.symbol] = p.qty
  const cash = nav - sum(positions.map(p=> (prices[p.symbol]||0)*p.qty ))

  // Step 1: Normalize signals to target weights
  let rawWeights: Weights = {}
  let totalSignal = 0
  for(const s of Object.values(signals)) totalSignal += abs(s)
  if(totalSignal===0) totalSignal=1 // avoid div0

  for(const [sym, sig] of Object.entries(signals)){
    rawWeights[sym] = sig / totalSignal * (cfg.maxGross/2) // scale to maxGross/2
  }

  // Step 2: Apply per-symbol bounds and global constraints
  let adjustedWeights: Weights = {}
  for(const [sym, w] of Object.entries(rawWeights)){
    const b = bounds[sym] || {}
    let wAdj = clamp(w, b.floor ?? -cfg.maxSingle, b.cap ?? cfg.maxSingle)
    adjustedWeights[sym] = wAdj
  }

  // Normalize to respect maxGross and cashBuffer
  let gross = sum(Object.values(adjustedWeights).map(w=> abs(w)))
  if(gross > cfg.maxGross){
    const scale = cfg.maxGross / gross
    for(const sym of Object.keys(adjustedWeights)){
      adjustedWeights[sym] *= scale
    }
    gross = cfg.maxGross
  }

  // Ensure cash buffer
  const targetCash = nav * cfg.cashBuffer
  let estCashAfter = cash - sum(Object.entries(adjustedWeights).map(([sym,w])=>{
    const px = prices[sym] || 0
    const targetNotional = w * nav
    const currentNotional = (posMap[sym] || 0) * px
    return targetNotional - currentNotional
  }))
  if(estCashAfter < targetCash){
    const cashDeficit = targetCash - estCashAfter
    const reductionFactor = (gross * nav - cashDeficit) / (gross * nav)
    for(const sym of Object.keys(adjustedWeights)){
      adjustedWeights[sym] *= reductionFactor
    }
    estCashAfter = targetCash
  }

  // Step 3: Generate trades
  const trades: Trade[] = []
  for(const [sym, w] of Object.entries(adjustedWeights)){
    const px = prices[sym] || 0
    if(px <= 0) continue
    const targetNotional = w * nav
    const currentQty = posMap[sym] || 0
    const targetQtyRaw = targetNotional / px
    const targetQty = roundLot(targetQtyRaw, cfg.roundLots)
    const deltaQty = targetQty - currentQty
    const notional = deltaQty * px

    if(abs(notional) >= cfg.minTradeNotional){
      trades.push({
        symbol: sym,
        fromQty: currentQty,
        toQty: targetQty,
        deltaQty,
        notional
      })
    }
  }

  // Recalculate estimated gross after trades
  const estGross = sum(Object.values(adjustedWeights).map(w=> abs(w)))

  return {
    targets: adjustedWeights,
    trades,
    estGross,
    estCashAfter
  }
}


