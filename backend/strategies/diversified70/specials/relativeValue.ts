// specials/relativevalue.ts
// Pure TypeScript utilities for Relative-Value (RV) & Statistical Arbitrage.
// No imports. One-file drop-in. Numerically safe enough for daily bars.
//
// What you get:
// - Basic stats (mean, variance, stdev, covariance, correlation).
// - OLS beta/alpha (market model) and variance-min hedge ratios.
// - Pair spread constructors: price spread, beta spread, log-spread.
// - Rolling z-scores, Bollinger bands, mean-reversion half-life.
// - Simple Engle–Granger cointegration test (rough t-stat diagnostic).
// - Basket neutralization: regress anchor on hedges to get hedge vector.
// - Kelly-style sizing for RV (f* ≈ mu/var cap), volatility scaling.
// - Tiny backtester for threshold (entry/exit) mean-reversion pairs.
// - Risk metrics (drawdown, Sharpe, hit rate).
//
// Conventions:
// - Series arrays are oldest → newest. Prices > 0 for log operations.
// - Returns & spreads are decimals (0.01 = +1%) when applicable.

export type Num = number;
export type Series = number[];
export type Weights = { [k: string]: number };

function isFiniteNumber(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

// ---------- Basic stats ----------

export function mean(xs: Series): number {
  let s = 0, n = 0;
  for (let i = 0; i < xs.length; i++) { const x = xs[i]; if (isFiniteNumber(x)) { s += x; n++; } }
  return n > 0 ? s / n : NaN;
}

export function variance(xs: Series, sample: boolean = true): number {
  let m = 0, s2 = 0, n = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]; if (!isFiniteNumber(x)) continue;
    n++; const d = x - m; m += d / n; s2 += d * (x - m);
  }
  if (n < 1) return NaN;
  return sample ? (n > 1 ? s2 / (n - 1) : 0) : s2 / n;
}

export function stdev(xs: Series, sample: boolean = true): number {
  const v = variance(xs, sample);
  return isFiniteNumber(v) ? Math.sqrt(Math.max(0, v)) : NaN;
}

export function covariance(x: Series, y: Series, sample: boolean = true): number {
  const n = Math.min(x.length, y.length);
  let sx = 0, sy = 0, sxy = 0, m = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i], yi = y[i];
    if (!isFiniteNumber(xi) || !isFiniteNumber(yi)) continue;
    sx += xi; sy += yi; sxy += xi * yi; m++;
  }
  if (m < 2) return NaN;
  const xm = sx / m, ym = sy / m;
  const cov = sxy / m - xm * ym;
  return sample ? (cov * m) / (m - 1) : cov;
}

export function correlation(x: Series, y: Series): number {
  const cov = covariance(x, y, true);
  const sx = stdev(x, true), sy = stdev(y, true);
  const denom = sx * sy;
  if (!isFiniteNumber(cov) || !(denom > 0)) return NaN;
  const r = cov / denom;
  return Math.max(-1, Math.min(1, r));
}

// ---------- OLS / Hedge ratios ----------

export type OLS = { alpha: number; beta: number; rsq: number; n: number };

export function ols(y: Series, x: Series): OLS {
  const n = Math.min(y.length, x.length);
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, m = 0;
  for (let i = 0; i < n; i++) {
    const yi = y[i], xi = x[i];
    if (!isFiniteNumber(yi) || !isFiniteNumber(xi)) continue;
    sx += xi; sy += yi; sxx += xi * xi; syy += yi * yi; sxy += xi * yi; m++;
  }
  if (m < 2) return { alpha: 0, beta: 0, rsq: 0, n: m };
  const xm = sx / m, ym = sy / m;
  const cov = sxy / m - xm * ym;
  const varx = sxx / m - xm * xm;
  const vary = syy / m - ym * ym;
  const beta = varx > 0 ? cov / varx : 0;
  const alpha = ym - beta * xm;
  const rsq = vary > 0 && varx > 0 ? Math.max(0, Math.min(1, (cov * cov) / (varx * vary))) : 0;
  return { alpha, beta, rsq, n: m };
}

/** Variance-minimizing static hedge ratio for price series (not returns): beta = cov(Px,Phedge)/var(Phedge) */
export function varianceMinHedgeRatio(target: Series, hedge: Series): number {
  const cov = covariance(target, hedge, true);
  const v = variance(hedge, true);
  return v > 0 && isFiniteNumber(cov) ? cov / v : 0;
}

// ---------- Spreads & transforms ----------

