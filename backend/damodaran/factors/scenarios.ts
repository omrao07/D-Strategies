// factors/scenario.ts
// Scenario engine: deterministic stresses + Monte Carlo factor paths.
// Applies factor shocks via betas to assets/portfolio, and computes PnL metrics.
// No external dependencies.

export type Dist = "gaussian" | "student-t";

export interface FactorShock {
  /** Factor name (must match exposures.keys) */
  name: string;
  /** Shock value as return (e.g., +0.05 = +5%) */
  shock: number;
}

export interface ScenarioSpec {
  /** Scenario id/name (e.g., "rates+200bps", "oil-spike") */
  id: string;
  /** Factor return shocks to apply deterministically */
  shocks: FactorShock[];
  /** Optional override: alpha contribution (ex-ante) applied to assets */
  alphaShock?: number; // in return space
}

export interface ExposureMap {
  /** betas per factor, e.g., { MKT: 0.9, OIL: -0.2 } */
  [factor: string]: number;
}

export interface Asset {
  symbol: string;
  weight?: number;       // portfolio weight (sum≈1). If omitted, equal-weight later.
  exposure: ExposureMap; // betas to factors
  alpha?: number;        // intercept (per period return), optional
  vol?: number;          // standalone vol (for idiosyncratic shock in simulations)
}

export interface Portfolio {
  cash?: number;         // optional cash weight (absorbs residuals)
  assets: Asset[];
}

export interface StressResult {
  scenarioId: string;
  portfolioReturn: number;
  assetReturns: Array<{ symbol: string; r: number }>;
  contributions: Array<{ symbol: string; contrib: number }>; // weight * r
  byFactor: Record<string, number>; // weight * beta_f * shock_f summed across assets
  alphaContribution: number;        // sum(weight * alphaShock + asset.alpha)
}

/* ========================= Deterministic Stress ========================= */

export function applyScenario(port: Portfolio, scenario: ScenarioSpec): StressResult {
  const { id, shocks, alphaShock = 0 } = scenario;
  const fShock: Record<string, number> = Object.fromEntries(shocks.map(s => [s.name, s.shock]));

  const n = port.assets.length;
  const equalW = n > 0 ? 1 / n : 0;
  const factorSum: Record<string, number> = {};
  let alphaContr = 0;

  const assetReturns = port.assets.map(a => {
    const w = a.weight ?? equalW;
    let r = 0;
    // factor component
    for (const [fname, shock] of Object.entries(fShock)) {
      const b = a.exposure[fname] ?? 0;
      const incr = b * shock;
      r += incr;
      factorSum[fname] = (factorSum[fname] ?? 0) + w * incr;
    }
    // alpha component (asset alpha + scenario-wide alphaShock)
    const alpha = (a.alpha ?? 0) + alphaShock;
    r += alpha;
    alphaContr += w * alpha;
    return { symbol: a.symbol, r, w };
  });

  // portfolio return = sum(w * r) + residual cash (if any)
  const totalW = assetReturns.reduce((s, x) => s + x.w, 0);
  const cashW = (port.cash ?? Math.max(0, 1 - totalW));
  const portR = assetReturns.reduce((s, x) => s + x.w * x.r, 0) + cashW * 0; // cash return ~ 0 for stress horizon

  return {
    scenarioId: id,
    portfolioReturn: portR,
    assetReturns: assetReturns.map(x => ({ symbol: x.symbol, r: x.r })),
    contributions: assetReturns.map(x => ({ symbol: x.symbol, contrib: x.w * x.r })),
    byFactor: factorSum,
    alphaContribution: alphaContr
  };
}

/* ===================== Monte Carlo Path Simulation ===================== */

export interface SimSpec {
  /** number of trials */
  trials: number;
  /** path length (periods) */
  horizon: number;
  /** factor names in order used by mu/sigma/corr */
  factors: string[];
  /** factor mean returns (per period), array length == factors.length */
  mu: number[];
  /** factor vols (per period std), same length */
  sigma: number[];
  /** factor correlation matrix (LxL, symmetric, pos-def) */
  corr: number[][];
  /** distribution for shocks */
  dist?: Dist;
  /** degrees of freedom for student-t */
  dof?: number;
  /** residual/idiosyncratic vol for assets, if not provided on each asset */
  idioVol?: number;
  /** optional: clamp each factor return to bounds */
  clamp?: { min?: number; max?: number };
}

/** Simulated PnL distribution summary */
export interface SimSummary {
  trials: number;
  horizon: number;
  mean: number;
  stdev: number;
  p5: number;
  p1: number;
  var95: number;   // one-period or horizon VaR (positive number as loss)
  es95: number;    // Expected Shortfall at 95% (positive as loss)
  min: number;
  max: number;
}

/**
 * Run correlated factor simulations and propagate to portfolio via betas.
 * Returns portfolio return per trial over the whole horizon (compounded to total return).
 */
