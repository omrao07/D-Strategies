# backend/api/backtest_router.py
"""
FastAPI router for the production backtesting engine.

Endpoints:
  POST /backtest/run          — run full backtest, return summary
  POST /backtest/run/async    — kick off background task, poll with run_id
  GET  /backtest/status/{id}  — poll background task status
  GET  /backtest/result/{id}  — get completed result
  POST /backtest/optimize     — optimize strategy weights from completed report
  GET  /backtest/strategies   — list all registered strategies
  POST /backtest/walk-forward — standalone walk-forward validation
  POST /backtest/monte-carlo  — standalone Monte Carlo simulation
"""
from __future__ import annotations

import datetime
import logging
import threading
import time
import uuid
from typing import Any, Dict, List, Optional, Union

import numpy as np
from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field, field_validator

log = logging.getLogger(__name__)
router = APIRouter(prefix="/backtest", tags=["backtest"])

# In-memory job store (replace with Redis in production)
_jobs: Dict[str, Dict] = {}
_jobs_lock = threading.Lock()


# ── Request / response models ─────────────────────────────────────────────────

class BacktestRunRequest(BaseModel):
    start: str = Field("2020-01-01", description="Start date YYYY-MM-DD")
    end: str = Field("2024-12-31", description="End date YYYY-MM-DD")
    capital: float = Field(10_000_000.0, gt=0)
    mode: str = Field("event_driven", description="'vectorized' or 'event_driven'")
    portfolio_method: str = Field("hrp", description="'equal'|'vol_parity'|'kelly'|'hrp'|'risk_parity'")
    symbols: Optional[List[str]] = Field(None, description="Symbols for synthetic feed if no CSV")
    fee_bps: float = Field(5.0, ge=0, le=100)
    slippage_bps: float = Field(5.0, ge=0, le=100)
    price_impact_eta: float = Field(0.1, ge=0)
    max_participation_rate: float = Field(0.20, ge=0.01, le=1.0)
    short_fee_bps: float = Field(50.0, ge=0)
    enable_risk_gates: bool = True
    daily_loss_limit_pct: float = Field(2.0, gt=0)
    drawdown_limit_pct: float = Field(10.0, gt=0)
    run_walk_forward: bool = True
    run_monte_carlo: bool = True
    mc_paths: int = Field(500, ge=10, le=10000)
    mc_horizon: int = Field(252, ge=10, le=1260)
    strategy_filter: Optional[List[str]] = Field(None, description="Subset of strategy names to run")
    use_registry: bool = Field(True, description="If True, load all strategies from registry")

    @field_validator("mode")
    @classmethod
    def validate_mode(cls, v):
        if v not in ("vectorized", "event_driven"):
            raise ValueError("mode must be 'vectorized' or 'event_driven'")
        return v

    @field_validator("portfolio_method")
    @classmethod
    def validate_pm(cls, v):
        valid = {"equal", "vol_parity", "kelly", "hrp", "risk_parity"}
        if v not in valid:
            raise ValueError(f"portfolio_method must be one of {valid}")
        return v


class WalkForwardRequest(BaseModel):
    daily_returns: List[float]
    capital: float = 1_000_000.0
    train_size: int = 252
    test_size: int = 63
    fee_bps: float = 5.0
    slippage_bps: float = 5.0


class MonteCarloRequest(BaseModel):
    daily_returns: List[float]
    n_paths: int = Field(1000, ge=10, le=50000)
    horizon: int = Field(252, ge=5, le=1260)
    capital: float = 1_000_000.0
    seed: int = 42


# ── Helper: build and run engine ──────────────────────────────────────────────

