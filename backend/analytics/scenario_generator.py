# backend/risk/scenario_generator.py
from __future__ import annotations

import os, json, time, math, random
from dataclasses import dataclass, asdict, field
from typing import Dict, List, Tuple, Optional, Iterable, Any

# ---- core deps (numpy required) ---------------------------------------------
try:
    import numpy as np
except Exception as e:
    raise RuntimeError("scenario_generator requires numpy") from e

# ---- optional deps (graceful fallbacks) -------------------------------------
HAVE_YAML = True
try:
    import yaml  # type: ignore
except Exception:
    HAVE_YAML = False

USE_REDIS = True
try:
    from redis.asyncio import Redis as AsyncRedis  # type: ignore
except Exception:
    USE_REDIS = False
    AsyncRedis = None  # type: ignore

REDIS_URL        = os.getenv("REDIS_URL", "redis://localhost:6379/0")
SCENARIO_OUT     = os.getenv("SCENARIO_OUT_STREAM", "risk.scenarios")
MAXLEN           = int(os.getenv("SCENARIO_MAXLEN", "5000"))

# -----------------------------------------------------------------------------
# Models / Config
# -----------------------------------------------------------------------------

@dataclass
class Factor:
    name: str
    shock: float = 0.0          # one-shot return shock (e.g., -0.08 = -8%)
    vol_mult: float = 1.0       # multiply vol during scenario
    drift: float = 0.0          # per-step additional drift (return units)
    decay: float = 1.0          # AR(1)-like persistence of shock (<=1)
    notes: str = ""

@dataclass
class ShockPack:
    name: str
    horizon: int                 # number of bars (minutes/hours/days) the scenario runs
    factors: List[Factor]        # factor list with shocks
    corr_surge: float = 0.0      # add to average pairwise correlation (0..1)
    vol_mult_global: float = 1.0 # multiply all vols
    liq_widen_bps: float = 0.0   # additional bps spread (slippage proxy)
    impact_perc: float = 0.0     # permanent price impact (fraction of notional traded)
    regime_tag: str = "STRESS"

@dataclass
class Universe:
    symbols: List[str]                                  # tradable names
    betas: Dict[str, Dict[str, float]] = field(default_factory=dict)  # symbol -> {factor: beta}
    sigma: Dict[str, float] = field(default_factory=dict)             # base vol per symbol (per bar)
    corr: Optional[np.ndarray] = None                                  # (N,N) corr matrix (optional)
    prices0: Dict[str, float] = field(default_factory=dict)            # starting prices for path PnL

@dataclass
class GenConfig:
    dist: str = "gaussian"       # gaussian | student | bootstrap
    df: int = 6                  # t-distribution df (if dist=='student')
    block: int = 60              # bootstrap block length (bars)
    paths: int = 1000            # number of Monte Carlo paths
    seed: Optional[int] = None

@dataclass
class Portfolio:
    qty: Dict[str, float]        # symbol -> quantity (can be ±)
    price_map: Optional[Dict[str, float]] = None  # overrides Universe.prices0 if provided

@dataclass
class PathMetrics:
    pnl: float
    ret: float
    dd: float
    var_p: float
    es_p: float

@dataclass
class ScenarioResult:
    name: str
    regime: str
    horizon: int
    symbols: List[str]
    paths: int
    metrics: PathMetrics
    per_symbol_pnl: Dict[str, float]
    pnl_paths_sample: List[float]  # few paths to visualize
    meta: Dict[str, Any] = field(default_factory=dict)

# -----------------------------------------------------------------------------
# Preset stress packs
# -----------------------------------------------------------------------------

