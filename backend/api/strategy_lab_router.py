# backend/api/strategy_lab_router.py
"""
Strategy Lab REST API — parallel backtest sweeps, A/B test management, allocator.

Endpoints:
  GET  /lab/health                    — liveness
  POST /lab/sweep                     — parallel strategy sweep via ParallelRunner
  POST /lab/sweep/async               — background sweep with job polling
  GET  /lab/sweep/status/{job_id}     — poll background sweep
  GET  /lab/sweep/result/{job_id}     — fetch completed sweep result
  GET  /lab/allocations               — current live allocations from engine/allocator
  GET  /lab/strategies                — list strategies discovered by ParallelRunner
  POST /lab/ab/snapshot               — snapshot of A/B test metrics (if runner active)
"""
from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Security
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)
router = APIRouter(prefix="/lab", tags=["strategy-lab"])

_ENGINE_API_KEY = os.getenv("ENGINE_API_KEY", "")
_key_header = APIKeyHeader(name="X-Engine-Key", auto_error=False)


def _require_key(key: str = Security(_key_header)) -> None:
    if not _ENGINE_API_KEY:
        raise HTTPException(500, "ENGINE_API_KEY not configured on server")
    if key != _ENGINE_API_KEY:
        raise HTTPException(403, "Invalid or missing X-Engine-Key")


# ── In-memory job store ──────────────────────────────────────────────────────

_jobs: Dict[str, Dict] = {}
_jobs_lock = threading.Lock()


# ── Request / response models ─────────────────────────────────────────────────

class SweepRequest(BaseModel):
    start: str = Field("2020-01-01", description="Backtest start date YYYY-MM-DD")
    end: str = Field("2024-12-31", description="Backtest end date YYYY-MM-DD")
    capital: float = Field(10_000_000.0, gt=0)
    n_workers: int = Field(4, ge=1, le=32, description="Parallel workers")
    strategy_filter: Optional[List[str]] = Field(None, description="Subset of strategy names; None = all")
    min_sharpe: float = Field(0.0, description="Filter out results below this Sharpe in leaderboard")
    top_n: int = Field(50, ge=1, le=500, description="Max strategies in leaderboard response")
    fee_bps: float = Field(5.0, ge=0)
    slippage_bps: float = Field(5.0, ge=0)


# ── Health ────────────────────────────────────────────────────────────────────

@router.get("/health")
def lab_health():
    return {"status": "ok", "ts": int(time.time() * 1000)}


# ── Strategy list ─────────────────────────────────────────────────────────────

@router.get("/strategies")
def lab_list_strategies():
    """List all strategies the parallel runner can discover."""
    try:
        from backend.backtester.parallel_runner import ParallelRunner
        runner = ParallelRunner(capital=1_000_000, n_workers=1)
        strats = runner._discover_strategies()
        return {"count": len(strats), "strategies": sorted(strats.keys())}
    except Exception as e:
        log.warning("Strategy discovery failed: %s", e)
        return {"count": 0, "strategies": [], "error": str(e)}


# ── Synchronous sweep ─────────────────────────────────────────────────────────

def _execute_sweep(req: SweepRequest) -> Dict[str, Any]:
    from backend.backtester.parallel_runner import ParallelRunner

    runner = ParallelRunner(
        capital=req.capital,
        n_workers=req.n_workers,
        fee_bps=req.fee_bps,
        slippage_bps=req.slippage_bps,
    )

    results = runner.run_all_strategies(
        start=req.start,
        end=req.end,
        strategy_filter=req.strategy_filter,
    )

    # Build leaderboard
    rows = []
    for r in results:
        if r.sharpe >= req.min_sharpe and not r.failed:
            rows.append({
                "name": r.name,
                "sharpe": round(r.sharpe, 3),
                "sortino": round(r.sortino, 3),
                "cagr": round(r.cagr, 4),
                "max_drawdown": round(r.max_drawdown, 4),
                "calmar": round(r.calmar, 3),
                "win_rate": round(r.win_rate, 4),
                "n_trades": r.n_trades,
                "total_return": round(r.total_return, 4),
                "anti_overfit_passed": r.anti_overfit_passed,
            })

    failed = [{"name": r.name, "error": r.error} for r in results if r.failed]
    rows.sort(key=lambda x: x["sharpe"], reverse=True)

    return {
        "n_strategies": len(results),
        "n_failed": len(failed),
        "leaderboard": rows[: req.top_n],
        "failed": failed,
        "params": {
            "start": req.start,
            "end": req.end,
            "capital": req.capital,
            "n_workers": req.n_workers,
        },
    }