export type SpreadKind = "raw" | "beta" | "log" | "beta_log";

/** Construct spread S = X - beta*Y (or log space if requested). */
export function pairSpread(
  x: Series, y: Series,
  kind: SpreadKind = "beta",
  betaOverride?: number
): Series {
  const n = Math.min(x.length, y.length);
  const out: number[] = [];
  if (kind === "raw") {
    for (let i = 0; i < n; i++) {
      const xi = x[i], yi = y[i];
      out.push(isFiniteNumber(xi) && isFiniteNumber(yi) ? (xi - yi) : NaN);
    }
    return out;
  }
  if (kind === "log" || kind === "beta_log") {
    const lx: number[] = [], ly: number[] = [];
    for (let i = 0; i < n; i++) {
      const xi = x[i], yi = y[i];
      lx.push(isFiniteNumber(xi) && xi > 0 ? Math.log(xi) : NaN);
      ly.push(isFiniteNumber(yi) && yi > 0 ? Math.log(yi) : NaN);
    }
    const b = kind === "beta_log"
      ? (isFiniteNumber(betaOverride) ? (betaOverride as number) : varianceMinHedgeRatio(lx, ly))
      : 1;
    for (let i = 0; i < n; i++) {
      const a = lx[i], bb = ly[i];
      out.push(isFiniteNumber(a) && isFiniteNumber(bb) ? (a - b * bb) : NaN);
    }
    return out;
  }
  // beta (levels)
  const b = isFiniteNumber(betaOverride) ? (betaOverride as number) : varianceMinHedgeRatio(x, y);
  for (let i = 0; i < n; i++) {
    const xi = x[i], yi = y[i];
    out.push(isFiniteNumber(xi) && isFiniteNumber(yi) ? (xi - b * yi) : NaN);
  }
  return out;
}

// ---------- Rolling z-scores & bands ----------

export function rollingMean(xs: Series, win: number): Series {
  const out: number[] = [];
  let q: number[] = [];
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (isFiniteNumber(x)) { q.push(x); s += x; }
    else { q.push(NaN); }
    if (q.length > win) {
      const old = q.shift()!;
      if (isFiniteNumber(old)) s -= old;
    }
    const valid = q.filter(isFiniteNumber);
    const m = valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : NaN;
    out.push(m);
  }
  return out;
}

export function rollingStdev(xs: Series, win: number): Series {
  const out: number[] = [];
  let q: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    q.push(isFiniteNumber(x) ? x : NaN);
    if (q.length > win) q.shift();
    const v = variance(q.filter(isFiniteNumber), true);
    out.push(isFiniteNumber(v) ? Math.sqrt(Math.max(0, v)) : NaN);
  }
  return out;
}

export function rollingZscore(xs: Series, win: number): Series {
  const m = rollingMean(xs, win);
  const s = rollingStdev(xs, win);
  const out: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const zi = isFiniteNumber(xs[i]) && isFiniteNumber(m[i]) && isFiniteNumber(s[i]) && s[i] > 0
      ? (xs[i] - m[i]) / s[i] : NaN;
    out.push(zi);
  }
  return out;
}

export function bollingerBands(xs: Series, win: number, k: number = 2): { mid: Series; upper: Series; lower: Series } {
  const mid = rollingMean(xs, win);
  const sd = rollingStdev(xs, win);
  const upper: number[] = [], lower: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const m = mid[i], s = sd[i];
    upper.push(isFiniteNumber(m) && isFiniteNumber(s) ? m + k * s : NaN);
    lower.push(isFiniteNumber(m) && isFiniteNumber(s) ? m - k * s : NaN);
  }
  return { mid, upper, lower };
}

// ---------- Mean-reversion half-life (Ornstein-Uhlenbeck proxy) ----------

/**
 * Estimate half-life of mean reversion for a spread (S_t).
 * Regress ΔS_t on S_{t-1}: ΔS = a + b*S_{t-1} + ε.
 * Then half-life ≈ -ln(2)/ln(1 + b). If b ~ 0 → long half-life.
 */
export function halfLife(spread: Series): number {
  const s: number[] = [];
  const lag: number[] = [];
  for (let i = 1; i < spread.length; i++) {
    const s0 = spread[i - 1], s1 = spread[i];
    if (isFiniteNumber(s0) && isFiniteNumber(s1)) { s.push(s1 - s0); lag.push(s0); }
  }
  const reg = ols(s, lag);
  const b = reg.beta;
  const denom = Math.log(1 + b);
  if (!isFiniteNumber(denom) || denom >= 0) return Infinity;
  return -Math.log(2) / denom;
}