def preset_stress(name: str) -> ShockPack:
    n = name.lower().replace(" ", "")
    if n in ("87", "1987", "blackmonday"):
        return ShockPack(
            name="Black Monday 1987",
            horizon=60,
            factors=[Factor("EQUITY", shock=-0.22, vol_mult=3.0, decay=0.97, notes="Crash leg"),
                     Factor("RATES", shock=+0.02, vol_mult=1.8, decay=0.98)],
            corr_surge=0.35, vol_mult_global=2.5, liq_widen_bps=35, impact_perc=0.001, regime_tag="CRISIS")
    if n in ("gfc", "2008", "lehman"):
        return ShockPack(
            name="GFC 2008",
            horizon=240,
            factors=[Factor("EQUITY", shock=-0.12, vol_mult=2.5, decay=0.995),
                     Factor("CREDIT", shock=+0.08, vol_mult=3.0, decay=0.996)],
            corr_surge=0.25, vol_mult_global=2.0, liq_widen_bps=25, impact_perc=0.0008, regime_tag="CRISIS")
    if n in ("covid", "2020", "pandemic"):
        return ShockPack(
            name="COVID Mar-2020",
            horizon=180,
            factors=[Factor("EQUITY", shock=-0.09, vol_mult=2.2, decay=0.993),
                     Factor("OIL", shock=-0.15, vol_mult=3.0, decay=0.99),
                     Factor("USD", shock=+0.04, vol_mult=1.7, decay=0.995)],
            corr_surge=0.20, vol_mult_global=1.8, liq_widen_bps=20, impact_perc=0.0005, regime_tag="CRISIS")
    if n in ("tapertantrum", "2013", "ustantrum"):
        return ShockPack(
            name="Taper Tantrum 2013",
            horizon=120,
            factors=[Factor("RATES", shock=+0.03, vol_mult=2.0, decay=0.992),
                     Factor("EMFX", shock=-0.06, vol_mult=2.5, decay=0.992)],
            corr_surge=0.15, vol_mult_global=1.5, liq_widen_bps=10, impact_perc=0.0004, regime_tag="STRESS")
    if n in ("inrcrisis", "2013inr", "rupee2013"):
        return ShockPack(
            name="INR FX Stress 2013",
            horizon=120,
            factors=[Factor("EMFX", shock=-0.08, vol_mult=2.5, decay=0.992),
                     Factor("RATES", shock=+0.01, vol_mult=1.7, decay=0.995)],
            corr_surge=0.10, vol_mult_global=1.4, liq_widen_bps=12, impact_perc=0.0005, regime_tag="STRESS")
    raise ValueError(f"Unknown preset stress: {name}")

# -----------------------------------------------------------------------------
# Core generation
# -----------------------------------------------------------------------------

def _rng(cfg: GenConfig):
    if cfg.seed is not None:
        np.random.seed(int(cfg.seed))
        random.seed(int(cfg.seed))
    return np.random.default_rng(cfg.seed or 7)

def _chol_psd(corr: np.ndarray) -> np.ndarray:
    # PSD guard: add tiny jitter if needed
    try:
        return np.linalg.cholesky(corr)
    except Exception:
        w, V = np.linalg.eigh((corr + corr.T) * 0.5)
        w = np.clip(w, 1e-10, None)
        return V @ np.diag(np.sqrt(w)) @ V.T

def _build_cov(univ: Universe, pack: ShockPack) -> Tuple[np.ndarray, np.ndarray]:
    """Return (sigma_vec, chol_corr) under corr surge and vol multiplier."""
    N = len(univ.symbols)
    sig = np.array([univ.sigma.get(s, 0.01) for s in univ.symbols], dtype=float)
    sig *= float(pack.vol_mult_global)
    corr = univ.corr if (univ.corr is not None and univ.corr.shape == (N, N)) else np.eye(N)
    if pack.corr_surge > 0 and N > 1:
        # convex blend toward ones off-diagonal
        J = np.ones((N, N))
        corr = (1 - pack.corr_surge) * corr + pack.corr_surge * J
        np.fill_diagonal(corr, 1.0)
    L = _chol_psd(corr)
    return sig, L

def _factor_return_path(pack: ShockPack, steps: int, cfg: GenConfig, rng) -> Dict[str, np.ndarray]:
    """
    AR(1)-like factor shock propagation with stochastic noise.
    """
    out = {}
    for f in pack.factors:
        r = np.zeros(steps)
        # apply one-shot shock at t=0, then decay
        level = float(f.shock)
        for t in range(steps):
            # noise
            if cfg.dist == "gaussian":
                eps = rng.standard_normal() * 0.01
            elif cfg.dist == "student":
                eps = rng.standard_t(cfg.df) * 0.01
            else:
                eps = rng.standard_normal() * 0.01
            r[t] = level + float(f.drift) + eps
            level *= float(f.decay)
        out[f.name] = r * float(f.vol_mult)
    return out

