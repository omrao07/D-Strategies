# backend/api/live_engine_router.py
"""
Live Engine REST API — start/stop scheduler, trigger jobs manually,
stream portfolio state, and inspect health.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

log = logging.getLogger(__name__)
router = APIRouter(prefix="/live", tags=["live-engine"])

# ── Lazy scheduler singleton ──────────────────────────────────────────────────

_scheduler = None

def _get_scheduler():
    global _scheduler
    if _scheduler is None:
        try:
            from backend.live_engine.scheduler import LiveEngineScheduler
            _scheduler = LiveEngineScheduler()
        except Exception as exc:
            log.error("Cannot load LiveEngineScheduler: %s", exc)
            raise HTTPException(503, f"Scheduler unavailable: {exc}")
    return _scheduler


# ── Schemas ───────────────────────────────────────────────────────────────────

class SchedulerStatus(BaseModel):
    running: bool
    jobs: List[Dict[str, Any]]
    uptime_s: float

class JobTriggerRequest(BaseModel):
    job_id: str

class RiskParamUpdate(BaseModel):
    param: str
    value: float

class OrderOverrideRequest(BaseModel):
    symbol: str
    side: str              # buy / sell
    qty: float
    order_type: str = "market"
    limit_price: Optional[float] = None
    strategy: str = "manual"
    reason: str = ""


# ── Scheduler routes ──────────────────────────────────────────────────────────

@router.post("/start")
def start_scheduler():
    """Start the live engine scheduler (all automated jobs)."""
    sched = _get_scheduler()
    if sched.is_running():
        return {"status": "already_running"}
    sched.start()
    log.info("Live engine scheduler started via API")
    return {"status": "started"}


@router.post("/stop")
def stop_scheduler():
    """Gracefully stop the scheduler."""
    sched = _get_scheduler()
    sched.stop()
    return {"status": "stopped"}


@router.get("/status", response_model=SchedulerStatus)
def scheduler_status():
    """Return scheduler status and list of registered jobs."""
    sched = _get_scheduler()
    return sched.status()


@router.post("/trigger")
def trigger_job(req: JobTriggerRequest, bg: BackgroundTasks):
    """Manually trigger any named job immediately."""
    sched = _get_scheduler()
    if not sched.has_job(req.job_id):
        raise HTTPException(404, f"No job named '{req.job_id}'")
    bg.add_task(sched.trigger_job, req.job_id)
    return {"status": "triggered", "job_id": req.job_id}


# ── Portfolio state ───────────────────────────────────────────────────────────

@router.get("/portfolio")
def portfolio_state():
    """Return current live portfolio snapshot from Redis."""
    try:
        import redis as _redis
        import os, json
        r = _redis.Redis(
            host=os.getenv("REDIS_HOST", "localhost"),
            port=int(os.getenv("REDIS_PORT", "6379")),
            decode_responses=True,
        )
        raw = r.get("live:portfolio_state")
        if raw:
            return json.loads(raw)
        return {"status": "no_data", "message": "No portfolio state yet — is the intraday loop running?"}
    except Exception as exc:
        raise HTTPException(503, f"Redis unavailable: {exc}")


@router.get("/positions")
def positions():
    """Return all open positions from PnL tracker."""
    try:
        from backend.live_engine.pnl_tracker import PnLTracker
        tracker = PnLTracker()
        return tracker.get_all_positions()
    except Exception as exc:
        raise HTTPException(503, str(exc))


@router.get("/pnl")
def daily_pnl():
    """Return today's realized + unrealized PnL."""
    try:
        from backend.live_engine.pnl_tracker import PnLTracker
        tracker = PnLTracker()
        return {
            "daily_pnl": tracker.get_daily_pnl(),
            "total_equity": tracker.get_total_equity(),
            "drawdown": tracker.get_drawdown(),
            "peak_equity": tracker.get_peak_equity(),
        }
    except Exception as exc:
        raise HTTPException(503, str(exc))


@router.get("/trades")
def recent_trades(limit: int = 50):
    """Return recent trade log."""
    try:
        from backend.live_engine.pnl_tracker import PnLTracker
        tracker = PnLTracker()
        return tracker.get_trade_log(limit=limit)
    except Exception as exc:
        raise HTTPException(503, str(exc))


# ── Health ────────────────────────────────────────────────────────────────────

@router.get("/health")
def engine_health():
    """Detailed health check — Redis, broker, data feeds, WebSocket."""
    try:
        from backend.live_engine.jobs.health_monitor import run as run_health
        return run_health()
    except Exception as exc:
        raise HTTPException(503, str(exc))


