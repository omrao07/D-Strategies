# backend/india/india_vix.py
"""India VIX reader — NSE's 30-day implied vol index."""
from __future__ import annotations

import os
from typing import Optional

import redis

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

_r: Optional[redis.Redis] = None

def _get_r() -> redis.Redis:
    global _r
    if _r is None:
        _r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT,
                         password=os.getenv("REDIS_PASSWORD") or None,
                         decode_responses=True)
    return _r

# India VIX interpretation thresholds
VIX_LOW = 12.0     # calm market
VIX_MEDIUM = 20.0  # moderate uncertainty
VIX_HIGH = 30.0    # elevated fear
VIX_CRISIS = 50.0  # crisis/black-swan

def get_india_vix(r=None) -> Optional[float]:
    """Read current India VIX from Redis (updated by data ingestion pipeline)."""
    rc = r or _get_r()
    val = rc.get("india:vix:current")
    return float(val) if val else None

def set_india_vix(vix: float, r=None) -> None:
    rc = r or _get_r()
    rc.set("india:vix:current", str(vix))

def vix_regime(vix: Optional[float] = None, r=None) -> str:
    """Return 'low'|'medium'|'high'|'crisis' based on India VIX level."""
    v = vix if vix is not None else get_india_vix(r)
    if v is None:
        return "unknown"
    if v < VIX_LOW:
        return "low"
    if v < VIX_MEDIUM:
        return "medium"
    if v < VIX_HIGH:
        return "high"
    return "crisis"

def vix_position_multiplier(vix: Optional[float] = None, r=None) -> float:
    """Scale factor to apply to position sizes based on VIX regime."""
    regime = vix_regime(vix, r)
    return {"low": 1.0, "medium": 0.8, "high": 0.5, "crisis": 0.25, "unknown": 0.6}[regime]
