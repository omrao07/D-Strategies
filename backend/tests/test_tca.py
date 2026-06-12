# test_tca.py
# Pytest test suite for backend/analytics/tca.py
#
# Tests:
#   - Record an order and one full fill; verify IS_bps is computed
#   - Fill ratio = filled_qty / ordered_qty
#   - Aggregate by symbol returns records grouped by symbol
#   - Multiple partial fills sum to correct filled_qty
#   - Cancel after partial fill gives correct cancel count
#   - TCA with no fills gives fill_ratio=0
#
# Run:
#   pytest -q backend/tests/test_tca.py

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict

import pytest

from backend.analytics.tca import TCA

# ---------------------------------------------------------------------------
# Minimal stub objects (no external dependencies)
# ---------------------------------------------------------------------------

@dataclass
class _Order:
    """Minimal order stub compatible with TCA.record_order()."""
    id: str
    symbol: str
    side: str
    qty: float
    ts: float = field(default_factory=time.time)
    strategy: str = "test_strat"
    attrs: Dict[str, Any] = field(default_factory=dict)


@dataclass
class _Fill:
    """Minimal fill stub compatible with TCA.record_fill()."""
    order_id: str
    symbol: str
    side: str
    qty: float       # positive quantity
    price: float
    fee: float = 0.0
    ts: float = field(default_factory=time.time)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_BASE_TS = 1_700_000_000.0   # fixed reference timestamp


def _make_order(
    order_id: str = "ORD-001",
    symbol: str = "AAPL",
    side: str = "buy",
    qty: float = 100.0,
    ts: float = _BASE_TS,
    strategy: str = "mom",
) -> _Order:
    return _Order(id=order_id, symbol=symbol, side=side, qty=qty, ts=ts, strategy=strategy)


def _make_fill(
    order_id: str = "ORD-001",
    symbol: str = "AAPL",
    side: str = "buy",
    qty: float = 100.0,
    price: float = 150.0,
    ts: float = _BASE_TS + 1.0,
) -> _Fill:
    return _Fill(order_id=order_id, symbol=symbol, side=side, qty=qty, price=price, ts=ts)


def _tca() -> TCA:
    """Return a fresh TCA instance with no CSV output."""
    return TCA(symbol_region_map={"AAPL": "us", "RELIANCE.NS": "india"})


# ---------------------------------------------------------------------------
# 1. Record order + single full fill; verify IS_bps is computed
# ---------------------------------------------------------------------------

class TestISComputation:
    def test_is_bps_computed_for_buy(self):
        """Buy order: fill_px > decision_px → IS_bps > 0 (paid more than decision)."""
        tca = _tca()
        o = _make_order(symbol="AAPL", side="buy", qty=100.0)
        decision_px = 150.0
        fill_px = 151.5  # 1.5 above decision

        tca.record_order(o, strategy="mom", decision_px=decision_px, decision_ts=_BASE_TS)
        tca.record_fill(_make_fill(price=fill_px, qty=100.0))

        rows = tca.per_order()
        assert len(rows) == 1
        row = rows[0]
        assert row["IS_bps"] is not None
        expected_is = (fill_px - decision_px) / decision_px * 1e4   # buy side_sign = +1
        assert row["IS_bps"] == pytest.approx(expected_is, rel=1e-4)

    def test_is_bps_computed_for_sell(self):
        """Sell order: fill_px < decision_px → IS_bps > 0 (sold below decision)."""
        tca = _tca()
        o = _make_order(symbol="AAPL", side="sell", qty=100.0)
        decision_px = 150.0
        fill_px = 148.0   # 2 below decision

        tca.record_order(o, strategy="rev", decision_px=decision_px, decision_ts=_BASE_TS)
        tca.record_fill(_make_fill(side="sell", price=fill_px, qty=100.0))

        rows = tca.per_order()
        row = rows[0]
        # sell side_sign = -1: IS_bps = -1 * (148-150)/150 * 1e4 = +13.33
        expected_is = -1.0 * (fill_px - decision_px) / decision_px * 1e4
        assert row["IS_bps"] == pytest.approx(expected_is, rel=1e-4)

    def test_is_dollar_computed(self):
        tca = _tca()
        o = _make_order(symbol="AAPL", side="buy", qty=50.0)
        decision_px = 100.0
        fill_px = 101.0

        tca.record_order(o, strategy="s", decision_px=decision_px)
        tca.record_fill(_make_fill(price=fill_px, qty=50.0))

        rows = tca.per_order()
        row = rows[0]
        expected_is_dollar = 1.0 * (fill_px - decision_px) * 50.0
        assert row["IS_$"] == pytest.approx(expected_is_dollar, rel=1e-4)

    def test_vwap_fill_matches_single_fill_price(self):
        tca = _tca()
        o = _make_order(symbol="AAPL", qty=100.0)
        tca.record_order(o, strategy="m", decision_px=100.0)
        tca.record_fill(_make_fill(price=105.0, qty=100.0))

        rows = tca.per_order()
        assert rows[0]["vwap_fill"] == pytest.approx(105.0)

    def test_is_none_when_no_fills(self):
        tca = _tca()
        o = _make_order(symbol="AAPL")
        tca.record_order(o, strategy="m", decision_px=100.0)
        rows = tca.per_order()
        assert rows[0]["IS_bps"] is None


