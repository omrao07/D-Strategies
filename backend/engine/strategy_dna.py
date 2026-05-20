# backend/engine/strategy_dna.py
"""
Strategy DNA Fingerprinting

Computes a behavioral characteristic vector ("DNA") for each strategy
from its recent fill history. The vector captures:
  - avg_holding_period_ms   : mean time between entry and exit fills
  - win_rate                : fraction of realized P&L > 0 trades
  - avg_notional            : mean abs(qty * price)
  - avg_spread_capture      : avg realized P&L per unit notional (fill quality)
  - fill_freq_per_hour      : fills per hour (activity)
  - long_short_ratio        : fraction of buys vs sells

DNA vectors are stored in Redis as:
  strategy:dna:<strategy_id>  → JSON vector
  strategy:dna:index          → HSET {strategy_id → JSON vector}  (for bulk reads)

Usage:
  from backend.engine.strategy_dna import compute_and_store_dna, get_dna
  compute_and_store_dna("momentum_us", fills_list)
  dna = get_dna("momentum_us")
  similarity = cosine_similarity(dna, get_dna("momentum_eu"))

Run as a cron / scheduled job after market close.
"""
from __future__ import annotations

import json
import logging
import math
import os
from typing import Dict, List, Optional

log = logging.getLogger(__name__)

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))


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


def compute_dna(fills: List[Dict]) -> Dict[str, float]:
    """
    Compute DNA vector from a list of fill dicts.
    Each fill: {ts_ms, price, qty, side, realized_delta, strategy, symbol}
    Returns a dict of named float features.
    """
    if not fills:
        return _zero_dna()

    total = len(fills)
    buys = [f for f in fills if str(f.get("side", "")).lower() == "buy"]
    sells = [f for f in fills if str(f.get("side", "")).lower() == "sell"]

    # Win rate: fraction of sells with realized_delta > 0
    profitable = sum(1 for f in sells if float(f.get("realized_delta", 0) or 0) > 0)
    win_rate = profitable / len(sells) if sells else 0.0

    # Avg notional
    notionals = [abs(float(f.get("qty", 0) or 0) * float(f.get("price", 0) or 0)) for f in fills]
    avg_notional = sum(notionals) / total if total else 0.0

    # Avg spread capture (realized P&L per notional)
    realized_list = [float(f.get("realized_delta", 0) or 0) for f in sells]
    sell_notionals = [abs(float(f.get("qty", 0) or 0) * float(f.get("price", 0) or 0)) for f in sells]
    if sells and any(n > 0 for n in sell_notionals):
        avg_spread = sum(r / n for r, n in zip(realized_list, sell_notionals) if n > 0) / len(realized_list)
    else:
        avg_spread = 0.0

    # Fill frequency per hour
    ts_list = sorted([int(f.get("ts_ms", 0) or 0) for f in fills if f.get("ts_ms")])
    if len(ts_list) >= 2:
        span_hours = (ts_list[-1] - ts_list[0]) / 3_600_000
        fill_freq = total / span_hours if span_hours > 0 else 0.0
    else:
        fill_freq = 0.0

    # Avg holding period: pair buys with subsequent sells
    holding_ms: List[float] = []
    buy_stack: List[int] = []
    for f in sorted(fills, key=lambda x: int(x.get("ts_ms", 0) or 0)):
        side = str(f.get("side", "")).lower()
        ts = int(f.get("ts_ms", 0) or 0)
        if side == "buy":
            buy_stack.append(ts)
        elif side == "sell" and buy_stack:
            entry = buy_stack.pop(0)
            holding_ms.append(ts - entry)
    avg_holding = sum(holding_ms) / len(holding_ms) if holding_ms else 0.0

    long_short_ratio = len(buys) / total if total else 0.5

    return {
        "avg_holding_period_ms": avg_holding,
        "win_rate": win_rate,
        "avg_notional": avg_notional,
        "avg_spread_capture": avg_spread,
        "fill_freq_per_hour": fill_freq,
        "long_short_ratio": long_short_ratio,
    }


def _zero_dna() -> Dict[str, float]:
    return {
        "avg_holding_period_ms": 0.0,
        "win_rate": 0.0,
        "avg_notional": 0.0,
        "avg_spread_capture": 0.0,
        "fill_freq_per_hour": 0.0,
        "long_short_ratio": 0.5,
    }


def compute_and_store_dna(strategy: str, fills: List[Dict], r=None) -> Dict[str, float]:
    """Compute DNA and persist to Redis."""
    dna = compute_dna(fills)
    try:
        if r is None:
            r = _get_redis()
        payload = json.dumps({"strategy": strategy, **dna})
        r.set(f"strategy:dna:{strategy}", payload)
        r.hset("strategy:dna:index", strategy, payload)
    except Exception:
        log.exception("strategy_dna: failed to store DNA for %s", strategy)
    return dna


def get_dna(strategy: str, r=None) -> Optional[Dict[str, float]]:
    """Retrieve stored DNA vector for a strategy."""
    try:
        if r is None:
            r = _get_redis()
        raw = r.get(f"strategy:dna:{strategy}")
        if not raw:
            return None
        obj = json.loads(raw)
        return {k: float(v) for k, v in obj.items() if k != "strategy"}
    except Exception:
        log.exception("strategy_dna: failed to get DNA for %s", strategy)
        return None


def cosine_similarity(a: Dict[str, float], b: Dict[str, float]) -> float:
    """Cosine similarity between two DNA dicts (shared keys only)."""
    keys = set(a) & set(b)
    if not keys:
        return 0.0
    dot = sum(a[k] * b[k] for k in keys)
    mag_a = math.sqrt(sum(a[k] ** 2 for k in keys))
    mag_b = math.sqrt(sum(b[k] ** 2 for k in keys))
    if mag_a == 0 or mag_b == 0:
        return 0.0
    return dot / (mag_a * mag_b)


def all_dna_vectors(r=None) -> Dict[str, Dict[str, float]]:
    """Return all stored DNA vectors keyed by strategy name."""
    try:
        if r is None:
            r = _get_redis()
        raw_map = r.hgetall("strategy:dna:index")
        result = {}
        for strategy, payload in raw_map.items():
            try:
                obj = json.loads(payload)
                result[strategy] = {k: float(v) for k, v in obj.items() if k != "strategy"}
            except Exception:
                continue
        return result
    except Exception:
        log.exception("strategy_dna: failed to fetch all DNA vectors")
        return {}
