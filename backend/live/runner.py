# backend/live/runner.py
"""
StrategyRunner: wraps a Strategy instance, feeds it ticks from a Redis stream,
and pipes signals into SignalAggregator.
"""
from __future__ import annotations

import json
import logging
import threading
from typing import Callable, Optional

from backend.engine.strategy_base import Strategy

from .signal_aggregator import SignalAggregator

log = logging.getLogger(__name__)


class StrategyRunner(threading.Thread):
    """
    Runs a single Strategy in its own thread, consuming from a Redis stream.
    Calls aggregator.update() after every on_tick() that emits a signal.
    """

    def __init__(
        self,
        strategy: Strategy,
        stream: str,
        aggregator: Optional[SignalAggregator] = None,
        start_id: str = "$",
        block_ms: int = 1000,
        count: int = 200,
        on_error: Optional[Callable[[str, Exception], None]] = None,
    ):
        super().__init__(daemon=True, name=f"runner-{strategy.ctx.name}")
        self.strategy = strategy
        self.stream = stream
        self.aggregator = aggregator
        self.start_id = start_id
        self.block_ms = block_ms
        self.count = count
        self.on_error = on_error
        self._stop_event = threading.Event()

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        from backend.bus.streams import consume_stream
        self.strategy.on_start()
        try:
            for _, tick in consume_stream(
                self.stream,
                start_id=self.start_id,
                block_ms=self.block_ms,
                count=self.count,
            ):
                if self._stop_event.is_set():
                    break
                try:
                    if isinstance(tick, str):
                        tick = json.loads(tick)
                    self.strategy.on_tick(tick)
                except Exception as exc:
                    log.exception("strategy %s tick error", self.strategy.ctx.name)
                    if self.on_error:
                        self.on_error(self.strategy.ctx.name, exc)
        finally:
            try:
                self.strategy.on_stop()
            except Exception:
                pass