# ---------------------------------------------------------------------------
# 2. Fill ratio = filled_qty / ordered_qty
# ---------------------------------------------------------------------------

class TestFillRatio:
    def test_full_fill_gives_ratio_one(self):
        tca = _tca()
        o = _make_order(qty=100.0)
        tca.record_order(o, strategy="m", decision_px=100.0)
        tca.record_fill(_make_fill(qty=100.0, price=100.0))
        rows = tca.per_order()
        assert rows[0]["fill_ratio"] == pytest.approx(1.0)

    def test_half_fill_gives_ratio_half(self):
        tca = _tca()
        o = _make_order(qty=100.0)
        tca.record_order(o, strategy="m", decision_px=100.0)
        tca.record_fill(_make_fill(qty=50.0, price=100.0))
        rows = tca.per_order()
        assert rows[0]["fill_ratio"] == pytest.approx(0.5)

    def test_no_fill_gives_ratio_zero(self):
        tca = _tca()
        o = _make_order(qty=100.0)
        tca.record_order(o, strategy="m", decision_px=100.0)
        rows = tca.per_order()
        assert rows[0]["fill_ratio"] == pytest.approx(0.0)

    def test_overfill_ratio_greater_than_one(self):
        """Overfill (e.g., partial then extra fills) gives ratio > 1."""
        tca = _tca()
        o = _make_order(qty=100.0)
        tca.record_order(o, strategy="m", decision_px=100.0)
        tca.record_fill(_make_fill(qty=120.0, price=100.0))
        rows = tca.per_order()
        assert rows[0]["fill_ratio"] == pytest.approx(1.2)


# ---------------------------------------------------------------------------
# 3. Aggregate by symbol
# ---------------------------------------------------------------------------

