# backend/tests/test_replay_parity.py
"""
Replay Parity Tests
-------------------
Verifies that live execution and replay produce bit-identical outputs,
that runs are deterministic, and that state hashes are sensitive to
every meaningful change in the event stream.
"""

import numpy as np
import pytest

from backend.engine.core.engine import Engine
from backend.engine.core.replay import Replayer
from backend.engine.core.types import Event, EngineResult, hash_state


# ─────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────

@pytest.fixture
def deterministic_events():
    np.random.seed(123)
    events = []
    for ts in range(1, 101):
        events.append(Event(
            ts=ts,
            symbol="AAPL",
            price=round(100 + np.random.randn(), 4),
            qty=1.0 if np.random.rand() > 0.5 else -1.0,
        ))
    return events


@pytest.fixture
def multi_symbol_events():
    return [
        Event(ts=1, symbol="AAPL", price=150.0, qty=10.0),
        Event(ts=2, symbol="TSLA", price=250.0, qty=5.0),
        Event(ts=3, symbol="AAPL", price=152.0, qty=-5.0),
        Event(ts=4, symbol="TSLA", price=248.0, qty=-5.0),
    ]


# ─────────────────────────────────────────────────────────────
# Parity: live == replay
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


def test_replay_matches_live_multi_symbol(multi_symbol_events):
    engine = Engine()
    replayer = Replayer()

    live = engine.run(multi_symbol_events)
    replay = replayer.replay(multi_symbol_events)

    assert live.state_hash == replay.state_hash
    assert live.positions == replay.positions


# ─────────────────────────────────────────────────────────────
# Determinism
# ─────────────────────────────────────────────────────────────

def test_replay_is_deterministic(deterministic_events):
    replayer = Replayer()

    r1 = replayer.replay(deterministic_events)
    r2 = replayer.replay(deterministic_events)

    assert r1.state_hash == r2.state_hash
    assert r1.pnl == r2.pnl
    assert r1.positions == r2.positions
    assert r1.trades == r2.trades


def test_engine_is_deterministic(deterministic_events):
    engine = Engine()

    r1 = engine.run(deterministic_events)
    r2 = engine.run(deterministic_events)

    assert r1.state_hash == r2.state_hash


# ─────────────────────────────────────────────────────────────
# Ordering sensitivity
# ─────────────────────────────────────────────────────────────

def test_event_order_matters(deterministic_events):
    engine = Engine()

    normal = engine.run(deterministic_events)
    reversed_run = engine.run(list(reversed(deterministic_events)))

    assert normal.state_hash != reversed_run.state_hash


def test_partial_replay_differs_from_full(deterministic_events):
    engine = Engine()
    replayer = Replayer(strict_ordering=False)

    full = engine.run(deterministic_events)
    partial = replayer.replay(deterministic_events[:50])

    assert partial.pnl != full.pnl
    assert partial.state_hash != full.state_hash


# ─────────────────────────────────────────────────────────────
# Edge cases
# ─────────────────────────────────────────────────────────────

def test_empty_events():
    engine = Engine()
    replayer = Replayer()

    live = engine.run([])
    replay = replayer.replay([])

    assert live.pnl == 0.0
    assert replay.pnl == 0.0
    assert live.positions == {}
    assert replay.positions == {}
    assert live.state_hash == replay.state_hash


def test_single_event():
    engine = Engine()
    result = engine.run([Event(ts=1, symbol="AAPL", price=100.0, qty=10.0)])

    assert result.pnl == 1000.0        # sold value: -(-10 * 100)
    assert result.positions == {"AAPL": 10.0}
    assert len(result.trades) == 1


def test_flat_book_zero_pnl():
    """Buy 10 then sell 10 at the same price → PnL = 0."""
    events = [
        Event(ts=1, symbol="MSFT", price=300.0, qty=10.0),
        Event(ts=2, symbol="MSFT", price=300.0, qty=-10.0),
    ]
    result = Engine().run(events)

    assert result.pnl == pytest.approx(0.0)
    assert result.positions["MSFT"] == pytest.approx(0.0)


def test_profitable_round_trip():
    """
    Buy low, sell high — engine tracks pnl = -net_cash_flow.
    After buy 10@400 then sell 10@450: cash = +500, pnl = -500.
    Positive cash inflow → negative pnl in this cost-basis convention.
    Use `cash = -pnl` to recover net cash if needed.
    """
    events = [
        Event(ts=1, symbol="NVDA", price=400.0, qty=10.0),
        Event(ts=2, symbol="NVDA", price=450.0, qty=-10.0),
    ]
    result = Engine().run(events)

    # net cash = sell_proceeds - buy_cost = 4500 - 4000 = +500
    # pnl = -cash = -500  (engine convention: pnl = cost of current holdings)
    assert result.pnl == pytest.approx(-500.0)
    assert result.positions["NVDA"] == pytest.approx(0.0)


# ─────────────────────────────────────────────────────────────
# Hash sensitivity
# ─────────────────────────────────────────────────────────────

def test_state_hash_changes_on_price_change(deterministic_events):
    engine = Engine()

    base = engine.run(deterministic_events)

    mutated = list(deterministic_events)
    mutated[0] = Event(
        ts=mutated[0].ts,
        symbol=mutated[0].symbol,
        price=mutated[0].price + 0.01,
        qty=mutated[0].qty,
    )
    changed = engine.run(mutated)

    assert base.state_hash != changed.state_hash


def test_state_hash_changes_on_qty_change(deterministic_events):
    engine = Engine()

    base = engine.run(deterministic_events)

    mutated = list(deterministic_events)
    mutated[0] = Event(
        ts=mutated[0].ts,
        symbol=mutated[0].symbol,
        price=mutated[0].price,
        qty=mutated[0].qty + 1.0,
    )
    changed = engine.run(mutated)

    assert base.state_hash != changed.state_hash


def test_hash_state_utility():
    h1 = hash_state({"a": 1, "b": 2})
    h2 = hash_state({"b": 2, "a": 1})   # key order shouldn't matter
    h3 = hash_state({"a": 1, "b": 3})

    assert h1 == h2
    assert h1 != h3


# ─────────────────────────────────────────────────────────────
# Replayer ordering enforcement
# ─────────────────────────────────────────────────────────────

def test_replayer_rejects_out_of_order_events():
    replayer = Replayer(strict_ordering=True)
    out_of_order = [
        Event(ts=5, symbol="AAPL", price=100.0, qty=1.0),
        Event(ts=3, symbol="AAPL", price=101.0, qty=-1.0),  # ts goes backward
    ]
    with pytest.raises(ValueError, match="timestamp order"):
        replayer.replay(out_of_order)


def test_replayer_loose_mode_accepts_out_of_order():
    replayer = Replayer(strict_ordering=False)
    out_of_order = [
        Event(ts=5, symbol="AAPL", price=100.0, qty=1.0),
        Event(ts=3, symbol="AAPL", price=101.0, qty=-1.0),
    ]
    result = replayer.replay(out_of_order)
    assert result is not None


# ─────────────────────────────────────────────────────────────
# Result type
# ─────────────────────────────────────────────────────────────

def test_result_fields(deterministic_events):
    result = Engine().run(deterministic_events)

    assert isinstance(result, EngineResult)
    assert isinstance(result.pnl, float)
    assert isinstance(result.positions, dict)
    assert isinstance(result.orders, list)
    assert isinstance(result.trades, list)
    assert isinstance(result.state_hash, str)
    assert len(result.state_hash) == 64    # sha256 hex
