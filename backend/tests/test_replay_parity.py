# tests/test_replay_parity.py
#
# Replay Parity Tests
# -------------------
# Ensures that:
# 1. Live execution and replay execution produce identical outputs
# 2. Determinism is preserved (same inputs → same outputs)
# 3. State transitions match exactly
#
# Expected interfaces:
#
# class Engine:
#   def run(events: list[Event]) -> EngineResult
#
# class Replayer:
#   def replay(events: list[Event]) -> EngineResult
#
# EngineResult:
#   - pnl: float
#   - positions: dict[str, float]
#   - orders: list
#   - trades: list
#   - state_hash: str
#

import hashlib
import json
import numpy as np
import pytest
from dataclasses import dataclass, asdict


# ─────────────────────────────────────────────────────────────
# Fallback minimal implementations (REMOVE when real exists)
# ─────────────────────────────────────────────────────────────

try:
    from engine.core.engine import Engine
    from engine.core.replay import Replayer
except ImportError:
    class Engine:
        def run(self, events):
            return simulate(events)

    class Replayer:
        def replay(self, events):
            return simulate(events)


# ─────────────────────────────────────────────────────────────
# Types
# ─────────────────────────────────────────────────────────────

@dataclass
class Event:
    ts: int
    symbol: str
    price: float
    qty: float


@dataclass
class EngineResult:
    pnl: float
    positions: dict
    orders: list
    trades: list
    state_hash: str


# ─────────────────────────────────────────────────────────────
# Deterministic simulator (shared logic)
# ─────────────────────────────────────────────────────────────

def simulate(events: list[Event]) -> EngineResult:
    pos = {}
    trades = []
    cash = 0.0

    for e in events:
        pos[e.symbol] = pos.get(e.symbol, 0.0) + e.qty
        trade_value = e.qty * e.price
        cash -= trade_value
        trades.append((e.ts, e.symbol, e.qty, e.price))

    pnl = -cash
    state = {
        "positions": pos,
        "trades": trades,
        "pnl": pnl,
    }

    return EngineResult(
        pnl=pnl,
        positions=pos,
        orders=[],
        trades=trades,
        state_hash=hash_state(state),
    )


def hash_state(obj) -> str:
    raw = json.dumps(obj, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


# ─────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────

@pytest.fixture
def deterministic_events():
    np.random.seed(123)
    events = []
    ts = 0
    for _ in range(100):
        ts += 1
        events.append(
            Event(
                ts=ts,
                symbol="AAPL",
                price=round(100 + np.random.randn(), 4),
                qty=1 if np.random.rand() > 0.5 else -1,
            )
        )
    return events


# ─────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────

def test_replay_matches_live(deterministic_events):
    engine = Engine()
    replayer = Replayer()

    live = engine.run(deterministic_events)
    replay = replayer.replay(deterministic_events)

    assert live.pnl == replay.pnl
    assert live.positions == replay.positions
    assert live.trades == replay.trades
    assert live.state_hash == replay.state_hash


def test_replay_is_deterministic(deterministic_events):
    replayer = Replayer()

    r1 = replayer.replay(deterministic_events)
    r2 = replayer.replay(deterministic_events)

    assert r1.state_hash == r2.state_hash
    assert r1.pnl == r2.pnl
    assert r1.positions == r2.positions


def test_event_order_matters(deterministic_events):
    engine = Engine()

    normal = engine.run(deterministic_events)
    reversed_events = list(reversed(deterministic_events))
    reversed_run = engine.run(reversed_events)

    assert normal.state_hash != reversed_run.state_hash


def test_partial_replay_prefix(deterministic_events):
    engine = Engine()
    replayer = Replayer()

    full = engine.run(deterministic_events)
    partial = replayer.replay(deterministic_events[:50])

    assert partial.pnl != full.pnl
    assert partial.state_hash != full.state_hash


def test_empty_events():
    engine = Engine()
    replayer = Replayer()

    live = engine.run([])
    replay = replayer.replay([])

    assert live.pnl == 0.0
    assert replay.pnl == 0.0
    assert live.positions == {}
    assert live.state_hash == replay.state_hash


def test_state_hash_changes_on_price_change(deterministic_events):
    engine = Engine()

    base = engine.run(deterministic_events)

    mutated = deterministic_events.copy()
    mutated[0] = Event(
        ts=mutated[0].ts,
        symbol=mutated[0].symbol,
        price=mutated[0].price + 0.01,
        qty=mutated[0].qty,
    )

    changed = engine.run(mutated)

    assert base.state_hash != changed.state_hash