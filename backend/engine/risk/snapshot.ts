// risk/snapshot.ts
// Build a full portfolio risk snapshot from positions, prices, cash, and return history.
// Self-contained: no external imports.

//////////////////////// Types ////////////////////////

export type Side = "long" | "short";

export interface Position {
  symbol: string;
  qty: number;           // signed qty (neg => short) OR use 'side'
  price: number;         // mark price in base currency
  side?: Side;           // optional; if provided, qty may be abs()
  sector?: string;       // optional tags for grouping
  assetClass?: string;   // e.g., "Equity", "Futures", "FX", "Commodity"
  currency?: string;     // e.g., "USD"
  beta?: number;         // optional instrument beta vs benchmark
}

export interface PriceMap {
  [symbol: string]: number;
}

export interface SnapshotInputs {
  asOf: string | number | Date;
  cash?: number;                         // base currency
  positions: Position[];
  prices?: PriceMap;                     // if provided, overrides position.price
  // Performance history (per-period returns) for the portfolio (and benchmark)
  // All series must be aligned to the same frequency (daily by default).
  returns?: number[];                    // portfolio returns history (oldest -> newest)
  benchmark?: number[];                  // optional benchmark returns
  // Config
  periodsPerYear?: number;               // default 252 (daily)
  riskFree?: number;                     // per-period risk-free, default 0
  varCL?: number;                        // default 0.99
  varMethod?: "historical" | "parametric" | "cornish-fisher";
  scale?: number;                        // VaR/CVaR scale (1 for raw returns, 100 for %)
}

export interface ExposureBucket {
  name: string;
  gross: number;    // sum(|position value|)
  net: number;      // sum(position value) (long - short)
  pctGross: number; // gross / portfolio gross
  pctNAV: number;   // net / NAV
}

export interface RiskMetrics {
  mean: number;
  stdev: number;
  annReturn: number;
  annVol: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  omega: number;
  maxDrawdown: number;
  maxDDStart?: number;
  maxDDEnd?: number;
  tau: number;
  hitRate: number;
  winLoss: number;
  skew: number;
  kurt: number;
  var: number;
  cvar: number;
  alpha?: number;
  beta?: number;
  infoRatio?: number;
  treynor?: number;
}

export interface Snapshot {
  asOf: string;            // ISO
  nav: number;
  cash: number;
  gross: number;
  net: number;
  longExposure: number;
  shortExposure: number;   // positive number (abs short)
  leverage: number;        // gross / NAV
  positions: Array<{
    symbol: string;
    qty: number;
    price: number;
    value: number;
    side: Side;
    sector?: string;
    assetClass?: string;
    currency?: string;
    weight: number; // value / NAV
  }>;
  exposures: {
    bySector: ExposureBucket[];
    byAssetClass: ExposureBucket[];
    byCurrency: ExposureBucket[];
    betaWeighted?: { netBeta: number; absBeta: number };
  };
  pnl: {
    day?: number;        // last return * NAV_start (if history present)
    mtd?: number;        // approximated via last ~22 periods
    ytd?: number;        // approximated via last ~252 periods
  };
  risk?: RiskMetrics;     // present if returns provided
}

//////////////////////// Math Utils ////////////////////////

const SQ = Math.sqrt;
const ABS = Math.abs;

function toISO(t: string | number | Date): string {
  if (t instanceof Date) return t.toISOString();
  if (typeof t === "number") return new Date(t).toISOString();
  return new Date(t).toISOString();
}

