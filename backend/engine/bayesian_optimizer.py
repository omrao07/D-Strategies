# backend/engine/bayesian_optimizer.py
"""
Self-Healing Strategy Parameters via Bayesian Optimization

Uses a simple GP-based surrogate (or random search fallback) to tune
strategy hyperparameters based on observed P&L outcomes.

Each strategy can register a parameter space and an objective function.
After each trading session, the optimizer suggests improved parameters
and writes them to Redis under `strategy:params:<strategy>`.

The strategy fetches its own params from Redis on startup:
  params = strategy_params("momentum_us") or DEFAULT_PARAMS

Design:
  - No external dependency required (falls back to random search if scipy unavailable)
  - Persistent experiment history in Redis (ledger:bayesopt:<strategy>)
  - Thread-safe: each run is independent, no shared state

Usage:
  from backend.engine.bayesian_optimizer import register_strategy, suggest_params, record_outcome

  register_strategy("momentum_us", {
      "lookback": (5, 60),        # int range
      "threshold": (0.001, 0.05), # float range
      "stop_loss": (0.005, 0.03),
  })
  params = suggest_params("momentum_us")
  # ... run strategy with params ...
  record_outcome("momentum_us", params, pnl=1234.56)
"""
from __future__ import annotations

import json
import logging
import math
import os
import random
import time
from typing import Dict, List, Optional, Tuple

log = logging.getLogger(__name__)

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
HISTORY_TTL = int(os.getenv("BAYESOPT_HISTORY_TTL", str(90 * 86400)))
MAX_HISTORY = int(os.getenv("BAYESOPT_MAX_HISTORY", "200"))


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


# ---- Parameter Space ----

_PARAM_SPACES: Dict[str, Dict[str, Tuple]] = {}


def register_strategy(strategy: str, param_space: Dict[str, Tuple]) -> None:
    """
    Register a strategy's tunable parameter space.
    param_space: {param_name: (min, max)} — numeric ranges only.
    """
    _PARAM_SPACES[strategy] = param_space
    log.info("BayesOpt: registered strategy %s with %d params", strategy, len(param_space))


def _random_sample(space: Dict[str, Tuple]) -> Dict[str, float]:
    """Uniform random sample from the parameter space."""
    return {
        k: random.uniform(lo, hi)
        for k, (lo, hi) in space.items()
    }


def _load_history(strategy: str, r) -> List[Dict]:
    raw = r.lrange(f"bayesopt:history:{strategy}", 0, MAX_HISTORY - 1)
    history = []
    for item in raw:
        try:
            history.append(json.loads(item))
        except Exception:
            continue
    return history


def _ucb_suggest(history: List[Dict], space: Dict[str, Tuple], kappa: float = 2.0) -> Dict[str, float]:
    """
    Simple Upper Confidence Bound (UCB) surrogate without external deps.
    Uses inverse-distance weighting to estimate mean and uncertainty.
    Falls back to random sampling for sparse history.
    """
    if len(history) < 5:
        return _random_sample(space)

    candidates = [_random_sample(space) for _ in range(50)]
    best_score = float("-inf")
    best_candidate = candidates[0]

    for candidate in candidates:
        # IDW mean estimate
        distances = []
        for obs in history:
            params = obs.get("params", {})
            dist = math.sqrt(sum(
                ((candidate.get(k, 0) - params.get(k, 0)) /
                 max(hi - lo, 1e-9)) ** 2
                for k, (lo, hi) in space.items()
            ))
            distances.append((dist, float(obs.get("pnl", 0.0))))

        distances.sort(key=lambda x: x[0])
        neighbors = distances[:5]

        total_w = sum(1.0 / (d + 1e-6) for d, _ in neighbors)
        mean_est = sum((1.0 / (d + 1e-6)) * pnl for d, pnl in neighbors) / total_w

        # Uncertainty: higher where observations are sparse
        min_dist = distances[0][0] if distances else 1.0
        uncertainty = math.log1p(min_dist + 1.0)

        ucb = mean_est + kappa * uncertainty
        if ucb > best_score:
            best_score = ucb
            best_candidate = candidate

    return best_candidate


def suggest_params(strategy: str, r=None) -> Dict[str, float]:
    """
    Suggest the next parameter set to try for the strategy.
    Returns random sample if no history or space registered.
    """
    space = _PARAM_SPACES.get(strategy)
    if not space:
        log.warning("BayesOpt: no param space registered for %s, returning empty", strategy)
        return {}

    try:
        if r is None:
            r = _get_redis()
        history = _load_history(strategy, r)
        params = _ucb_suggest(history, space)
        log.debug("BayesOpt: suggested params for %s: %s", strategy, params)
        return params
    except Exception:
        log.exception("BayesOpt: error suggesting params for %s", strategy)
        return _random_sample(space)


def record_outcome(strategy: str, params: Dict[str, float], pnl: float, r=None) -> None:
    """
    Record the P&L outcome of running the strategy with given params.
    This drives future suggestions toward better regions.
    """
    try:
        if r is None:
            r = _get_redis()
        entry = json.dumps({"params": params, "pnl": pnl, "ts": int(time.time())})
        r.lpush(f"bayesopt:history:{strategy}", entry)
        r.ltrim(f"bayesopt:history:{strategy}", 0, MAX_HISTORY - 1)
        r.expire(f"bayesopt:history:{strategy}", HISTORY_TTL)
        # Also write best-known params if this is the best outcome
        history = _load_history(strategy, r)
        if history:
            best = max(history, key=lambda x: x.get("pnl", float("-inf")))
            r.set(f"strategy:params:{strategy}", json.dumps(best["params"]))
        log.info("BayesOpt: recorded outcome pnl=%.2f for %s", pnl, strategy)
    except Exception:
        log.exception("BayesOpt: error recording outcome for %s", strategy)


def strategy_params(strategy: str, r=None) -> Optional[Dict[str, float]]:
    """
    Get the best-known parameters for a strategy (for use at startup).
    Returns None if no optimization has been run yet.
    """
    try:
        if r is None:
            r = _get_redis()
        raw = r.get(f"strategy:params:{strategy}")
        return json.loads(raw) if raw else None
    except Exception:
        return None