// ---------- Engle–Granger (simple diagnostic) ----------

export type EGResult = {
  beta: number;
  alpha: number;
  resid: Series;
  adfT: number;     // t-stat of lag-1 coefficient in Δε ~ c + ρ*ε_{t-1}
  rho: number;
  n: number;
};

/**
 * Rough Engle–Granger cointegration diagnostic:
 * 1) Regress X on Y (levels): X = a + b*Y + u.
 * 2) Test residuals u for unit root via Δu = c + ρ*u_{t-1} + e; report t-stat of ρ.
 * (Critical values are not standard t; we only return the stat and rho.)
 */
export function engleGranger(x: Series, y: Series): EGResult {
  const reg = ols(x, y);
  const resid: number[] = [];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const xi = x[i], yi = y[i];
    const ui = (isFiniteNumber(xi) && isFiniteNumber(yi)) ? (xi - (reg.alpha + reg.beta * yi)) : NaN;
    resid.push(ui);
  }
  // Δu on u_{t-1}
  const du: number[] = [];
  const lag: number[] = [];
  for (let i = 1; i < resid.length; i++) {
    const u0 = resid[i - 1], u1 = resid[i];
    if (isFiniteNumber(u0) && isFiniteNumber(u1)) {
      du.push(u1 - u0); lag.push(u0);
    }
  }
  // OLS without intercept gives similar ρ; we include intercept for robustness
  const reg2 = ols(du, lag);
  // t-stat for ρ via simple regression math
  const yhat: number[] = [];
  for (let i = 0; i < lag.length; i++) yhat.push(reg2.alpha + reg2.beta * lag[i]);
  const resid2: number[] = [];
  for (let i = 0; i < du.length; i++) resid2.push(du[i] - yhat[i]);
  const s2 = variance(resid2, true); // residual variance
  const xvar = variance(lag, true);
  const seBeta = xvar > 0 && isFiniteNumber(s2) ? Math.sqrt(s2 / ((lag.length - 2) * xvar)) : NaN;
  const tStat = isFiniteNumber(seBeta) && seBeta > 0 ? reg2.beta / seBeta : NaN;

  return { beta: reg.beta, alpha: reg.alpha, resid, adfT: tStat, rho: reg2.beta, n: du.length };
}

// ---------- Basket neutralization (anchor ~ hedges) ----------

export type BasketHedge = { intercept: number; coefs: number[]; rsq: number; n: number };

/**
 * Regress anchor A on K hedges H (K small). Returns intercept & coefs (size K).
 * Use to hedge A with weights = coefs on hedges; spread = A - intercept - sum(coefs * H).
 * Implementation: normal equations with small K, no matrix lib.
 */
export function basketHedge(anchor: Series, hedges: Series[]): BasketHedge {
  const K = hedges.length;
  const n = Math.min(anchor.length, ...hedges.map(h => h.length));
  // Build sums
  const sx: number[] = new Array(K).fill(0);
  const sxx: number[][] = Array.from({ length: K }, () => new Array(K).fill(0));
  let sy = 0, syy = 0, sxy: number[] = new Array(K).fill(0), m = 0;

  for (let i = 0; i < n; i++) {
    const y = anchor[i];
    if (!isFiniteNumber(y)) continue;
    const xi: number[] = [];
    let ok = true;
    for (let k = 0; k < K; k++) {
      const v = hedges[k][i];
      if (!isFiniteNumber(v)) { ok = false; break; }
      xi.push(v);
    }
    if (!ok) continue;
    m++; sy += y; syy += y * y;
    for (let k = 0; k < K; k++) {
      const xk = xi[k];
      sx[k] += xk; sxy[k] += xk * y;
      for (let j = 0; j < K; j++) sxx[k][j] += xk * xi[j];
    }
  }
  if (m < K + 1) return { intercept: 0, coefs: new Array(K).fill(0), rsq: 0, n: m };

  // Solve normal equations: [ [m, sx^T], [sx, sxx] ] * [a; b] = [sy; sxy]
  // We'll center X to improve conditioning: Xc = X - mean(X)
  const mx: number[] = sx.map(v => v / m);
  // Build centered matrices
  const Sxx: number[][] = Array.from({ length: K }, () => new Array(K).fill(0));
  let Sxy: number[] = new Array(K).fill(0);
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      Sxx[i][j] = sxx[i][j] - m * mx[i] * mx[j];
    }
    Sxy[i] = sxy[i] - m * mx[i] * (sy / m);
  }

  // Solve Sxx * b = Sxy  (small K → use Gaussian elimination)
  const b = gaussSolve(Sxx, Sxy);
  const a = sy / m - dot(mx, b);
  // R^2
  const yhatVar = dot(b, matVec(Sxx, b)) / m; // approximate; fine for diagnostics
  const varY = syy / m - (sy / m) * (sy / m);
  const rsq = varY > 0 ? Math.max(0, Math.min(1, yhatVar / varY)) : 0;

  return { intercept: a, coefs: b, rsq, n: m };
}

