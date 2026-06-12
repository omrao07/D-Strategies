# backend/live_engine/engine_state.py
"""
Global singleton state for the live engine.

All long-lived objects (StrategyRunner, OrderRouter, PnLTracker,
MarketDataService, InstitutionalRiskEngine) are created ONCE at startup
and shared across every intraday tick, health check, and API call.

This is the "nervous system" of the organism — initialised by __main__.py,
referenced by every job that needs live state.

Usage:
    from backend.live_engine.engine_state import state
    state.runner.run_all_bars(bars)
    state.router.route(order)
    state.tracker.get_daily_pnl()
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Optional

log = logging.getLogger(__name__)


class EngineState:
    """
    Container for all live engine singletons.
    Thread-safe via a single init lock; all objects are read-only after init.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._initialized = False

        # ── Core components ───────────────────────────────────────────────────
        self.runner: Optional[Any] = None           # StrategyRunner
        self.router: Optional[Any] = None           # OrderRouter
        self.tracker: Optional[Any] = None          # PnLTracker
        self.market_svc: Optional[Any] = None       # MarketDataService
        self.risk_engine: Optional[Any] = None      # InstitutionalRiskEngine
        self.alerter: Optional[Any] = None          # TelegramAlerter
        self.redis: Optional[Any] = None            # redis.Redis connection

        # ── Runtime counters (for health / dashboard) ─────────────────────────
        self.ticks_processed: int = 0
        self.orders_submitted: int = 0
        self.orders_rejected: int = 0
        self.start_time: float = 0.0
        self.last_tick_ts: float = 0.0
        self.last_tick_pnl: float = 0.0

    # ── Initialisation ────────────────────────────────────────────────────────

    def initialize(self, force: bool = False) -> None:
        """
        Bootstrap all singletons.  Safe to call multiple times — only runs once
        unless force=True.  Called by __main__.py at process startup.
        """
        with self._lock:
            if self._initialized and not force:
                return
            log.info("EngineState.initialize() — bootstrapping all singletons")
            self.start_time = time.time()

            self._init_redis()
            self._init_alerter()
            self._init_risk_engine()
            self._init_tracker()
            self._init_market_svc()
            self._init_router()
            self._init_runner()

            self._initialized = True
            log.info("EngineState ready: %d strategies loaded", self.runner.strategy_count() if self.runner else 0)

    def is_ready(self) -> bool:
        return self._initialized

    # ── Private init helpers ──────────────────────────────────────────────────

    def _init_redis(self) -> None:
        try:
            import redis as _r

            from backend.live_engine.config import REDIS_HOST, REDIS_PASSWORD, REDIS_PORT
            self.redis = _r.Redis(
                host=REDIS_HOST,
                port=REDIS_PORT,
                password=REDIS_PASSWORD,
                decode_responses=True,
                socket_connect_timeout=5,
                socket_timeout=5,
                retry_on_timeout=True,
            )
            self.redis.ping()
            log.info("Redis connected: %s:%s", REDIS_HOST, REDIS_PORT)
        except Exception as exc:
            log.error("Redis connection FAILED: %s — running in memory-only mode", exc)
            self.redis = None

    def _init_alerter(self) -> None:
        try:
            from backend.live_engine.telegram_alerts import TelegramAlerter
            self.alerter = TelegramAlerter()
            log.info("TelegramAlerter initialized")
        except Exception as exc:
            log.warning("TelegramAlerter unavailable: %s", exc)

    def _init_risk_engine(self) -> None:
        try:
            from backend.risk.institutional_risk_engine import (
                InstitutionalRiskEngine,
                RiskConfig,
                get_risk_config_from_redis,
            )
            config = get_risk_config_from_redis(self.redis) if self.redis else RiskConfig()
            self.risk_engine = InstitutionalRiskEngine(config=config, redis_client=self.redis)
            log.info("InstitutionalRiskEngine initialized (VaR=%.0f%%, DD kill=%.0f%%)",
                     config.var_confidence * 100, config.drawdown_kill_switch_pct * 100)
        except Exception as exc:
            log.error("InstitutionalRiskEngine unavailable: %s", exc)

    def _init_tracker(self) -> None:
        try:
            from backend.live_engine.pnl_tracker import PnLTracker
            self.tracker = PnLTracker()
            log.info("PnLTracker initialized. Equity=₹%.0f", self.tracker.get_total_equity())
        except Exception as exc:
            log.error("PnLTracker unavailable: %s", exc)

    def _init_market_svc(self) -> None:
        try:
            from backend.live_engine.market_data_service import MarketDataService
            self.market_svc = MarketDataService()
            log.info("MarketDataService initialized")
        except Exception as exc:
            log.error("MarketDataService unavailable: %s", exc)

    def _init_router(self) -> None:
        try:
            from backend.live_engine.order_router import OrderRouter
            self.router = OrderRouter(pnl_tracker=self.tracker, alert_on_fill=True)
            log.info("OrderRouter initialized")
        except Exception as exc:
            log.error("OrderRouter unavailable: %s", exc)

    def _init_runner(self) -> None:
        try:
            from backend.live_engine.strategy_runner import StrategyRunner
            self.runner = StrategyRunner(max_workers=8)
            n = self.runner.load_strategies()
            log.info("StrategyRunner initialized: %d strategies loaded", n)
        except Exception as exc:
            log.error("StrategyRunner unavailable: %s", exc)

    # ── Live state helpers ────────────────────────────────────────────────────

    def uptime_s(self) -> float:
        return time.time() - self.start_time if self.start_time else 0.0

    def is_halted(self) -> bool:
        """True if kill switch or daily trading halt is active."""
        try:
            if self.redis:
                return bool(self.redis.get("risk:kill_switch_active")) or \
                       bool(self.redis.get("risk:daily_trading_halted"))
        except Exception:
            pass
        return False

    def publish_portfolio_state(self, summary: dict) -> None:
        """Push portfolio snapshot to Redis and WebSocket channel."""
        import json
        try:
            if self.redis:
                payload = json.dumps({**summary, "ts": int(time.time()), "uptime_s": self.uptime_s()})
                self.redis.set("live:portfolio_state", payload, ex=120)   # 2 min TTL
                self.redis.publish("ws:portfolio", payload)
        except Exception as exc:
            log.debug("publish_portfolio_state error: %s", exc)

    def record_tick_stats(self, n_orders: int, n_rejected: int, pnl: float) -> None:
        self.ticks_processed += 1
        self.orders_submitted += n_orders
        self.orders_rejected += n_rejected
        self.last_tick_ts = time.time()
        self.last_tick_pnl = pnl
        try:
            if self.redis:
                self.redis.hmset("live:engine_stats", {
                    "ticks": self.ticks_processed,
                    "orders_submitted": self.orders_submitted,
                    "orders_rejected": self.orders_rejected,
                    "last_tick_ts": int(self.last_tick_ts),
                    "uptime_s": int(self.uptime_s()),
                })
        except Exception:
            pass

    def alert(self, msg: str) -> None:
        if self.alerter:
            try:
                self.alerter.send_sync(msg)
            except Exception:
                pass


# ── Module-level singleton ────────────────────────────────────────────────────

state = EngineState()