def _asset_paths_from_factors(univ: Universe, pack: ShockPack, steps: int, cfg: GenConfig, rng) -> np.ndarray:
    """
    Build (steps, N) returns using factor paths + idiosyncratic correlated noise.
    """
    N = len(univ.symbols)
    sig, L = _build_cov(univ, pack)
    # factor paths
    Fpaths = _factor_return_path(pack, steps, cfg, rng)  # dict: name->(T,)
    # map to assets via betas
    R = np.zeros((steps, N))
    # common idio noise per step
    for t in range(steps):
        z = rng.standard_normal(N)  # iid N(0,1)
        idio = (L @ z) * sig
        for i, sym in enumerate(univ.symbols):
            r = 0.0
            bet = univ.betas.get(sym, {})
            for k, b in bet.items():
                fp = Fpaths.get(k)
                if fp is not None:
                    r += float(b) * fp[t]
            R[t, i] = r + idio[i]
    return R

def _apply_liquidity_costs(notional_traded: float, pack: ShockPack) -> float:
    """Return slippage cost in currency units for a trade notional."""
    spread = float(pack.liq_widen_bps) * 1e-4
    imp    = float(pack.impact_perc)
    return notional_traded * (spread + imp)

def simulate_paths(
    univ: Universe,
    pack: ShockPack,
    port: Portfolio,
    *,
    cfg: Optional[GenConfig] = None
) -> ScenarioResult:
    """
    Generate Monte Carlo paths under a stress pack, compute PnL & metrics.
    Returns a ScenarioResult.
    """
    cfg = cfg or GenConfig()
    rng = _rng(cfg)
    steps = int(pack.horizon)
    N = len(univ.symbols)

    # price map
    p0 = dict(univ.prices0)
    if port.price_map:
        p0.update(port.price_map)
    p0v = np.array([float(p0.get(s, 100.0)) for s in univ.symbols], dtype=float)

    # qty vector and notionals
    qv = np.array([float(port.qty.get(s, 0.0)) for s in univ.symbols], dtype=float)
    notional0 = float(np.sum(np.abs(qv) * p0v))

    # generate R paths
    pnl_paths = []
    per_symbol_pnl = np.zeros(N)
    sample_paths = []

    for path in range(int(cfg.paths)):
        R = _asset_paths_from_factors(univ, pack, steps, cfg, rng)  # (T,N)
        # form price path (geom compounding)
        log1p = np.log1p(np.clip(R, -0.999999, None))
        P = p0v * np.exp(np.cumsum(log1p, axis=0))
        # final P&L with liquidity costs incurred on first re-hedge notionally (simplified)
        pnl_series = (P - p0v) * qv
        pnl = float(np.sum(pnl_series[-1, :]))
        # crude liquidity/slippage penalty proportional to traded notional
        trade_notional = notional0  # assume one full turnover; adjust if you model rebalancing
        pnl -= _apply_liquidity_costs(trade_notional, pack)
        pnl_paths.append(pnl)
        if path < 50:  # keep a few for visualization
            sample_paths.append(pnl)

        # accumulate average per-symbol pnl (using last bar)
        per_symbol_pnl += pnl_series[-1, :]

    per_symbol_pnl = (per_symbol_pnl / max(1, cfg.paths)).tolist()

    # metrics
    pnl_arr = np.array(pnl_paths, dtype=float)
    pnl_arr.sort()
    mu = float(np.mean(pnl_arr))
    dd = float(np.min(pnl_arr))  # worst end PnL over paths
    # portfolio return normalize by gross notionals if available
    ret = mu / (notional0 + 1e-12)
    # param: VaR / ES at 99%
    alpha = 0.99
    k = max(1, int(math.floor((1 - alpha) * pnl_arr.size)))
    var_p = float(-pnl_arr[k - 1])
    es_p = float(-np.mean(pnl_arr[:k])) if k > 0 else float("nan")

    return ScenarioResult(
        name=pack.name,
        regime=pack.regime_tag,
        horizon=steps,
        symbols=list(univ.symbols),
        paths=int(cfg.paths),
        metrics=PathMetrics(pnl=mu, ret=ret, dd=dd, var_p=var_p, es_p=es_p),
        per_symbol_pnl={univ.symbols[i]: float(per_symbol_pnl[i]) for i in range(N)},
        pnl_paths_sample=[float(x) for x in sample_paths],
        meta={"liq_widen_bps": pack.liq_widen_bps, "corr_surge": pack.corr_surge, "vol_mult": pack.vol_mult_global}
    )

