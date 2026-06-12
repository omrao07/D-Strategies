# backend/ai/agents/concrete/monte_carlo_agent.py
"""
MonteCarloAgent
---------------
Simulation agent connecting backend/models/mc.py to the AI layer.

Capabilities:
  - GBM, Merton Jump-Diffusion, Heston Lite path generation
  - Correlated multi-asset simulation via Cholesky
  - VaR / ES at multiple confidence levels
  - Drawdown distribution (max, mean, duration)
  - Terminal price distribution stats (mean, stdev, skew, kurtosis, quantiles)
  - European option Monte Carlo pricing with variance reduction (antithetic sampling)
  - Portfolio PnL simulation (weights vector)
  - Stress scenario overlays (shock drift, vol multiplier, jump intensity boost)
  - Human-readable risk commentary
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, Tuple

import numpy as np

try:
    from ..core.base_agent import BaseAgent  # type: ignore
except Exception:
    class BaseAgent:  # type: ignore
        name: str = "base_agent"
        def plan(self, *a, **k): ...
        def act(self, *a, **k): return {}
        def explain(self): return ""
        def heartbeat(self): return {"ok": True}

try:
    from backend.models.mc import (  # type: ignore
        GBM,
        HestonLite,
        MertonJD,
        bs_call_price,
        control_variate,
        drawdown,
        portfolio_pnl,
        var_es,
    )
    _HAS_MC = True
except Exception:
    _HAS_MC = False

# ─────────────────────────────────────────────────────────────
# Inline fallbacks if mc.py not importable
# ─────────────────────────────────────────────────────────────
if not _HAS_MC:
    class _Paths:
        def __init__(self, X): self.X = X
        def last(self): return self.X[:,-1,:]
        def returns(self): return self.X[:,1:,:] / self.X[:,:-1,:] - 1.0
        def log_returns(self): return np.log(np.maximum(self.X[:,1:,:], 1e-12) / np.maximum(self.X[:,:-1,:], 1e-12))

    class GBM:  # type: ignore
        def __init__(self, s0, mu, sigma): self.s0=np.asarray(s0,float); self.mu=np.asarray(mu,float); self.sigma=np.asarray(sigma,float)
        def simulate(self, n_steps, n_paths, dt=1/252, corr=None, antithetic=False, seed=None, names=None):
            rng = np.random.default_rng(seed)
            d = self.s0.shape[0] if self.s0.ndim > 0 else 1
            s0 = self.s0.reshape(1,1,d); mu = self.mu.reshape(1,1,d); sig = self.sigma.reshape(1,1,d)
            Z = rng.normal(size=(n_paths, n_steps, d))
            drift = (mu - 0.5*sig*sig)*dt; diff = sig*math.sqrt(dt)*Z
            X = np.empty((n_paths, n_steps+1, d)); X[:,0,:] = s0
            X[:,1:,:] = s0 * np.cumprod(np.exp(drift+diff), axis=1)
            return _Paths(X)

    class MertonJD:  # type: ignore
        def __init__(self, s0, mu, sigma, lam=0.1, mu_j=-0.1, sigma_j=0.2):
            self.s0=np.asarray(s0,float); self.mu=np.asarray(mu,float); self.sigma=np.asarray(sigma,float)
            self.lam=lam; self.mu_j=mu_j; self.sigma_j=sigma_j
        def simulate(self, n_steps, n_paths, dt=1/252, corr=None, antithetic=False, seed=None, names=None):
            return GBM(self.s0, self.mu, self.sigma).simulate(n_steps, n_paths, dt, seed=seed)

    class HestonLite:  # type: ignore
        def __init__(self, s0, v0, mu, kappa, theta, xi, rho):
            self.s0=s0; self.v0=v0; self.mu=mu; self.kappa=kappa; self.theta=theta; self.xi=xi; self.rho=rho
        def simulate(self, n_steps, n_paths, dt=1/252, seed=None, names=None):
            return GBM(np.array([self.s0]), np.array([self.mu]), np.array([math.sqrt(self.v0)])).simulate(n_steps, n_paths, dt, seed=seed)

    def var_es(sample, levels=(0.95, 0.99)):  # type: ignore
        x = np.asarray(sample, float)
        out = {}
        for lvl in levels:
            q = np.quantile(x, 1-lvl)
            tail = x[x <= q]
            out[lvl] = {"VaR": float(q), "ES": float(tail.mean()) if tail.size else float("nan")}
        return out

    def drawdown(eq):  # type: ignore
        eq = np.asarray(eq, float)
        if eq.ndim == 1:
            peak = np.maximum.accumulate(eq)
            dd = (eq-peak)/np.maximum(peak, 1e-12)
            return float(dd.min()), float(len(eq))
        return float(np.mean([drawdown(eq[i])[0] for i in range(eq.shape[0])])), float(len(eq[0]))

    def portfolio_pnl(returns, weights):  # type: ignore
        r = np.asarray(returns, float); w = np.asarray(weights, float)
        return (r * w[None,None,:]).sum(axis=2)

    def bs_call_price(s0, k, r, sigma, T, q=0.0):  # type: ignore
        if sigma<=0 or T<=0: return max(0.0, s0-k)
        d1=(math.log(s0/k)+(r-q+0.5*sigma*sigma)*T)/(sigma*math.sqrt(T)); d2=d1-sigma*math.sqrt(T)
        return float(s0*math.exp(-q*T)*0.5*(1+math.erf(d1/math.sqrt(2))) - k*math.exp(-r*T)*0.5*(1+math.erf(d2/math.sqrt(2))))

    _Paths = _Paths  # noqa: F811

ModelType = Literal["gbm", "merton_jd", "heston"]


# ─────────────────────────────────────────────────────────────
# Request / Response models
# ─────────────────────────────────────────────────────────────

@dataclass
class AssetSpec:
    symbol: str
    s0: float                           # initial price
    mu: float = 0.08                    # annual drift (risk-neutral for option pricing)
    sigma: float = 0.20                 # annual vol
    # Merton JD extras
    lam: float = 0.1                    # jump intensity per year
    mu_j: float = -0.10                 # log-mean jump size
    sigma_j: float = 0.15              # log-stdev jump size
    # Heston extras
    v0: float = 0.04                    # initial variance (vol²)
    kappa: float = 2.0                  # mean-reversion speed
    theta: float = 0.04                 # long-run variance
    xi: float = 0.3                     # vol of vol
    rho: float = -0.7                   # spot-vol correlation
    weight: float = 1.0                 # portfolio weight (auto-normalized)

@dataclass
class OptionPayoff:
    """Optional: price a European option from MC paths."""
    option_type: Literal["call","put"] = "call"
    strike: float = 100.0
    expiry_yr: float = 0.25
    r: float = 0.065
    q: float = 0.0
    use_control_variate: bool = True

@dataclass
class SimRequest:
    assets: List[AssetSpec]
    model: ModelType = "gbm"
    n_paths: int = 20_000
    n_steps: int = 252                  # trading days
    dt: float = 1/252
    horizon_yr: float = 1.0
    antithetic: bool = True
    seed: Optional[int] = 42
    corr: Optional[List[List[float]]] = None   # d×d correlation matrix
    var_levels: List[float] = field(default_factory=lambda: [0.90, 0.95, 0.99])
    option_payoff: Optional[OptionPayoff] = None
    stress: Optional[Dict[str, float]] = None  # e.g. {"drift_shock": -0.3, "vol_mult": 2.0}

@dataclass
class DistStats:
    mean: float; stdev: float; skew: float; kurt: float
    p1: float; p5: float; p25: float; p50: float; p75: float; p95: float; p99: float

@dataclass
class AssetSimResult:
    symbol: str
    s0: float
    terminal_price_stats: DistStats
    pct_return_stats: DistStats
    var_es: Dict[str, Dict[str, float]]     # {"0.95": {"VaR": ..., "ES": ...}}

@dataclass
class PortfolioSimResult:
    cumulative_pnl_stats: DistStats
    max_drawdown_stats: Dict[str, float]    # mean, worst, duration_mean
    var_es: Dict[str, Dict[str, float]]
    sharpe_estimate: float

@dataclass
class OptionMCResult:
    option_type: str; strike: float; expiry_yr: float
    mc_price: float; bs_price: float; variance_reduction_pct: float
    std_error: float; ci_95: Tuple[float, float]

@dataclass
class SimResponse:
    generated_at: int
    model: str
    n_paths: int; n_steps: int
    asset_results: List[AssetSimResult]
    portfolio: Optional[PortfolioSimResult]
    option_mc: Optional[OptionMCResult]
    summary: str


# ─────────────────────────────────────────────────────────────
# Agent
# ─────────────────────────────────────────────────────────────

class MonteCarloAgent(BaseAgent):  # type: ignore
    """
    Monte Carlo simulation agent.  Wires GBM / Merton-JD / Heston Lite
    from backend.models.mc into the agent framework.  Computes per-asset
    and portfolio risk, option MC pricing, and stress overlays.
    """

    name = "monte_carlo_agent"

    def plan(self, req: Any) -> SimRequest:
        if isinstance(req, SimRequest):
            return req
        if isinstance(req, dict):
            assets = []
            for a in req.get("assets", []):
                if isinstance(a, dict):
                    a = AssetSpec(**{k: v for k, v in a.items() if k in AssetSpec.__dataclass_fields__})
                assets.append(a)
            op = req.get("option_payoff")
            if op and isinstance(op, dict):
                op = OptionPayoff(**{k: v for k, v in op.items() if k in OptionPayoff.__dataclass_fields__})
            return SimRequest(
                assets=assets,
                model=req.get("model", "gbm"),
                n_paths=int(req.get("n_paths", 20_000)),
                n_steps=int(req.get("n_steps", 252)),
                dt=float(req.get("dt", 1/252)),
                horizon_yr=float(req.get("horizon_yr", 1.0)),
                antithetic=bool(req.get("antithetic", True)),
                seed=req.get("seed", 42),
                corr=req.get("corr"),
                var_levels=req.get("var_levels", [0.90, 0.95, 0.99]),
                option_payoff=op,
                stress=req.get("stress"),
            )
        return SimRequest(assets=[])

    def act(self, req: Any) -> SimResponse:
        req = self.plan(req)

        if not req.assets:
            return SimResponse(generated_at=int(time.time()*1000), model=req.model,
                               n_paths=0, n_steps=0, asset_results=[], portfolio=None,
                               option_mc=None, summary="No assets specified.")

        # Apply stress overlay
        assets = self._apply_stress(req.assets, req.stress)

        # Build correlation matrix
        d = len(assets)
        corr = np.asarray(req.corr) if req.corr and len(req.corr)==d else np.eye(d)

        # Simulate all assets together
        paths = self._simulate(assets, req.model, req.n_paths, req.n_steps, req.dt,
                               req.antithetic, req.seed, corr)

        asset_results = []
        for i, spec in enumerate(assets):
            # Slice asset i paths: (n_paths, n_steps+1)
            px = paths.X[:,:,i]   # (n_paths, n_steps+1)
            ST = px[:,-1]
            pct_ret = (ST - spec.s0) / max(spec.s0, 1e-9)
            np.log(np.maximum(px[:,1:], 1e-9) / np.maximum(px[:,:-1], 1e-9)).sum(axis=1)

            term_stats = self._dist_stats(ST)
            ret_stats  = self._dist_stats(pct_ret)
            ve = {str(round(lvl,4)): v for lvl, v in var_es(pct_ret, req.var_levels).items()}

            asset_results.append(AssetSimResult(
                symbol=spec.symbol, s0=spec.s0,
                terminal_price_stats=term_stats,
                pct_return_stats=ret_stats,
                var_es=ve,
            ))

        # Portfolio simulation
        portfolio_result: Optional[PortfolioSimResult] = None
        if d > 1 or True:  # always compute portfolio metrics
            weights = np.array([a.weight for a in assets], dtype=float)
            weights /= max(weights.sum(), 1e-9)
            ret_tensor = paths.returns()  # (n_paths, n_steps, d)
            port_pnl = portfolio_pnl(ret_tensor, weights)  # (n_paths, n_steps)
            # cumulative PnL at horizon
            cum_pnl = port_pnl.sum(axis=1)
            cum_stats = self._dist_stats(cum_pnl)
            ve_port = {str(round(lvl,4)): v for lvl, v in var_es(cum_pnl, req.var_levels).items()}

            # drawdown per path
            # equity curve = 1 + cumulative pnl per path
            eq = np.concatenate([np.ones((paths.X.shape[0],1)), 1 + np.cumsum(port_pnl, axis=1)], axis=1)
            mdd_mean, dur_mean = drawdown(eq)
            mdds = [drawdown(eq[i])[0] for i in range(min(500, eq.shape[0]))]
            dd_stats = {"mean": float(np.mean(mdds)), "worst": float(np.min(mdds)),
                        "pct_paths_gt10pct": float(np.mean(np.array(mdds) < -0.10)),
                        "duration_mean": dur_mean}

            # Sharpe estimate: annualized
            mean_daily = port_pnl.mean()
            std_daily  = port_pnl.std()
            sharpe = (mean_daily / max(std_daily, 1e-9)) * math.sqrt(252)

            portfolio_result = PortfolioSimResult(
                cumulative_pnl_stats=cum_stats,
                max_drawdown_stats=dd_stats,
                var_es=ve_port,
                sharpe_estimate=float(sharpe),
            )

        # Option MC pricing
        option_result: Optional[OptionMCResult] = None
        if req.option_payoff and d >= 1:
            option_result = self._price_option_mc(
                paths.X[:,:,0],  # use first asset
                assets[0],
                req.option_payoff,
                req.n_paths,
            )

        summary = self._summarize(req, asset_results, portfolio_result, option_result)
        return SimResponse(
            generated_at=int(time.time()*1000),
            model=req.model, n_paths=req.n_paths, n_steps=req.n_steps,
            asset_results=asset_results,
            portfolio=portfolio_result,
            option_mc=option_result,
            summary=summary,
        )

    # ─────────────── simulation dispatch ───────────────

    def _simulate(self, assets: List[AssetSpec], model: str,
                  n_paths: int, n_steps: int, dt: float,
                  antithetic: bool, seed: Optional[int],
                  corr: np.ndarray) -> Any:
        d = len(assets)
        s0    = np.array([a.s0    for a in assets], dtype=float)
        mu    = np.array([a.mu    for a in assets], dtype=float)
        sigma = np.array([a.sigma for a in assets], dtype=float)

        if model == "gbm":
            return GBM(s0, mu, sigma).simulate(
                n_steps, n_paths, dt,
                corr=corr if d > 1 else None,
                antithetic=antithetic, seed=seed,
            )
        elif model == "merton_jd":
            # Simulate each asset independently (jumps don't correlate)
            results = []
            for i, a in enumerate(assets):
                p = MertonJD(
                    np.array([a.s0]), np.array([a.mu]), np.array([a.sigma]),
                    lam=a.lam, mu_j=a.mu_j, sigma_j=a.sigma_j,
                ).simulate(n_steps, n_paths, dt, antithetic=antithetic, seed=seed)
                results.append(p.X)
            X = np.concatenate(results, axis=2)
            return type("Paths", (), {"X": X,
                "returns": lambda self: X[:,1:,:]/X[:,:-1,:]-1,
            })()
        elif model == "heston":
            # Heston per asset (single-asset each)
            results = []
            for i, a in enumerate(assets):
                p = HestonLite(
                    s0=a.s0, v0=a.v0, mu=a.mu, kappa=a.kappa,
                    theta=a.theta, xi=a.xi, rho=a.rho,
                ).simulate(n_steps, n_paths, dt, seed=seed)
                results.append(p.X)
            X = np.concatenate(results, axis=2)
            return type("Paths", (), {"X": X,
                "returns": lambda self: X[:,1:,:]/X[:,:-1,:]-1,
            })()
        else:
            return GBM(s0, mu, sigma).simulate(n_steps, n_paths, dt, antithetic=antithetic, seed=seed)

    def _apply_stress(self, assets: List[AssetSpec], stress: Optional[Dict[str, float]]) -> List[AssetSpec]:
        if not stress:
            return assets
        out = []
        for a in assets:
            import dataclasses
            a2 = dataclasses.replace(a)
            a2.mu    = a.mu + stress.get("drift_shock", 0.0)
            a2.sigma = a.sigma * stress.get("vol_mult", 1.0)
            a2.lam   = a.lam * stress.get("jump_intensity_mult", 1.0)
            out.append(a2)
        return out

    # ─────────────── option MC pricing ───────────────

    def _price_option_mc(self, px: np.ndarray, spec: AssetSpec,
                         op: OptionPayoff, n_paths: int) -> OptionMCResult:
        ST = px[:,-1]
        disc = math.exp(-op.r * op.expiry_yr)
        if op.option_type == "call":
            payoff = np.maximum(ST - op.strike, 0.0) * disc
        else:
            payoff = np.maximum(op.strike - ST, 0.0) * disc

        bs_price = bs_call_price(spec.s0, op.strike, op.r, spec.sigma, op.expiry_yr, op.q)
        if op.option_type == "put":
            bs_price = bs_price - spec.s0*math.exp(-op.q*op.expiry_yr) + op.strike*math.exp(-op.r*op.expiry_yr)

        mc_price_plain = float(payoff.mean())
        std_err = float(payoff.std() / math.sqrt(max(n_paths, 1)))

        var_red = 0.0
        if op.use_control_variate and _HAS_MC:
            try:
                cv_pay = np.maximum(ST - op.strike, 0.0) * disc
                reduced = control_variate(payoff, cv_pay, bs_price)
                mc_price = float(reduced.mean())
                var_red = (1 - reduced.std()/max(payoff.std(), 1e-12)) * 100
                std_err = float(reduced.std() / math.sqrt(max(n_paths, 1)))
            except Exception:
                mc_price = mc_price_plain
        else:
            mc_price = mc_price_plain

        z95 = 1.96
        ci = (mc_price - z95*std_err, mc_price + z95*std_err)
        return OptionMCResult(
            option_type=op.option_type, strike=op.strike, expiry_yr=op.expiry_yr,
            mc_price=mc_price, bs_price=bs_price,
            variance_reduction_pct=var_red,
            std_error=std_err, ci_95=ci,
        )

    # ─────────────── stats helpers ───────────────

    @staticmethod
    def _dist_stats(x: np.ndarray) -> DistStats:
        x = np.asarray(x, dtype=float)
        len(x)
        mu = float(x.mean()); sig = float(x.std())
        if sig > 1e-12:
            skew = float(((x - mu)**3).mean() / sig**3)
            kurt = float(((x - mu)**4).mean() / sig**4 - 3)
        else:
            skew = kurt = 0.0
        pcts = np.percentile(x, [1, 5, 25, 50, 75, 95, 99]).tolist()
        return DistStats(mean=mu, stdev=sig, skew=skew, kurt=kurt,
                         p1=pcts[0], p5=pcts[1], p25=pcts[2], p50=pcts[3],
                         p75=pcts[4], p95=pcts[5], p99=pcts[6])

    def _summarize(self, req: SimRequest, assets: List[AssetSimResult],
                   port: Optional[PortfolioSimResult],
                   opt: Optional[OptionMCResult]) -> str:
        parts = [f"MC simulation: {req.model.upper()} | {req.n_paths:,} paths × {req.n_steps} steps."]
        if req.stress:
            parts.append(f"[STRESS OVERLAY: {req.stress}]")
        for a in assets:
            ve99 = a.var_es.get("0.99") or a.var_es.get("0.9900")
            if ve99:
                parts.append(f"{a.symbol}: E[T]={a.terminal_price_stats.mean:.2f} ± {a.terminal_price_stats.stdev:.2f}, "
                              f"99%VaR={ve99['VaR']*100:.2f}% / ES={ve99['ES']*100:.2f}%.")
        if port:
            parts.append(f"Portfolio: Sharpe≈{port.sharpe_estimate:.2f}, "
                         f"max drawdown (mean)={port.max_drawdown_stats['mean']*100:.1f}%, "
                         f"worst={port.max_drawdown_stats['worst']*100:.1f}%.")
            if port.max_drawdown_stats.get("pct_paths_gt10pct", 0) > 0.3:
                parts.append("WARNING: >30% of paths breach -10% drawdown — high tail risk.")
        if opt:
            parts.append(f"MC option ({opt.option_type} K={opt.strike}): "
                         f"MC={opt.mc_price:.4f} vs BS={opt.bs_price:.4f} "
                         f"(SE={opt.std_error:.5f}, VR={opt.variance_reduction_pct:.1f}%).")
        return " ".join(parts)

    def explain(self) -> str:
        return ("MonteCarloAgent simulates GBM/Merton-JD/Heston price paths, computes per-asset "
                "VaR/ES/drawdown distributions, portfolio risk metrics, Sharpe estimates, "
                "and European option MC pricing with antithetic sampling and control variates.")

    def heartbeat(self) -> Dict[str, Any]:
        return {"ok": True, "agent": self.name, "has_mc_module": _HAS_MC, "ts": int(time.time())}


if __name__ == "__main__":  # pragma: no cover
    agent = MonteCarloAgent()
    req = SimRequest(
        assets=[
            AssetSpec("NIFTY",  s0=22000, mu=0.10, sigma=0.18, weight=0.6),
            AssetSpec("BANKNIFTY", s0=48000, mu=0.12, sigma=0.22, weight=0.4),
        ],
        model="gbm", n_paths=10_000, n_steps=252, antithetic=True, seed=42,
        corr=[[1.0, 0.75],[0.75, 1.0]],
        var_levels=[0.95, 0.99],
        option_payoff=OptionPayoff(option_type="call", strike=22500, expiry_yr=30/365, r=0.065),
    )
    resp = agent.act(req)
    print(resp.summary)
