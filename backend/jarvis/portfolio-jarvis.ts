// jarvis/portfolio-jarvis.ts
// A tiny, dependency-free portfolio assistant core used by the Jarvis CLI.
// - Tracks positions
// - Computes portfolio value, P&L, simple risk (mock/hybrid)
// - Produces explanations (optionally via local explainers if present)
// - Pure TypeScript, no external imports

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Position {
  symbol: string;
  qty: number;
  price: number;      // last price
  cost?: number;      // avg cost per share (optional, for P&L)
  meta?: Record<string, any>;
}

export interface PortfolioSnapshot {
  asOf: string; // ISO
  value: number;
  cash: number;
  positions: Array<Position & { value: number; pnl?: number; pnlPct?: number }>;
}

export interface FactorExposure {
  factor: string;
  value: number; // +/- exposure
}

export interface RiskMetrics {
  var95: number;     // as fraction of portfolio value (negative means loss)
  cvar95: number;    // as fraction
  beta?: number;     // optional market beta
  stdev?: number;    // daily stdev (fraction)
  horizonDays?: number;
}

export interface ExplainBundle {
  position: string;
  factors: string;
  risk: string;
  full: string;
}

export type Prices = Record<string, number>;
export type ExposuresMap = Record<string, FactorExposure[]>; // by symbol

export class PortfolioJarvis {
  private _positions: Position[] = [];
  private _cash = 0;

  // Optional caches (caller can set/update)
  private _exposures: ExposuresMap = {};
  private _histReturns: number[] = [];   // portfolio daily returns (for risk)
  private _beta?: number;

  // ---------- lifecycle ----------

  setCash(amount: number): this { this._cash = num(amount); return this; }
  get cash(): number { return this._cash; }

  setPositions(ps: Position[]): this {
    this._positions = (ps || []).map(p => ({ ...p, symbol: p.symbol.toUpperCase(), qty: num(p.qty), price: num(p.price), cost: p.cost != null ? num(p.cost) : undefined }));
    return this;
  }
  upsertPosition(p: Position): this {
    const sym = p.symbol.toUpperCase();
    const i = this._positions.findIndex(x => x.symbol === sym);
    const canon: Position = { ...p, symbol: sym, qty: num(p.qty), price: num(p.price), cost: p.cost != null ? num(p.cost) : undefined };
    if (i === -1) this._positions.push(canon); else this._positions[i] = { ...this._positions[i], ...canon };
    return this;
  }
  removePosition(symbol: string): this {
    const sym = symbol.toUpperCase();
    this._positions = this._positions.filter(p => p.symbol !== sym);
    return this;
  }

  setExposures(map: ExposuresMap): this { this._exposures = map || {}; return this; }
  setHistoricalReturns(rets: number[]): this { this._histReturns = (rets || []).map(num); return this; }
  setBeta(beta?: number): this { this._beta = isFiniteNum(beta) ? beta : undefined; return this; }

  // ---------- pricing ----------

  /** Bulk update last prices. Missing symbols ignored. */
  markToMarket(prices: Prices): this {
    const P = prices || {};
    for (const p of this._positions) if (isFiniteNum(P[p.symbol])) p.price = num(P[p.symbol]);
    return this;
  }

  // ---------- core metrics ----------

  portfolioValue(): number {
    return this._cash + this._positions.reduce((s, p) => s + p.qty * p.price, 0);
  }

  snapshot(): PortfolioSnapshot {
    const snapPositions = this._positions.map(p => {
      const value = p.qty * p.price;
      const pnl = p.cost != null ? (p.price - p.cost) * p.qty : undefined;
      const pnlPct = p.cost != null && p.cost !== 0 ? (p.price - p.cost) / p.cost : undefined;
      return { ...p, value, pnl, pnlPct };
    });
    return { asOf: new Date().toISOString(), value: this.portfolioValue(), cash: this._cash, positions: snapPositions };
  }

  holdings(): Array<{ symbol: string; qty: number; price: number; value: number }> {
    return this._positions.map(p => ({ symbol: p.symbol, qty: p.qty, price: p.price, value: p.qty * p.price }));
  }

  // ---------- simple risk ----------

  /**
   * Very small risk estimator:
   * - If historical returns available (>= 30), use empirical 95% quantile for VaR and mean of worst 5% for CVaR.
   * - Else use stdev proxy from position-level notional and a heuristic sigma (2% daily) to produce parametric VaR.
   * - Horizon via sqrt(T).
   */
  risk(horizonDays = 1): RiskMetrics {
    const H = Math.max(1, Math.floor(horizonDays));
    const V = this.portfolioValue();
    let var95: number;
    let cvar95: number;
    let sigma: number;

    if (this._histReturns.length >= 30) {
      const r = this._histReturns.slice().sort((a,b)=>a-b);
      const q = quantile(r, 0.05); // 5th percentile (loss)
      var95 = Math.min(0, q) * Math.sqrt(H); // already daily fraction
      const worst = r.slice(0, Math.max(1, Math.floor(0.05 * r.length)));
      cvar95 = mean(worst) * Math.sqrt(H);
      sigma = stdev(this._histReturns);
    } else {
      // crude sigma proxy: assume daily 2% stdev scaled by leverage-ish proxy
      const baseSigma = 0.02;
      const gross = this._positions.reduce((s,p)=>s + Math.abs(p.qty * p.price), 0);
      const lev = V !== 0 ? gross / Math.abs(V) : 1;
      sigma = baseSigma * Math.max(0.5, Math.min(2, lev));
      // Gaussian VaR (one-sided 95% ~ -1.65σ)
      var95 = -1.65 * sigma * Math.sqrt(H);
      cvar95 = -2.06 * sigma * Math.sqrt(H); // approx for normal
    }

    return { var95, cvar95, beta: this._beta, stdev: sigma, horizonDays: H };
  }