function dot(a: number[], b: number[]): number {
  let s = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i]; return s;
}
function matVec(M: number[][], v: number[]): number[] {
  const out: number[] = new Array(M.length).fill(0);
  for (let i = 0; i < M.length; i++) {
    let s = 0; for (let j = 0; j < v.length; j++) s += (M[i][j] || 0) * (v[j] || 0);
    out[i] = s;
  }
  return out;
}
function gaussSolve(Ain: number[][], bin: number[]): number[] {
  const n = bin.length;
  const A = Ain.map(row => row.slice());
  const b = bin.slice();
  // forward elimination
  for (let i = 0; i < n; i++) {
    // pivot
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    if (Math.abs(A[piv][i] || 0) < 1e-12) continue;
    if (piv !== i) { const tmp = A[i]; A[i] = A[piv]; A[piv] = tmp; const tb = b[i]; b[i] = b[piv]; b[piv] = tb; }
    const p = A[i][i];
    for (let r = i + 1; r < n; r++) {
      const f = (A[r][i] || 0) / p;
      if (!isFiniteNumber(f)) continue;
      for (let c = i; c < n; c++) A[r][c] = (A[r][c] || 0) - f * (A[i][c] || 0);
      b[r] = b[r] - f * b[i];
    }
  }
  // back substitution
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= (A[i][c] || 0) * x[c];
    const denom = A[i][i] || 0;
    x[i] = Math.abs(denom) > 1e-12 ? s / denom : 0;
  }
  return x;
}

// ---------- RV sizing ----------

export function volScaledWeight(targetVol: number, assetVol: number, cap: number = 1): number {
  if (!isFiniteNumber(targetVol) || !isFiniteNumber(assetVol) || assetVol <= 0) return 0;
  const w = targetVol / assetVol;
  return Math.max(0, Math.min(cap, w));
}

/** Kelly-ish fraction for mean-reverting spread with expected return mu and variance var: f* ≈ mu / var (cap 0..1). */
export function kellyRv(mu: number, varR: number, cap: number = 1): number {
  if (!isFiniteNumber(mu) || !isFiniteNumber(varR) || varR <= 0) return 0;
  const f = mu / varR;
  return Math.max(0, Math.min(cap, f));
}

// ---------- Tiny pairs backtester ----------

export type PairSignalParams = {
  lookback: number;           // rolling z window
  entryZ: number;             // |z| >= entryZ to open
  exitZ: number;              // |z| <= exitZ to close
  side?: "longSpread" | "shortSpread" | "both"; // both = trade both sides
  useLog?: boolean;           // work in log space for prices
  betaLookback?: number;      // optional rolling beta window (if omitted, static beta on whole set)
};

export type Trade = {
  entryIdx: number;
  exitIdx: number;
  side: "long" | "short";
  pnl: number;                // in spread points (S delta)
};

export type BacktestResult = {
  trades: Trade[];
  totalPnL: number;
  sharpe: number;
  hitRate: number;
  maxDD: number;
  avgHold: number;
};

/**
 * Backtest a pairs strategy on spread S_t:
 * - Build spread via beta on whole sample or rolling beta (approx).
 * - Use rolling z-score; open when |z| >= entryZ; close when |z| <= exitZ or on last bar.
 * - PnL computed as ΔS with sign (long = bet S reverts down; short = S reverts up).
 */
