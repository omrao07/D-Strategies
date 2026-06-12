# backend/india/weekly_expiry_manager.py
"""NSE weekly F&O expiry tracking — Nifty/BankNifty/FinNifty/Midcap expire Thursdays."""
from __future__ import annotations

import os
from datetime import date, timedelta
from typing import Optional

import redis

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

_r: Optional[redis.Redis] = None

def _get_r() -> redis.Redis:
    global _r
    if _r is None:
        _r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT,
                         password=os.getenv("REDIS_PASSWORD") or None,
                         decode_responses=True)
    return _r

# Indices with weekly Thursday expiry on NSE
WEEKLY_EXPIRY_INDICES = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"}

def next_expiry(ref: Optional[date] = None) -> date:
    """Return the next Thursday expiry from ref date (defaults to today)."""
    d = ref or date.today()
    days_ahead = (3 - d.weekday()) % 7  # Thursday = 3
    if days_ahead == 0:
        days_ahead = 7
    return d + timedelta(days=days_ahead)

def current_expiry(ref: Optional[date] = None) -> date:
    """Return current week's Thursday expiry (today if it is Thursday)."""
    d = ref or date.today()
    days_ahead = (3 - d.weekday()) % 7
    return d + timedelta(days=days_ahead)

def days_to_expiry(ref: Optional[date] = None) -> int:
    """Calendar days until next Thursday expiry."""
    exp = next_expiry(ref)
    return (exp - (ref or date.today())).days

def is_expiry_day(ref: Optional[date] = None) -> bool:
    d = ref or date.today()
    return d.weekday() == 3  # Thursday

def monthly_expiry(year: int, month: int) -> date:
    """Last Thursday of the month (monthly F&O expiry)."""
    # Find last day, walk back to Thursday
    last = date(year, month, 28)
    while True:
        nxt = last + timedelta(days=1)
        if nxt.month != month:
            break
        last = nxt
    while last.weekday() != 3:
        last -= timedelta(days=1)
    return last

def cache_expiry_data(r=None):
    """Persist expiry info to Redis for downstream use."""
    rc = r or _get_r()
    exp = next_expiry()
    rc.set("india:next_weekly_expiry", exp.isoformat())
    rc.set("india:days_to_expiry", str(days_to_expiry()))
    return exp
