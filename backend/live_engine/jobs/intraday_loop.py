# backend/live_engine/jobs/intraday_loop.py
"""
Intraday 60-second tick loop.

Called every 60s by the scheduler during market hours (9:15 AM – 3:30 PM IST).

Flow per tick:
  1. Fetch latest bars for all tracked symbols
  2. Run all active strategies on each bar (strategy_runner)
  3. Route resulting orders through risk engine → broker (order_router)
  4. Mark portfolio to market (pnl_tracker)
  5. Check kill switch / drawdown halt
  6. Publish portfolio state to Redis and WebSocket
  7. Log tick summary
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict, List

log = logging.getLogger(__name__)

_REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
_REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))


def _get_redis():
    try:
        import redis
        return redis.Redis(host=_REDIS_HOST, port=int(_REDIS_PORT), decode_responses=True)
    except Exception:
        return None


def run_tick() -> dict:
    """
    Execute one 60-second tick.
    Returns a summary dict (n_bars, n_signals, n_orders, n_rejected, pnl).
    """
    t0 = time.perf_counter()
    summary: Dict[str, Any] = {
        "ts": int(time.time()),
        "n_bars": 0,
        "n_signals": 0,
        "n_orders_submitted": 0,
        "n_orders_rejected": 0,
        "daily_pnl": 0.0,
        "drawdown": 0.0,
        "equity": 0.0,
        "kill_switch": False,
    }

    r = _get_redis()

    # ── 0. Kill switch check ──────────────────────────────────────────────────
    if r:
        if r.get("risk:kill_switch_active") or r.get("risk:daily_trading_halted"):
            log.warning("Intraday tick SKIPPED — kill switch or daily halt active")
            summary["kill_switch"] = True
            _publish_state(r, summary)
            return summary

    # ── 1. Fetch latest bars ──────────────────────────────────────────────────
    bars: Dict[str, dict] = {}
    prices: Dict[str, float] = {}
    try:
        from backend.live_engine.market_data_service import MarketDataService
        from backend.live_engine.config import NIFTY50_SYMBOLS
        svc = MarketDataService()
        quotes = svc.get_multi_quote(NIFTY50_SYMBOLS)
        for sym, q in quotes.items():
            if q:
                ltp = float(q.get("last_price", q.get("close", 0)) or 0)
                bars[sym] = {
                    "symbol": sym,
                    "open": float(q.get("ohlc", {}).get("open", ltp)),
                    "high": float(q.get("ohlc", {}).get("high", ltp)),
                    "low":  float(q.get("ohlc", {}).get("low", ltp)),
                    "close": ltp,
                    "volume": float(q.get("volume", 0)),
                    "ts": int(time.time()),
                }
                if ltp > 0:
                    prices[sym] = ltp
        summary["n_bars"] = len(bars)
    except Exception as exc:
        log.error("Bar fetch failed: %s", exc)

    if not bars:
        log.warning("No bars received this tick — skipping strategy run")
        return summary

    # ── 2. Run strategies ─────────────────────────────────────────────────────
    order_requests = []
    try:
        from backend.live_engine.strategy_runner import StrategyRunner
        runner = StrategyRunner()
        runner.load_strategies()
        order_requests = runner.run_all_bars(bars)
        signals = runner.get_aggregated_signals()
        summary["n_signals"] = len(signals)

        # Persist signals to Redis for allocator
        if r and signals:
            for sym, score in signals.items():
                r.hset("strategy:signal:live", sym, str(score))
    except Exception as exc:
        log.error("Strategy runner failed: %s", exc)

    # ── 3. Route orders ───────────────────────────────────────────────────────
    try:
        from backend.live_engine.order_router import OrderRouter
        router = OrderRouter()
        for order_req in order_requests:
            try:
                order_id = router.route(order_req)
                if order_id:
                    summary["n_orders_submitted"] += 1
                else:
                    summary["n_orders_rejected"] += 1
            except Exception as exc:
                log.debug("Order routing error for %s: %s", order_req.symbol, exc)
                summary["n_orders_rejected"] += 1
    except Exception as exc:
        log.error("Order router unavailable: %s", exc)

    # ── 4. Mark to market ─────────────────────────────────────────────────────
    try:
        from backend.live_engine.pnl_tracker import PnLTracker
        tracker = PnLTracker()
        if prices:
            tracker.mark_to_market(prices)
        summary["daily_pnl"] = round(tracker.get_daily_pnl(), 2)
        summary["equity"] = round(tracker.get_total_equity(), 2)
        summary["drawdown"] = round(tracker.get_drawdown(), 6)

        # ── 5. Kill switch: drawdown ──────────────────────────────────────────
        try:
            from backend.risk.institutional_risk_engine import get_risk_config_from_redis
            config = get_risk_config_from_redis(r)
            dd = summary["drawdown"]
            nav = summary["equity"]
            dpnl = summary["daily_pnl"]

            if dd > config.drawdown_kill_switch_pct:
                if r:
                    r.set("risk:kill_switch_active", "1")
                log.critical("DRAWDOWN KILL SWITCH: %.2f%% > %.2f%%",
                             dd * 100, config.drawdown_kill_switch_pct * 100)
                _alert(f"🚨 KILL SWITCH: Drawdown {dd*100:.1f}% hit limit {config.drawdown_kill_switch_pct*100:.1f}%")
                router.cancel_all_orders()
                summary["kill_switch"] = True

            elif nav > 0 and dpnl / nav < -config.daily_loss_limit_pct:
                if r:
                    r.set("risk:daily_trading_halted", "1")
                log.critical("DAILY LOSS HALT: %.2f%%", dpnl / nav * 100)
                _alert(f"🚨 DAILY LOSS LIMIT: {dpnl/nav*100:.2f}% < -{config.daily_loss_limit_pct*100:.1f}%")
                summary["kill_switch"] = True
        except Exception as exc:
            log.debug("Kill switch check error: %s", exc)

    except Exception as exc:
        log.error("PnL mark-to-market failed: %s", exc)

    # ── 6. Publish state ──────────────────────────────────────────────────────
    if r:
        _publish_state(r, summary)

    elapsed = time.perf_counter() - t0
    log.info(
        "Tick done in %.2fs | bars=%d signals=%d orders=%d/%d rejected | PnL=₹%.0f DD=%.2f%%",
        elapsed,
        summary["n_bars"],
        summary["n_signals"],
        summary["n_orders_submitted"],
        summary["n_orders_rejected"],
        summary["daily_pnl"],
        summary["drawdown"] * 100,
    )
    return summary


def _publish_state(r, summary: dict) -> None:
    try:
        payload = json.dumps({**summary, "ts": int(time.time())})
        r.set("live:portfolio_state", payload)
        r.publish("ws:portfolio", payload)
    except Exception as exc:
        log.debug("State publish error: %s", exc)


def _alert(msg: str) -> None:
    try:
        from backend.live_engine.telegram_alerts import TelegramAlerter
        TelegramAlerter().send_sync(msg)
    except Exception:
        pass