def _execute_backtest(req: BacktestRunRequest) -> Dict:
    """Build BacktestEngine, run, return serializable summary dict."""
    from backend.backtester.backtest_engine import BacktestEngine
    from backend.backtester.data_feeds import SyntheticFeed

    engine = BacktestEngine(
        capital=req.capital,
        mode=req.mode,
        portfolio_method=req.portfolio_method,
        fee_bps=req.fee_bps,
        slippage_bps=req.slippage_bps,
        price_impact_eta=req.price_impact_eta,
        max_participation_rate=req.max_participation_rate,
        short_fee_bps=req.short_fee_bps,
        enable_risk_gates=req.enable_risk_gates,
        daily_loss_limit_pct=req.daily_loss_limit_pct,
        drawdown_limit_pct=req.drawdown_limit_pct,
        run_walk_forward=req.run_walk_forward,
        run_monte_carlo=req.run_monte_carlo,
        mc_paths=req.mc_paths,
        mc_horizon=req.mc_horizon,
        verbose=True,
    )

    if req.use_registry:
        n = engine.add_all_from_registry()
        log.info("Loaded %d strategies from registry", n)

    if req.strategy_filter and req.strategy_filter:
        allowed = set(req.strategy_filter)
        engine._strategies = [
            s for s in engine._strategies
            if s.ctx.name in allowed
        ]

    # Build feed
    symbols = req.symbols or [
        "RELIANCE", "TCS", "INFY", "HDFC", "ICICI",
        "SBIN", "WIPRO", "HCLTECH", "LT", "AXISBANK",
    ]
    feed = SyntheticFeed(
        symbols=symbols,
        start=req.start,
        end=req.end,
        use_regimes=True,
    )

    report = engine.run(
        start=req.start,
        end=req.end,
        feed=feed,
    )

    # Serialize (numpy arrays are not JSON-safe)
    summary = report.summary()
    summary["strategy_ranking"] = report.strategy_ranking().to_dict(orient="records")
    summary["monthly_returns"] = {
        str(yr): {str(mo): float(v) for mo, v in row.items() if v is not None and not np.isnan(v)}
        for yr, row in report.monthly_returns_table().iterrows()
    } if not report.daily_pnl.empty else {}
    summary["drawdown_periods"] = report.drawdown_periods()
    summary["risk_events"] = [
        {k: str(v) if isinstance(v, datetime.datetime) else v for k, v in e.items()}
        for e in report.risk_events
    ]

    if report.mc_results is not None:
        mc = report.mc_results
        pcts = mc.get("percentiles", np.zeros((5, 1)))
        summary["monte_carlo"] = {
            "p5":  [round(float(x), 2) for x in pcts[0]],
            "p25": [round(float(x), 2) for x in pcts[1]],
            "p50": [round(float(x), 2) for x in pcts[2]],
            "p75": [round(float(x), 2) for x in pcts[3]],
            "p95": [round(float(x), 2) for x in pcts[4]],
        }

    # Equity curve (sampled to avoid huge payloads: max 500 points)
    eq = report.equity_curve
    if len(eq) > 500:
        step = len(eq) // 500
        eq = eq.iloc[::step]
    summary["equity_curve"] = [
        {"ts": str(ts.date()) if hasattr(ts, "date") else str(ts), "equity": round(float(v), 2)}
        for ts, v in eq.items()
    ]

    return summary


# ── Synchronous run ───────────────────────────────────────────────────────────

@router.post("/run")
def run_backtest_sync(req: BacktestRunRequest):
    """
    Run backtest synchronously. Returns full summary.
    Use /run/async for long runs (> 30 seconds).
    """
    try:
        return _execute_backtest(req)
    except Exception as exc:
        log.exception("Backtest run failed")
        raise HTTPException(status_code=500, detail=str(exc))


# ── Asynchronous run (background task) ───────────────────────────────────────

@router.post("/run/async")
def run_backtest_async(req: BacktestRunRequest, background_tasks: BackgroundTasks):
    """
    Kick off a backtest in the background. Returns a run_id immediately.
    Poll GET /backtest/status/{run_id} for progress.
    Fetch result from GET /backtest/result/{run_id} when done.
    """
    run_id = str(uuid.uuid4())[:8]
    with _jobs_lock:
        _jobs[run_id] = {"status": "running", "started_at": time.time(), "result": None, "error": None}

    def _task():
        try:
            result = _execute_backtest(req)
            with _jobs_lock:
                _jobs[run_id]["status"] = "completed"
                _jobs[run_id]["result"] = result
                _jobs[run_id]["elapsed_s"] = time.time() - _jobs[run_id]["started_at"]
        except Exception as exc:
            log.exception("Background backtest %s failed", run_id)
            with _jobs_lock:
                _jobs[run_id]["status"] = "failed"
                _jobs[run_id]["error"] = str(exc)

    background_tasks.add_task(_task)
    return {"run_id": run_id, "status": "running", "message": f"Poll at /backtest/status/{run_id}"}


