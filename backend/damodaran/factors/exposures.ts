// factors/exposures.ts
// Factor exposures via OLS with Newey–West (HAC) std errors.
// Includes rolling betas and small utilities.
// No external dependencies.

export interface SeriesPoint {
  t: number | string | Date; // timestamp
  v: number;                  // value (return)
}

export type Series = SeriesPoint[];

export interface ExposuresInput {
  asset: Series;                  // asset returns (e.g., daily excess returns)
  factors: Record<string, Series>;// factor returns keyed by factor name
  includeIntercept?: boolean;     // include alpha (default true)
  neweyWestLags?: number;         // override automatic lag choice
  minObservations?: number;       // default 30
}

export interface ExposureResult {
  n: number;
  k: number;                      // number of betas
  factors: string[];              // factor names in regression order
  includeIntercept: boolean;

  coefficients: {
    alpha?: number;
    betas: Record<string, number>;
  };

  stderr: {
    alpha?: number;
    betas: Record<string, number>;
  };

  tStats: {
    alpha?: number;
    betas: Record<string, number>;
  };

  r2: number;
  r2Adj: number;
  sigma2: number;                 // residual variance
  residuals: number[];
}

/* =============================== Utils =============================== */

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function toEpoch(x: number | string | Date): number {
  if (typeof x === "number") return x;
  if (x instanceof Date) return x.getTime();
  // string
  const d = new Date(x);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) throw new Error(`Invalid date: ${x}`);
  return ms;
}

function clone<T>(o: T): T { return JSON.parse(JSON.stringify(o)); }

/** Left-join on timestamp: returns aligned [y, X] matrices */
function align(asset: Series, factors: Record<string, Series>): { y: number[]; X: number[][]; names: string[] } {
  const facNames = Object.keys(factors);
  const map = new Map<number, number>(); // t -> y
  for (const p of asset) map.set(toEpoch(p.t), p.v);

  const rows: Array<{ t: number; y: number; x: number[] }> = [];
  for (const name of facNames) {
    // ensure factor series sorted and numeric
    factors[name] = factors[name].slice().map(p => ({ t: toEpoch(p.t), v: p.v })).sort((a,b)=>a.t-b.t);
  }

  const times = Array.from(map.keys()).sort((a,b)=>a-b);
  for (const t of times) {
    const yv = map.get(t)!;
    const xRow: number[] = [];
    let ok = true;
    for (const name of facNames) {
      // binary search could be used; assume exact timestamps in test fixtures
      const arr = factors[name];
      // simple map for speed (build on first call)
      if (!(arr as any)._m) {
        (arr as any)._m = new Map<number, number>(arr.map(p => [p.t as number, p.v]));
      }
      const mv = (arr as any)._m.get(t);
      if (!isNum(mv)) { ok = false; break; }
      xRow.push(mv);
    }
    if (ok && isNum(yv)) rows.push({ t, y: yv, x: xRow });
  }

  const y = rows.map(r => r.y);
  const X = rows.map(r => r.x);
  return { y, X, names: facNames };
}

/** Simple column-ops */
function transpose(A: number[][]): number[][] {
  if (A.length === 0) return [];
  const m = A.length, n = A[0].length;
  const T = Array.from({ length: n }, () => Array(m).fill(0));
  for (let i=0;i<m;i++) for (let j=0;j<n;j++) T[j][i] = A[i][j];
  return T;
}
function matMul(A: number[][], B: number[][]): number[][] {
  const m = A.length, n = A[0].length, p = B[0].length;
  const C = Array.from({ length: m }, () => Array(p).fill(0));
  for (let i=0;i<m;i++) {
    for (let k=0;k<n;k++) {
      const aik = A[i][k];
      for (let j=0;j<p;j++) C[i][j] += aik * B[k][j];
    }
  }
  return C;
}
function matVec(A: number[][], v: number[]): number[] {
  const m = A.length, n = A[0].length;
  const out = Array(m).fill(0);
  for (let i=0;i<m;i++) {
    let s = 0;
    for (let j=0;j<n;j++) s += A[i][j] * v[j];
    out[i] = s;
  }
  return out;
}
function vecDot(a: number[], b: number[]): number {
  let s = 0; for (let i=0;i<a.length;i++) s += a[i]*b[i]; return s;
}
function eye(n: number): number[][] {
  const I = Array.from({ length: n }, (_,i) => {
    const row = Array(n).fill(0); row[i]=1; return row;
  });
  return I;
}

