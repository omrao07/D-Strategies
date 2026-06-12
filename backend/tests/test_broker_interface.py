# test_broker_interface.py
# Pytest test suite for backend/api/broker_interface.py
#
# Tests:
#   - PaperBroker.place_order() buy reduces cash and creates a position
#   - PaperBroker.place_order() sell increases cash and reduces position
#   - PaperBroker.get_account() equity = cash + mark-to-market of positions
#   - PaperBroker.cancel_order() removes the order
#   - Position.apply_fill() tracks quantity and average price across multiple fills
#   - new_order() helper creates an Order with UUID id
#   - ZerodhaBroker raises RuntimeError when _HAVE_KITE=False
#   - IBKRBroker raises RuntimeError when _HAVE_IB=False
#   - make_broker({"broker": {"name": "paper"}}) returns PaperBroker
#
# Run:
#   pytest -q backend/tests/test_broker_interface.py

from __future__ import annotations

import time
import uuid
from unittest.mock import patch

import pytest

import backend.api.broker_interface as bi
from backend.api.broker_interface import (
    Fill,
    Order,
    PaperBroker,
    Position,
    make_broker,
    new_order,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_broker(starting_cash: float = 100_000.0, fees_bps: float = 0.0, slippage_bps: float = 0.0) -> PaperBroker:
    """Return a PaperBroker with controllable costs."""
    return PaperBroker(starting_cash=starting_cash, fees_bps=fees_bps, slippage_bps=slippage_bps)


def _order(symbol: str, side: str, qty: float, price: float) -> Order:
    return Order(
        id=str(uuid.uuid4()),
        symbol=symbol,
        side=side,
        qty=float(abs(qty)),
        price=float(price),
    )


# ---------------------------------------------------------------------------
# 1. PaperBroker.place_order() — buy
# ---------------------------------------------------------------------------

class TestPaperBrokerBuyOrder:
    def test_buy_reduces_cash(self):
        broker = _make_broker(starting_cash=50_000.0)
        broker.set_prices({"AAPL": 100.0})
        o = _order("AAPL", "buy", 10, 100.0)
        broker.place_order(o)
        acct = broker.get_account()
        # Bought 10 @ 100 → cash reduced by 1000
        assert acct.cash == pytest.approx(49_000.0, rel=1e-4)

    def test_buy_creates_position(self):
        broker = _make_broker(starting_cash=50_000.0)
        broker.set_prices({"AAPL": 100.0})
        o = _order("AAPL", "buy", 10, 100.0)
        broker.place_order(o)
        positions = broker.get_positions()
        assert "AAPL" in positions
        assert positions["AAPL"].qty == pytest.approx(10.0)

    def test_buy_position_avg_price_is_fill_price(self):
        broker = _make_broker(starting_cash=50_000.0)
        broker.set_prices({"AAPL": 150.0})
        o = _order("AAPL", "buy", 5, 150.0)
        broker.place_order(o)
        positions = broker.get_positions()
        assert positions["AAPL"].avg_price == pytest.approx(150.0)

    def test_buy_fill_returned(self):
        broker = _make_broker(starting_cash=50_000.0)
        broker.set_prices({"AAPL": 100.0})
        o = _order("AAPL", "buy", 10, 100.0)
        fill = broker.place_order(o)
        assert fill.order_id == o.id
        assert fill.symbol == "AAPL"
        assert fill.qty == pytest.approx(10.0)


# ---------------------------------------------------------------------------
# 2. PaperBroker.place_order() — sell
# ---------------------------------------------------------------------------

class TestPaperBrokerSellOrder:
    def test_sell_increases_cash(self):
        broker = _make_broker(starting_cash=50_000.0)
        broker.set_prices({"AAPL": 200.0})
        # First buy to create a position
        broker.place_order(_order("AAPL", "buy", 10, 200.0))
        cash_after_buy = broker.get_account().cash

        # Now sell all
        broker.place_order(_order("AAPL", "sell", 10, 200.0))
        cash_after_sell = broker.get_account().cash
        assert cash_after_sell > cash_after_buy

    def test_sell_reduces_position_qty(self):
        broker = _make_broker(starting_cash=100_000.0)
        broker.set_prices({"AAPL": 100.0})
        broker.place_order(_order("AAPL", "buy", 10, 100.0))
        broker.place_order(_order("AAPL", "sell", 4, 100.0))
        positions = broker.get_positions()
        assert positions["AAPL"].qty == pytest.approx(6.0)

    def test_sell_entire_position_leaves_zero_qty(self):
        broker = _make_broker(starting_cash=100_000.0)
        broker.set_prices({"AAPL": 100.0})
        broker.place_order(_order("AAPL", "buy", 10, 100.0))
        broker.place_order(_order("AAPL", "sell", 10, 100.0))
        positions = broker.get_positions()
        assert positions["AAPL"].qty == pytest.approx(0.0, abs=1e-10)

    def test_sell_without_position_goes_short(self):
        """PaperBroker allows short selling — qty becomes negative."""
        broker = _make_broker(starting_cash=100_000.0)
        broker.set_prices({"AAPL": 100.0})
        broker.place_order(_order("AAPL", "sell", 5, 100.0))
        positions = broker.get_positions()
        assert positions["AAPL"].qty == pytest.approx(-5.0)


# ---------------------------------------------------------------------------
# 3. PaperBroker.get_account() equity = cash + mark-to-market
# ---------------------------------------------------------------------------

class TestPaperBrokerGetAccount:
    def test_equity_equals_cash_plus_mtm(self):
        # Use zero fees/slippage so arithmetic is exact
        broker = PaperBroker(starting_cash=100_000.0, fees_bps=0.0, slippage_bps=0.0)
        broker.set_prices({"AAPL": 100.0})
        broker.place_order(_order("AAPL", "buy", 10, 100.0))
        # Mark price to 120
        broker.set_prices({"AAPL": 120.0})
        acct = broker.get_account()
        # Cash = 100_000 - 10*100 = 99_000; MTM = 10*120 = 1200; equity = 100_200
        assert acct.equity == pytest.approx(99_000.0 + 1200.0)

    def test_equity_with_no_positions_equals_cash(self):
        broker = _make_broker(starting_cash=50_000.0)
        acct = broker.get_account()
        assert acct.equity == pytest.approx(50_000.0)
        assert acct.cash == pytest.approx(50_000.0)

    def test_buying_power_is_2x_cash(self):
        broker = _make_broker(starting_cash=40_000.0)
        acct = broker.get_account()
        assert acct.buying_power == pytest.approx(80_000.0)

    def test_account_currency_is_set(self):
        broker = PaperBroker(starting_cash=10_000.0, base_ccy="INR")
        acct = broker.get_account()
        assert acct.currency == "INR"


# ---------------------------------------------------------------------------
# 4. PaperBroker.cancel_order() removes the order
# ---------------------------------------------------------------------------

class TestPaperBrokerCancelOrder:
    def test_cancel_existing_order_returns_true(self):
        broker = _make_broker(starting_cash=100_000.0)
        broker.set_prices({"AAPL": 100.0})
        o = _order("AAPL", "buy", 5, 100.0)
        broker.place_order(o)
        result = broker.cancel_order(o.id)
        assert result is True

    def test_cancel_removes_order_from_open_orders(self):
        broker = _make_broker(starting_cash=100_000.0)
        broker.set_prices({"AAPL": 100.0})
        o = _order("AAPL", "buy", 5, 100.0)
        broker.place_order(o)
        broker.cancel_order(o.id)
        open_orders = broker.get_open_orders()
        assert o.id not in open_orders

    def test_cancel_nonexistent_order_returns_false(self):
        broker = _make_broker()
        result = broker.cancel_order("nonexistent-id-xyz")
        assert result is False

    def test_cancel_twice_returns_false_second_time(self):
        broker = _make_broker(starting_cash=100_000.0)
        broker.set_prices({"AAPL": 100.0})
        o = _order("AAPL", "buy", 5, 100.0)
        broker.place_order(o)
        broker.cancel_order(o.id)
        result = broker.cancel_order(o.id)
        assert result is False


# ---------------------------------------------------------------------------
# 5. Position.apply_fill() — avg price across multiple fills
# ---------------------------------------------------------------------------

class TestPositionApplyFill:
    def _fill(self, order_id: str, symbol: str, side: str, qty: float, price: float) -> Fill:
        return Fill(
            order_id=order_id,
            symbol=symbol,
            side=side,
            qty=qty if side == "buy" else -qty,
            price=price,
            fee=0.0,
            ts=time.time(),
        )

    def test_single_buy_fill(self):
        pos = Position(symbol="AAPL")
        f = self._fill("o1", "AAPL", "buy", 10, 100.0)
        pos.apply_fill(f)
        assert pos.qty == pytest.approx(10.0)
        assert pos.avg_price == pytest.approx(100.0)

    def test_two_buy_fills_avg_price_weighted(self):
        pos = Position(symbol="AAPL")
        pos.apply_fill(self._fill("o1", "AAPL", "buy", 10, 100.0))
        pos.apply_fill(self._fill("o2", "AAPL", "buy", 10, 120.0))
        # Avg = (10*100 + 10*120) / 20 = 110
        assert pos.qty == pytest.approx(20.0)
        assert pos.avg_price == pytest.approx(110.0)

    def test_three_buy_fills_avg_price_weighted(self):
        pos = Position(symbol="TSLA")
        pos.apply_fill(self._fill("o1", "TSLA", "buy", 5, 200.0))
        pos.apply_fill(self._fill("o2", "TSLA", "buy", 10, 210.0))
        pos.apply_fill(self._fill("o3", "TSLA", "buy", 5, 220.0))
        # Avg = (5*200 + 10*210 + 5*220) / 20 = (1000 + 2100 + 1100)/20 = 4200/20 = 210
        assert pos.qty == pytest.approx(20.0)
        assert pos.avg_price == pytest.approx(210.0)

    def test_buy_then_partial_sell_reduces_qty(self):
        pos = Position(symbol="AAPL")
        pos.apply_fill(self._fill("o1", "AAPL", "buy", 10, 100.0))
        pos.apply_fill(self._fill("o2", "AAPL", "sell", 4, 110.0))
        assert pos.qty == pytest.approx(6.0)

    def test_full_sell_zeroes_qty_and_avg(self):
        pos = Position(symbol="AAPL")
        pos.apply_fill(self._fill("o1", "AAPL", "buy", 10, 100.0))
        pos.apply_fill(self._fill("o2", "AAPL", "sell", 10, 100.0))
        assert pos.qty == pytest.approx(0.0, abs=1e-10)
        assert pos.avg_price == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# 6. new_order() helper
# ---------------------------------------------------------------------------

class TestNewOrderHelper:
    def test_returns_order_instance(self):
        o = new_order("AAPL", "buy", 10, 150.0)
        assert isinstance(o, Order)

    def test_id_is_uuid_string(self):
        o = new_order("AAPL", "buy", 10, 150.0)
        # Must parse as a valid UUID
        parsed = uuid.UUID(o.id)
        assert str(parsed) == o.id

    def test_ids_are_unique(self):
        o1 = new_order("AAPL", "buy", 10, 150.0)
        o2 = new_order("AAPL", "buy", 10, 150.0)
        assert o1.id != o2.id

    def test_side_is_lowercased(self):
        o = new_order("AAPL", "BUY", 10, 150.0)
        assert o.side == "buy"

    def test_qty_is_absolute(self):
        o = new_order("AAPL", "sell", -5, 100.0)
        assert o.qty == pytest.approx(5.0)

    def test_fields_propagated(self):
        o = new_order("MSFT", "sell", 3, 300.0, type="limit", tif="gtc", strategy="momentum")
        assert o.symbol == "MSFT"
        assert o.price == pytest.approx(300.0)
        assert o.type == "limit"
        assert o.tif == "gtc"
        assert o.strategy == "momentum"


# ---------------------------------------------------------------------------
# 7. ZerodhaBroker raises RuntimeError when _HAVE_KITE=False
# ---------------------------------------------------------------------------

class TestZerodhaBrokerNoKite:
    def test_raises_runtime_error_when_kite_not_installed(self):
        with patch.object(bi, "_HAVE_KITE", False):
            with pytest.raises(RuntimeError, match="pip install kiteconnect"):
                bi.ZerodhaBroker(api_key="dummy", access_token="dummy")


# ---------------------------------------------------------------------------
# 8. IBKRBroker raises RuntimeError when _HAVE_IB=False
# ---------------------------------------------------------------------------

class TestIBKRBrokerNoIB:
    def test_raises_runtime_error_when_ib_insync_not_installed(self):
        with patch.object(bi, "_HAVE_IB", False):
            with pytest.raises(RuntimeError, match="pip install ib_insync"):
                bi.IBKRBroker()


# ---------------------------------------------------------------------------
# 9. make_broker factory
# ---------------------------------------------------------------------------

class TestMakeBroker:
    def test_paper_broker_returned_for_paper_name(self):
        broker = make_broker({"broker": {"name": "paper"}})
        assert isinstance(broker, PaperBroker)

    def test_paper_broker_is_default(self):
        broker = make_broker({})
        assert isinstance(broker, PaperBroker)

    def test_paper_broker_starting_cash_passed(self):
        broker = make_broker({"broker": {"name": "paper", "starting_cash": 500_000}})
        assert isinstance(broker, PaperBroker)
        acct = broker.get_account()
        assert acct.cash == pytest.approx(500_000.0)

    def test_unknown_broker_name_raises_value_error(self):
        with pytest.raises(ValueError, match="Unknown broker"):
            make_broker({"broker": {"name": "nonexistent_broker"}})

    def test_ibkr_broker_raises_without_ib_insync(self):
        with patch.object(bi, "_HAVE_IB", False):
            with pytest.raises(RuntimeError):
                make_broker({"broker": {"name": "ibkr"}})

    def test_zerodha_broker_raises_without_kiteconnect(self):
        with patch.object(bi, "_HAVE_KITE", False):
            with pytest.raises((RuntimeError, KeyError)):
                make_broker({"broker": {"name": "zerodha", "api_key": "x", "access_token": "y"}})
