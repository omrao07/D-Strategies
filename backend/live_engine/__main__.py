# backend/live_engine/__main__.py
"""
Live Engine entry point.

Start with:
    python -m backend.live_engine

What this does (in order):
  1.  Configure structured logging
  2.  Initialise EngineState (Redis, risk engine, PnL tracker, strategies, router)
  3.  Register SIGTERM / SIGINT for graceful shutdown
  4.  ARM all risk limits in Redis
  5.  Start the APScheduler (pre-market, intraday loop, health, post-market, nightly …)
  6.  Emit startup Telegram alert
  7.  Block in heartbeat loop — logs pulse every 60 s
  8.  On shutdown: drain open orders, save state, send Telegram
"""
from __future__ import annotations

import logging
import os
import signal
import sys
import threading
import time
from pathlib import Path

# ── Logging ───────────────────────────────────────────────────────────────────
_LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
_LOG_FILE   = os.getenv("LOG_FILE", "logs/live_engine.log")

Path(_LOG_FILE).parent.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=getattr(logging, _LOG_LEVEL, logging.INFO),
    format="%(asctime)s.%(msecs)03d | %(levelname)-7s | %(name)-30s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(_LOG_FILE, encoding="utf-8"),
    ],
)
log = logging.getLogger("live_engine.main")

# ── Banner ────────────────────────────────────────────────────────────────────
_BANNER = r"""
╔══════════════════════════════════════════════════════════════╗
║          D-STRATEGIES LIVE ENGINE  —  INSTITUTIONAL          ║
║        337 Strategies  ·  NSE/BSE  ·  Real-time Risk         ║
╚══════════════════════════════════════════════════════════════╝
"""