/** Inverse via Gauss-Jordan (small n expected) */
function invert(M: number[][]): number[][] {
  const n = M.length;
  const A = M.map(r => r.slice());
  const I = eye(n);

  for (let i = 0; i < n; i++) {
    // pivot
    let piv = A[i][i];
    if (Math.abs(piv) < 1e-12) {
      // swap with a lower row
      let swap = i+1;
      for (; swap < n; swap++) if (Math.abs(A[swap][i]) > Math.abs(piv)) break;
      if (swap === n) throw new Error("Matrix not invertible");
      const tmp = A[i]; A[i] = A[swap]; A[swap] = tmp;
      const tmpI = I[i]; I[i] = I[swap]; I[swap] = tmpI;
      piv = A[i][i];
    }
    const invP = 1 / piv;
    for (let j=0;j<n;j++) { A[i][j] *= invP; I[i][j] *= invP; }
    for (let r=0;r<n;r++) if (r!==i) {
      const f = A[r][i];
      for (let c=0;c<n;c++) { A[r][c] -= f*A[i][c]; I[r][c] -= f*I[i][c]; }
    }
  }
  return I;
}

/* ============================== OLS Core ============================== */

function addIntercept(X: number[][]): number[][] {
  return X.map(row => [1, ...row]);
}

function ols(y: number[], X: number[][]) {
  // beta = (X'X)^(-1) X'y
  const Xt = transpose(X);
  const XtX = matMul(Xt, X);
  const XtX_inv = invert(XtX);
  const Xty = matVec(Xt, y);
  const beta = matVec(XtX_inv, Xty); // [alpha?, betas...]

  // residuals & stats
  const yhat = matVec(X, beta);
  const e = y.map((yi, i) => yi - yhat[i]);
  const n = y.length;
  const k = X[0].length; // including intercept if present
  const s2 = vecDot(e, e) / Math.max(1, (n - k));
  const r2 = 1 - (vecDot(e,e) / (vecDot(y,y) || 1e-12));
  const r2Adj = 1 - (1 - r2) * ((n - 1) / Math.max(1, (n - k)));

  return { beta, residuals: e, XtX_inv, s2, r2, r2Adj, yhat };
}

/* ====================== Newey–West (HAC) SE ========================== */
/**
 * Newey–West (HAC) covariance:
 * Var(beta) = (X'X)^(-1) (X' Ω X) (X'X)^(-1),
 * with Ω estimated using residual autocovariances up to lag q.
 * q defaults to floor(4 * (n/100)^(2/9)) (common rule of thumb).
 */
function neweyWestCov(X: number[][], resid: number[], XtX_inv: number[][], q?: number) {
  const n = X.length;
  const k = X[0].length;

  const H = Array.from({ length: k }, () => Array(k).fill(0)); // meat
  const e = resid;

  // S_0 = sum_t (e_t^2 * x_t x_t')
  for (let t=0; t<n; t++) {
    const xt = X[t];
    const outer = outerProd(xt, xt, e[t]*e[t]);
    addInPlace(H, outer);
  }

  // Add weighted autocovariances
  const qLag = (typeof q === "number" && q >= 0) ? Math.floor(q) : Math.floor(4 * Math.pow(n / 100, 2/9));
  for (let l = 1; l <= qLag; l++) {
    const w = 1 - l/(qLag+1); // Bartlett kernel
    let Sl = zero(k);
    for (let t=l; t<n; t++) {
      const xt = X[t], xtl = X[t-l];
      const scale = e[t] * e[t-l];
      addInPlace(Sl, outerProd(xt, xtl, scale));
    }
    // S_l + S_l' scaled by weight
    const SlT = transpose(Sl);
    const add = addMat(Sl, SlT);
    scaleInPlace(add, w);
    addInPlace(H, add);
  }

  // sandwich: (X'X)^(-1) H (X'X)^(-1)
  const left = XtX_inv;
  const right = XtX_inv;
  const temp = matMul(left, H);
  const V = matMul(temp, right);
  return V;
}