export function backtestPairs(x: Series, y: Series, p: PairSignalParams): BacktestResult {
  const n = Math.min(x.length, y.length);
  if (n < Math.max(10, p.lookback + 5)) return { trades: [], totalPnL: 0, sharpe: 0, hitRate: 0, maxDD: 0, avgHold: 0 };

  // Build spread
  let b = varianceMinHedgeRatio(x, y);
  let S: number[] = pairSpread(x, y, p.useLog ? (p.betaLookback ? "beta_log" : "log") : (p.betaLookback ? "beta" : "raw"), b);
  if (!p.betaLookback) {
    // If no beta lookback and using raw/log, ensure beta style appropriate
    if (!p.useLog && S === undefined) S = pairSpread(x, y, "beta", b);
  } else {
    // Rolling beta
    S = [];
    const win = p.betaLookback;
    for (let i = 0; i < n; i++) {
      const L = Math.max(0, i - win + 1);
      const xs = x.slice(L, i + 1);
      const ys = y.slice(L, i + 1);
      const beta = varianceMinHedgeRatio(xs, ys);
      const si = (p.useLog ? Math.log(x[i]) - beta * Math.log(y[i]) : x[i] - beta * y[i]);
      S.push(isFiniteNumber(si) ? si : NaN);
    }
  }

  const z = rollingZscore(S, p.lookback);
  const trades: Trade[] = [];
  let pos: { side: "long" | "short"; entryIdx: number; entryS: number } | null = null;

  for (let i = 0; i < n; i++) {
    const zi = z[i], Si = S[i];
    if (!isFiniteNumber(zi) || !isFiniteNumber(Si)) continue;

    // Exit condition
    if (pos && Math.abs(zi) <= p.exitZ) {
      const pnl = (pos.side === "long" ? (pos.entryS - Si) : (Si - pos.entryS));
      trades.push({ entryIdx: pos.entryIdx, exitIdx: i, side: pos.side, pnl });
      pos = null;
      continue;
    }

    if (!pos) {
      const canLong = (p.side ?? "both") !== "shortSpread";
      const canShort = (p.side ?? "both") !== "longSpread";
      if (zi <= -p.entryZ && canLong) {
        pos = { side: "long", entryIdx: i, entryS: Si };
      } else if (zi >= p.entryZ && canShort) {
        pos = { side: "short", entryIdx: i, entryS: Si };
      }
    }
  }
  // Force-close at last index
  if (pos) {
    const i = n - 1, Si = S[i];
    if (isFiniteNumber(Si)) {
      const pnl = (pos.side === "long" ? (pos.entryS - Si) : (Si - pos.entryS));
      trades.push({ entryIdx: pos.entryIdx, exitIdx: i, side: pos.side, pnl });
      pos = null;
    }
  }

  // Compute PnL series from trades (mark-to-close PnL only)
  const pnls = trades.map(t => t.pnl);
  const totalPnL = pnls.reduce((a, b) => a + b, 0);
  const sh = stdev(pnls, true);
  const sharpe = isFiniteNumber(sh) && sh > 0 ? mean(pnls) / sh * Math.sqrt(Math.max(1, pnls.length)) : 0;
  const hitRate = trades.length > 0 ? trades.filter(t => t.pnl > 0).length / trades.length : 0;
  const avgHold = trades.length > 0 ? trades.reduce((a, t) => a + (t.exitIdx - t.entryIdx + 1), 0) / trades.length : 0;
  const maxDD = maxDrawdown(pnls);

  return { trades, totalPnL, sharpe, hitRate, maxDD, avgHold };
}

// ---------- Risk helpers ----------

export function equityCurve(pnls: Series): Series {
  const out: number[] = [];
  let c = 0;
  for (let i = 0; i < pnls.length; i++) { const p = pnls[i]; c += isFiniteNumber(p) ? p : 0; out.push(c); }
  return out;
}

export function maxDrawdown(pnls: Series): number {
  const eq = equityCurve(pnls);
  let peak = -Infinity, maxDD = 0;
  for (let i = 0; i < eq.length; i++) {
    const v = eq[i];
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

// ---------- Convenience wrappers ----------

/** Build a normalized z-score spread ready to trade. */
export function buildZSpread(
  x: Series, y: Series,
  opts?: { kind?: SpreadKind; lookback?: number; betaLookback?: number }
): { spread: Series; z: Series; beta?: number } {
  const kind = opts?.kind ?? "beta";
  const beta = opts?.betaLookback ? undefined : (kind === "beta" ? varianceMinHedgeRatio(x, y) : undefined);
  const S = pairSpread(x, y, kind, beta);
  const z = rollingZscore(S, opts?.lookback ?? 60);
  return { spread: S, z, beta };
}

/** Compute daily PnL for a 1:-beta pair (no leverage) given price changes in spread space. */
export function spreadPnL(spread: Series): Series {
  const out: number[] = [];
  for (let i = 1; i < spread.length; i++) {
    const d = isFiniteNumber(spread[i]) && isFiniteNumber(spread[i - 1]) ? (spread[i] - spread[i - 1]) : NaN;
    out.push(d);
  }
  return out;
}