# -----------------------------------------------------------------------------
# YAML loader
# -----------------------------------------------------------------------------

def load_from_yaml(path: str) -> Tuple[Universe, ShockPack, Portfolio, GenConfig]:
    if not HAVE_YAML:
        raise RuntimeError("PyYAML not installed; cannot load yaml configs.")
    with open(path, "r") as f:
        y = yaml.safe_load(f) or {}
    # universe
    syms = y["universe"]["symbols"]
    betas = y["universe"].get("betas", {})
    sigma = y["universe"].get("sigma", {})
    prices0 = y["universe"].get("prices0", {})
    corr = np.array(y["universe"].get("corr", np.eye(len(syms))).tolist(), dtype=float) if "corr" in y["universe"] else np.eye(len(syms))
    univ = Universe(symbols=syms, betas=betas, sigma=sigma, prices0=prices0, corr=corr)
    # pack
    p = y["scenario"]
    factors = [Factor(name=k, **(p["factors"][k] or {})) for k in p.get("factors", {})]
    pack = ShockPack(
        name=p.get("name", "Custom"),
        horizon=int(p.get("horizon", 120)),
        factors=factors,
        corr_surge=float(p.get("corr_surge", 0.0)),
        vol_mult_global=float(p.get("vol_mult_global", 1.0)),
        liq_widen_bps=float(p.get("liq_widen_bps", 0.0)),
        impact_perc=float(p.get("impact_perc", 0.0)),
        regime_tag=p.get("regime_tag", "STRESS"),
    )
    # portfolio
    port = Portfolio(qty=y["portfolio"]["qty"], price_map=y["portfolio"].get("prices0"))
    # gen cfg
    g = y.get("generator", {})
    gen = GenConfig(dist=g.get("dist","gaussian"), df=int(g.get("df",6)), block=int(g.get("block",60)),
                    paths=int(g.get("paths",1000)), seed=g.get("seed"))
    return univ, pack, port, gen

# -----------------------------------------------------------------------------
# Redis publisher (optional)
# -----------------------------------------------------------------------------

class ScenarioPublisher:
    def __init__(self, url: str = REDIS_URL):
        self.url = url
        self.r: Optional[AsyncRedis] = None # type: ignore

    async def connect(self):
        if not USE_REDIS: return
        try:
            self.r = AsyncRedis.from_url(self.url, decode_responses=True)  # type: ignore
            await self.r.ping() # type: ignore
        except Exception:
            self.r = None

    async def publish(self, res: ScenarioResult):
        if not self.r:
            print("[scenario] (no redis)", asdict(res)); return
        try:
            payload = asdict(res)
            payload["ts_ms"] = int(time.time() * 1000)
            await self.r.xadd(SCENARIO_OUT, {"json": json.dumps(payload)}, maxlen=MAXLEN, approximate=True)  # type: ignore
        except Exception:
            pass

# -----------------------------------------------------------------------------
# Convenience helpers
# -----------------------------------------------------------------------------

def quick_run_preset(
    preset: str,
    symbols: List[str],
    *,
    betas: Optional[Dict[str, Dict[str, float]]] = None,
    sigma: Optional[Dict[str, float]] = None,
    prices0: Optional[Dict[str, float]] = None,
    qty: Optional[Dict[str, float]] = None,
    corr: Optional[np.ndarray] = None,
    paths: int = 1000,
    seed: Optional[int] = 7,
) -> ScenarioResult:
    pack = preset_stress(preset)
    univ = Universe(symbols=symbols, betas=betas or {}, sigma=sigma or {}, prices0=prices0 or {}, corr=corr)
    port = Portfolio(qty=qty or {s: 0.0 for s in symbols})
    cfg = GenConfig(paths=paths, seed=seed)
    return simulate_paths(univ, pack, port, cfg=cfg)

# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------

def _cli():
    import argparse, asyncio
    ap = argparse.ArgumentParser("scenario_generator")
    ap.add_argument("--demo", action="store_true", help="Run a demo INR stress on a toy portfolio.")
    ap.add_argument("--preset", type=str, default=None, help="Use a preset stress pack (e.g., gfc, covid, 87, tapertantrum, inrcrisis)")
    ap.add_argument("--yaml", type=str, default=None, help="Load full config from YAML.")
    ap.add_argument("--paths", type=int, default=1000)
    ap.add_argument("--horizon", type=int, default=None)
    ap.add_argument("--publish", action="store_true", help="Publish to Redis stream risk.scenarios")
    args = ap.parse_args()

    if args.demo:
        # Toy: INDIA equities with simple betas to factors
        syms = ["RELIANCE", "TCS", "INFY", "HDFCBANK"]
        betas = {s: {"EQUITY": 1.0} for s in syms}
        sigma = {s: 0.012 for s in syms}
        prices0 = {s: 1000.0 for s in syms}
        qty = {"RELIANCE": 50, "TCS": -20, "INFY": 30, "HDFCBANK": 40}
        res = quick_run_preset("inrcrisis", syms, betas=betas, sigma=sigma, prices0=prices0, qty=qty, paths=args.paths) # type: ignore
        print(json.dumps(asdict(res), indent=2))
        return

    if args.yaml:
        univ, pack, port, gen = load_from_yaml(args.yaml)
        if args.horizon is not None:
            pack.horizon = int(args.horizon)
        gen.paths = int(args.paths or gen.paths)
        res = simulate_paths(univ, pack, port, cfg=gen)
    elif args.preset:
        # minimal run with equal vols/prices and flat betas to selected factor
        syms = ["AAPL", "MSFT", "NVDA", "AMZN"]
        betas = {s: {"EQUITY": 1.0} for s in syms}
        sigma = {s: 0.01 for s in syms}
        prices0 = {s: 100.0 for s in syms}
        qty = {s: 10.0 for s in syms}
        res = quick_run_preset(args.preset, syms, betas=betas, sigma=sigma, prices0=prices0, qty=qty, paths=args.paths)
    else:
        print("Provide --preset PRESET or --yaml PATH or use --demo"); return

    if args.publish:
        async def _run():
            pub = ScenarioPublisher()
            await pub.connect()
            await pub.publish(res)
            print("[scenario] published")
        asyncio.run(_run())
    else:
        print(json.dumps(asdict(res), indent=2))


# ---------------------------------------------------------------------------
# Test-compatible ScenarioGenerator — numpy path-simulation interface
# ---------------------------------------------------------------------------

