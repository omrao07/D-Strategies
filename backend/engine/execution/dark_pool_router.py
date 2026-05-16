# backend/engine/execution/dark_pool_router.py
"""
Dark pool router: splits an order across venues, prioritising best net price.
Positive qty = buy (sort by price+fee ascending); negative/sell (sort by price-fee descending).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List


@dataclass
class ExecutionPlan:
    venue: str
    qty: int
    price: float


class DarkPoolRouter:
    """Route an order across a list of Venue objects, respecting per-venue liquidity."""

    def route(self, order, venues: list) -> List[ExecutionPlan]:
        if not venues or order.qty <= 0:
            return []

        if order.side == "buy":
            sorted_venues = sorted(venues, key=lambda v: v.price + v.fee)
        else:
            sorted_venues = sorted(venues, key=lambda v: v.price - v.fee, reverse=True)

        plans: List[ExecutionPlan] = []
        remaining = order.qty

        for v in sorted_venues:
            if remaining <= 0:
                break
            take = min(remaining, v.liquidity)
            if take > 0:
                plans.append(ExecutionPlan(venue=v.name, qty=take, price=v.price))
                remaining -= take

        return plans
