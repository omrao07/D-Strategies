# backend/execution/vwap.py
"""VWAP execution algorithm — simple plan() interface."""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional


# Default U-shaped volume profile: (time_fraction, cum_volume_fraction)
_DEFAULT_UCURVE = [
    (0.00, 0.00),
    (0.10, 0.18),
    (0.25, 0.35),
    (0.50, 0.62),
    (0.75, 0.83),
    (1.00, 1.00),
]


def _interp(curve: list, x: float) -> float:
    """Linear interpolation on (x, y) curve."""
    for i in range(len(curve) - 1):
        x0, y0 = curve[i]
        x1, y1 = curve[i + 1]
        if x0 <= x <= x1:
            if x1 == x0:
                return y0
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return curve[-1][1]


def plan(
    parent: Dict[str, Any],
    market: Optional[Dict[str, Any]] = None,
    *,
    n_slices: int = 60,
    ucurve: Optional[list] = None,
    **kw,
) -> List[Dict[str, Any]]:
    """
    Distribute a parent order following a VWAP volume curve.

    Parameters
    ----------
    parent   : dict with symbol, side, qty, start_ts, end_ts (ms)
    market   : optional market context (unused in static plan)
    n_slices : number of child orders to generate
    ucurve   : (time_frac, cum_vol_frac) points; defaults to U-shaped profile

    Returns list of {ts, qty, side, symbol} children.
    """
    symbol = str(parent.get("symbol", ""))
    side = str(parent.get("side", "buy"))
    qty = float(parent.get("qty", 0))
    start_ts = int(parent.get("start_ts", 0))
    end_ts = int(parent.get("end_ts", start_ts + 60_000))

    if qty <= 0 or end_ts <= start_ts:
        return []

    curve = ucurve or _DEFAULT_UCURVE
    duration = end_ts - start_ts

    # Compute per-slice quantities from the volume curve
    fracs: List[float] = []
    for i in range(n_slices):
        t_frac_lo = i / n_slices
        t_frac_hi = (i + 1) / n_slices
        vol_lo = _interp(curve, t_frac_lo)
        vol_hi = _interp(curve, t_frac_hi)
        fracs.append(vol_hi - vol_lo)

    total_frac = sum(fracs)
    if total_frac <= 0:
        return []

    schedule: List[Dict[str, Any]] = []
    assigned = 0.0
    for i, frac in enumerate(fracs):
        ts = start_ts + int(i * duration / n_slices)
        slice_qty = (frac / total_frac) * qty
        if i == n_slices - 1:
            slice_qty = qty - assigned  # absorb rounding residual
        slice_qty = round(slice_qty, 6)
        assigned += slice_qty
        schedule.append({"ts": ts, "qty": slice_qty, "side": side, "symbol": symbol})

    return schedule
