"""
StrategyRunner — loads all registered strategies and dispatches market bars.

Integration points:
  - ``backend.execution_plus.registry.HUB.strategies`` — the global strategy registry
  - ``backend.execution_plus.registry.auto_register_strategies()`` — scans
    ``backend.strategies`` package and populates HUB
  - ``backend.engine.strategy_base.Strategy._collector`` hook — zero-Redis
    in-memory order capture (same mechanism as the backtester)

The runner is deliberately stateless beyond the loaded strategy instances.
All state lives in the strategies themselves and in Redis (via their
``emit_signal`` / ``emit_vol`` / ``emit_drawdown`` calls).
"""
from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional dependencies
# ---------------------------------------------------------------------------
try:
    import redis as _redis_mod
    from backend.live_engine.config import REDIS_HOST, REDIS_PORT, REDIS_PASSWORD
    _redis_client = _redis_mod.Redis(
        host=REDIS_HOST, port=REDIS_PORT, password=REDIS_PASSWORD, decode_responses=True
    )
    _HAS_REDIS = True
except Exception:
    _redis_client = None  # type: ignore[assignment]
    _HAS_REDIS = False

try:
    from backend.execution_plus.registry import HUB, auto_register_strategies
    _HAS_REGISTRY = True
except Exception as _e:
    log.warning("execution_plus registry unavailable: %s", _e)
    HUB = None  # type: ignore[assignment]
    auto_register_strategies = None  # type: ignore[assignment]
    _HAS_REGISTRY = False

try:
    from backend.engine.strategy_base import Strategy
    _HAS_STRATEGY_BASE = True
except Exception as _e:
    log.warning("strategy_base unavailable: %s", _e)
    Strategy = None  # type: ignore[assignment]
    _HAS_STRATEGY_BASE = False


# ---------------------------------------------------------------------------
# OrderRequest dataclass (also used by OrderRouter)
# ---------------------------------------------------------------------------

@dataclass
class OrderRequest:
    """A single order emitted by a strategy during bar processing."""

    strategy: str
    symbol: str
    side: str                          # 'buy' | 'sell'
    qty: float
    order_type: str = "market"         # market | limit | stop | stop-limit
    limit_price: Optional[float] = None
    stop_price: Optional[float] = None
    ts_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    extra: Dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# In-memory collector — intercepts Strategy.order() / emit_* calls
# ---------------------------------------------------------------------------

class _Collector:
    """
    Attached to a strategy instance as ``strategy._collector`` to capture
    orders and signals without touching Redis or the broker.
    This mirrors the backtester's collector hook pattern exactly.
    """

    def __init__(self, strategy_name: str) -> None:
        self.strategy_name = strategy_name
        self.orders: List[OrderRequest] = []
        self.signals: List[float] = []
        self.vols: List[float] = []
        self.drawdowns: List[float] = []

    def collect(self, kind: str, *args: Any) -> None:
        if kind == "order":
            # args: symbol, side, qty, order_type, limit_price
            symbol, side, qty, order_type, limit_price = (
                args[0], args[1], args[2],
                args[3] if len(args) > 3 else "market",
                args[4] if len(args) > 4 else None,
            )
            self.orders.append(
                OrderRequest(
                    strategy=self.strategy_name,
                    symbol=str(symbol).upper(),
                    side=str(side).lower(),
                    qty=float(qty),
                    order_type=str(order_type),
                    limit_price=float(limit_price) if limit_price is not None else None,
                )
            )
        elif kind == "signal":
            self.signals.append(float(args[0]))
        elif kind == "vol":
            self.vols.append(float(args[0]))
        elif kind == "drawdown":
            self.drawdowns.append(float(args[0]))

    def last_signal(self) -> Optional[float]:
        return self.signals[-1] if self.signals else None


# ---------------------------------------------------------------------------
# StrategyRunner
# ---------------------------------------------------------------------------