  // ---------- factors ----------

  /** Return factor exposures for a symbol, or an empty array. */
  factors(symbol: string): FactorExposure[] {
    const sym = symbol.toUpperCase();
    return (this._exposures[sym] || []).slice();
    // If you want portfolio-level exposures, aggregate here by value weights.
  }

  // ---------- explainers (built-in, but can call external module if desired) ----------

  explain(symbol: string): ExplainBundle {
    const pos = this._positions.find(p => p.symbol === symbol.toUpperCase());
    const exposures = this.factors(symbol);
    const risk = this.risk(1);

    const positionText = explainPositionLocal(pos);
    const factorsText  = explainFactorsLocal(exposures);
    const riskText     = explainRiskLocal(risk);
    const full         = [positionText, "", factorsText, "", riskText].join("\n");

    return { position: positionText, factors: factorsText, risk: riskText, full };
  }

  // ---------- ask (naive NL) ----------

  ask(question: string): string {
    const q = String(question || "").toLowerCase();

    if (/(value|nav|worth)/i.test(q)) {
      return `Current portfolio value: ${fmtNum(this.portfolioValue())}`;
    }
    if (/(holding|position|what do i own|list)/i.test(q)) {
      const rows = this.holdings().map(h => `- ${h.symbol}: ${h.qty} @ ${fmtNum(h.price)} = ${fmtNum(h.value)}`);
      return ["Holdings:", ...rows].join("\n");
    }
    if (/(risk|var|cvar|drawdown|stdev)/i.test(q)) {
      const r = this.risk(1);
      return [
        "Risk (1-day):",
        `- VaR 95%: ${pct(r.var95)}`,
        `- CVaR 95%: ${pct(r.cvar95)}`,
        r.stdev != null ? `- Stdev: ${pct(r.stdev)}` : undefined,
        r.beta != null ? `- Beta: ${round4(r.beta)}` : undefined,
      ].filter(Boolean).join("\n");
    }
    const sym = (q.match(/[A-Z]{1,5}/g) || [])[0];
    if (sym) return this.explain(sym).full;

    return "Sorry, I can't answer that yet.";
  }
}

// ---------------- local explainers (no external import) ----------------

function explainPositionLocal(p?: Position): string {
  if (!p) return "No such position.";
  const value = p.qty * p.price;
  const pnl = p.cost != null ? (p.price - p.cost) * p.qty : undefined;
  const pnlPct = p.cost != null && p.cost !== 0 ? (p.price - p.cost) / p.cost : undefined;
  return [
    `Position: ${p.symbol}`,
    `- Quantity: ${p.qty}`,
    `- Price: ${fmtNum(p.price)}`,
    `- Market value: ${fmtNum(value)}`,
    p.cost != null ? `- Cost: ${fmtNum(p.cost)} → P&L ${fmtNum(pnl ?? 0)} (${pnlPct != null ? pct(pnlPct) : "n/a"})` : undefined,
  ].filter(Boolean).join("\n");
}

function explainFactorsLocal(factors: FactorExposure[]): string {
  if (!factors.length) return "No factor exposures available.";
  const lines = factors
    .sort((a,b)=>Math.abs(b.value)-Math.abs(a.value))
    .map(f => `- ${f.factor}: ${f.value >= 0 ? "+" : ""}${round4(f.value)}`);
  return ["Factor exposures:", ...lines].join("\n");
}

function explainRiskLocal(r: RiskMetrics): string {
  const parts: string[] = [];
  parts.push(`- VaR 95%: ${pct(r.var95)}`);
  parts.push(`- CVaR 95%: ${pct(r.cvar95)}`);
  if (r.stdev !== undefined) parts.push(`- Stdev: ${pct(r.stdev)}`);
  if (r.beta !== undefined) parts.push(`- Beta: ${round4(r.beta)}`);
  return ["Risk metrics:", ...parts].join("\n");
}

// ---------------- tiny utils ----------------

function num(v: any): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function isFiniteNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }
function mean(a: number[]): number { return a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0; }
function stdev(a: number[]): number { const m = mean(a); const v = a.reduce((s,x)=>s+(x-m)*(x-m),0) / (a.length || 1); return Math.sqrt(v); }
function quantile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return 0;
  const p = Math.min(Math.max(q, 0), 1);
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const w = idx - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}
function pct(x: number): string { return (x * 100).toFixed(2) + "%"; }
function round4(x: number): string { return String(Math.round(x * 1e4) / 1e4); }
function fmtNum(x: number): string { return String(Math.round(x * 100) / 100); }

// ---------------- factory ----------------

/** Convenience factory with optional seed data. */
export function createPortfolioJarvis(seed?: {
  cash?: number;
  positions?: Position[];
  exposures?: ExposuresMap;
  histReturns?: number[];
  beta?: number;
}): PortfolioJarvis {
  const pj = new PortfolioJarvis();
  if (seed?.cash != null) pj.setCash(seed.cash);
  if (seed?.positions) pj.setPositions(seed.positions);
  if (seed?.exposures) pj.setExposures(seed.exposures);
  if (seed?.histReturns) pj.setHistoricalReturns(seed.histReturns);
  if (seed?.beta != null) pj.setBeta(seed.beta);
  return pj;
}