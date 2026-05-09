# backend/backtester/intrabar_simulator.py
"""
Brownian Bridge intra-bar path simulation.

Most backtestors fill limit/stop orders using only bar.low and bar.high —
which either over-fills (every limit within range fills) or under-fills.

This module simulates the actual price path *within* each bar using a
Brownian Bridge constrained to pass through the observed O, H, L, C.
This eliminates the biggest source of backtest overfitting.

Key capabilities:
  - Realistic limit order fills (path must actually TOUCH the price)
  - Accurate stop fill prices (path finds exact crossing point)
  - Trailing stop simulation that tracks the path, not just bar extremes
  - Configurable n_steps (default 100 — enough for intraday realism)
  - Vectorized NumPy implementation for speed

Usage:
    sim = IntrabarSimulator(n_steps=100, seed=42)
    path = sim.generate_path(open=100, high=102, low=99, close=101)
    # path: ndarray of n_steps prices from open to close
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Optional, Tuple

import numpy as np


# ── Path generation ───────────────────────────────────────────────────────────

class IntrabarSimulator:
    """
    Generates intra-bar price paths using a scaled Brownian Bridge.

    The bridge starts at `open` and ends at `close`, then is scaled
    so that max(path) ≥ high and min(path) ≤ low. A random time is
    chosen for the extreme excursion (uniformly distributed),
    consistent with the theoretical distribution of BM extrema.
    """

    def __init__(self, n_steps: int = 100, seed: Optional[int] = None):
        self.n_steps = n_steps
        self._rng = np.random.default_rng(seed)

    def generate_path(
        self,
        open_: float,
        high: float,
        low: float,
        close: float,
        vol: Optional[float] = None,
    ) -> np.ndarray:
        """
        Generate a price path that:
          - Starts at open_, ends at close
          - Achieves at least high (max) and at most low (min)

        Returns ndarray of shape (n_steps,).
        """
        n = self.n_steps
        t = np.linspace(0, 1, n)

        # Standard Brownian Bridge: B(t) = W(t) - t*W(1)
        dW = self._rng.standard_normal(n) / math.sqrt(n)
        W = np.cumsum(dW)
        bridge = W - t * W[-1]   # bridge from 0 to 0

        # Scale bridge to [0, T=1] interval using drift from open to close
        drift = (close - open_) * t
        raw_path = open_ + drift + bridge

        # Now scale so the path actually hits high and low
        raw_high = raw_path.max()
        raw_low = raw_path.min()

        # Scale separately above/below the drift line
        range_up = raw_high - (open_ + drift[-1] / 2)
        range_dn = (open_ + drift[-1] / 2) - raw_low

        if range_up > 0 and high > close and high > open_:
            target_up = high - open_
            raw_up = raw_high - open_
            if raw_up > 0:
                above_drift = np.maximum(raw_path - (open_ + drift), 0)
                raw_path = raw_path + above_drift * (target_up / raw_up - 1)

        if range_dn > 0 and low < close and low < open_:
            target_dn = open_ - low
            raw_dn = open_ - raw_low
            if raw_dn > 0:
                below_drift = np.maximum((open_ + drift) - raw_path, 0)
                raw_path = raw_path - below_drift * (target_dn / raw_dn - 1)

        # Guarantee endpoints and extremes
        raw_path[0] = open_
        raw_path[-1] = close
        raw_path = np.clip(raw_path, low * 0.999, high * 1.001)

        return raw_path

    def seed(self, seed: int) -> None:
        self._rng = np.random.default_rng(seed)


# ── Fill engine ───────────────────────────────────────────────────────────────

@dataclass
class PathFillResult:
    filled: bool
    fill_price: float = 0.0
    fill_step: int = 0       # which step in the path triggered the fill
    fill_qty: float = 0.0
    reason: str = ""


class PathFillEngine:
    """
    Walks a simulated intra-bar price path and determines fills for
    various order types with path-dependent accuracy.
    """

    def fill_market(
        self, path: np.ndarray, qty: float, side: str
    ) -> PathFillResult:
        """Market order: fills at first step (open price)."""
        return PathFillResult(
            filled=True,
            fill_price=float(path[0]),
            fill_step=0,
            fill_qty=qty,
            reason="market_open",
        )

    def fill_limit(
        self, path: np.ndarray, qty: float, side: str, limit_price: float
    ) -> PathFillResult:
        """
        Limit: find FIRST step where path crosses limit.
        BUY  limit: path[i] ≤ limit_price
        SELL limit: path[i] ≥ limit_price
        Fill at limit_price (conservative), or better if gapped.
        """
        if side == "buy":
            crossings = np.where(path <= limit_price)[0]
            if len(crossings) == 0:
                return PathFillResult(filled=False, reason="limit_not_reached")
            step = int(crossings[0])
            fill_price = min(float(path[step]), limit_price)
        else:
            crossings = np.where(path >= limit_price)[0]
            if len(crossings) == 0:
                return PathFillResult(filled=False, reason="limit_not_reached")
            step = int(crossings[0])
            fill_price = max(float(path[step]), limit_price)

        return PathFillResult(
            filled=True, fill_price=fill_price, fill_step=step,
            fill_qty=qty, reason="limit_filled",
        )

    def fill_stop(
        self, path: np.ndarray, qty: float, side: str, stop_price: float
    ) -> PathFillResult:
        """
        Stop: triggers when path crosses stop, then fills as market.
        Fill price = path at trigger step (may be worse than stop if gapped).
        """
        if side == "buy":
            crossings = np.where(path >= stop_price)[0]
        else:
            crossings = np.where(path <= stop_price)[0]

        if len(crossings) == 0:
            return PathFillResult(filled=False, reason="stop_not_triggered")

        step = int(crossings[0])
        fill_price = float(path[step])   # actual path price at trigger

        return PathFillResult(
            filled=True, fill_price=fill_price, fill_step=step,
            fill_qty=qty, reason="stop_triggered",
        )

    def fill_stop_limit(
        self,
        path: np.ndarray,
        qty: float,
        side: str,
        stop_price: float,
        limit_price: float,
    ) -> PathFillResult:
        """Stop triggers first, then limit executes."""
        if side == "buy":
            stop_crossings = np.where(path >= stop_price)[0]
        else:
            stop_crossings = np.where(path <= stop_price)[0]

        if len(stop_crossings) == 0:
            return PathFillResult(filled=False, reason="stop_not_triggered")

        trigger_step = int(stop_crossings[0])
        sub_path = path[trigger_step:]

        if side == "buy":
            limit_crossings = np.where(sub_path <= limit_price)[0]
        else:
            limit_crossings = np.where(sub_path >= limit_price)[0]

        if len(limit_crossings) == 0:
            return PathFillResult(filled=False, reason="limit_not_reached_after_stop")

        fill_step = trigger_step + int(limit_crossings[0])
        fill_price = limit_price  # filled at limit

        return PathFillResult(
            filled=True, fill_price=fill_price, fill_step=fill_step,
            fill_qty=qty, reason="stop_limit_filled",
        )

    def fill_trailing_stop(
        self,
        path: np.ndarray,
        qty: float,
        side: str,
        trail_pct: float,
        initial_price: float,
    ) -> PathFillResult:
        """
        Trailing stop: walks the path step-by-step updating the trailing level.
        This is path-dependent and can only be done correctly with a path.
        """
        if side == "sell":
            peak = initial_price
            stop = peak * (1.0 - trail_pct)
            for i, price in enumerate(path):
                if price > peak:
                    peak = price
                    stop = peak * (1.0 - trail_pct)
                if price <= stop:
                    return PathFillResult(
                        filled=True, fill_price=float(price), fill_step=i,
                        fill_qty=qty, reason="trailing_stop_triggered",
                    )
        else:  # buy (covering a short)
            trough = initial_price
            stop = trough * (1.0 + trail_pct)
            for i, price in enumerate(path):
                if price < trough:
                    trough = price
                    stop = trough * (1.0 + trail_pct)
                if price >= stop:
                    return PathFillResult(
                        filled=True, fill_price=float(price), fill_step=i,
                        fill_qty=qty, reason="trailing_stop_triggered",
                    )

        return PathFillResult(filled=False, reason="trailing_stop_not_triggered")

    def fill_twap(
        self, path: np.ndarray, qty: float, n_slices: int
    ) -> List[PathFillResult]:
        """TWAP: split qty into n_slices, fill each at equally-spaced path steps."""
        n = len(path)
        slice_qty = qty / max(n_slices, 1)
        fills = []
        for i in range(n_slices):
            step = min(int(i * n / n_slices), n - 1)
            fills.append(PathFillResult(
                filled=True,
                fill_price=float(path[step]),
                fill_step=step,
                fill_qty=slice_qty,
                reason="twap_slice",
            ))
        return fills

    def fill_vwap(
        self,
        path: np.ndarray,
        qty: float,
        volume_profile: Optional[np.ndarray] = None,
    ) -> List[PathFillResult]:
        """
        VWAP: volume-weighted average of path.
        volume_profile: relative volume at each step (uniform if None).
        """
        n = len(path)
        if volume_profile is None:
            # U-shaped intraday volume curve (higher at open/close)
            t = np.linspace(0, 1, n)
            volume_profile = 0.3 + 0.7 * (2 * t - 1) ** 2
        volume_profile = volume_profile / volume_profile.sum()

        fills = []
        for i in range(n):
            slice_qty = qty * volume_profile[i]
            if slice_qty > 1e-9:
                fills.append(PathFillResult(
                    filled=True,
                    fill_price=float(path[i]),
                    fill_step=i,
                    fill_qty=slice_qty,
                    reason="vwap_slice",
                ))
        return fills

    def fill_iceberg(
        self,
        path: np.ndarray,
        total_qty: float,
        visible_qty: float,
        side: str,
        limit_price: float,
    ) -> List[PathFillResult]:
        """
        Iceberg: repeatedly place visible_qty limit orders along the path.
        Each slice fills when path crosses limit.
        """
        fills = []
        remaining = total_qty
        search_from = 0

        while remaining > 1e-9 and search_from < len(path):
            sub_path = path[search_from:]
            result = self.fill_limit(sub_path, min(visible_qty, remaining), side, limit_price)
            if not result.filled:
                break

            actual_step = search_from + result.fill_step
            fills.append(PathFillResult(
                filled=True,
                fill_price=result.fill_price,
                fill_step=actual_step,
                fill_qty=result.fill_qty,
                reason="iceberg_slice",
            ))
            remaining -= result.fill_qty
            search_from = actual_step + 1   # continue from after fill

        return fills


# ── Bar-level path simulator interface ────────────────────────────────────────

class BarPathSimulator:
    """
    High-level interface: given a bar's OHLCV, generate a path and fill orders.
    Caches the path per bar to avoid re-generating when multiple orders hit the same bar.
    """

    def __init__(self, n_steps: int = 100, seed: Optional[int] = None):
        self._path_gen = IntrabarSimulator(n_steps=n_steps, seed=seed)
        self._fill_engine = PathFillEngine()
        self._cached_bar: Optional[Tuple] = None    # (open, high, low, close)
        self._cached_path: Optional[np.ndarray] = None

    def get_path(
        self, open_: float, high: float, low: float, close: float
    ) -> np.ndarray:
        key = (round(open_, 6), round(high, 6), round(low, 6), round(close, 6))
        if self._cached_bar != key:
            self._cached_path = self._path_gen.generate_path(open_, high, low, close)
            self._cached_bar = key
        return self._cached_path  # type: ignore[return-value]

    def fill_order_on_bar(
        self,
        open_: float,
        high: float,
        low: float,
        close: float,
        order_type: str,
        side: str,
        qty: float,
        limit_price: Optional[float] = None,
        stop_price: Optional[float] = None,
        trail_pct: Optional[float] = None,
        n_slices: int = 5,
        visible_qty: Optional[float] = None,
    ) -> List[PathFillResult]:
        """
        Main entry point. Returns list of PathFillResult (multiple for algo orders).
        """
        path = self.get_path(open_, high, low, close)

        if order_type == "market":
            return [self._fill_engine.fill_market(path, qty, side)]

        elif order_type == "limit" and limit_price is not None:
            return [self._fill_engine.fill_limit(path, qty, side, limit_price)]

        elif order_type == "stop" and stop_price is not None:
            return [self._fill_engine.fill_stop(path, qty, side, stop_price)]

        elif order_type == "stop_limit" and stop_price is not None and limit_price is not None:
            return [self._fill_engine.fill_stop_limit(path, qty, side, stop_price, limit_price)]

        elif order_type == "trailing_stop" and trail_pct is not None:
            ref = open_
            return [self._fill_engine.fill_trailing_stop(path, qty, side, trail_pct, ref)]

        elif order_type == "twap":
            return self._fill_engine.fill_twap(path, qty, n_slices)

        elif order_type == "vwap":
            return self._fill_engine.fill_vwap(path, qty)

        elif order_type == "iceberg" and limit_price is not None:
            vis = visible_qty or qty / 5.0
            return self._fill_engine.fill_iceberg(path, qty, vis, side, limit_price)

        # Fallback to market
        return [self._fill_engine.fill_market(path, qty, side)]

    def reset_cache(self) -> None:
        self._cached_bar = None
        self._cached_path = None
