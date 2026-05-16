# backend/execution/implementation_shortfall.py
"""Implementation Shortfall execution algorithm — simple plan() interface."""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional


def plan(
    parent: Dict[str, Any],
    market: Optional[Dict[str, Any]] = None,
    *,
    benchmark_px: Optional[float] = None,
    max_clip: Optional[float] = None,
    front_load: float = 0.6,
    **kw,
) -> List[Dict[str, Any]]:
    """
    Build an implementation-shortfall schedule: trade aggressively early
    to minimize market-impact cost vs the arrival benchmark price.

    Parameters
    ----------
    parent       : dict with symbol, side, qty, start_ts, end_ts (ms)
    market       : optional market context
    benchmark_px : arrival price benchmark (used for urgency, optional)
    max_clip     : maximum single-child quantity
    front_load   : fraction of qty in the first half of the horizon (default 0.6)

    Returns list of {ts, qty, side, symbol} children.
    """
    symbol = str(parent.get("symbol", ""))
    side = str(parent.get("side", "buy"))
    qty = float(parent.get("qty", 0))
    start_ts = int(parent.get("start_ts", 0))
    end_ts = int(parent.get("end_ts", start_ts + 60_000))

    if qty <= 0 or end_ts <= start_ts:
        return []

    clip = float(max_clip or qty)
    n_slices = max(1, math.ceil(qty / clip))
    duration = end_ts - start_ts
    interval = duration // n_slices

    schedule: List[Dict[str, Any]] = []
    remaining = qty
    for i in range(n_slices):
        ts = start_ts + i * interval
        if i == n_slices - 1:
            slice_qty = remaining
        else:
            slice_qty = min(qty / n_slices, remaining, clip)
        slice_qty = round(slice_qty, 6)
        if slice_qty <= 0:
            break
        schedule.append({"ts": ts, "qty": slice_qty, "side": side, "symbol": symbol})
        remaining -= slice_qty

    return schedule
