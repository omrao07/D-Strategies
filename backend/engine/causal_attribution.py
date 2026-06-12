# backend/engine/causal_attribution.py
"""
Causal Impact Attribution Engine

Decomposes realized P&L changes into attributable causes:
  - Market move (beta)
  - Signal alpha (residual after market)
  - Execution quality (slippage vs. arrival price)
  - Risk decisions (position sizing, stops)

Each fill in STREAM_FILLS is annotated with attribution:
  attribution:{fill_id}   → JSON {market_pnl, alpha_pnl, slippage_pnl, total}

The engine consumes STREAM_FILLS continuously (or can be called per-fill)
and writes attribution data for the dashboard and autopsy system.

Usage:
  from backend.engine.causal_attribution import attribute_fill, run_attribution_loop
  attr = attribute_fill(fill_dict, spy_return_for_period=0.001)

Requirements:
  Redis key `last_price:SPY` (or configured benchmark) for market returns.
  Redis key `arrival_price:{symbol}` set at order submission time for slippage calc.
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Dict, Optional

from backend.bus.streams import STREAM_FILLS, consume_stream

log = logging.getLogger(__name__)

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
BENCHMARK_SYMBOL = os.getenv("ATTRIBUTION_BENCHMARK", "SPY")
ATTRIBUTION_TTL = int(os.getenv("ATTRIBUTION_TTL_SECONDS", str(7 * 86400)))


def _get_redis():
    import redis as _redis
    ssl = os.getenv("REDIS_SSL", "").lower() in ("1", "true", "yes")
    kwargs = dict(
        host=REDIS_HOST,
        port=REDIS_PORT,
        password=os.getenv("REDIS_PASSWORD") or None,
        decode_responses=True,
    )
    if ssl:
        kwargs["ssl"] = True
    return _redis.Redis(**kwargs)


def _parse_float(v, default: float = 0.0) -> float:
    try:
        return float(v) if v is not None else default
    except Exception:
        return default


def _get_benchmark_return(r) -> float:
    """Get 1-period return of the benchmark index."""
    try:
        raw = r.hget("last_price", BENCHMARK_SYMBOL)
        if not raw:
            return 0.0
        current = _parse_float(raw)
        raw_prev = r.hget("prev_price", BENCHMARK_SYMBOL)
        prev = _parse_float(raw_prev, current)
        if prev == 0:
            return 0.0
        return (current - prev) / prev
    except Exception:
        return 0.0


def _get_arrival_price(symbol: str, r) -> Optional[float]:
    """Arrival price is set at order submission time for slippage calculation."""
    try:
        raw = r.hget("arrival_price", symbol)
        return _parse_float(raw) if raw else None
    except Exception:
        return None


def attribute_fill(fill: Dict, r=None) -> Dict:
    """
    Decompose a fill's realized P&L into causal components.

    fill expected keys: fill_id, symbol, side, qty, price, realized_delta, strategy
    Returns: {market_pnl, alpha_pnl, slippage_pnl, total_pnl, fill_id}
    """
    if r is None:
        r = _get_redis()

    fill_id = str(fill.get("fill_id", ""))
    symbol = str(fill.get("symbol", ""))
    side = str(fill.get("side", "")).lower()
    qty = _parse_float(fill.get("qty"))
    exec_price = _parse_float(fill.get("price"))
    realized = _parse_float(fill.get("realized_delta"))

    # Market component: beta * market_return * position_notional
    mkt_return = _get_benchmark_return(r)
    position_notional = abs(qty * exec_price)
    direction = 1.0 if side == "buy" else -1.0
    market_pnl = direction * mkt_return * position_notional

    # Slippage component: (arrival_price - exec_price) * qty for buys
    arrival = _get_arrival_price(symbol, r)
    if arrival is not None and arrival > 0 and exec_price > 0:
        if side == "buy":
            slippage_pnl = (arrival - exec_price) * qty  # negative if paid more
        else:
            slippage_pnl = (exec_price - arrival) * qty  # negative if received less
    else:
        slippage_pnl = 0.0

    # Alpha: residual after stripping market and slippage
    alpha_pnl = realized - market_pnl - slippage_pnl

    attribution = {
        "fill_id": fill_id,
        "symbol": symbol,
        "strategy": fill.get("strategy", ""),
        "total_pnl": realized,
        "market_pnl": market_pnl,
        "alpha_pnl": alpha_pnl,
        "slippage_pnl": slippage_pnl,
        "ts_ms": fill.get("ts_ms", int(time.time() * 1000)),
    }

    # Persist
    try:
        if fill_id:
            r.set(f"attribution:{fill_id}", json.dumps(attribution), ex=ATTRIBUTION_TTL)
        # Accumulate strategy-level attribution
        strat = fill.get("strategy", "")
        if strat:
            r.hincrbyfloat(f"attribution:strategy:{strat}", "market_pnl", market_pnl)
            r.hincrbyfloat(f"attribution:strategy:{strat}", "alpha_pnl", alpha_pnl)
            r.hincrbyfloat(f"attribution:strategy:{strat}", "slippage_pnl", slippage_pnl)
            r.hincrbyfloat(f"attribution:strategy:{strat}", "total_pnl", realized)
    except Exception:
        log.exception("causal_attribution: failed to persist attribution for fill %s", fill_id)

    return attribution


def run_attribution_loop() -> None:
    """Consume STREAM_FILLS and attribute each fill."""
    r = _get_redis()
    log.info("Causal attribution engine started, consuming %s", STREAM_FILLS)
    for _, fill in consume_stream(STREAM_FILLS, start_id="$", block_ms=1000, count=100):
        try:
            if isinstance(fill, str):
                fill = json.loads(fill)
            attribute_fill(fill, r)
        except Exception:
            log.exception("causal_attribution: error processing fill %s", fill)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_attribution_loop()
