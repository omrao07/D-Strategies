# backend/execution/twap.py
"""TWAP execution algorithm — simple plan() interface for tests and live use."""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional


def plan(
    parent: Dict[str, Any],
    market: Optional[Dict[str, Any]] = None,
    *,
    clip_size: Optional[float] = None,
    **kw,
) -> List[Dict[str, Any]]:
    """
    Slice a parent order into near-uniform time-weighted child orders.

    Parameters
    ----------
    parent   : dict with symbol, side, qty, start_ts, end_ts (ms), optional clip_size
    market   : ignored (placeholder for live context)
    clip_size: max single-child qty; defaults to parent['clip_size'] or no cap

    Returns list of {ts, qty, side, symbol} children.
    """
    symbol = str(parent.get("symbol", ""))
    side = str(parent.get("side", "buy"))
    qty = float(parent.get("qty", 0))
    start_ts = int(parent.get("start_ts", 0))
    end_ts = int(parent.get("end_ts", start_ts + 60_000))

    if clip_size is None:
        clip_size = float(parent.get("clip_size") or qty)
    clip_size = float(clip_size)

    if qty <= 0 or end_ts <= start_ts:
        return []

    n_slices = max(1, math.ceil(qty / clip_size))
    duration = end_ts - start_ts
    interval = duration // n_slices

    schedule: List[Dict[str, Any]] = []
    remaining = qty
    for i in range(n_slices):
        ts = start_ts + i * interval
        slice_qty = qty / n_slices if i < n_slices - 1 else remaining
        slice_qty = round(slice_qty, 6)
        if slice_qty <= 0:
            break
        schedule.append({"ts": ts, "qty": slice_qty, "side": side, "symbol": symbol})
        remaining -= slice_qty

    return schedule