function zero(n: number): number[][] { return Array.from({ length: n }, () => Array(n).fill(0)); }
function outerProd(a: number[], b: number[], scale = 1): number[][] {
  const m = a.length, n = b.length;
  const M = Array.from({ length: m }, () => Array(n).fill(0));
  for (let i=0;i<m;i++) for (let j=0;j<n;j++) M[i][j] = scale * a[i]*b[j];
  return M;
}
function addInPlace(A: number[][], B: number[][]) {
  for (let i=0;i<A.length;i++) for (let j=0;j<A[0].length;j++) A[i][j]+=B[i][j];
}
function addMat(A: number[][], B: number[][]): number[][] {
  const M = A.map(r => r.slice());
  addInPlace(M, B); return M;
}
function scaleInPlace(A: number[][], s: number) {
  for (let i=0;i<A.length;i++) for (let j=0;j<A[0].length;j++) A[i][j]*=s;
}

/* =========================== Public APIs ============================= */

/**
 * Compute factor exposures (alpha + betas) using OLS + Newey–West std errors.
 * Assumes input series are returns already (excess returns recommended).
 */
export function computeExposures(input: ExposuresInput): ExposureResult {
  const {
    asset,
    factors,
    includeIntercept = true,
    neweyWestLags,
    minObservations = 30,
  } = input;

  // Align
  const { y, X, names } = align(asset, factors);
  if (y.length < Math.max(minObservations, names.length + (includeIntercept ? 1 : 0) + 1)) {
    throw new Error(`Not enough observations: ${y.length}`);
  }

  const Xreg = includeIntercept ? addIntercept(X) : X;
  const { beta, residuals, XtX_inv, s2, r2, r2Adj } = ols(y, Xreg);

  // Newey-West covariance & std errors
  const V = neweyWestCov(Xreg, residuals, XtX_inv, neweyWestLags);
  const se = V.map((row, i) => Math.sqrt(Math.max(0, row[i]))); // diag sqrt

  const res: ExposureResult = {
    n: y.length,
    k: names.length,
    factors: clone(names),
    includeIntercept,
    coefficients: {
      alpha: includeIntercept ? beta[0] : undefined,
      betas: Object.fromEntries(names.map((n, i) => [n, beta[i + (includeIntercept ? 1 : 0)]])),
    },
    stderr: {
      alpha: includeIntercept ? se[0] : undefined,
      betas: Object.fromEntries(names.map((n, i) => [n, se[i + (includeIntercept ? 1 : 0)]])),
    },
    tStats: {
      alpha: includeIntercept && se[0] ? beta[0] / (se[0] || 1e-12) : undefined,
      betas: Object.fromEntries(names.map((n, i) => {
        const b = beta[i + (includeIntercept ? 1 : 0)];
        const s = se[i + (includeIntercept ? 1 : 0)] || 1e-12;
        return [n, b / s];
      })),
    },
    r2,
    r2Adj,
    sigma2: s2,
    residuals,
  };

  return res;
}

/**
 * Rolling exposures over a moving window (e.g., 60 days).
 * Returns array of window results with end timestamp indices.
 */
