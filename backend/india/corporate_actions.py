# backend/india/corporate_actions.py
"""NSE corporate actions tracker — dividends, splits, bonus, rights, mergers."""
from __future__ import annotations

import json
import os
from datetime import date
from typing import Dict, List, Optional
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


ACTION_TYPES = {"dividend", "split", "bonus", "rights", "merger", "demerger", "buyback"}


def get_upcoming_actions(symbol: str, r=None) -> List[Dict]:
    """Return list of upcoming corporate actions for a symbol from Redis cache."""
    rc = r or _get_r()
    raw = rc.get(f"nse:corp_actions:{symbol}")
    return json.loads(raw) if raw else []


def cache_action(symbol: str, action: Dict, r=None) -> None:
    """
    Cache a corporate action event.
    action = {"type": "dividend", "ex_date": "2024-03-15", "value": 5.0, "ratio": None}
    """
    rc = r or _get_r()
    key = f"nse:corp_actions:{symbol}"
    existing = json.loads(rc.get(key) or "[]")
    existing.append(action)
    rc.set(key, json.dumps(existing), ex=86400 * 7)  # 7-day cache


def has_action_in_window(symbol: str, days_ahead: int = 5, r=None) -> bool:
    """True if any corporate action falls within the next N calendar days."""
    actions = get_upcoming_actions(symbol, r)
    today = date.today()
    for act in actions:
        try:
            ex = date.fromisoformat(act["ex_date"])
            if 0 <= (ex - today).days <= days_ahead:
                return True
        except (KeyError, ValueError):
            continue
    return False


def dividend_yield_impact(symbol: str, spot: float, r=None) -> float:
    """Approximate annualized dividend yield from upcoming actions."""
    actions = get_upcoming_actions(symbol, r)
    if not actions or spot <= 0:
        return 0.0
    total_div = sum(
        float(a.get("value", 0))
        for a in actions
        if a.get("type") == "dividend"
    )
    return round(total_div / spot, 6)


def split_adjusted_qty(qty: float, symbol: str, r=None) -> float:
    """Return qty adjusted for any pending stock split (ratio applied forward)."""
    actions = get_upcoming_actions(symbol, r)
    for act in actions:
        if act.get("type") == "split":
            ratio = act.get("ratio", 1.0)
            return qty * float(ratio) if ratio else qty
    return qty
