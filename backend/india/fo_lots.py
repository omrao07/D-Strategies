# backend/india/fo_lots.py
"""
NSE F&O lot sizes. Updated per NSE circular (approximate for 2025).
Returns lot size for a given symbol; falls back to 1 if unknown.
"""
from __future__ import annotations

from typing import Dict

# NSE F&O lot sizes (shares per lot). Keep updated with NSE circulars.
FO_LOT_SIZES: Dict[str, int] = {
    # Index
    "NIFTY": 25,
    "BANKNIFTY": 15,
    "FINNIFTY": 40,
    "MIDCPNIFTY": 75,
    "NIFTYNXT50": 10,
    "SENSEX": 10,
    "BANKEX": 15,
    # Large cap stocks
    "RELIANCE": 250,
    "TCS": 150,
    "INFY": 300,
    "HDFCBANK": 550,
    "ICICIBANK": 700,
    "HINDUNILVR": 300,
    "KOTAKBANK": 400,
    "SBIN": 1500,
    "AXISBANK": 1200,
    "BAJFINANCE": 125,
    "BAJAJFINSV": 500,
    "LT": 175,
    "WIPRO": 1500,
    "TECHM": 600,
    "HCLTECH": 700,
    "ULTRACEMCO": 100,
    "ASIANPAINT": 200,
    "NESTLEIND": 40,
    "MARUTI": 50,
    "TITAN": 375,
    "SUNPHARMA": 700,
    "DRREDDY": 125,
    "CIPLA": 650,
    "DIVISLAB": 200,
    "APOLLOHOSP": 125,
    "ADANIENT": 125,
    "ADANIPORTS": 625,
    "ONGC": 1925,
    "COALINDIA": 4200,
    "NTPC": 3375,
    "POWERGRID": 4000,
    "BPCL": 1800,
    "EICHERMOT": 175,
    "HEROMOTOCO": 300,
    "TATAMOTORS": 1425,
    "TATASTEEL": 5500,
    "JSWSTEEL": 1350,
    "HINDALCO": 1075,
    "GRASIM": 250,
    "BRITANNIA": 200,
    "ITC": 3200,
    "VEDL": 2000,
    "INDUSINDBK": 500,
    "M&M": 700,
    "BAJAJ-AUTO": 250,
}


def get_lot_size(symbol: str, default: int = 1) -> int:
    """Return the F&O lot size for symbol. Returns default if not found."""
    sym = symbol.upper().replace("-", "").replace("&", "&")
    return FO_LOT_SIZES.get(sym, FO_LOT_SIZES.get(symbol.upper(), default))


def fo_ban_list() -> frozenset:
    """
    Returns current F&O ban list symbols. In production, fetch from NSE.
    Stub returns empty set — wire to NSE API or daily file in prod.
    """
    return frozenset()
