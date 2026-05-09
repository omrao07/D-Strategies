# backend/live/engine.py
"""
LiveEngine: orchestrates multiple StrategyRunners, the SignalAggregator,
RiskGates, and a scheduler for market-open/close events.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Dict, List, Optional

from backend.engine.strategy_base import Strategy
from .runner import StrategyRunner
from .signal_aggregator import SignalAggregator
from .risk_gates import RiskGates

log = logging.getLogger(__name__)


class LiveEngine:
    """
    Central orchestrator for live trading.

    Usage:
        engine = LiveEngine(capital=1_000_000)
        engine.add_strategy(MyStrategy(), stream="ticks.equities.us")
        engine.start()
        ...
        engine.stop()
    """

    def __init__(
        self,
        capital: float = 1_000_000.0,
        aggregator_mode: str = "vol",
        signal_age_ms: int = 30_000,
    ):
        self.capital = capital
        self.aggregator = SignalAggregator(mode=aggregator_mode, max_signal_age_ms=signal_age_ms)
        self.risk = RiskGates(capital=capital)
        self._runners: Dict[str, StrategyRunner] = {}
        self._lock = threading.Lock()
        self._monitor_thread: Optional[threading.Thread] = None
        self._running = False

    def add_strategy(
        self,
        strategy: Strategy,
        stream: str,
        start_id: str = "$",
    ) -> None:
        name = strategy.ctx.name
        runner = StrategyRunner(
            strategy=strategy,
            stream=stream,
            aggregator=self.aggregator,
            start_id=start_id,
            on_error=self._on_strategy_error,
        )
        with self._lock:
            if name in self._runners:
                log.warning("strategy %s already registered; replacing", name)
                self._runners[name].stop()
            self._runners[name] = runner

    def remove_strategy(self, name: str) -> None:
        with self._lock:
            runner = self._runners.pop(name, None)
        if runner:
            runner.stop()

    def start(self) -> None:
        self._running = True
        with self._lock:
            for runner in self._runners.values():
                if not runner.is_alive():
                    runner.start()
        self._monitor_thread = threading.Thread(
            target=self._monitor_loop, daemon=True, name="live-engine-monitor"
        )
        self._monitor_thread.start()
        log.info("LiveEngine started with %d strategies", len(self._runners))

    def stop(self) -> None:
        self._running = False
        with self._lock:
            for runner in self._runners.values():
                runner.stop()
        if self._monitor_thread:
            self._monitor_thread.join(timeout=5)
        log.info("LiveEngine stopped")

    def status(self) -> Dict:
        sig_summary = self.aggregator.summary()
        gate1_ok, g1 = self.risk.gate1_daily_loss()
        gate2_ok, g2 = self.risk.gate2_drawdown()
        return {
            "running": self._running,
            "n_strategies": len(self._runners),
            "signal": sig_summary,
            "risk": {
                "daily_pnl": self.risk._daily_pnl,
                "gate1_daily_loss": "ok" if gate1_ok else g1,
                "gate2_drawdown": "ok" if gate2_ok else g2,
            },
        }

    def _on_strategy_error(self, name: str, exc: Exception) -> None:
        log.error("strategy %s error: %s", name, exc)

    def _monitor_loop(self) -> None:
        """Periodically log engine health and check daily loss gate."""
        while self._running:
            time.sleep(60)
            ok, reason = self.risk.gate1_daily_loss()
            if not ok:
                log.critical("DAILY LOSS GATE TRIGGERED: %s — halting all strategies", reason)
                self.stop()
                break
            ok2, reason2 = self.risk.gate2_drawdown()
            if not ok2:
                log.critical("DRAWDOWN GATE TRIGGERED: %s — halting all strategies", reason2)
                self.stop()
                break
            log.info("LiveEngine heartbeat: %d strategies alive", len(self._runners))
