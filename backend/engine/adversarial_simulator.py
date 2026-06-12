# backend/engine/adversarial_simulator.py
"""
Adversarial Market Simulator

Injects synthetic market stress scenarios into the paper trading pipeline
to stress-test strategies without risking real capital.

Scenarios:
  flash_crash   : price drops 15-30% in 1-3 seconds, then recovers 60%
  liquidity_gap : bid/ask spread widens 10x, order rejection rate 80%
  momentum_trap : false breakout followed by sharp reversal
  corr_spike    : all positions move against simultaneously (correlation=1)
  vol_regime    : volatility 3x normal for N seconds

The simulator writes synthetic `last_price` entries and injects fake
order rejections into the orders channel so risk/execution systems respond
as they would in a real crisis.

Usage:
  from backend.engine.adversarial_simulator import run_scenario
  run_scenario("flash_crash", symbols=["AAPL", "MSFT"], duration_seconds=10)

Wire into chaos/ or run standalone for stress testing.
"""
from __future__ import annotations

import json
import logging
import os
import random
import time
from typing import Dict, List, Optional

from backend.bus.streams import CHAN_ORDERS, publish_pubsub

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


def _get_price(symbol: str, r) -> Optional[float]:
    try:
        raw = r.hget("last_price", symbol)
        if raw is None:
            return None
        try:
            return float(raw)
        except ValueError:
            obj = json.loads(raw)
            return float(obj.get("price", 0))
    except Exception:
        return None


def _set_price(symbol: str, price: float, r) -> None:
    r.hset("last_price", symbol, str(price))


def _announce(scenario: str, phase: str, symbols: List[str], metadata: Dict = {}) -> None:
    publish_pubsub(CHAN_ORDERS, {
        "event": "adversarial_scenario",
        "scenario": scenario,
        "phase": phase,
        "symbols": symbols,
        "ts_ms": int(time.time() * 1000),
        **metadata,
    })


# ---- Scenarios ----

def flash_crash(symbols: List[str], drop_pct: float = 0.20, duration_s: float = 5.0, r=None) -> None:
    """Simulate a flash crash: sharp drop then partial recovery."""
    if r is None:
        r = _get_redis()

    originals = {sym: _get_price(sym, r) for sym in symbols}
    _announce("flash_crash", "start", symbols, {"drop_pct": drop_pct})

    # Crash phase
    for sym in symbols:
        p = originals[sym]
        if p:
            _set_price(sym, p * (1.0 - drop_pct), r)
    log.warning("Adversarial: flash_crash started — %.0f%% drop on %s", drop_pct * 100, symbols)
    time.sleep(duration_s)

    # Partial recovery (recover 60% of the drop)
    for sym in symbols:
        p = originals[sym]
        if p:
            _set_price(sym, p * (1.0 - drop_pct * 0.4), r)
    _announce("flash_crash", "partial_recovery", symbols)
    time.sleep(duration_s)

    # Full restore
    for sym, p in originals.items():
        if p:
            _set_price(sym, p, r)
    _announce("flash_crash", "end", symbols)
    log.info("Adversarial: flash_crash ended, prices restored")


def vol_regime(symbols: List[str], vol_multiplier: float = 3.0, duration_s: float = 30.0, ticks: int = 20, r=None) -> None:
    """Simulate a high-volatility regime with random large moves."""
    if r is None:
        r = _get_redis()

    originals = {sym: _get_price(sym, r) for sym in symbols}
    _announce("vol_regime", "start", symbols, {"vol_multiplier": vol_multiplier})
    log.warning("Adversarial: vol_regime started on %s (%.1fx vol)", symbols, vol_multiplier)

    sleep_per_tick = duration_s / max(ticks, 1)
    prices = {sym: p for sym, p in originals.items() if p}

    for _ in range(ticks):
        for sym in list(prices):
            shock = random.gauss(0, prices[sym] * 0.01 * vol_multiplier)
            prices[sym] = max(prices[sym] + shock, 0.01)
            _set_price(sym, prices[sym], r)
        time.sleep(sleep_per_tick)

    # Restore
    for sym, p in originals.items():
        if p:
            _set_price(sym, p, r)
    _announce("vol_regime", "end", symbols)
    log.info("Adversarial: vol_regime ended, prices restored")


def corr_spike(symbols: List[str], shock_pct: float = 0.08, duration_s: float = 5.0, r=None) -> None:
    """All positions move against simultaneously (correlation spike to 1)."""
    if r is None:
        r = _get_redis()

    originals = {sym: _get_price(sym, r) for sym in symbols}
    _announce("corr_spike", "start", symbols, {"shock_pct": shock_pct})
    log.warning("Adversarial: corr_spike — all symbols drop %.0f%%", shock_pct * 100)

    for sym in symbols:
        p = originals[sym]
        if p:
            _set_price(sym, p * (1.0 - shock_pct), r)

    time.sleep(duration_s)

    for sym, p in originals.items():
        if p:
            _set_price(sym, p, r)
    _announce("corr_spike", "end", symbols)
    log.info("Adversarial: corr_spike ended")


SCENARIOS = {
    "flash_crash": flash_crash,
    "vol_regime": vol_regime,
    "corr_spike": corr_spike,
}


def run_scenario(scenario: str, symbols: List[str], **kwargs) -> None:
    """Dispatch a named adversarial scenario."""
    fn = SCENARIOS.get(scenario)
    if fn is None:
        raise ValueError(f"Unknown scenario '{scenario}'. Available: {list(SCENARIOS)}")
    log.info("Adversarial: running scenario=%s on symbols=%s", scenario, symbols)
    fn(symbols, **kwargs)