class ScenarioGenerator:
    """
    Monte-Carlo path generator with a simple sample() interface.

    Returns {"paths": ndarray[n_scenarios, horizon, N], "assets": [...],
             "dates": [...], "meta": {"freq": ...}}.
    """

    def sample(
        self,
        n_scenarios: int,
        horizon_days: int,
        assets: list,
        mu: Optional[Any] = None,
        Sigma: Optional[Any] = None,
        seed: Optional[int] = None,
        freq: str = "D",
        method: str = "gaussian",
        shocks: Optional[List[Dict]] = None,
        jumps: Optional[Dict] = None,
        regimes: Optional[Dict] = None,
        mix: Optional[Dict] = None,
        **kw,
    ) -> Dict[str, Any]:
        if n_scenarios <= 0:
            raise ValueError(f"n_scenarios must be > 0, got {n_scenarios}")
        if horizon_days <= 0:
            raise ValueError(f"horizon_days must be > 0, got {horizon_days}")

        N = len(list(assets))
        assets_list = list(assets)

        mu_arr = np.zeros(N) if mu is None else np.asarray(mu, dtype=float)
        Sigma_arr = np.eye(N) if Sigma is None else np.asarray(Sigma, dtype=float)

        if len(mu_arr) != N:
            raise ValueError(f"mu length {len(mu_arr)} != len(assets) {N}")
        if Sigma_arr.shape != (N, N):
            raise ValueError(f"Sigma shape {Sigma_arr.shape} != ({N},{N})")

        # Validate PSD
        eigvals = np.linalg.eigvalsh(Sigma_arr)
        if eigvals.min() < -1e-8:
            raise ValueError("Sigma is not positive semi-definite")

        rng = np.random.default_rng(seed)

        # Cholesky factor (stabilize tiny eigenvalues)
        L = np.linalg.cholesky(Sigma_arr + 1e-10 * np.eye(N))

        if method == "gaussian":
            Z = rng.standard_normal(size=(n_scenarios, horizon_days, N))
            paths = Z @ L.T
        elif method == "t":
            df = int(kw.get("df", 6))
            Z = rng.standard_normal(size=(n_scenarios, horizon_days, N))
            chi2 = rng.chisquare(df, size=(n_scenarios, horizon_days, 1))
            t_factor = np.sqrt(df / chi2)
            paths = (Z * t_factor) @ L.T
        else:
            # Unsupported method: fall back to Gaussian
            Z = rng.standard_normal(size=(n_scenarios, horizon_days, N))
            paths = Z @ L.T

        # Apply shocks
        if shocks:
            for shock in shocks:
                asset_name = shock.get("asset")
                t = int(shock.get("t", 0))
                value = float(shock.get("value", 0.0))
                if asset_name in assets_list and 0 <= t < horizon_days:
                    i = assets_list.index(asset_name)
                    paths[:, t, i] += value

        # Apply jump diffusion
        if jumps is not None:
            lam = float(jumps.get("lam", 0.1))
            j_mu = float(jumps.get("mu", 0.0))
            j_sig = float(jumps.get("sigma", 0.02))
            # Expected jumps per step; Poisson draw
            n_jumps = rng.poisson(lam, size=(n_scenarios, horizon_days, N))
            jump_sizes = rng.normal(j_mu, j_sig, size=(n_scenarios, horizon_days, N))
            paths += n_jumps * jump_sizes

        # Regime switching
        if regimes is not None:
            P_mat = np.asarray(regimes.get("P", [[1.0]]))
            mus_reg = regimes.get("mus", [mu_arr])
            Sigs_reg = regimes.get("Sigmas", [Sigma_arr])
            n_reg = len(mus_reg)
            state = 0
            for t in range(horizon_days):
                L_r = np.linalg.cholesky(np.asarray(Sigs_reg[state]) + 1e-10 * np.eye(N))
                Z_r = rng.standard_normal(size=(n_scenarios, N))
                mu_r = np.asarray(mus_reg[state])
                paths[:, t, :] = Z_r @ L_r.T + mu_r[np.newaxis, :]
                # Markov transition (deterministic for simplicity: use prob of staying)
                if n_reg > 1 and t < horizon_days - 1:
                    next_prob = P_mat[state]
                    state = int(rng.choice(n_reg, p=next_prob))

        dates = list(range(horizon_days))
        return {
            "paths": paths,
            "assets": assets_list,
            "dates": dates,
            "meta": {"freq": freq, "method": method},
        }

    def percentiles(
        self,
        paths: Any,
        qs: tuple = (1, 5, 50, 95, 99),
    ) -> Dict[str, Any]:
        X = np.asarray(paths)
        N = X.shape[-1] if X.ndim == 3 else 1
        out: Dict[str, Any] = {}
        for i in range(N):
            series = X[:, :, i].reshape(-1) if X.ndim == 3 else X.reshape(-1)
            out[str(i)] = np.percentile(series, list(qs))
        return out

    def export_json(self, obj: Dict) -> Dict:
        result = {}
        for k, v in obj.items():
            if isinstance(v, np.ndarray):
                result[k] = v.tolist()
            else:
                result[k] = v
        return result

    def import_json(self, blob: Dict) -> Dict:
        result = {}
        for k, v in blob.items():
            if isinstance(v, list):
                result[k] = np.asarray(v)
            else:
                result[k] = v
        return result

if __name__ == "__main__":
    _cli()