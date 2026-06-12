# backend/engine/regime_risk.py
"""
Regime-Conditional Risk Limits

Reads `regime:current` from Redis (set by the regime detector / macro model)
and returns a multiplier that scales the base risk limits in risk_manager.py.

Regimes and their multipliers:
  bull       → 1.0  (full position sizes)
  neutral    → 0.8
  bear       → 0.5
  crisis     → 0.25 (emergency throttle)
  unknown    → 0.6  (conservative default for unrecognized regime)

Usage in risk_manager.py:
    from backend.engine.regime_risk import regime_multiplier
    cap_strat = cap_strat * regime_multiplier()

The regime key can be set by any macro/ML model:
    redis-cli SET regime:current '{"regime":"bear","confidence":0.87,"ts":1716220000}'
"""
from __future__ import annotations

import json
import logging
import os

log = logging.getLogger(__name__)

_MULTIPLIERS = {
    "bull":    1.0,
    "neutral": 0.8,
    "bear":    0.5,
    "crisis":  0.25,
}
_DEFAULT_MULTIPLIER = float(os.getenv("REGIME_DEFAULT_MULTIPLIER", "0.6"))


def regime_multiplier(r=None) -> float:
    """
    Return the risk limit multiplier for the current market regime.
    Falls back to _DEFAULT_MULTIPLIER if Redis is unavailable or key missing.
    """
    try:
        if r is None:
            import redis as _redis
            ssl = os.getenv("REDIS_SSL", "").lower() in ("1", "true", "yes")
            kwargs = dict(
                host=os.getenv("REDIS_HOST", "localhost"),
                port=int(os.getenv("REDIS_PORT", "6379")),
                password=os.getenv("REDIS_PASSWORD") or None,
                decode_responses=True,
            )
            if ssl:
                kwargs["ssl"] = True
            r = _redis.Redis(**kwargs)

        raw = r.get("regime:current")
        if not raw:
            return _DEFAULT_MULTIPLIER

        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode()

        # Support both plain string ("bear") and JSON ({"regime":"bear",...})
        try:
            obj = json.loads(raw)
            regime = str(obj.get("regime", "")).lower()
        except (json.JSONDecodeError, AttributeError):
            regime = str(raw).lower()

        mult = _MULTIPLIERS.get(regime, _DEFAULT_MULTIPLIER)
        log.debug("Regime=%s → multiplier=%.2f", regime, mult)
        return mult

    except Exception:
        log.warning("regime_multiplier: Redis unavailable, using default %.2f", _DEFAULT_MULTIPLIER)
        return _DEFAULT_MULTIPLIER


def set_regime(regime: str, confidence: float = 1.0, r=None) -> None:
    """Write the current regime to Redis. Used by macro/ML models."""
    import time
    try:
        if r is None:
            import redis as _redis
            ssl = os.getenv("REDIS_SSL", "").lower() in ("1", "true", "yes")
            kwargs = dict(
                host=os.getenv("REDIS_HOST", "localhost"),
                port=int(os.getenv("REDIS_PORT", "6379")),
                password=os.getenv("REDIS_PASSWORD") or None,
                decode_responses=True,
            )
            if ssl:
                kwargs["ssl"] = True
            r = _redis.Redis(**kwargs)
        r.set("regime:current", json.dumps({
            "regime": regime.lower(),
            "confidence": confidence,
            "ts": int(time.time()),
        }))
    except Exception:
        log.exception("set_regime: failed to write regime=%s", regime)
