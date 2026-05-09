# backend/api/risk_router.py
"""
Institutional Risk Engine REST API.
Exposes all 11 risk gates, live risk snapshot, and adjustable config.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

import redis as _redis
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

log = logging.getLogger(__name__)
router = APIRouter(prefix="/risk", tags=["risk-engine"])

_REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
_REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))


def _r():
    return _redis.Redis(host=_REDIS_HOST, port=_REDIS_PORT, decode_responses=True)


def _load_engine():
    from backend.risk.institutional_risk_engine import InstitutionalRiskEngine, RiskConfig, get_risk_config_from_redis
    r = _r()
    config = get_risk_config_from_redis(r)
    return InstitutionalRiskEngine(config=config, redis_client=r), r


# ── Schemas ───────────────────────────────────────────────────────────────────

class RiskConfigUpdate(BaseModel):
    param: str
    value: float

class RiskConfigBulkUpdate(BaseModel):
    params: Dict[str, float]

class PreTradeCheckRequest(BaseModel):
    order: Dict[str, Any]     # symbol, side, qty, price, order_type, strategy, sector, fo_type
    portfolio_state: Dict[str, Any]
    market_state: Dict[str, Any]

class StressTestRequest(BaseModel):
    weights: Dict[str, float]   # symbol → weight (fractions summing to ~1)
    scenario: Optional[str] = None   # None = all scenarios

class PositionSizerRequest(BaseModel):
    method: str = "volatility_targeting"   # kelly, fractional_kelly, vol_target, equal_weight, risk_parity, hrp
    capital: float = 10_000_000.0
    symbols: List[str] = []
    prices: Optional[Dict[str, float]] = None
    vols: Optional[Dict[str, float]] = None
    win_rate: Optional[float] = None
    avg_win: Optional[float] = None
    avg_loss: Optional[float] = None
    target_vol: float = 0.12
    kelly_fraction: float = 0.25


# ── Config endpoints ──────────────────────────────────────────────────────────

@router.get("/config")
def get_risk_config():
    """Return current institutional risk engine configuration."""
    try:
        from backend.risk.institutional_risk_engine import RiskConfig, get_risk_config_from_redis
        import dataclasses
        config = get_risk_config_from_redis(_r())
        return dataclasses.asdict(config)
    except Exception as exc:
        raise HTTPException(503, str(exc))


@router.patch("/config")
def update_risk_param(req: RiskConfigUpdate):
    """Adjust a single risk parameter at runtime (takes effect on next order)."""
    try:
        from backend.risk.institutional_risk_engine import update_risk_param
        ok = update_risk_param(req.param, req.value, _r())
        if not ok:
            raise HTTPException(400, f"Unknown risk param: {req.param}")
        return {"status": "updated", "param": req.param, "value": req.value}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, str(exc))


@router.patch("/config/bulk")
def bulk_update_risk_params(req: RiskConfigBulkUpdate):
    """Update multiple risk parameters at once."""
    try:
        from backend.risk.institutional_risk_engine import update_risk_param
        r = _r()
        results = {}
        for param, value in req.params.items():
            results[param] = update_risk_param(param, value, r)
        failed = [k for k, v in results.items() if not v]
        return {"updated": [k for k, v in results.items() if v], "failed": failed}
    except Exception as exc:
        raise HTTPException(500, str(exc))


# ── Live risk snapshot ────────────────────────────────────────────────────────

@router.get("/snapshot")
def risk_snapshot():
    """Return latest risk snapshot from Redis (updated by intraday loop)."""
    try:
        from backend.risk.institutional_risk_engine import PortfolioRiskMonitor
        monitor = PortfolioRiskMonitor(redis_client=_r())
        snap = monitor.get_snapshot_from_redis()
        if snap is None:
            return {"status": "no_data", "message": "Risk snapshot not yet computed"}
        import dataclasses
        return dataclasses.asdict(snap)
    except Exception as exc:
        raise HTTPException(503, str(exc))


@router.get("/alerts")
def active_risk_alerts():
    """Return any active risk breaches from the latest snapshot."""
    try:
        from backend.risk.institutional_risk_engine import PortfolioRiskMonitor
        monitor = PortfolioRiskMonitor(redis_client=_r())
        snap = monitor.get_snapshot_from_redis()
        if snap is None:
            return {"alerts": [], "message": "No snapshot available"}
        alerts = monitor.should_trigger_alert(snap)
        return {"alerts": alerts, "count": len(alerts)}
    except Exception as exc:
        raise HTTPException(503, str(exc))


# ── Pre-trade check ───────────────────────────────────────────────────────────

@router.post("/check")
def pre_trade_check(req: PreTradeCheckRequest):
    """
    Run all 11 risk gates against a proposed order.
    Returns: approved (bool), gate results, modified order (with scaled qty if applicable).
    """
    try:
        engine, _ = _load_engine()
        approved, gate_results, modified_order = engine.pre_trade_check(
            req.order, req.portfolio_state, req.market_state
        )
        return {
            "approved": approved,
            "modified_order": modified_order,
            "gates": [
                {
                    "gate": g.gate,
                    "passed": g.passed,
                    "value": g.value,
                    "threshold": g.threshold,
                    "action": g.action,
                    "message": g.message,
                    "scale_factor": g.scale_factor,
                }
                for g in gate_results
            ],
        }
    except Exception as exc:
        raise HTTPException(500, str(exc))


# ── VaR / CVaR ───────────────────────────────────────────────────────────────

@router.get("/var")
def portfolio_var(confidence: float = 0.99, horizon_days: int = 1):
    """
    Compute portfolio VaR (historical, parametric, Monte Carlo) from Redis equity curve.
    """
    try:
        import numpy as np
        from backend.risk.institutional_risk_engine import VaREngine

        r = _r()
        raw = r.lrange("portfolio:daily_returns", 0, -1)
        if len(raw) < 30:
            return {"error": "Insufficient return history (need ≥ 30 days)"}

        returns = np.array([float(x) for x in raw])
        engine = VaREngine()
        hist_var = engine.historical_var(returns, confidence, horizon_days)
        param_var = engine.parametric_var(returns, confidence, horizon_days)
        cvar = engine.historical_cvar(returns, confidence)

        return {
            "confidence": confidence,
            "horizon_days": horizon_days,
            "historical_var": round(hist_var, 6),
            "parametric_var": round(param_var, 6),
            "cvar": round(cvar, 6),
            "n_observations": len(returns),
        }
    except Exception as exc:
        raise HTTPException(500, str(exc))


# ── Stress testing ────────────────────────────────────────────────────────────

@router.post("/stress")
def run_stress_test(req: StressTestRequest):
    """
    Run named stress scenarios (or all) against current portfolio weights.
    """
    try:
        import numpy as np
        import pandas as pd
        from backend.risk.institutional_risk_engine import StressTestEngine

        r = _r()
        symbols = list(req.weights.keys())
        weights = np.array([req.weights[s] for s in symbols])

        # Try to get real return history from Redis
        returns_dict = {}
        for sym in symbols:
            raw = r.lrange(f"returns:{sym}", -252, -1)
            if raw:
                returns_dict[sym] = [float(x) for x in raw]

        if len(returns_dict) < len(symbols) // 2:
            # Use synthetic
            rng = np.random.default_rng(42)
            returns_df = pd.DataFrame(
                rng.normal(0.0003, 0.015, (252, len(symbols))),
                columns=symbols,
            )
        else:
            n = min(len(v) for v in returns_dict.values())
            returns_df = pd.DataFrame(
                {s: returns_dict[s][-n:] for s in symbols}
            )

        stress_engine = StressTestEngine()
        results = stress_engine.historical_scenarios(returns_df, weights)

        if req.scenario:
            filtered = {k: v for k, v in results.items() if k == req.scenario}
            return {"results": filtered}

        return {
            "results": {k: round(float(v), 6) for k, v in results.items()},
            "worst_scenario": min(results, key=results.get),
            "worst_pnl": round(float(min(results.values())), 6),
        }
    except Exception as exc:
        raise HTTPException(500, str(exc))


# ── Position sizing ───────────────────────────────────────────────────────────

@router.post("/size")
def compute_position_sizes(req: PositionSizerRequest):
    """
    Compute position sizes using the specified method.
    Available methods: kelly, fractional_kelly, volatility_targeting,
                       equal_weight, risk_parity, hrp
    """
    try:
        import numpy as np
        from backend.risk.institutional_risk_engine import PositionSizer

        sizer = PositionSizer()
        symbols = req.symbols
        n = len(symbols)
        prices_arr = np.array([req.prices.get(s, 1000.0) for s in symbols]) if req.prices else np.ones(n) * 1000
        vols_arr = np.array([req.vols.get(s, 0.2) for s in symbols]) if req.vols else np.ones(n) * 0.2

        result = {}

        if req.method == "kelly" and req.win_rate and req.avg_win and req.avg_loss:
            f = sizer.kelly_criterion(req.win_rate, req.avg_win, req.avg_loss)
            result = {"kelly_f": round(f, 4), "fractional_25pct": round(f * 0.25, 4)}

        elif req.method == "fractional_kelly" and req.win_rate and req.avg_win and req.avg_loss:
            f = sizer.fractional_kelly(
                sizer.kelly_criterion(req.win_rate, req.avg_win, req.avg_loss),
                req.kelly_fraction,
            )
            result = {"fractional_kelly": round(f, 4)}

        elif req.method == "volatility_targeting":
            qtys = {}
            for i, sym in enumerate(symbols):
                qty = sizer.volatility_targeting(req.target_vol, vols_arr[i], req.capital / n, prices_arr[i])
                qtys[sym] = int(qty)
            result = {"method": "volatility_targeting", "quantities": qtys}

        elif req.method == "equal_weight":
            qtys = {}
            for i, sym in enumerate(symbols):
                qty = sizer.equal_weight(req.capital, n, prices_arr[i])
                qtys[sym] = int(qty)
            result = {"method": "equal_weight", "quantities": qtys}

        elif req.method == "risk_parity":
            qtys_arr = sizer.risk_parity(vols_arr, req.capital, prices_arr)
            result = {"method": "risk_parity", "quantities": {s: int(q) for s, q in zip(symbols, qtys_arr)}}

        elif req.method == "hrp" and n >= 2:
            cov = np.diag(vols_arr ** 2)
            # Add some off-diagonal correlation
            for i in range(n):
                for j in range(i + 1, n):
                    cov[i, j] = cov[j, i] = 0.3 * vols_arr[i] * vols_arr[j]
            weights = sizer.hrp_weights(cov)
            qtys = {}
            for i, sym in enumerate(symbols):
                qtys[sym] = int(weights[i] * req.capital / prices_arr[i])
            result = {
                "method": "hrp",
                "weights": {s: round(float(w), 4) for s, w in zip(symbols, weights)},
                "quantities": qtys,
            }
        else:
            raise HTTPException(400, f"Unknown method '{req.method}' or missing parameters")

        return result
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, str(exc))


# ── Risk metrics ──────────────────────────────────────────────────────────────

@router.get("/metrics")
def portfolio_risk_metrics():
    """Compute all portfolio risk metrics from Redis return history."""
    try:
        import numpy as np
        from backend.risk.institutional_risk_engine import PortfolioRiskEngine

        r = _r()
        raw = r.lrange("portfolio:daily_returns", 0, -1)
        if len(raw) < 10:
            return {"error": "Insufficient return history"}

        returns = np.array([float(x) for x in raw])
        equity = np.cumprod(1 + returns) * float(r.get("portfolio:capital_base") or 10_000_000)

        engine = PortfolioRiskEngine()
        return {
            "sharpe": round(engine.sharpe_ratio(returns), 4),
            "sortino": round(engine.sortino_ratio(returns), 4),
            "calmar": round(engine.calmar_ratio(returns), 4),
            "max_drawdown": round(engine.max_drawdown(equity), 4),
            "ulcer_index": round(engine.ulcer_index(equity), 4),
            "pain_index": round(engine.pain_index(equity), 4),
            "tail_ratio": round(engine.tail_ratio(returns), 4),
            "omega_ratio": round(engine.omega_ratio(returns), 4),
            "n_observations": len(returns),
        }
    except Exception as exc:
        raise HTTPException(500, str(exc))


# ── Kill switch passthrough ───────────────────────────────────────────────────

@router.get("/kill-switch/status")
def kill_switch_status():
    """Check if kill switch or daily trading halt is active."""
    try:
        r = _r()
        return {
            "kill_switch_active": bool(r.get("risk:kill_switch_active")),
            "daily_trading_halted": bool(r.get("risk:daily_trading_halted")),
        }
    except Exception as exc:
        raise HTTPException(503, str(exc))
