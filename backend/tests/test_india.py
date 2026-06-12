# backend/tests/test_india.py
"""Tests for backend/india/ modules."""
import datetime

from backend.india.circuit_breakers import CircuitBreakerChecker
from backend.india.fo_lots import get_lot_size
from backend.india.market_calendar import IndiaMarketCalendar


def test_trading_day_weekday():
    # 2025-01-02 is a Thursday (not a holiday)
    d = datetime.date(2025, 1, 2)
    assert IndiaMarketCalendar.is_trading_day(d)


def test_trading_day_weekend():
    d = datetime.date(2025, 1, 4)  # Saturday
    assert not IndiaMarketCalendar.is_trading_day(d)


def test_trading_day_republic_day():
    d = datetime.date(2025, 1, 26)  # Republic Day holiday
    assert not IndiaMarketCalendar.is_trading_day(d)


def test_next_trading_day_skips_weekend():
    friday = datetime.date(2025, 1, 3)  # Friday
    nxt = IndiaMarketCalendar.next_trading_day(friday)
    assert nxt == datetime.date(2025, 1, 6)  # Monday


def test_next_trading_day_skips_holiday():
    # Day before Republic Day (2025-01-25, Saturday) → next is Mon 2025-01-27
    d = datetime.date(2025, 1, 25)
    nxt = IndiaMarketCalendar.next_trading_day(d)
    assert nxt.weekday() not in (5, 6)
    assert nxt not in IndiaMarketCalendar.HOLIDAYS


def test_trading_days_between():
    # Week of 2025-01-06: Mon-Fri (5 days, no holidays)
    start = datetime.date(2025, 1, 6)
    end = datetime.date(2025, 1, 10)
    count = IndiaMarketCalendar.trading_days_between(start, end)
    assert count == 5


def test_fo_lot_nifty():
    assert get_lot_size("NIFTY") == 25


def test_fo_lot_banknifty():
    assert get_lot_size("BANKNIFTY") == 15


def test_fo_lot_unknown():
    # Unknown symbol should return default=1
    assert get_lot_size("UNKNOWNSYMBOL") == 1


def test_fo_lot_case_insensitive():
    assert get_lot_size("nifty") == get_lot_size("NIFTY")


def test_circuit_within_band():
    # RELIANCE at ref 2500, proposed 2600 = 4% move, default band is 20%
    ok, reason = CircuitBreakerChecker.check_order("RELIANCE", 2500.0, 2600.0)
    assert ok
    assert reason == "ok"


def test_circuit_outside_band():
    # RELIANCE at ref 2500, proposed 3100 = 24% move → outside 20% band
    ok, reason = CircuitBreakerChecker.check_order("RELIANCE", 2500.0, 3100.0)
    assert not ok
    assert "price_band" in reason


def test_circuit_index_always_ok():
    # Index should never fail circuit check (it's handled at exchange level)
    ok, reason = CircuitBreakerChecker.check_order("NIFTY", 24000.0, 30000.0)
    assert ok


def test_circuit_zero_ref():
    # Zero ref price → always allowed (no prior data)
    ok, reason = CircuitBreakerChecker.check_order("TCS", 0.0, 3500.0)
    assert ok