@router.get("/status/{run_id}")
def backtest_status(run_id: str):
    job = _jobs.get(run_id)
    if not job:
        raise HTTPException(404, f"Run {run_id} not found")
    return {
        "run_id": run_id,
        "status": job["status"],
        "elapsed_s": round(time.time() - job["started_at"], 1),
        "error": job.get("error"),
    }


@router.get("/result/{run_id}")
def backtest_result(run_id: str):
    job = _jobs.get(run_id)
    if not job:
        raise HTTPException(404, f"Run {run_id} not found")
    if job["status"] == "running":
        raise HTTPException(202, "Still running")
    if job["status"] == "failed":
        raise HTTPException(500, job.get("error", "Unknown error"))
    return job["result"]


# ── Strategy list ─────────────────────────────────────────────────────────────

@router.get("/strategies")
def list_strategies():
    """List all strategies available in the registry."""
    try:
        from backend.engine.registry import auto_register_strategies, HUB
        auto_register_strategies()
        strategies = []
        for name, cls in HUB.strategies._store.items():
            try:
                inst = cls()
                strategies.append(inst.get_metadata())
            except Exception:
                strategies.append({"name": name})
        return {"count": len(strategies), "strategies": strategies}
    except Exception as exc:
        log.warning("Could not load registry: %s", exc)
        return {"count": 0, "strategies": [], "error": str(exc)}


# ── Walk-forward standalone ───────────────────────────────────────────────────

@router.post("/walk-forward")
def standalone_walk_forward(req: WalkForwardRequest):
    """Run walk-forward validation on a provided daily returns series."""
    try:
        import numpy as np
        import pandas as pd
        from backend.backtester.vectorized_backtester import walk_forward

        rets = np.array(req.daily_returns, dtype=float)
        T = len(rets)
        if T < req.train_size + req.test_size:
            raise HTTPException(400, f"Need at least {req.train_size + req.test_size} data points")

        # Build synthetic price series from returns
        prices = pd.DataFrame({"equity": req.capital * np.cumprod(1 + rets)})
        signals = pd.DataFrame({"sig": np.sign(rets)})

        results = walk_forward(
            prices, signals,
            train_size=req.train_size,
            test_size=req.test_size,
            capital=req.capital,
            fee_bps=req.fee_bps,
            slippage_bps=req.slippage_bps,
        )

        from backend.backtester.metrics import sharpe as _sharpe
        windows = []
        for i, r in enumerate(results):
            windows.append({
                "window": i + 1,
                "sharpe": round(r.sharpe, 3),
                "total_return": round(r.total_return, 4),
                "max_drawdown": round(r.max_drawdown, 4),
                "win_rate": round(r.win_rate, 4),
            })

        oos_sharpes = [w["sharpe"] for w in windows]
        return {
            "n_windows": len(windows),
            "avg_oos_sharpe": round(float(np.mean(oos_sharpes)), 3),
            "min_oos_sharpe": round(float(np.min(oos_sharpes)), 3),
            "consistency": round(float(np.mean([1 for s in oos_sharpes if s > 0]) / max(len(oos_sharpes), 1)), 3),
            "windows": windows,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, str(exc))


# ── Monte Carlo standalone ────────────────────────────────────────────────────

@router.post("/monte-carlo")
def standalone_monte_carlo(req: MonteCarloRequest):
    """Run Monte Carlo bootstrap on a provided daily returns series."""
    try:
        import numpy as np
        from backend.backtester.vectorized_backtester import monte_carlo

        rets = np.array(req.daily_returns, dtype=float)
        result = monte_carlo(
            rets,
            n_paths=req.n_paths,
            horizon=req.horizon,
            capital=req.capital,
            seed=req.seed,
        )
        pcts = result["percentiles"]
        return {
            "capital": req.capital,
            "n_paths": req.n_paths,
            "horizon_days": req.horizon,
            "percentiles": {
                "p5":  [round(float(x), 2) for x in pcts[0]],
                "p25": [round(float(x), 2) for x in pcts[1]],
                "p50": [round(float(x), 2) for x in pcts[2]],
                "p75": [round(float(x), 2) for x in pcts[3]],
                "p95": [round(float(x), 2) for x in pcts[4]],
            },
            "final_p50": round(float(pcts[2, -1]), 2),
            "expected_return_pct": round(float(pcts[2, -1] / req.capital - 1) * 100, 2),
        }
    except Exception as exc:
        raise HTTPException(500, str(exc))