class StrategyRunner:
    """
    Loads all registered strategies, dispatches bars, and collects orders.

    Thread safety: ``run_bar`` and ``run_all_bars`` are safe to call from
    a single scheduler thread.  The ThreadPoolExecutor used inside
    ``run_all_bars`` only handles the per-symbol fan-out.
    """

    def __init__(self, max_workers: int = 8) -> None:
        self._strategies: Dict[str, Any] = {}  # name -> Strategy instance
        self._max_workers = max_workers
        self._disabled: set = set()

    # ------------------------------------------------------------------
    # Loading
    # ------------------------------------------------------------------

    def load_strategies(self) -> int:
        """
        Import and instantiate all strategies from the registry.

        Returns the number of strategies loaded.
        """
        if not _HAS_REGISTRY or HUB is None:
            log.warning("load_strategies: registry not available — no strategies loaded")
            return 0

        # Auto-register any unregistered strategies from the strategies package
        try:
            if auto_register_strategies is not None:
                auto_register_strategies()
        except Exception as exc:
            log.warning("auto_register_strategies failed: %s", exc)

        all_registered = HUB.strategies.all()
        loaded = 0

        for name, cls_or_instance in all_registered.items():
            if name in self._strategies:
                continue

            # Check if it's disabled in Redis
            if self._is_disabled_in_redis(name):
                self._disabled.add(name)
                continue

            try:
                if isinstance(cls_or_instance, type):
                    instance = cls_or_instance(name=name)
                else:
                    instance = cls_or_instance

                # Initialise lifecycle
                if hasattr(instance, "on_start"):
                    instance.on_start()

                self._strategies[name] = instance
                loaded += 1
            except Exception as exc:
                log.error("Failed to load strategy %s: %s", name, exc)

        log.info("Loaded %d strategies (%d disabled)", loaded, len(self._disabled))
        return loaded

    # ------------------------------------------------------------------
    # Bar dispatch
    # ------------------------------------------------------------------

    def run_bar(self, bar_dict: Dict[str, Any], symbol: str) -> List[OrderRequest]:
        """
        Dispatch one bar to every loaded strategy and collect resulting orders.

        *bar_dict* should contain at minimum: open, high, low, close, volume.
        ``symbol`` is normalised to uppercase and injected into the bar.
        """
        symbol = symbol.upper()
        bar_dict = {**bar_dict, "symbol": symbol}
        orders: List[OrderRequest] = []

        for name, strategy in list(self._strategies.items()):
            if name in self._disabled:
                continue
            collector = _Collector(name)
            strategy._collector = collector
            try:
                strategy.on_tick(bar_dict)
            except Exception as exc:
                log.error("Strategy %s raised on bar for %s: %s", name, symbol, exc)
            finally:
                strategy._collector = None

            orders.extend(collector.orders)

        return orders

    def run_all_bars(self, bars: Dict[str, Dict[str, Any]]) -> List[OrderRequest]:
        """
        Dispatch bars for multiple symbols in parallel using a ThreadPoolExecutor.

        Returns a flat list of all ``OrderRequest`` objects from every strategy
        across every symbol.
        """
        all_orders: List[OrderRequest] = []

        with ThreadPoolExecutor(max_workers=self._max_workers) as executor:
            futures = {
                executor.submit(self.run_bar, bar, symbol): symbol
                for symbol, bar in bars.items()
            }
            for future in as_completed(futures):
                symbol = futures[future]
                try:
                    result = future.result()
                    all_orders.extend(result)
                except Exception as exc:
                    log.error("run_all_bars: error for symbol %s: %s", symbol, exc)

        return all_orders

    # ------------------------------------------------------------------
    # Signal aggregation
    # ------------------------------------------------------------------

    def get_aggregated_signals(self) -> Dict[str, float]:
        """
        Read ``strategy:signal`` Redis hash and return a weighted average
        signal per symbol.

        Returns ``{symbol: weighted_signal}`` where signal is in ``[-1, +1]``.
        This is a best-effort read; returns empty dict if Redis is unavailable.
        """
        if not _HAS_REDIS or _redis_client is None:
            return {}

        try:
            import json
            raw = _redis_client.hgetall("strategy:signal") or {}
            # raw: {strategy_name: json({"score": x, "symbol": y})}
            symbol_scores: Dict[str, List[float]] = {}
            for name, val in raw.items():
                try:
                    data = json.loads(val) if isinstance(val, str) else val
                    score = float(data.get("score", 0.0))
                    sym = str(data.get("symbol", "")).upper()
                    if sym:
                        symbol_scores.setdefault(sym, []).append(score)
                except Exception:
                    pass

            return {
                sym: sum(scores) / len(scores)
                for sym, scores in symbol_scores.items()
                if scores
            }
        except Exception as exc:
            log.warning("get_aggregated_signals failed: %s", exc)
            return {}

    # ------------------------------------------------------------------
    # Metadata / control
    # ------------------------------------------------------------------

    def strategy_count(self) -> int:
        """Return the number of currently loaded (enabled) strategies."""
        return len(self._strategies)

    def enable_strategy(self, name: str) -> None:
        """Enable a strategy by name (removes from disabled set, sets Redis flag)."""
        self._disabled.discard(name)
        self._set_redis_enabled(name, True)
        log.info("Strategy %s enabled", name)

    def disable_strategy(self, name: str) -> None:
        """Disable a strategy by name (adds to disabled set, sets Redis flag)."""
        self._disabled.add(name)
        self._set_redis_enabled(name, False)
        log.info("Strategy %s disabled", name)

    def list_strategies(self) -> Dict[str, str]:
        """Return mapping of strategy_name -> 'enabled'/'disabled'."""
        out: Dict[str, str] = {}
        for name in self._strategies:
            out[name] = "disabled" if name in self._disabled else "enabled"
        return out

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _is_disabled_in_redis(self, name: str) -> bool:
        if not _HAS_REDIS or _redis_client is None:
            return False
        try:
            val = _redis_client.hget("strategy:enabled", name)
            if val is None:
                return False
            return str(val).lower() in ("false", "0", "no")
        except Exception:
            return False

    def _set_redis_enabled(self, name: str, enabled: bool) -> None:
        if not _HAS_REDIS or _redis_client is None:
            return
        try:
            _redis_client.hset("strategy:enabled", name, "true" if enabled else "false")
        except Exception as exc:
            log.warning("Failed to set strategy:enabled for %s: %s", name, exc)
