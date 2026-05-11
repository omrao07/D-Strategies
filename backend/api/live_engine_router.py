# backend/api/live_engine_router.py
"""
Live Engine REST API — start/stop scheduler, trigger jobs manually,
stream portfolio state, and inspect health.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

import os
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Security
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel

# ── Auth ──────────────────────────────────────────────────────────────────────
_ENGINE_API_KEY = os.environ.get("ENGINE_API_KEY", "")
_key_header = APIKeyHeader(name="X-Engine-Key", auto_error=False)

def _require_key(key: str = Security(_key_header)) -> None:
    if not _ENGINE_API_KEY:
        raise HTTPException(500, "ENGINE_API_KEY not configured on server")
    if key != _ENGINE_API_KEY:
        raise HTTPException(403, "Invalid or missing X-Engine-Key")

# ── Shared Redis helper (with password) ───────────────────────────────────────
def _get_redis():
    import redis as _redis_mod
    from backend.live_engine.config import REDIS_HOST, REDIS_PORT, REDIS_PASSWORD
    return _redis_mod.Redis(
        host=REDIS_HOST, port=REDIS_PORT, password=REDIS_PASSWORD, decode_responses=True
    )

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

@router.post("/start", dependencies=[Depends(_require_key)])
def start_scheduler():
    """Start the live engine scheduler (all automated jobs)."""
    sched = _get_scheduler()
    if sched.is_running():
        return {"status": "already_running"}
    sched.start()
    log.info("Live engine scheduler started via API")
    return {"status": "started"}


@router.post("/stop", dependencies=[Depends(_require_key)])
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


@router.post("/trigger", dependencies=[Depends(_require_key)])
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
        import json
        r = _get_redis()
        raw = r.get("live:portfolio_state")
        if raw:
            return json.loads(raw)
        return {"status": "no_data", "message": "No portfolio state yet — is the intraday loop running?"}
    except Exception as exc:
        raise HTTPException(503, f"Redis unavailable: {exc}")


def _engine_tracker():
    """Return the engine singleton's PnLTracker, not a new instance."""
    try:
        from backend.live_engine.engine_state import state
        if state.tracker:
            return state.tracker
    except Exception:
        pass
    # Fallback: fresh instance hydrated from Redis so daily PnL is correct
    from backend.live_engine.pnl_tracker import PnLTracker
    tracker = PnLTracker()
    try:
        r = _get_redis()
        raw_daily = r.get("pnl:realized_today")
        if raw_daily:
            tracker._realized_pnl = float(raw_daily)
            tracker._last_persisted_daily = tracker._realized_pnl
        raw_alltime = r.get("pnl:realized_alltime")
        if raw_alltime:
            tracker._alltime_realized = float(raw_alltime)
    except Exception:
        pass
    return tracker


@router.get("/positions")
def positions():
    try:
        return _engine_tracker().get_all_positions()
    except Exception as exc:
        raise HTTPException(503, str(exc))


@router.get("/pnl")
def daily_pnl():
    try:
        t = _engine_tracker()
        return {
            "daily_pnl": t.get_daily_pnl(),
            "total_equity": t.get_total_equity(),
            "drawdown": t.get_drawdown(),
            "peak_equity": t.get_peak_equity(),
        }
    except Exception as exc:
        raise HTTPException(503, str(exc))


@router.get("/trades")
def recent_trades(limit: int = 50):
    try:
        return _engine_tracker().get_trade_log(limit=limit)
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

@router.post("/order", dependencies=[Depends(_require_key)])
def place_manual_order(req: OrderOverrideRequest):
    """Place a manual order through the full risk-checked order router."""
    try:
        from backend.live_engine.engine_state import state
        from backend.live_engine.order_router import OrderRequest
        router_inst = state.router
        if router_inst is None:
            raise HTTPException(503, "Engine router not initialized")
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
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, str(exc))


@router.post("/kill-switch", dependencies=[Depends(_require_key)])
def emergency_kill_switch():
    """Emergency: cancel all open orders and halt trading."""
    try:
        r = _get_redis()
        r.set("risk:kill_switch_active", "1")
        r.set("risk:daily_trading_halted", "1")
        # Use the engine singleton's router — not a new instance
        from backend.live_engine.engine_state import state
        if state.router:
            state.router.cancel_all_orders()
        log.critical("KILL SWITCH ACTIVATED via API")
        return {"status": "kill_switch_activated", "ts": time.time()}
    except Exception as exc:
        raise HTTPException(500, str(exc))


@router.post("/kill-switch/reset", dependencies=[Depends(_require_key)])
def reset_kill_switch():
    """Reset the kill switch (use after manual review)."""
    try:
        r = _get_redis()
        r.delete("risk:kill_switch_active")
        r.delete("risk:daily_trading_halted")
        from backend.live_engine.engine_state import state
        if state.router:
            state.router.resume()
        log.warning("Kill switch RESET via API")
        return {"status": "kill_switch_reset", "ts": time.time()}
    except Exception as exc:
        raise HTTPException(500, str(exc))


# ── Strategies ────────────────────────────────────────────────────────────────

@router.get("/strategies")
def list_strategies():
    try:
        from backend.live_engine.engine_state import state
        if state.runner:
            names = list(state.runner._strategies.keys())
            return {"count": len(names), "strategies": names}
        return {"count": 0, "strategies": []}
    except Exception as exc:
        raise HTTPException(503, str(exc))


@router.post("/strategies/{name}/enable", dependencies=[Depends(_require_key)])
def enable_strategy(name: str):
    """Enable a strategy — sets Redis key checked by the live engine runner."""
    try:
        r = _get_redis()
        r.delete(f"strategy:disabled:{name}")
        return {"status": "enabled", "strategy": name}
    except Exception as exc:
        raise HTTPException(500, str(exc))


@router.post("/strategies/{name}/disable", dependencies=[Depends(_require_key)])
def disable_strategy(name: str):
    """Disable a strategy — sets Redis key checked by the live engine runner."""
    try:
        r = _get_redis()
        r.set(f"strategy:disabled:{name}", "1")
        return {"status": "disabled", "strategy": name}
    except Exception as exc:
        raise HTTPException(500, str(exc))