class TestAggregateBySymbol:
    def test_two_symbols_separate_groups(self):
        tca = TCA(symbol_region_map={"AAPL": "us", "MSFT": "us"})

        o1 = _make_order(order_id="A1", symbol="AAPL")
        o2 = _make_order(order_id="M1", symbol="MSFT")
        tca.record_order(o1, strategy="m", decision_px=100.0)
        tca.record_order(o2, strategy="m", decision_px=200.0)
        tca.record_fill(_make_fill(order_id="A1", symbol="AAPL", price=101.0, qty=100.0))
        tca.record_fill(_make_fill(order_id="M1", symbol="MSFT", price=201.0, qty=100.0))

        snap = tca.snapshot()
        by_sym = snap["by_symbol"]
        assert "AAPL" in by_sym
        assert "MSFT" in by_sym

    def test_same_symbol_two_orders_aggregated(self):
        tca = _tca()
        o1 = _make_order(order_id="A1", symbol="AAPL", qty=100.0)
        o2 = _make_order(order_id="A2", symbol="AAPL", qty=200.0)
        tca.record_order(o1, strategy="m", decision_px=100.0)
        tca.record_order(o2, strategy="m", decision_px=100.0)
        tca.record_fill(_make_fill(order_id="A1", price=101.0, qty=100.0))
        tca.record_fill(_make_fill(order_id="A2", price=101.0, qty=200.0))

        snap = tca.snapshot()
        aapl_agg = snap["by_symbol"]["AAPL"]
        assert aapl_agg["orders"] == 2
        assert aapl_agg["qty_filled"] == pytest.approx(300.0)

    def test_per_order_rows_include_symbol_field(self):
        tca = _tca()
        o = _make_order(symbol="AAPL")
        tca.record_order(o, strategy="m", decision_px=100.0)
        tca.record_fill(_make_fill(price=100.0, qty=100.0))
        per = tca.per_order()
        assert per[0]["symbol"] == "AAPL"

    def test_snapshot_by_symbol_absent_when_no_fills(self):
        """If order has no fills, IS_bps is None and it won't appear in aggregates."""
        tca = _tca()
        o = _make_order(symbol="AAPL")
        tca.record_order(o, strategy="m", decision_px=100.0)
        snap = tca.snapshot()
        # by_symbol may be empty or missing AAPL since IS_bps is None
        by_sym = snap["by_symbol"]
        assert "AAPL" not in by_sym or by_sym["AAPL"] == {}


# ---------------------------------------------------------------------------
# 4. Multiple partial fills sum to correct filled_qty
# ---------------------------------------------------------------------------

class TestMultiplePartialFills:
    def test_three_partial_fills_sum_qty(self):
        tca = _tca()
        o = _make_order(qty=100.0)
        tca.record_order(o, strategy="m", decision_px=150.0)
        tca.record_fill(_make_fill(qty=30.0, price=151.0, ts=_BASE_TS + 1))
        tca.record_fill(_make_fill(qty=40.0, price=152.0, ts=_BASE_TS + 2))
        tca.record_fill(_make_fill(qty=30.0, price=153.0, ts=_BASE_TS + 3))

        rows = tca.per_order()
        assert rows[0]["filled_qty"] == pytest.approx(100.0)

    def test_vwap_correct_across_partials(self):
        tca = _tca()
        o = _make_order(qty=100.0)
        tca.record_order(o, strategy="m", decision_px=100.0)
        # 40 @ 100, 60 @ 110 → VWAP = (40*100 + 60*110)/100 = (4000+6600)/100 = 106
        tca.record_fill(_make_fill(qty=40.0, price=100.0, ts=_BASE_TS + 1))
        tca.record_fill(_make_fill(qty=60.0, price=110.0, ts=_BASE_TS + 2))

        rows = tca.per_order()
        assert rows[0]["vwap_fill"] == pytest.approx(106.0, rel=1e-4)

    def test_partial_count_increments(self):
        tca = _tca()
        o = _make_order(qty=100.0)
        tca.record_order(o, strategy="m", decision_px=100.0)
        tca.record_fill(_make_fill(qty=25.0, price=100.0, ts=_BASE_TS + 1))
        tca.record_fill(_make_fill(qty=25.0, price=100.0, ts=_BASE_TS + 2))
        tca.record_fill(_make_fill(qty=50.0, price=100.0, ts=_BASE_TS + 3))

        rows = tca.per_order()
        assert rows[0]["partials"] == 3

    def test_fill_ratio_after_partials(self):
        tca = _tca()
        o = _make_order(qty=200.0)
        tca.record_order(o, strategy="m", decision_px=100.0)
        tca.record_fill(_make_fill(qty=100.0, price=100.0, ts=_BASE_TS + 1))
        tca.record_fill(_make_fill(qty=50.0, price=100.0, ts=_BASE_TS + 2))
        # 150 / 200 = 0.75
        rows = tca.per_order()
        assert rows[0]["fill_ratio"] == pytest.approx(0.75)


# ---------------------------------------------------------------------------
# 5. Cancel after partial fill gives correct cancel count
# ---------------------------------------------------------------------------