export function simulatePaths(port: Portfolio, spec: SimSpec): { returns: number[]; summary: SimSummary } {
  const { trials, horizon, factors, mu, sigma, corr, dist = "gaussian", dof = 5, idioVol = 0, clamp } = spec;
  if (factors.length !== mu.length || mu.length !== sigma.length) {
    throw new Error("simulatePaths: factors, mu, sigma must have same length.");
  }
  const L = factors.length;
  if (corr.length !== L || corr.some(r => r.length !== L)) {
    throw new Error("simulatePaths: corr must be LxL.");
  }

  // Cholesky of covariance (Sigma = D * Corr * D)
  const D = diag(sigma);
  const C = matMul(matMul(D, corr), D);
  const Lchol = cholesky(C);

  const n = port.assets.length;
  const eqW = n > 0 ? 1 / n : 0;

  const rets: number[] = new Array(trials).fill(0);
  for (let m = 0; m < trials; m++) {
    let total = 1;
    for (let t = 0; t < horizon; t++) {
      // draw factor vector ~ N(mu, C) or t-dist scaled to match vol
      const z = (dist === "gaussian") ? randnVec(L) : studentTVec(L, dof);
      let shock = matVec(Lchol, z); // now ~ N(0, C) or t with covariance-ish
      // add means
      shock = shock.map((v, i) => v + mu[i]);

      // clamp if requested
      if (clamp) {
        for (let i = 0; i < L; i++) {
          if (clamp.min !== undefined) shock[i] = Math.max(clamp.min, shock[i]);
          if (clamp.max !== undefined) shock[i] = Math.min(clamp.max, shock[i]);
        }
      }

      // portfolio return this step via factor model
      let stepR = 0;
      for (const a of port.assets) {
        const w = a.weight ?? eqW;
        let r = (a.alpha ?? 0);
        for (let i = 0; i < L; i++) {
          const fname = factors[i];
          const b = a.exposure[fname] ?? 0;
          r += b * shock[i];
        }
        // add idiosyncratic noise
        const iv = a.vol ?? idioVol;
        if (iv > 0) r += iv * randn();
        stepR += w * r;
      }
      total *= (1 + stepR);
    }
    rets[m] = total - 1;
  }

  const summary = summarizeDist(rets);
  return { returns: rets, summary };
}

/* ============================ Risk Metrics ============================ */

export function summarizeDist(xs: number[], alpha = 0.95): SimSummary {
  const n = xs.length;
  const mu = mean(xs);
  const sd = std(xs);
  const p1 = percentile(xs, 0.01);
  const p5 = percentile(xs, 0.05);
  const min = Math.min(...xs);
  const max = Math.max(...xs);

  // VaR/ES at (1 - alpha) tail; treat as positive loss numbers
  const q = percentile(xs, 1 - alpha);
  const losses = xs.filter(v => v <= q);
  const es = losses.length ? mean(losses) : q;
  return {
    trials: n,
    horizon: 1,
    mean: mu,
    stdev: sd,
    p1, p5,
    var95: Math.abs(q),
    es95: Math.abs(es),
    min, max,
  };
}

/* ================================ Math ================================ */

function cholesky(A: number[][]): number[][] {
  const n = A.length;
  const L = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (sum <= 0) throw new Error("cholesky: matrix not positive definite");
        L[i][j] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return L;
}
function matMul(A: number[][], B: number[][]): number[][] {
  const m = A.length, n = A[0].length, p = B[0].length;
  const C = Array.from({ length: m }, () => Array(p).fill(0));
  for (let i=0;i<m;i++) for (let k=0;k<n;k++) for (let j=0;j<p;j++) C[i][j] += A[i][k]*B[k][j];
  return C;
}
function matVec(A: number[][], v: number[]): number[] {
  const m = A.length, n = A[0].length;
  const out = new Array(m).fill(0);
  for (let i=0;i<m;i++) {
    let s = 0; for (let j=0;j<n;j++) s += A[i][j]*v[j];
    out[i] = s;
  }
  return out;
}
function diag(s: number[]): number[][] {
  const n = s.length; const D = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i=0;i<n;i++) D[i][i] = s[i];
  return D;
}
function randn(): number {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
function randnVec(n: number): number[] {
  const z = new Array(n);
  for (let i=0;i<n;i++) z[i] = randn();
  return z;
}
function studentT(nu: number): number {
  // Simple t via normal / sqrt(chi2/nu), using sum of squares of normals as chi2(nu)
  const z = randn();
  let chi2 = 0;
  for (let i=0;i<Math.max(1, Math.floor(nu)); i++) {
    const g = randn(); chi2 += g*g;
  }
  const scale = Math.sqrt(chi2 / Math.max(1e-9, nu));
  return z / scale;
}
function studentTVec(n: number, nu: number): number[] {
  const out = new Array(n);
  for (let i=0;i<n;i++) out[i] = studentT(nu);
  return out;
}
function mean(xs: number[]): number { return xs.reduce((a,b)=>a+b,0) / Math.max(1, xs.length); }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0; for (const x of xs) s += (x-m)*(x-m);
  return Math.sqrt(s / (xs.length - 1));
}
function percentile(xs: number[], q: number): number {
  const s = xs.slice().sort((a,b)=>a-b);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (s[base+1] !== undefined) return s[base] + rest*(s[base+1]-s[base]);
  return s[base];
}

/* ============================== Examples ============================== */
/*
const port: Portfolio = {
  assets: [
    { symbol: "A", weight: 0.5, exposure: { MKT: 1.1, OIL: -0.2 }, alpha: 0.0005, vol: 0.02 },
    { symbol: "B", weight: 0.5, exposure: { MKT: 0.7, OIL:  0.1 }, alpha: 0.0002, vol: 0.015 },
  ]
};

// 1) Deterministic stress
const shock: ScenarioSpec = {
  id: "oil+10%_market-3%",
  shocks: [{ name: "OIL", shock: 0.10 }, { name: "MKT", shock: -0.03 }],
};
console.log(applyScenario(port, shock));

// 2) Monte Carlo simulate 1-week horizon
const spec: SimSpec = {
  trials: 5000,
  horizon: 5,
  factors: ["MKT","OIL"],
  mu: [0.0005, 0.0002],
  sigma: [0.01, 0.015],
  corr: [[1, -0.2],[-0.2,1]],
  dist: "student-t",
  dof: 5,
  idioVol: 0.01,
  clamp: { min: -0.2, max: 0.2 }
};
const sim = simulatePaths(port, spec);
console.log(sim.summary);
*/