function sum(xs: number[]): number { let s=0; for (const v of xs) s+=v; return s; }
function mean(x: number[]): number { return x.length ? sum(x)/x.length : NaN; }
function stdev(x: number[]): number {
  const n = x.length; if (n < 2) return 0;
  const m = mean(x); let v = 0; for (const a of x) v += (a - m) * (a - m);
  return SQ(v / (n - 1));
}
function skew(x: number[]): number {
  const n = x.length; if (n < 3) return 0;
  const m = mean(x), s = stdev(x) || 1e-12; let z3 = 0;
  for (const a of x) z3 += Math.pow((a - m) / s, 3);
  return (n / ((n - 1) * (n - 2))) * z3;
}
function kurtosisExcess(x: number[]): number {
  const n = x.length; if (n < 4) return 0;
  const m = mean(x), s = stdev(x) || 1e-12; let z4 = 0;
  for (const a of x) z4 += Math.pow((a - m) / s, 4);
  return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * z4
       - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
}
function quantile(x: number[], p: number): number {
  if (!x.length) return NaN;
  const arr = x.slice().sort((a,b)=>a-b);
  const idx = Math.max(0, Math.min(arr.length - 1, Math.floor(p * arr.length)));
  return arr[idx];
}
function normInv(p: number): number {
  const a = [-39.69683028665376,220.9460984245205,-275.9285104469687,138.3577518672690,-30.66479806614716,2.506628277459239];
  const b = [-54.47609879822406,161.5858368580409,-155.6989798598866,66.80131188771972,-13.28068155288572];
  const c = [-0.007784894002430293,-0.3223964580411365,-2.400758277161838,-2.549732539343734,4.374664141464968,2.938163982698783];
  const d = [0.007784695709041462,0.3224671290700398,2.445134137142996,3.754408661907416];
  const plow = 0.02425, phigh = 1 - plow;
  if (p <= 0 || p >= 1) return NaN;
  let q, r;
  if (p < plow) { q = SQ(-2*Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p > phigh) { q = SQ(-2*Math.log(1-p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
             ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else { q = p-0.5; r=q*q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  }
}

//////////////////////// Risk / Perf ////////////////////////

function equityCurve(returns: number[], start=1): number[] {
  const out = new Array(returns.length);
  let eq = start;
  for (let i=0;i<returns.length;i++){ eq *= (1 + (returns[i] ?? 0)); out[i]=eq; }
  return out;
}
function maxDrawdown(returns: number[]): { mdd: number; start?: number; end?: number } {
  const eq = equityCurve(returns,1);
  let peak=eq[0]??1, mdd=0, s=0, e=0, pidx=0;
  for (let i=0;i<eq.length;i++){
    if (eq[i]>peak){ peak=eq[i]; pidx=i; }
    const dd=(eq[i]-peak)/peak; // ≤ 0
    if (dd<mdd){ mdd=dd; s=pidx; e=i; }
  }
  return { mdd: Math.abs(mdd), start:s, end:e };
}
function timeUnderWater(returns: number[]): number {
  const eq = equityCurve(returns,1);
  let peak=-Infinity, under=0;
  for (const v of eq){ peak=Math.max(peak,v); if (v<peak) under++; }
  return eq.length ? under/eq.length : 0;
}
function downsideDeviation(returns: number[], mar=0): number {
  const neg = returns.map(r => Math.min(0, r - mar));
  const sq  = neg.map(x => x*x);
  return SQ(mean(sq));
}
function omegaRatio(returns: number[], mar=0): number {
  let g=0, l=0;
  for (const r of returns){ g += Math.max(0, r - mar); l += Math.max(0, mar - r); }
  return l>0 ? g/l : Infinity;
}
function annualizedReturn(returns: number[], ppY=252): number {
  const eq = equityCurve(returns,1);
  if (!eq.length) return NaN;
  const total = eq[eq.length-1];
  const n = returns.length;
  return Math.pow(total, ppY / Math.max(1,n)) - 1;
}
function sharpeRatio(returns: number[], ppY=252, rf=0): number {
  const ex = returns.map(r => r - rf);
  return (mean(ex) / (stdev(ex) || 1e-12)) * SQ(ppY);
}
function sortinoRatio(returns: number[], ppY=252, rf=0, mar?: number): number {
  const m = mar ?? rf;
  const ex = returns.map(r => r - rf);
  return (mean(ex) / (downsideDeviation(returns, m) || 1e-12)) * SQ(ppY);
}
function calmarRatio(returns: number[], ppY=252): number {
  const annRet = annualizedReturn(returns, ppY);
  const { mdd } = maxDrawdown(returns);
  return mdd>0 ? annRet/mdd : Infinity;
}
function informationRatio(returns: number[], bench: number[], ppY=252): number {
  const n = Math.min(returns.length, bench.length);
  const ex = new Array(n);
  for (let i=0;i<n;i++) ex[i] = (returns[i]??0) - (bench[i]??0);
  return (mean(ex) / (stdev(ex) || 1e-12)) * SQ(ppY);
}
function covariance(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n));
  let s = 0; for (let i=0;i<n;i++) s += (x[i]-mx)*(y[i]-my);
  return s / (n - 1);
}
function capm(returns: number[], bench: number[], rf=0): { beta: number; alpha: number } {
  const n = Math.min(returns.length, bench.length);
  const r = returns.slice(0,n).map(x => x - rf);
  const b = bench.slice(0,n).map(x => x - rf);
  const beta = covariance(r,b) / ((stdev(b) ** 2) || 1e-12);
  const alpha = mean(r) - beta * mean(b); // per-period alpha
  return { beta, alpha };
}

// VaR / CVaR (same conventions as risk/cvar.ts)
function varHistorical(returns: number[], cl=0.99, scale=1): number {
  const p = 1 - cl;
  const q = quantile(returns, p);
  return Math.max(0, -q * scale);
}
function cvarHistorical(returns: number[], cl=0.99, scale=1): number {
  const p = 1 - cl;
  const q = quantile(returns, p);
  const tail = returns.filter(r => r <= q);
  if (!tail.length) return NaN;
  return Math.max(0, -mean(tail) * scale);
}
function varParametric(returns: number[], cl=0.99, scale=1): number {
  const mu = mean(returns), sd = stdev(returns);
  const z = normInv(1 - cl); // negative
  return Math.max(0, -(mu + sd * z) * scale);
}
function cvarParametric(returns: number[], cl=0.99, scale=1): number {
  const mu = mean(returns), sd = stdev(returns) || 1e-12;
  const z = normInv(1 - cl);
  const alpha = 1 - cl;
  const phi = (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z);
  const es = mu - sd * (phi / alpha);
  return Math.max(0, -es * scale);
}
function varCornishFisher(returns: number[], cl=0.99, scale=1): number {
  const m = mean(returns), s = stdev(returns);
  const sk = skew(returns), ku = kurtosisExcess(returns);
  const z = normInv(1 - cl), z2 = z*z, z3 = z2*z;
  const zcf = z + (sk/6)*(z2-1) + (ku/24)*(z3-3*z) - (sk*sk/36)*(2*z3-5*z);
  return Math.max(0, -(m + s*zcf) * scale);
}
function cvarCornishFisher(returns: number[], cl=0.99, scale=1): number {
  const v = varCornishFisher(returns, cl, 1);
  const thr = -v;
  const tail = returns.filter(r => r <= thr);
  if (!tail.length) return NaN;
  return Math.max(0, -mean(tail) * scale);
}

//////////////////////// Exposures ////////////////////////

function bucketize(
  items: Array<{ name: string; value: number }>
): ExposureBucket[] {
  const totalGross = sum(items.map(i => ABS(i.value)));
  const nav = sum(items.map(i => i.value)); // not strictly NAV; pctNAV uses net / NAV in caller
  const grouped = new Map<string, { gross: number; net: number }>();
  for (const it of items) {
    const g = grouped.get(it.name) ?? { gross: 0, net: 0 };
    g.gross += ABS(it.value);
    g.net += it.value;
    grouped.set(it.name, g);
  }
  const out: ExposureBucket[] = [];
  for (const [name, g] of grouped.entries()) {
    out.push({
      name,
      gross: g.gross,
      net: g.net,
      pctGross: totalGross ? g.gross / totalGross : 0,
      pctNAV: nav ? g.net / nav : 0,
    });
  }
  out.sort((a,b) => b.gross - a.gross);
  return out;
}

//////////////////////// Main API ////////////////////////

export function buildSnapshot(input: SnapshotInputs): Snapshot {
  const asOfISO = toISO(input.asOf);
  const cash = input.cash ?? 0;
  const prices = input.prices ?? {};
  const ppY = Math.max(1, input.periodsPerYear ?? 252);
  const rf = input.riskFree ?? 0;
  const cl = input.varCL ?? 0.99;
  const scale = input.scale ?? 1;
  const varMethod = input.varMethod ?? "historical";

  // Normalize positions -> value, side, applied price
  const norm = input.positions.map(p => {
    const side: Side = p.side ?? (p.qty >= 0 ? "long" : "short");
    const qtySigned = p.side ? (p.side === "long" ? +ABS(p.qty) : -ABS(p.qty)) : p.qty;
    const px = prices[p.symbol] != null ? prices[p.symbol] : p.price;
    const value = qtySigned * px;
    return {
      symbol: p.symbol,
      qty: qtySigned,
      price: px,
      value,
      side,
      sector: p.sector,
      assetClass: p.assetClass,
      currency: p.currency ?? "USD",
      beta: p.beta ?? 0,
    };
  });

  const longExposure = sum(norm.filter(p => p.value > 0).map(p => p.value));
  const shortExposure = sum(norm.filter(p => p.value < 0).map(p => -p.value));
  const gross = longExposure + shortExposure;
  const net = longExposure - shortExposure;
  const nav = cash + net;
  const leverage = nav !== 0 ? gross / nav : 0;

  // Per-position weights (vs NAV)
  const posOut = norm.map(p => ({
    symbol: p.symbol,
    qty: p.qty,
    price: p.price,
    value: p.value,
    side: p.side,
    sector: p.sector,
    assetClass: p.assetClass,
    currency: p.currency,
    weight: nav ? p.value / nav : 0,
  })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  // Exposures
  const bySector = bucketize(norm.map(p => ({ name: p.sector ?? "Unclassified", value: p.value })));
  const byAssetClass = bucketize(norm.map(p => ({ name: p.assetClass ?? "Unclassified", value: p.value })));
  const byCurrency = bucketize(norm.map(p => ({ name: p.currency ?? "USD", value: p.value })));

  // Beta-weighted sums (optional)
  const netBeta = sum(norm.map(p => p.beta! * (p.value / (nav || 1))));
  const absBeta = sum(norm.map(p => ABS(p.beta! * (p.value / (nav || 1)))));

  // PnL approximations from return history if provided
  const returns = input.returns && input.returns.length ? input.returns.slice() : undefined;
  const pnl: Snapshot["pnl"] = {};
  if (returns) {
    const last = returns[returns.length - 1] ?? 0;
    const dayEqStart = nav / (1 + last || 1);
    pnl.day = dayEqStart * last;

    const n = returns.length;
    const mtdWindow = Math.min(22, n);
    const ytdWindow = Math.min(252, n);
    const mtdRet = comp(returns.slice(n - mtdWindow));
    const ytdRet = comp(returns.slice(n - ytdWindow));
    pnl.mtd = nav * (mtdRet / (1 + mtdRet || 1));
    pnl.ytd = nav * (ytdRet / (1 + ytdRet || 1));
  }

  // Risk metrics if history present
  let risk: RiskMetrics | undefined = undefined;
  if (returns && returns.length) {
    const annVol = stdev(returns) * SQ(ppY);
    const annReturn = annualizedReturn(returns, ppY);
    const sharpe = sharpeRatio(returns, ppY, rf);
    const sortino = sortinoRatio(returns, ppY, rf);
    const calmar = calmarRatio(returns, ppY);
    const omega = omegaRatio(returns, rf);
    const { mdd, start, end } = maxDrawdown(returns);
    const tau = timeUnderWater(returns);
    const sk = skew(returns);
    const ku = kurtosisExcess(returns);
    let v=0, cv=0;
    if (varMethod === "historical") { v = varHistorical(returns, cl, scale); cv = cvarHistorical(returns, cl, scale); }
    else if (varMethod === "parametric") { v = varParametric(returns, cl, scale); cv = cvarParametric(returns, cl, scale); }
    else { v = varCornishFisher(returns, cl, scale); cv = cvarCornishFisher(returns, cl, scale); }

    let alpha: number | undefined, beta: number | undefined, infoRatio: number | undefined, treynor: number | undefined;
    if (input.benchmark && input.benchmark.length) {
      const bench = input.benchmark;
      infoRatio = informationRatio(returns, bench, ppY);
      const cap = capm(returns, bench, rf);
      alpha = cap.alpha;
      beta = cap.beta;
      treynor = (beta && beta !== 0) ? (mean(returns.map(r => r - rf)) / beta) : undefined;
    }

    risk = {
      mean: mean(returns),
      stdev: stdev(returns),
      annReturn,
      annVol,
      sharpe,
      sortino,
      calmar,
      omega,
      maxDrawdown: mdd,
      maxDDStart: start,
      maxDDEnd: end,
      tau,
      hitRate: hitRate(returns),
      winLoss: winLossRatio(returns),
      skew: sk,
      kurt: ku,
      var: v,
      cvar: cv,
      alpha,
      beta,
      infoRatio,
      treynor,
    };
  }

  return {
    asOf: asOfISO,
    nav,
    cash,
    gross,
    net,
    longExposure,
    shortExposure,
    leverage,
    positions: posOut,
    exposures: {
      bySector: finalizeBuckets(bySector, gross, nav),
      byAssetClass: finalizeBuckets(byAssetClass, gross, nav),
      byCurrency: finalizeBuckets(byCurrency, gross, nav),
      betaWeighted: { netBeta, absBeta },
    },
    pnl,
    risk,
  };
}

//////////////////////// Helpers ////////////////////////

function comp(rs: number[]): number {
  // compound return over a slice
  let v = 1;
  for (const r of rs) v *= (1 + (r ?? 0));
  return v - 1;
}

function hitRate(returns: number[]): number {
  if (!returns.length) return NaN;
  const w = returns.filter(r => r > 0).length;
  return w / returns.length;
}
function winLossRatio(returns: number[]): number {
  const wins = returns.filter(r => r > 0);
  const losses = returns.filter(r => r < 0).map(Math.abs);
  const avgW = wins.length ? mean(wins) : 0;
  const avgL = losses.length ? mean(losses) : 0;
  return avgL > 0 ? avgW / avgL : Infinity;
}
function finalizeBuckets(buckets: ExposureBucket[], gross: number, nav: number): ExposureBucket[] {
  return buckets.map(b => ({
    ...b,
    pctGross: gross ? b.gross / gross : 0,
    pctNAV: nav ? b.net / nav : 0
  }));
}

//////////////////////// Example ////////////////////////
/*
const snap = buildSnapshot({
  asOf: new Date(),
  cash: 250000,
  positions: [
    { symbol: "AAPL", qty: 1000, price: 180, sector: "Tech", assetClass: "Equity", beta: 1.2 },
    { symbol: "TSLA", qty: -300, price: 250, sector: "Auto", assetClass: "Equity", beta: 2.0, side: "short" },
  ],
  returns: [0.01, -0.005, 0.003, 0.02, -0.01, 0.004],
  benchmark: [0.008, -0.004, 0.002, 0.015, -0.007, 0.003],
  periodsPerYear: 252,
  riskFree: 0,
  varCL: 0.99,
  varMethod: "cornish-fisher",
  scale: 1,
});
console.log(JSON.stringify(snap, null, 2));
*/