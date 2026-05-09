"""
Live engine configuration — environment variables, market calendar, and symbol universe.

All environment variables have safe defaults so the engine can start in paper-trading
mode without any .env file present.  Production deployments override via Docker/K8s
environment injection.
"""
from __future__ import annotations

import os
from datetime import date, time
from typing import List, Set

try:
    import pytz
    IST = pytz.timezone("Asia/Kolkata")
except ImportError:
    import zoneinfo  # Python 3.9+
    IST = zoneinfo.ZoneInfo("Asia/Kolkata")  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Market hours (IST)
# ---------------------------------------------------------------------------
MARKET_OPEN: time = time(9, 15)
MARKET_CLOSE: time = time(15, 30)
PRE_MARKET_START: time = time(9, 10)

# ---------------------------------------------------------------------------
# Redis
# ---------------------------------------------------------------------------
REDIS_HOST: str = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT: int = int(os.getenv("REDIS_PORT", "6379"))
REDIS_PASSWORD: str | None = os.getenv("REDIS_PASSWORD") or None

# ---------------------------------------------------------------------------
# Telegram
# ---------------------------------------------------------------------------
TELEGRAM_BOT_TOKEN: str = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID: str = os.getenv("TELEGRAM_CHAT_ID", "")

# ---------------------------------------------------------------------------
# Zerodha
# ---------------------------------------------------------------------------
ZERODHA_API_KEY: str = os.getenv("ZERODHA_API_KEY", "")
ZERODHA_API_SECRET: str = os.getenv("ZERODHA_API_SECRET", "")
ZERODHA_ACCESS_TOKEN: str = os.getenv("ZERODHA_ACCESS_TOKEN", "")

# ---------------------------------------------------------------------------
# Portfolio / risk
# ---------------------------------------------------------------------------
CAPITAL_BASE: float = float(os.getenv("CAPITAL_BASE", "10000000"))          # ₹1 Cr default
MAX_DAILY_LOSS_PCT: float = float(os.getenv("MAX_DAILY_LOSS_PCT", "2.0"))   # 2% of capital
MAX_DRAWDOWN_PCT: float = float(os.getenv("MAX_DRAWDOWN_PCT", "10.0"))      # 10% from peak
NIFTY_VIX_HALT_THRESHOLD: float = float(os.getenv("NIFTY_VIX_HALT_THRESHOLD", "30.0"))
FOB_API_URL: str = os.getenv(
    "FOB_API_URL",
    "https://www.nseindia.com/api/fo-ban-list-page",
)
NSE_CIRCUIT_BREAKER_URL: str = os.getenv(
    "NSE_CIRCUIT_BREAKER_URL",
    "https://www.nseindia.com/api/marketStatus",
)

# ---------------------------------------------------------------------------
# Nifty 50 symbol universe
# ---------------------------------------------------------------------------
NIFTY50_SYMBOLS: List[str] = [
    "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK",
    "BAJAJ-AUTO", "BAJAJFINSV", "BAJFINANCE", "BHARTIARTL", "BPCL",
    "BRITANNIA", "CIPLA", "COALINDIA", "DIVISLAB", "DRREDDY",
    "EICHERMOT", "GRASIM", "HCLTECH", "HDFC", "HDFCBANK",
    "HDFCLIFE", "HEROMOTOCO", "HINDALCO", "HINDUNILVR", "ICICIBANK",
    "INDUSINDBK", "INFY", "ITC", "JSWSTEEL", "KOTAKBANK",
    "LT", "LTIM", "M&M", "MARUTI", "NESTLEIND",
    "NTPC", "ONGC", "POWERGRID", "RELIANCE", "SBILIFE",
    "SBIN", "SUNPHARMA", "TATACONSUM", "TATAMOTORS", "TATASTEEL",
    "TCS", "TECHM", "TITAN", "ULTRACEMCO", "WIPRO",
]

# ---------------------------------------------------------------------------
# Nifty 500 — Nifty50 + common large-cap extension (60 symbols total)
# ---------------------------------------------------------------------------
_EXTRA_LARGECAP: List[str] = [
    "ABB", "AMBUJACEM", "AUROPHARMA", "BANDHANBNK", "BANKBARODA",
    "BEL", "BERGEPAINT", "BIOCON", "BOSCHLTD", "CANBK",
]

NIFTY500_SYMBOLS: List[str] = NIFTY50_SYMBOLS + _EXTRA_LARGECAP

# ---------------------------------------------------------------------------
# NSE holiday calendar — 2025 and 2026 trading holidays
# ---------------------------------------------------------------------------
_NSE_HOLIDAYS_2025: Set[date] = {
    date(2025, 1, 26),   # Republic Day
    date(2025, 2, 26),   # Mahashivratri
    date(2025, 3, 14),   # Holi
    date(2025, 3, 31),   # Id-Ul-Fitr (Ramzan Eid)
    date(2025, 4, 14),   # Dr. Ambedkar Jayanti / Ram Navami
    date(2025, 4, 18),   # Good Friday
    date(2025, 5, 1),    # Maharashtra Day
    date(2025, 8, 15),   # Independence Day
    date(2025, 8, 27),   # Ganesh Chaturthi
    date(2025, 10, 2),   # Gandhi Jayanti / Mahatma Gandhi
    date(2025, 10, 2),   # Dussehra (overlaps — kept once)
    date(2025, 10, 24),  # Diwali (Laxmi Puja)
    date(2025, 11, 5),   # Diwali Balipratipada
    date(2025, 11, 5),   # Prakash Gurpurab (overlap)
    date(2025, 12, 25),  # Christmas
}

_NSE_HOLIDAYS_2026: Set[date] = {
    date(2026, 1, 26),   # Republic Day
    date(2026, 3, 20),   # Holi
    date(2026, 4, 3),    # Good Friday
    date(2026, 4, 10),   # Id-Ul-Fitr (Ramzan Eid) — approximate
    date(2026, 4, 14),   # Dr. Ambedkar Jayanti
    date(2026, 5, 1),    # Maharashtra Day
    date(2026, 8, 15),   # Independence Day
    date(2026, 9, 16),   # Ganesh Chaturthi
    date(2026, 10, 2),   # Gandhi Jayanti
    date(2026, 10, 20),  # Dussehra — approximate
    date(2026, 11, 8),   # Diwali — approximate
    date(2026, 12, 25),  # Christmas
}

NSE_HOLIDAYS: Set[date] = _NSE_HOLIDAYS_2025 | _NSE_HOLIDAYS_2026


def is_market_holiday(d: date) -> bool:
    """Return True if *d* is a recognised NSE trading holiday."""
    return d in NSE_HOLIDAYS


def is_market_open() -> bool:
    """
    Return True if the current IST clock time is within regular NSE market
    hours AND today is not a weekend or a declared holiday.
    """
    import datetime as _dt

    try:
        now_ist = _dt.datetime.now(tz=IST)
    except Exception:
        # Fallback for non-pytz ZoneInfo
        import datetime as _dt2
        now_ist = _dt2.datetime.now(_dt2.timezone.utc).astimezone(IST)  # type: ignore[arg-type]

    today = now_ist.date()

    # Weekend check (Monday=0 … Sunday=6)
    if today.weekday() >= 5:
        return False

    # Holiday check
    if is_market_holiday(today):
        return False

    current_time = now_ist.time().replace(tzinfo=None)
    return MARKET_OPEN <= current_time <= MARKET_CLOSE