export function rollingExposures(
  asset: Series,
  factors: Record<string, Series>,
  window: number,
  step = 1,
  opts?: Omit<ExposuresInput, "asset" | "factors">
): Array<ExposureResult & { endIndex: number }> {
  const { y, X, names } = align(asset, factors);
  const includeIntercept = opts?.includeIntercept ?? true;
  const neweyWestLags = opts?.neweyWestLags;
  const minObs = opts?.minObservations ?? Math.max(30, window);

  const out: Array<ExposureResult & { endIndex: number }> = [];
  for (let end = window; end <= y.length; end += step) {
    const start = end - window;
    const yW = y.slice(start, end);
    const XW = X.slice(start, end);
    if (yW.length < Math.max(minObs, names.length + (includeIntercept ? 1 : 0) + 1)) continue;

    const Xreg = includeIntercept ? addIntercept(XW) : XW;
    const { beta, residuals, XtX_inv, s2, r2, r2Adj } = ols(yW, Xreg);
    const V = neweyWestCov(Xreg, residuals, XtX_inv, neweyWestLags);
    const se = V.map((row, i) => Math.sqrt(Math.max(0, row[i])));
    out.push({
      n: yW.length,
      k: names.length,
      factors: clone(names),
      includeIntercept,
      coefficients: {
        alpha: includeIntercept ? beta[0] : undefined,
        betas: Object.fromEntries(names.map((n, i) => [n, beta[i + (includeIntercept ? 1 : 0)]])),
      },
      stderr: {
        alpha: includeIntercept ? se[0] : undefined,
        betas: Object.fromEntries(names.map((n, i) => [n, se[i + (includeIntercept ? 1 : 0)]])),
      },
      tStats: {
        alpha: includeIntercept && se[0] ? beta[0] / (se[0] || 1e-12) : undefined,
        betas: Object.fromEntries(names.map((n, i) => {
          const b = beta[i + (includeIntercept ? 1 : 0)];
          const s = se[i + (includeIntercept ? 1 : 0)] || 1e-12;
          return [n, b / s];
        })),
      },
      r2,
      r2Adj,
      sigma2: s2,
      residuals,
      endIndex: end - 1,
    });
  }
  return out;
}

/* ====================== Helpers: returns & builders =================== */

/** Build simple returns from a price series. */
export function simpleReturns(prices: Series): Series {
  const sorted = prices.slice().sort((a,b)=>toEpoch(a.t)-toEpoch(b.t));
  const out: Series = [];
  for (let i=1;i<sorted.length;i++) {
    const p0 = sorted[i-1].v, p1 = sorted[i].v;
    out.push({ t: sorted[i].t, v: (p1 - p0) / (p0 || 1e-12) });
  }
  return out;
}

/** Convert a numeric array to a Series with incremental integer timestamps (0..n-1). */
export function arrayToSeries(xs: number[]): Series {
  return xs.map((v, i) => ({ t: i, v }));
}

/** Quick CSV to Series (expects headers: date,value). Minimal and safe. */
export function csvToSeries(csv: string): Series {
  const lines = csv.trim().split(/\r?\n/);
  const out: Series = [];
  for (let i=1;i<lines.length;i++) {
    const [d, val] = lines[i].split(",");
    const v = Number(val);
    if (isNum(v)) out.push({ t: d, v });
  }
  return out;
}

/** Format a result as a flat object for CSV/JSON reporting */
export function flattenExposure(res: ExposureResult): Record<string, number> {
  const o: Record<string, number> = {
    n: res.n,
    r2: res.r2,
    r2Adj: res.r2Adj,
    sigma2: res.sigma2,
  };
  if (res.includeIntercept) {
    o["alpha"] = res.coefficients.alpha ?? 0;
    o["alpha_se"] = res.stderr.alpha ?? 0;
    o["alpha_t"] = res.tStats.alpha ?? 0;
  }
  for (const f of res.factors) {
    o[`beta_${f}`] = res.coefficients.betas[f];
    o[`se_${f}`] = res.stderr.betas[f];
    o[`t_${f}`] = res.tStats.betas[f];
  }
  return o;
}

/* ============================== Example =============================== */
/*
const asset = arrayToSeries([0.01, -0.02, 0.015, 0.004, 0.01, -0.003, 0.02]);
const mkt   = arrayToSeries([0.012,-0.018,0.010, 0.002, 0.011,-0.004,0.018]);
const smb   = arrayToSeries([0.001, 0.000,0.002,-0.001, 0.000, 0.001,0.000]);

const res = computeExposures({
  asset,
  factors: { MKT: mkt, SMB: smb },
  includeIntercept: true,
});

console.log(res.coefficients, res.stderr, res.tStats, res.r2);

// Rolling example:
const roll = rollingExposures(asset, { MKT: mkt, SMB: smb }, 5, 1);
console.log("windows:", roll.length, "last beta_MKT:", roll.at(-1)?.coefficients.betas["MKT"]);
*/