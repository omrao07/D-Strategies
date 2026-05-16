# backend/risk/capacity.py
"""
Capacity model: computes maximum executable quantity for an order given
liquidity, venue depth, leverage, margin, borrow, and VaR constraints.
"""
from __future__ import annotations

from typing import Any, Dict, Optional


class CapacityModel:
    """
    Compute the maximum quantity that can be executed for a given order,
    subject to a hierarchy of constraints:

    1. ADV participation cap
    2. Intraday volume participation cap
    3. Per-venue depth cap (sum of min(per_venue_cap, depth) across venues)
    4. Leverage / margin cap (notional ≤ equity × leverage_max)
    5. Borrow availability (sell/short only)
    6. VaR budget (simplified: qty ≤ var_limit / (price × vol_annualised × z99))

    Returns
    -------
    dict with keys:
      "qty"         – maximum shares/contracts
      "notional"    – qty × price
      "constraints" – per-constraint dict {"limit":…, "used":…, "binding": bool}
    """

    def __init__(self, **cfg):
        self._cfg = cfg

    # ------------------------------------------------------------------
    def compute(
        self,
        symbol: str,
        side: str,
        strategy: str,
        market_ctx: Dict[str, Any],
        risk_ctx: Dict[str, Any],
        **cfg,
    ) -> Dict[str, Any]:
        merged = {**self._cfg, **cfg}

        price = float(market_ctx.get("price", 0.0))
        if price <= 0:
            return {"qty": 0.0, "notional": 0.0, "constraints": {}}

        adv        = float(market_ctx.get("adv", 0.0))
        today_vol  = float(market_ctx.get("today_volume", 0.0))
        vol_20d    = float(market_ctx.get("vol_20d", 0.0))
        venues     = market_ctx.get("venues", {})

        equity        = float(risk_ctx.get("equity", 0.0))
        leverage_max  = float(risk_ctx.get("leverage_max", 1.0))
        margin_long   = float(risk_ctx.get("margin_long", 1.0))
        margin_short  = float(risk_ctx.get("margin_short", 1.0))
        borrow_avail  = float(risk_ctx.get("borrow_avail", float("inf")))
        var_limit     = float(risk_ctx.get("var_limit", float("inf")))

        part_cap     = float(merged.get("participation_cap", 1.0))
        intraday_cap = float(merged.get("intraday_participation_cap", 1.0))
        per_venue_cap = float(merged.get("per_venue_cap", float("inf")))

        constraints: Dict[str, Dict] = {}
        caps = []

        # 1. ADV participation
        adv_limit = part_cap * adv
        caps.append(adv_limit)
        constraints["participation_adv"] = {"limit": adv_limit, "used": adv_limit, "binding": False}

        # 2. Intraday participation
        intra_limit = intraday_cap * today_vol
        caps.append(intra_limit)
        constraints["intraday_participation"] = {"limit": intra_limit, "used": intra_limit, "binding": False}

        # 3. Per-venue depth (ask for buys, bid for sells)
        depth_key = "depth_ask" if side == "buy" else "depth_bid"
        venue_limit = sum(
            min(per_venue_cap, float(v.get(depth_key, 0.0)))
            for v in venues.values()
        )
        caps.append(venue_limit)
        constraints["venue_depth"] = {"limit": venue_limit, "used": venue_limit, "binding": False}

        # 4. Leverage / margin cap
        margin = margin_long if side == "buy" else margin_short
        max_notional = equity * leverage_max
        margin_notional = (equity * leverage_max / margin) if margin > 0 else 0.0
        lev_qty = min(max_notional, margin_notional) / price
        caps.append(lev_qty)
        constraints["leverage"] = {"limit": max_notional, "used": max_notional, "binding": False}

        # 5. Borrow cap (sells only)
        if side == "sell":
            caps.append(borrow_avail)
            constraints["borrow"] = {"limit": borrow_avail, "used": borrow_avail, "binding": False}

        # 6. VaR budget (annualised vol, z=2.33 for 99% CI)
        if vol_20d > 0 and var_limit < float("inf"):
            z = 2.33
            var_qty = var_limit / (price * vol_20d * z)
            caps.append(var_qty)
            constraints["var"] = {"limit": var_qty, "used": var_qty, "binding": False}

        qty = max(0.0, min(caps)) if caps else 0.0
        notional = qty * price

        # Mark which constraint is actually binding
        for c in constraints.values():
            c["binding"] = bool(abs(c["limit"] - qty) < 1.0 or c["limit"] <= qty + 1e-6)

        return {"qty": qty, "notional": notional, "constraints": constraints}


def compute_capacity(
    symbol: str,
    side: str,
    strategy: str,
    market_ctx: Dict[str, Any],
    risk_ctx: Optional[Dict[str, Any]] = None,
    **cfg,
) -> Dict[str, Any]:
    """Functional entry point — delegates to CapacityModel."""
    return CapacityModel().compute(
        symbol=symbol,
        side=side,
        strategy=strategy,
        market_ctx=market_ctx,
        risk_ctx=risk_ctx or {},
        **cfg,
    )
