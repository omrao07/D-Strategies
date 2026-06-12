# backend/data/streaming/bar_aggregator.py
"""
Bar aggregator: accumulates tick/trade events into OHLCV bars.
Publishes completed bars to Redis Stream.
Supports 1m, 5m, 15m, 1h, 1d bar frequencies.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Dict, Optional

from backend.bus.streams import publish_stream

logger = logging.getLogger("data.streaming.bar_aggregator")

COMPLETED_BARS_STREAM = os.getenv("BARS_STREAM", "bars.completed")


@dataclass
class Bar:
    symbol: str
    freq_s: int        # bar frequency in seconds
    ts_open: float     # epoch seconds of bar open
    open: float = 0.0
    high: float = 0.0
    low: float = float("inf")
    close: float = 0.0
    volume: float = 0.0
    n_trades: int = 0

    def update(self, price: float, size: float = 0.0) -> None:
        if self.n_trades == 0:
            self.open = price
            self.high = price
            self.low = price
        else:
            self.high = max(self.high, price)
            self.low = min(self.low, price)
        self.close = price
        self.volume += size
        self.n_trades += 1

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "freq_s": self.freq_s,
            "ts": self.ts_open,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "n_trades": self.n_trades,
        }

    def is_empty(self) -> bool:
        return self.n_trades == 0


class BarAggregator:
    """
    Accepts individual tick/trade events and emits completed OHLCV bars.
    One instance per (symbol, frequency) pair.
    """

    FREQ_PRESETS = {
        "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
        "1h": 3600, "4h": 14400, "1d": 86400,
    }

    def __init__(self, freq: str = "1m", publish: bool = True):
        self.freq_s = self.FREQ_PRESETS.get(freq, 60)
        self._bars: Dict[str, Bar] = {}
        self._publish = publish

    def _bar_ts(self, ts: float) -> float:
        """Floor timestamp to bar boundary."""
        return (ts // self.freq_s) * self.freq_s

    def _get_or_create(self, symbol: str, ts: float) -> Bar:
        bar_ts = self._bar_ts(ts)
        key = f"{symbol}:{bar_ts}"
        if key not in self._bars:
            self._bars[key] = Bar(symbol=symbol, freq_s=self.freq_s, ts_open=bar_ts)
        return self._bars[key]

    def on_tick(
        self,
        symbol: str,
        price: float,
        size: float = 0.0,
        ts: Optional[float] = None,
    ) -> Optional[dict]:
        """
        Process one tick. Returns a completed bar dict if the bar just closed,
        else None.
        """
        now = ts or time.time()
        current_bar_ts = self._bar_ts(now)

        # Check if we have an older open bar that just closed
        completed = None
        for k in list(self._bars.keys()):
            k_sym, k_ts_str = k.rsplit(":", 1)
            if k_sym == symbol and float(k_ts_str) < current_bar_ts:
                old_bar = self._bars.pop(k)
                if not old_bar.is_empty():
                    completed = old_bar.to_dict()
                    logger.debug(f"[bar] completed {k_sym} {old_bar.ts_open} close={old_bar.close}")
                    if self._publish:
                        try:
                            publish_stream(COMPLETED_BARS_STREAM, completed)
                        except Exception as e:
                            logger.warning(f"[bar] publish failed: {e}")

        bar = self._get_or_create(symbol, now)
        bar.update(price, size)
        return completed

    def flush(self) -> list:
        """Force-close all open bars (e.g. on market close). Returns list of bar dicts."""
        out = []
        for k, bar in list(self._bars.items()):
            if not bar.is_empty():
                d = bar.to_dict()
                out.append(d)
                if self._publish:
                    try:
                        publish_stream(COMPLETED_BARS_STREAM, d)
                    except Exception as e:
                        logger.warning(f"[bar] flush publish failed: {e}")
        self._bars.clear()
        return out
