# backend/execution/pov.py
"""POV (Participation-of-Volume) execution algorithm — simple plan() interface."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

_DEFAULT_ASSUMED_MKT_VOL_PER_SEC = 80.0  # conservative shares/sec assumption


def plan(
    parent: Dict[str, Any],
    market: Optional[Dict[str, Any]] = None,
    *,
    target_pov: float = 0.10,
    tick_ms: int = 1_000,
    assumed_mkt_vol_per_sec: float = _DEFAULT_ASSUMED_MKT_VOL_PER_SEC,
    **kw,
) -> List[Dict[str, Any]]:
    """
    Produce a static participation-of-volume schedule.

    Each child's quantity is bounded by target_pov × assumed market volume
    per tick. Total filled may be less than parent.qty if the participation
    cap limits throughput.

    Parameters
    ----------
    parent                  : dict with symbol, side, qty, start_ts, end_ts (ms)
    market                  : optional context (unused in static plan)
    target_pov              : target fraction of market volume per tick
    tick_ms                 : interval between children in ms
    assumed_mkt_vol_per_sec : assumed market volume per second (conservative default)

    Returns list of {ts, qty, side, symbol} children.
    """
    symbol = str(parent.get("symbol", ""))
    side = str(parent.get("side", "buy"))
    qty = float(parent.get("qty", 0))
    start_ts = int(parent.get("start_ts", 0))
    end_ts = int(parent.get("end_ts", start_ts + 60_000))

    if qty <= 0 or end_ts <= start_ts:
        return []

    vol_per_tick = assumed_mkt_vol_per_sec * (tick_ms / 1000.0)
    child_qty_per_tick = target_pov * vol_per_tick

    schedule: List[Dict[str, Any]] = []
    remaining = qty
    ts = start_ts
    while ts <= end_ts and remaining > 0:
        slice_qty = min(child_qty_per_tick, remaining)
        slice_qty = round(slice_qty, 6)
        if slice_qty > 0:
            schedule.append({"ts": ts, "qty": slice_qty, "side": side, "symbol": symbol})
            remaining -= slice_qty
        ts += tick_ms

    return schedule