# ── Market data ───────────────────────────────────────────────────────────────

@router.get("/market/vix")
def india_vix():
    """Return current India VIX from cache."""
    try:
        from backend.live_engine.market_data_service import MarketDataService
        svc = MarketDataService()
        return {"india_vix": svc.get_india_vix()}
    except Exception as exc:
        raise HTTPException(503, str(exc))


@router.get("/market/fo-ban")
def fo_ban_list():
    """Return current NSE F&O ban list."""
    try:
        from backend.live_engine.market_data_service import MarketDataService
        svc = MarketDataService()
        return {"fo_ban_list": svc.get_fo_ban_list()}
    except Exception as exc:
        raise HTTPException(503, str(exc))


@router.get("/market/quote/{symbol}")
def live_quote(symbol: str):
    """Return live quote for a symbol."""
    try:
        from backend.live_engine.market_data_service import MarketDataService
        svc = MarketDataService()
        return svc.get_live_quote(symbol.upper())
    except Exception as exc:
        raise HTTPException(503, str(exc))


# ── Manual order ─────────────────────────────────────────────────────────────

@router.post("/order")
def place_manual_order(req: OrderOverrideRequest):
    """Place a manual order through the full risk-checked order router."""
    try:
        from backend.live_engine.order_router import OrderRouter, OrderRequest
        router_inst = OrderRouter()
        order = OrderRequest(
            strategy=req.strategy,
            symbol=req.symbol.upper(),
            side=req.side.lower(),
            qty=req.qty,
            order_type=req.order_type,
            limit_price=req.limit_price,
        )
        order_id = router_inst.route(order)
        if order_id:
            return {"status": "accepted", "order_id": order_id}
        return {"status": "rejected", "reason": "Risk gate or broker rejection"}
    except Exception as exc:
        raise HTTPException(500, str(exc))


@router.post("/kill-switch")
def emergency_kill_switch():
    """Emergency: cancel all open orders and halt trading."""
    try:
        import redis as _redis, os
        r = _redis.Redis(
            host=os.getenv("REDIS_HOST", "localhost"),
            port=int(os.getenv("REDIS_PORT", "6379")),
            decode_responses=True,
        )
        r.set("risk:kill_switch_active", "1")
        r.set("risk:daily_trading_halted", "1")
        from backend.live_engine.order_router import OrderRouter
        OrderRouter().cancel_all_orders()
        log.critical("KILL SWITCH ACTIVATED via API")
        return {"status": "kill_switch_activated", "ts": time.time()}
    except Exception as exc:
        raise HTTPException(500, str(exc))


@router.post("/kill-switch/reset")
def reset_kill_switch():
    """Reset the kill switch (use after manual review)."""
    try:
        import redis as _redis, os
        r = _redis.Redis(
            host=os.getenv("REDIS_HOST", "localhost"),
            port=int(os.getenv("REDIS_PORT", "6379")),
            decode_responses=True,
        )
        r.delete("risk:kill_switch_active")
        r.delete("risk:daily_trading_halted")
        log.warning("Kill switch RESET via API")
        return {"status": "kill_switch_reset", "ts": time.time()}
    except Exception as exc:
        raise HTTPException(500, str(exc))


# ── Strategies ────────────────────────────────────────────────────────────────

@router.get("/strategies")
def list_strategies():
    """List all registered strategies and their enabled/disabled state."""
    try:
        from backend.live_engine.strategy_runner import StrategyRunner
        runner = StrategyRunner()
        runner.load_strategies()
        return {
            "count": runner.strategy_count(),
            "strategies": list(runner._strategies.keys()),
        }
    except Exception as exc:
        raise HTTPException(503, str(exc))


@router.post("/strategies/{name}/enable")
def enable_strategy(name: str):
    try:
        from backend.live_engine.strategy_runner import StrategyRunner
        runner = StrategyRunner()
        runner.enable_strategy(name)
        return {"status": "enabled", "strategy": name}
    except Exception as exc:
        raise HTTPException(500, str(exc))


@router.post("/strategies/{name}/disable")
def disable_strategy(name: str):
    try:
        from backend.live_engine.strategy_runner import StrategyRunner
        runner = StrategyRunner()
        runner.disable_strategy(name)
        return {"status": "disabled", "strategy": name}
    except Exception as exc:
        raise HTTPException(500, str(exc))