def main() -> None:
    print(_BANNER)
    log.info("Live engine starting up...")

    # ── 1. Load engine state (all singletons) ────────────────────────────────
    from backend.live_engine.engine_state import state
    try:
        state.initialize()
    except Exception as exc:
        log.critical("EngineState.initialize() FAILED: %s — aborting", exc)
        sys.exit(1)

    n_strategies = state.runner.strategy_count() if state.runner else 0
    log.info("Engine state ready. Strategies loaded: %d", n_strategies)

    # ── 2. ARM risk limits in Redis ───────────────────────────────────────────
    _arm_risk_limits(state)

    # ── 3. Graceful shutdown handler ─────────────────────────────────────────
    _shutdown_event = threading.Event()

    def _on_signal(signum, frame):
        log.warning("Signal %s received — initiating graceful shutdown", signum)
        _shutdown_event.set()

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT,  _on_signal)

    # ── 4. Start scheduler ────────────────────────────────────────────────────
    from backend.live_engine.scheduler import LiveEngineScheduler
    scheduler = LiveEngineScheduler()
    try:
        scheduler.start()
        log.info("Scheduler started. Jobs: %d", len(scheduler.status().get("jobs", [])))
    except Exception as exc:
        log.critical("Scheduler start FAILED: %s — aborting", exc)
        sys.exit(1)

    # ── 5. Startup Telegram alert ─────────────────────────────────────────────
    state.alert(
        f"🚀 D-Strategies Live Engine STARTED\n"
        f"Strategies: {n_strategies}\n"
        f"Capital: ₹{state.tracker.get_total_equity():,.0f}\n" if state.tracker else
        f"🚀 D-Strategies Live Engine STARTED\nStrategies: {n_strategies}\n"
    )

    # ── 6. Heartbeat loop ─────────────────────────────────────────────────────
    log.info("Entering heartbeat loop. Ctrl+C or SIGTERM to stop.")
    _pulse_interval = int(os.getenv("PULSE_INTERVAL_S", "60"))
    _pulse_count = 0

    while not _shutdown_event.is_set():
        _shutdown_event.wait(timeout=_pulse_interval)

        if _shutdown_event.is_set():
            break

        _pulse_count += 1
        try:
            _log_pulse(state, _pulse_count)
        except Exception as exc:
            log.warning("Pulse log error: %s", exc)

    # ── 7. Graceful shutdown ──────────────────────────────────────────────────
    log.warning("Shutdown initiated...")

    try:
        scheduler.stop()
        log.info("Scheduler stopped")
    except Exception as exc:
        log.error("Scheduler stop error: %s", exc)

    # Cancel all open orders on shutdown
    if state.router:
        try:
            n_cancelled = state.router.cancel_all_orders()
            log.info("Cancelled %d open orders on shutdown", n_cancelled)
        except Exception as exc:
            log.error("cancel_all_orders on shutdown: %s", exc)

    # Final PnL snapshot
    if state.tracker:
        try:
            final_pnl = state.tracker.get_daily_pnl()
            final_eq  = state.tracker.get_total_equity()
            log.info("Final PnL=₹%.0f  Equity=₹%.0f", final_pnl, final_eq)
        except Exception:
            pass

    state.alert("⛔ D-Strategies Live Engine STOPPED (graceful shutdown)")
    log.info("Live engine stopped cleanly. Goodbye.")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _arm_risk_limits(state) -> None:
    """Write risk thresholds from RiskConfig into Redis so all jobs read them."""
    try:
        if not state.redis:
            return
        from backend.live_engine.config import (
            CAPITAL_BASE, MAX_DAILY_LOSS_PCT, MAX_DRAWDOWN_PCT
        )
        daily_loss_abs = CAPITAL_BASE * MAX_DAILY_LOSS_PCT / 100
        state.redis.set("risk:daily_loss_limit",     str(daily_loss_abs))
        state.redis.set("risk:drawdown_kill_pct",    str(MAX_DRAWDOWN_PCT / 100))
        state.redis.set("portfolio:capital_base",    str(CAPITAL_BASE))

        # Guard: preserve kill-switch across restarts unless operator explicitly clears it
        ks_active  = state.redis.get("risk:kill_switch_active")
        halt_active = state.redis.get("risk:daily_trading_halted")
        if ks_active in ("1", "true") or halt_active in ("1", "true"):
            force = os.getenv("FORCE_CLEAR_KILL_SWITCH", "0").lower() in ("1", "true", "yes")
            if not force:
                log.critical(
                    "Kill switch was active from previous session — engine will NOT start. "
                    "Set FORCE_CLEAR_KILL_SWITCH=1 to resume trading after human review."
                )
                state.alert(
                    "🚨 ENGINE START BLOCKED: kill switch was active from previous session. "
                    "Set FORCE_CLEAR_KILL_SWITCH=1 to override."
                )
                sys.exit(1)
            log.warning("FORCE_CLEAR_KILL_SWITCH=1 — clearing kill switch from previous session")
        state.redis.delete("risk:kill_switch_active")
        state.redis.delete("risk:daily_trading_halted")

        # Persist risk config from InstitutionalRiskEngine into Redis
        if state.risk_engine:
            from backend.risk.institutional_risk_engine import save_risk_config_to_redis
            save_risk_config_to_redis(state.risk_engine.config, state.redis)

        log.info("Risk limits armed: daily_loss=₹%.0f, drawdown=%.0f%%",
                 daily_loss_abs, MAX_DRAWDOWN_PCT)
    except Exception as exc:
        log.error("_arm_risk_limits failed: %s", exc)


def _log_pulse(state, pulse: int) -> None:
    """Log a compact heartbeat line every pulse interval."""
    from backend.live_engine.config import is_market_open
    market_status = "OPEN" if is_market_open() else "CLOSED"

    pnl = eq = dd = 0.0
    if state.tracker:
        pnl = state.tracker.get_daily_pnl()
        eq  = state.tracker.get_total_equity()
        dd  = state.tracker.get_drawdown()

    log.info(
        "♥ PULSE #%d | market=%s | uptime=%.0fm | ticks=%d | "
        "orders=%d/%d | PnL=₹%.0f | eq=₹%.0f | dd=%.2f%%",
        pulse,
        market_status,
        state.uptime_s() / 60,
        state.ticks_processed,
        state.orders_submitted,
        state.orders_submitted + state.orders_rejected,
        pnl,
        eq,
        dd * 100,
    )


if __name__ == "__main__":
    main()