class TestCancelAfterPartialFill:
    def test_cancel_increments_cancel_count(self):
        tca = _tca()
        o = _make_order(order_id="C1", qty=100.0)
        tca.record_order(o, strategy="m", decision_px=100.0)
        tca.record_fill(_make_fill(order_id="C1", qty=50.0, price=100.0))
        tca.record_cancel("C1")

        rows = tca.per_order()
        assert rows[0]["cancels"] == 1

    def test_cancel_marks_order_closed(self):
        tca = _tca()
        o = _make_order(order_id="C2", qty=100.0)
        tca.record_order(o, strategy="m", decision_px=100.0)
        tca.record_cancel("C2")
        # The internal order info should be closed
        assert tca.orders["C2"].order.is_closed is True

    def test_filled_qty_preserved_after_cancel(self):
        """Cancelling doesn't remove already-filled quantity."""
        tca = _tca()
        o = _make_order(order_id="C3", qty=100.0)
        tca.record_order(o, strategy="m", decision_px=100.0)
        tca.record_fill(_make_fill(order_id="C3", qty=30.0, price=100.0))
        tca.record_cancel("C3")

        rows = tca.per_order()
        assert rows[0]["filled_qty"] == pytest.approx(30.0)

    def test_cancel_on_unknown_order_is_no_op(self):
        """Cancelling an unknown order_id should not raise."""
        tca = _tca()
        tca.record_cancel("DOES-NOT-EXIST")  # should not raise

    def test_multiple_cancels_counted_individually(self):
        """Multiple cancel() calls on same id keep incrementing."""
        tca = _tca()
        o = _make_order(order_id="C4", qty=100.0)
        tca.record_order(o, strategy="m", decision_px=100.0)
        tca.record_cancel("C4")
        tca.record_cancel("C4")
        rows = tca.per_order()
        assert rows[0]["cancels"] == 2


# ---------------------------------------------------------------------------
# 6. TCA with no fills gives fill_ratio=0
# ---------------------------------------------------------------------------

class TestNoFills:
    def test_fill_ratio_is_zero_with_no_fills(self):
        tca = _tca()
        o = _make_order(qty=100.0)
        tca.record_order(o, strategy="m", decision_px=150.0)
        rows = tca.per_order()
        assert rows[0]["fill_ratio"] == pytest.approx(0.0)

    def test_filled_qty_is_zero_with_no_fills(self):
        tca = _tca()
        o = _make_order(qty=100.0)
        tca.record_order(o, strategy="m", decision_px=150.0)
        rows = tca.per_order()
        assert rows[0]["filled_qty"] == pytest.approx(0.0)

    def test_vwap_fill_is_none_or_zero_with_no_fills(self):
        tca = _tca()
        o = _make_order(qty=100.0)
        tca.record_order(o, strategy="m", decision_px=150.0)
        rows = tca.per_order()
        # vwap_fill is None when filled_qty==0 (per implementation)
        assert rows[0]["vwap_fill"] is None

    def test_is_bps_is_none_with_no_fills(self):
        tca = _tca()
        o = _make_order(qty=100.0)
        tca.record_order(o, strategy="m", decision_px=150.0)
        rows = tca.per_order()
        assert rows[0]["IS_bps"] is None

    def test_n_fills_is_zero(self):
        tca = _tca()
        o = _make_order(qty=100.0)
        tca.record_order(o, strategy="m", decision_px=150.0)
        rows = tca.per_order()
        assert rows[0]["n_fills"] == 0

    def test_snapshot_totals_empty_when_no_fills(self):
        """With no fills, IS_bps is None → aggregate ignores all rows → totals = {}."""
        tca = _tca()
        o = _make_order(qty=100.0)
        tca.record_order(o, strategy="m", decision_px=150.0)
        snap = tca.snapshot()
        assert snap["totals"] == {}

    def test_multiple_orders_no_fills_all_zero_ratio(self):
        tca = _tca()
        for i in range(5):
            o = _make_order(order_id=f"ORD-{i}", qty=float(10 * (i + 1)))
            tca.record_order(o, strategy="m", decision_px=100.0)
        rows = tca.per_order()
        assert len(rows) == 5
        for row in rows:
            assert row["fill_ratio"] == pytest.approx(0.0)
