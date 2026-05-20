# backend/engine/strategy_tournament.py
"""
Real-Time Strategy Tournament

Ranks all active strategies by a composite score (Sharpe-weighted) using
their shadow PnL data (from shadow_engine.py) and their real PnL.

Leaderboard is written to:
  tournament:leaderboard        ZSET  {strategy → composite_score}  (higher=better)
  tournament:snapshot           JSON  [{rank, strategy, score, sharpe, total_pnl, shadow_pnl}]
  tournament:last_updated       epoch timestamp

Run as a periodic job (e.g., every 5 minutes):
  python -m backend.engine.strategy_tournament

The leaderboard drives:
  - Allocator: boost capital allocation to top-ranked strategies
  - Dashboard: real-time ranking panel
  - Autopsy: bottom-ranked strategies trigger review
"""
from __future__ import annotations

import json
import logging
import math
import os
import time
from typing import Dict, List, Optional, Tuple

log = logging.getLogger(__name__)

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
TOURNAMENT_INTERVAL = int(os.getenv("TOURNAMENT_INTERVAL_SECONDS", "300"))


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


def _get_strategies(r) -> List[str]:
    """Discover all strategies that have shadow PnL data."""
    strategies = set()
    # From shadow PnL keys
    for key in r.scan_iter("shadow:pnl:*"):
        strat = key[len("shadow:pnl:"):]
        if strat:
            strategies.add(strat)
    # From real PnL keys
    for key in r.scan_iter("pnl:day_strategy:*"):
        strat = key[len("pnl:day_strategy:"):]
        if strat:
            strategies.add(strat)
    return list(strategies)


def _get_shadow_pnl(strategy: str, r) -> Dict:
    raw = r.get(f"shadow:pnl:{strategy}")
    if not raw:
        return {"realized": 0.0, "unrealized": 0.0, "total": 0.0}
    try:
        return json.loads(raw)
    except Exception:
        return {"realized": 0.0, "unrealized": 0.0, "total": 0.0}


def _get_real_pnl(strategy: str, r) -> Dict:
    raw = r.get(f"pnl:day_strategy:{strategy}")
    if not raw:
        return {"realized": 0.0, "unrealized": 0.0, "total": 0.0}
    try:
        return json.loads(raw)
    except Exception:
        return {"realized": 0.0, "unrealized": 0.0, "total": 0.0}


def _compute_score(real_pnl: Dict, shadow_pnl: Dict) -> Tuple[float, float]:
    """
    Composite score = 0.6 * real_total + 0.4 * shadow_total (both normalized).
    Returns (composite_score, sharpe_proxy).
    """
    real_total = float(real_pnl.get("total", 0.0))
    shadow_total = float(shadow_pnl.get("total", 0.0))
    # Sharpe proxy: use total vs. absolute value as crude stand-in without std dev
    # (full Sharpe needs fill-level time series — approximated here)
    if abs(real_total) > 1e-6:
        sharpe_proxy = real_total / (abs(real_total) ** 0.5)
    else:
        sharpe_proxy = 0.0
    composite = 0.6 * real_total + 0.4 * shadow_total
    return composite, sharpe_proxy


def update_leaderboard(r=None) -> List[Dict]:
    """Recompute and store the tournament leaderboard. Returns snapshot list."""
    if r is None:
        r = _get_redis()

    strategies = _get_strategies(r)
    if not strategies:
        log.debug("Tournament: no strategies found")
        return []

    scores = []
    for strat in strategies:
        real_pnl = _get_real_pnl(strat, r)
        shadow_pnl = _get_shadow_pnl(strat, r)
        score, sharpe = _compute_score(real_pnl, shadow_pnl)
        scores.append({
            "strategy": strat,
            "score": score,
            "sharpe_proxy": sharpe,
            "real_pnl": real_pnl.get("total", 0.0),
            "shadow_pnl": shadow_pnl.get("total", 0.0),
        })

    scores.sort(key=lambda x: x["score"], reverse=True)

    # Write to Redis sorted set
    pipeline = r.pipeline()
    pipeline.delete("tournament:leaderboard")
    for entry in scores:
        pipeline.zadd("tournament:leaderboard", {entry["strategy"]: entry["score"]})

    snapshot = [
        {"rank": i + 1, **entry}
        for i, entry in enumerate(scores)
    ]
    pipeline.set("tournament:snapshot", json.dumps(snapshot))
    pipeline.set("tournament:last_updated", int(time.time()))
    pipeline.execute()

    log.info("Tournament updated: %d strategies ranked", len(scores))
    return snapshot


def get_leaderboard(r=None) -> List[Dict]:
    """Return the latest tournament snapshot."""
    if r is None:
        r = _get_redis()
    raw = r.get("tournament:snapshot")
    if not raw:
        return []
    try:
        return json.loads(raw)
    except Exception:
        return []


def run_loop() -> None:
    """Run the tournament updater in a loop."""
    r = _get_redis()
    log.info("Strategy tournament loop started (interval=%ds)", TOURNAMENT_INTERVAL)
    while True:
        try:
            update_leaderboard(r)
        except Exception:
            log.exception("Tournament: error during leaderboard update")
        time.sleep(TOURNAMENT_INTERVAL)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_loop()
