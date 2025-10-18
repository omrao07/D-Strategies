// adapters/chains.adapter.ts
// Adapter layer between raw market data (quotes, implied vols, trades) and the
// option chain builder in `commodities/chains.ts`. 
//
// Purpose: 
// - Normalize external data (whatever format you get) into a ChainInput
// - Delegate to makeChain / makeTermStructure
// - Provide CSV / JSON exports
//
// Self-contained: no imports; includes its own helpers + duplicated chain logic
// wrappers. Plug in actual exchange/broker feeds here.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type CP = "call" | "put";

export interface RawQuote {
  cp: CP;
  K: number;
  T: number;
  mid?: number;
  bid?: number;
  ask?: number;
  iv?: number;
}

export interface RawChain {
  F: number;
  r: number;
  T: number;
  quotes: RawQuote[];
}

export interface ChainInput {
  F: number;
  r: number;
  T: number;
  strikes: number[];
  sigma?: number;
  mids?: Record<number, Partial<Record<CP, number>>>;
  spreadBps?: number;
}

// --- Minimal wrapper to chain builder (local copy) ---

type Chain = ReturnType<typeof makeChain>;

// Adapt raw quotes into ChainInput and call makeChain
export function adaptRawChain(raw: RawChain, spreadBps = 0): Chain {
  const mids: Record<number, Partial<Record<CP, number>>> = {};
  const strikes: number[] = [];

  for (const q of raw.quotes) {
    if (!mids[q.K]) mids[q.K] = {};
    if (q.mid != null) mids[q.K]![q.cp] = q.mid;
    strikes.push(q.K);
  }

  const input: ChainInput = {
    F: raw.F,
    r: raw.r,
    T: raw.T,
    strikes: Array.from(new Set(strikes)).sort((a, b) => a - b),
    mids,
    spreadBps
  };

  return makeChain(input);
}

// ---------------- Local embedded makeChain (wrapper on Black76) ----------------

function makeChain(input: ChainInput) {
  const F = num(input.F), r = num(input.r), T = Math.max(0, num(input.T));
  const strikes = (input.strikes || []).map(num).filter(isFiniteNum).sort((a,b)=>a-b);
  const mids = input.mids || {};
  const spreadBps = Math.max(0, Math.floor(input.spreadBps ?? 0));
  const rows: any[] = [];

  for (const K of strikes) {
    for (const cp of (["call","put"] as CP[])) {
      const mid = mids[K]?.[cp];
      if (mid == null) continue;
      // Derive IV
      const iv = black76ImpliedVol(mid, F, K, r, T, cp, 0.3);
      const g = black76Greeks({ F, K, r, sigma: iv, T, cp });
      const res = black76Price({ F, K, r, sigma: iv, T, cp });

      let bid, ask;
      if (spreadBps > 0) {
        const half = (spreadBps / 10000) * Math.max(mid, 0.01) / 2;
        bid = Math.max(0, round4(mid - half));
        ask = round4(mid + half);
      }

      rows.push({
        cp, K, T, mid: round4(mid), bid, ask,
        iv: round6(iv),
        deltaF: round6(g.deltaF), gammaF: round6(g.gammaF), vega: round6(g.vega),
        theta: round6(g.theta), rho: round6(g.rho),
        d1: res.d1, d2: res.d2, df: res.df,
        itm: cp === "call" ? F > K : F < K,
      });
    }
  }

  rows.sort((a,b) => (a.K - b.K) || (a.cp === "put" ? -1 : 1));
  return { F, r, T, rows };
}

// ---------------- Embedded Black76 utils ----------------

function black76Price({ F, K, r, sigma, T, cp }: {F:number;K:number;r:number;sigma:number;T:number;cp:CP}) {
  const df = exp(-r * T);
  if (T<=0||sigma<=0) {
    return { price: df * Math.max((cp==="call"?F-K:K-F),0), d1:NaN,d2:NaN,df };
  }
  const d1 = (Math.log(F/K)+0.5*sigma*sigma*T)/(sigma*Math.sqrt(T));
  const d2 = d1 - sigma*Math.sqrt(T);
  const price = cp==="call" ? df*(F*nCdf(d1)-K*nCdf(d2)) : df*(K*nCdf(-d2)-F*nCdf(-d1));
  return { price,d1,d2,df };
}
function black76Greeks({ F, K, r, sigma, T, cp }: {F:number;K:number;r:number;sigma:number;T:number;cp:CP}) {
  const res = black76Price({F,K,r,sigma,T,cp});
  if (T<=0||sigma<=0) return { deltaF:0,gammaF:0,vega:0,theta:0,rho:0 };
  const d1 = res.d1, d2=res.d2, df=res.df;
  const phi = nPdf(d1); const srt=sigma*Math.sqrt(T);
  const deltaF = cp==="call"? df*nCdf(d1): -df*nCdf(-d1);
  const gammaF = df*phi/(F*srt);
  const vega = df*F*phi*Math.sqrt(T);
  const rho = -T*res.price;
  const d1dT = -d2/(2*T); const d2dT = d1dT - sigma/(2*Math.sqrt(T));
  const theta = (-r*df)*(cp==="call"?F*nCdf(d1)-K*nCdf(d2):K*nCdf(-d2)-F*nCdf(-d1))
              + df*(F*phi*d1dT - K*nPdf(d2)*d2dT);
  return { deltaF,gammaF,vega,theta,rho };
}
function black76ImpliedVol(targetPrice:number,F:number,K:number,r:number,T:number,cp:CP,guess=0.3):number {
  let sigma=guess;
  for(let i=0;i<20;i++){
    const {price}=black76Price({F,K,r,sigma,T,cp});
    const diff=price-targetPrice;
    if(Math.abs(diff)<1e-10) return sigma;
    const v=black76Greeks({F,K,r,sigma,T,cp}).vega;
    if(v<=1e-12) break;
    sigma=Math.max(1e-8,Math.min(5,sigma-diff/v));
  }
  return sigma;
}

// ---------------- Math helpers ----------------
function nPdf(x:number){return 0.3989422804014327*Math.exp(-0.5*x*x);}
function nCdf(x:number){const z=Math.abs(x);const t=1/(1+0.2316419*z);
 const a1=0.319381530,a2=-0.356563782,a3=1.781477937,a4=-1.821255978,a5=1.330274429;
 const m=1-nPdf(z)*((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t;
 return x>=0?m:1-m;}
function exp(x:number){return Math.exp(Math.max(Math.min(x,700),-700));}
function round4(x:number){return Math.round(x*1e4)/1e4;}
function round6(x:number){return Math.round(x*1e6)/1e6;}
function num(x:any){const n=Number(x);return Number.isFinite(n)?n:0;}
function isFiniteNum(x:any):x is number{return typeof x==="number"&&Number.isFinite(x);}