@router.post("/sweep")
def sweep_sync(req: SweepRequest, _auth: None = Depends(_require_key)):
    """Run parallel strategy sweep synchronously (blocks until done)."""
    try:
        return _execute_sweep(req)
    except Exception as e:
        log.exception("Sweep failed")
        raise HTTPException(500, str(e))


# ── Async sweep ───────────────────────────────────────────────────────────────

@router.post("/sweep/async")
def sweep_async(req: SweepRequest, background_tasks: BackgroundTasks, _auth: None = Depends(_require_key)):
    """Kick off parallel sweep in background. Poll /lab/sweep/status/{job_id}."""
    job_id = str(uuid.uuid4())[:8]
    with _jobs_lock:
        _jobs[job_id] = {"status": "running", "started_at": time.time(), "result": None, "error": None}

    def _task():
        try:
            result = _execute_sweep(req)
            with _jobs_lock:
                _jobs[job_id]["status"] = "completed"
                _jobs[job_id]["result"] = result
                _jobs[job_id]["elapsed_s"] = time.time() - _jobs[job_id]["started_at"]
        except Exception as e:
            log.exception("Async sweep %s failed", job_id)
            with _jobs_lock:
                _jobs[job_id]["status"] = "failed"
                _jobs[job_id]["error"] = str(e)

    background_tasks.add_task(_task)
    return {"job_id": job_id, "status": "running", "poll_at": f"/lab/sweep/status/{job_id}"}


@router.get("/sweep/status/{job_id}")
def sweep_status(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    return {
        "job_id": job_id,
        "status": job["status"],
        "elapsed_s": round(time.time() - job["started_at"], 1),
        "error": job.get("error"),
    }


@router.get("/sweep/result/{job_id}")
def sweep_result(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    if job["status"] == "running":
        raise HTTPException(202, "Still running")
    if job["status"] == "failed":
        raise HTTPException(500, job.get("error", "Unknown error"))
    return job["result"]


# ── Live allocations ──────────────────────────────────────────────────────────

@router.get("/allocations")
def lab_allocations():
    """Return current target weights and notionals from the live allocator."""
    try:
        from backend.engine.allocator import get_notionals, get_weights
        weights = get_weights()
        notionals = get_notionals()
        return {
            "weights": weights,
            "notionals": notionals,
            "ts": int(time.time() * 1000),
        }
    except Exception as e:
        log.warning("Allocator unavailable: %s", e)
        raise HTTPException(503, f"Allocator unavailable: {e}")


@router.post("/allocations/recompute")
def lab_recompute_allocations(_auth: None = Depends(_require_key)):
    """Force a fresh allocation pass (risk-parity + signal tilt + drawdown guard)."""
    try:
        from backend.engine.allocator import allocate
        weights, notionals = allocate()
        return {
            "weights": weights,
            "notionals": notionals,
            "ts": int(time.time() * 1000),
        }
    except Exception as e:
        log.exception("Allocation recompute failed")
        raise HTTPException(500, str(e))


# ── A/B test snapshot ────────────────────────────────────────────────────────

# Global A/B runner (set externally if desired)
_ab_runner = None


def set_ab_runner(runner: Any) -> None:
    """Wire a live ABTestRunner instance so /lab/ab/snapshot works."""
    global _ab_runner
    _ab_runner = runner


@router.get("/ab/snapshot")
def lab_ab_snapshot():
    """Return current A/B test metrics snapshot if a runner is active."""
    if _ab_runner is None:
        raise HTTPException(503, "No A/B runner configured; call set_ab_runner() on startup")
    try:
        return _ab_runner.snapshot()
    except Exception as e:
        raise HTTPException(500, str(e))
