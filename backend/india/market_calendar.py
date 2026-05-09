# backend/india/market_calendar.py
"""
NSE/BSE market calendar for India.
Provides: trading hours check, holiday lookup, next/prev trading day.
"""
from __future__ import annotations

import datetime
from typing import FrozenSet, Optional

# NSE trading hours (IST = UTC+5:30)
_OPEN_H, _OPEN_M = 9, 15
_CLOSE_H, _CLOSE_M = 15, 30

# NSE holidays for 2025–2026 (add more as needed)
_NSE_HOLIDAYS_2025: FrozenSet[datetime.date] = frozenset([
    datetime.date(2025, 1, 26),   # Republic Day
    datetime.date(2025, 2, 26),   # Mahashivratri
    datetime.date(2025, 3, 14),   # Holi
    datetime.date(2025, 3, 31),   # Id-Ul-Fitr (Ramzan Eid)
    datetime.date(2025, 4, 10),   # Shri Mahavir Jayanti
    datetime.date(2025, 4, 14),   # Dr. Baba Saheb Ambedkar Jayanti
    datetime.date(2025, 4, 18),   # Good Friday
    datetime.date(2025, 5, 1),    # Maharashtra Day
    datetime.date(2025, 6, 7),    # Eid Al Adha
    datetime.date(2025, 8, 15),   # Independence Day
    datetime.date(2025, 8, 27),   # Ganesh Chaturthi
    datetime.date(2025, 10, 2),   # Gandhi Jayanti / Dussehra
    datetime.date(2025, 10, 20),  # Diwali Laxmi Puja
    datetime.date(2025, 10, 21),  # Diwali Balipratipada
    datetime.date(2025, 11, 5),   # Prakash Gurpurb
    datetime.date(2025, 12, 25),  # Christmas
])

_NSE_HOLIDAYS_2026: FrozenSet[datetime.date] = frozenset([
    datetime.date(2026, 1, 26),   # Republic Day
    datetime.date(2026, 3, 4),    # Mahashivratri
    datetime.date(2026, 3, 20),   # Holi
    datetime.date(2026, 4, 3),    # Good Friday
    datetime.date(2026, 4, 14),   # Dr. Baba Saheb Ambedkar Jayanti
    datetime.date(2026, 5, 1),    # Maharashtra Day
    datetime.date(2026, 8, 15),   # Independence Day
    datetime.date(2026, 10, 2),   # Gandhi Jayanti
    datetime.date(2026, 12, 25),  # Christmas
])


def _all_holidays() -> FrozenSet[datetime.date]:
    return _NSE_HOLIDAYS_2025 | _NSE_HOLIDAYS_2026


class IndiaMarketCalendar:
    """NSE/BSE market calendar."""

    HOLIDAYS: FrozenSet[datetime.date] = _all_holidays()

    @classmethod
    def is_holiday(cls, d: datetime.date) -> bool:
        return d in cls.HOLIDAYS

    @classmethod
    def is_weekend(cls, d: datetime.date) -> bool:
        return d.weekday() >= 5  # Saturday=5, Sunday=6

    @classmethod
    def is_trading_day(cls, d: datetime.date) -> bool:
        return not cls.is_weekend(d) and not cls.is_holiday(d)

    @classmethod
    def is_market_open(cls, dt: Optional[datetime.datetime] = None) -> bool:
        """Check if NSE is currently open (IST)."""
        import zoneinfo
        ist = zoneinfo.ZoneInfo("Asia/Kolkata")
        now = dt or datetime.datetime.now(tz=ist)
        if not cls.is_trading_day(now.date()):
            return False
        open_t = now.replace(hour=_OPEN_H, minute=_OPEN_M, second=0, microsecond=0)
        close_t = now.replace(hour=_CLOSE_H, minute=_CLOSE_M, second=0, microsecond=0)
        return open_t <= now <= close_t

    @classmethod
    def next_trading_day(cls, d: datetime.date) -> datetime.date:
        nxt = d + datetime.timedelta(days=1)
        while not cls.is_trading_day(nxt):
            nxt += datetime.timedelta(days=1)
        return nxt

    @classmethod
    def prev_trading_day(cls, d: datetime.date) -> datetime.date:
        prv = d - datetime.timedelta(days=1)
        while not cls.is_trading_day(prv):
            prv -= datetime.timedelta(days=1)
        return prv

    @classmethod
    def trading_days_between(cls, start: datetime.date, end: datetime.date) -> int:
        """Count trading days in [start, end] inclusive."""
        count = 0
        d = start
        while d <= end:
            if cls.is_trading_day(d):
                count += 1
            d += datetime.timedelta(days=1)
        return count
