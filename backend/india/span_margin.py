# backend/india/span_margin.py
"""
Simplified SPAN margin estimator for NSE F&O positions.
SEBI requires minimum SPAN + Exposure margin for F&O writing.
This is a simplified approximation — use NSE's actual SPAN calculator in prod.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

from .fo_lots import get_lot_size


@dataclass
class FoPosition:
    symbol: str
    expiry: str         # "2025-01-30"
    instrument: str     # "CE" | "PE" | "FUT"
    strike: float       # 0 for futures
    qty_lots: int       # positive=long, negative=short
    premium: float      # option premium or futures price


def estimate_span_margin(
    positions: List[FoPosition],
    underlying_price: float,
    vol_pct: float = 20.0,       # annualized vol assumption (%)
    span_scenarios: int = 16,    # standard SPAN uses 16 risk scenarios
) -> Dict[str, float]:
    """
    Approximate SPAN margin using a simplified scenario-based approach.
    Returns dict: {span, exposure, total_margin, net_premium}.

    For production: integrate NSE's iSPAN API or SEBI's margin calculator.
    """
    if not positions or underlying_price <= 0:
        return {"span": 0.0, "exposure": 0.0, "total_margin": 0.0, "net_premium": 0.0}

    daily_vol = underlying_price * (vol_pct / 100.0) / (252 ** 0.5)
    price_range = 3.0 * daily_vol  # ±3σ range for SPAN scenarios

    # Build simple P&L matrix over price scenarios
    scenario_pnl = []
    for i in range(span_scenarios):
        # Prices from -price_range to +price_range
        delta_price = price_range * (2 * i / (span_scenarios - 1) - 1)
        pnl = 0.0
        for pos in positions:
            lot_size = get_lot_size(pos.symbol)
            qty_shares = pos.qty_lots * lot_size
            if pos.instrument == "FUT":
                pnl += qty_shares * delta_price
            elif pos.instrument in ("CE", "PE"):
                # Simplified Black-Scholes delta approximation
                is_call = pos.instrument == "CE"
                new_price = underlying_price + delta_price
                intrinsic = max(0.0, (new_price - pos.strike) if is_call else (pos.strike - new_price))
                # Rough time value decay (ignored for now)
                option_pnl = qty_shares * (intrinsic - pos.premium)
                pnl += option_pnl
        scenario_pnl.append(pnl)

    # SPAN = worst-case loss
    span = max(0.0, -min(scenario_pnl))

    # Exposure margin: 1.5% of notional for options, 3% for futures
    exposure = 0.0
    net_premium = 0.0
    for pos in positions:
        lot_size = get_lot_size(pos.symbol)
        notional = abs(pos.qty_lots) * lot_size * underlying_price
        if pos.instrument == "FUT":
            exposure += 0.03 * notional
        else:
            exposure += 0.015 * notional
            net_premium += pos.qty_lots * lot_size * pos.premium

    total = max(0.0, span + exposure - min(0.0, net_premium))

    return {
        "span": round(span, 2),
        "exposure": round(exposure, 2),
        "total_margin": round(total, 2),
        "net_premium": round(net_premium, 2),
    }
