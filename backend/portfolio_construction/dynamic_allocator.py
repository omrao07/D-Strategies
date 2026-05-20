# backend/portfolio_construction/dynamic_allocator.py
"""
Dynamic allocator: weekly weight shifts based on rolling Sharpe.
Reads strategy PnL from Redis and rebalances capital allocations.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Dict, List, Optional

import redis

logger = logging.getLogger("portfolio.dynamic_allocator")

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
ALLOC_KEY = "allocator:weights"
PNL_HISTORY_DAYS = 30
MIN_WEIGHT = 0.01
MAX_WEIGHT = 0.40

_r: Optional[redis.Redis] = None

def _get_r() -> redis.Redis:
    global _r
    if _r is None:
        _r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT,
                         password=os.getenv("REDIS_PASSWORD") or None,
                         decode_responses=True)
    return _r


def _get_strategy_returns(strategy: str, r) -> List[float]:
    """Read daily return history for a strategy from Redis."""
    raw = r.lrange(f"pnl:daily:{strategy}", 0, PNL_HISTORY_DAYS - 1)
    return [float(x) for x in raw] if raw else []


def rolling_sharpe(returns: List[float], rf: float = 0.0) -> float:
    if len(returns) < 5:
        return 0.0
    import math
    n = len(returns)
    mean = sum(returns) / n - rf / 252
    var = sum((r - mean) ** 2 for r in returns) / (n - 1)
    std = math.sqrt(var) if var > 0 else 1e-9
    return mean / std * (252 ** 0.5)


def compute_weights(strategies: List[str], r=None) -> Dict[str, float]:
    """
    Compute dynamic weights for each strategy based on rolling Sharpe.
    Sharpe < 0 gets minimum weight; positive Sharpe gets proportional share.
    """
    rc = r or _get_r()
    sharpes = {}
    for s in strategies:
        ret = _get_strategy_returns(s, rc)
        sharpes[s] = max(0.0, rolling_sharpe(ret))

    total = sum(sharpes.values())
    if total == 0:
        # Equal weight fallback
        eq = 1.0 / len(strategies) if strategies else 0.0
        return {s: eq for s in strategies}

    raw = {s: v / total for s, v in sharpes.items()}
    # Clamp to [MIN_WEIGHT, MAX_WEIGHT]
    clamped = {s: max(MIN_WEIGHT, min(MAX_WEIGHT, v)) for s, v in raw.items()}
    total_c = sum(clamped.values())
    return {s: round(v / total_c, 6) for s, v in clamped.items()}


def publish_weights(weights: Dict[str, float], r=None) -> None:
    rc = r or _get_r()
    rc.set(ALLOC_KEY, json.dumps(weights))
    logger.info(f"[dynamic_allocator] weights updated: {weights}")


def get_weights(r=None) -> Dict[str, float]:
    rc = r or _get_r()
    raw = rc.get(ALLOC_KEY)
    return json.loads(raw) if raw else {}


def get_strategy_notional(strategy: str, total_capital: float, r=None) -> float:
    weights = get_weights(r)
    w = weights.get(strategy, 0.0)
    return total_capital * w
