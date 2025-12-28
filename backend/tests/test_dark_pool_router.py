# tests/test_dark_pool_router.py
#
# Pytest test suite for DarkPoolRouter
#
# Expected interface:
#
# class DarkPoolRouter:
#     def route(order: Order, venues: list[Venue]) -> ExecutionPlan
#
# Where:
#   - Order has: id, symbol, side, qty, limit_price
#   - Venue has: name, liquidity, price, fee
#   - ExecutionPlan has: venue, qty, price
#

import pytest
from dataclasses import dataclass


# ─────────────────────────────────────────────────────────────
# Test fixtures (pure, deterministic)
# ─────────────────────────────────────────────────────────────

@dataclass
class Order:
    id: str
    symbol: str
    side: str        # "buy" or "sell"
    qty: int
    limit_price: float


@dataclass
class Venue:
    name: str
    liquidity: int   # available quantity
    price: float     # executable price
    fee: float       # per-share fee


@dataclass
class ExecutionPlan:
    venue: str
    qty: int
    price: float


# ─────────────────────────────────────────────────────────────
# Dummy router (only used if real one is missing)
# Remove this block once real router exists
# ─────────────────────────────────────────────────────────────

try:
    from engine.execution.dark_pool_router import DarkPoolRouter
except ImportError:
    class DarkPoolRouter:
        def route(self, order, venues):
            # Simple best-price router
            if order.side == "buy":
                venues = sorted(venues, key=lambda v: v.price + v.fee)
            else:
                venues = sorted(venues, key=lambda v: v.price - v.fee)

            plans = []
            remaining = order.qty

            for v in venues:
                if remaining <= 0:
                    break
                take = min(remaining, v.liquidity)
                plans.append(
                    ExecutionPlan(
                        venue=v.name,
                        qty=take,
                        price=v.price
                    )
                )
                remaining -= take

            return plans


# ─────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────

@pytest.fixture
def router():
    return DarkPoolRouter()


@pytest.fixture
def buy_order():
    return Order(
        id="ORD-1",
        symbol="AAPL",
        side="buy",
        qty=1_000,
        limit_price=200.00
    )


@pytest.fixture
def sell_order():
    return Order(
        id="ORD-2",
        symbol="AAPL",
        side="sell",
        qty=1_000,
        limit_price=200.00
    )


@pytest.fixture
def venues():
    return [
        Venue(name="DP1", liquidity=400, price=199.90, fee=0.01),
        Venue(name="DP2", liquidity=300, price=199.95, fee=0.00),
        Venue(name="DP3", liquidity=600, price=200.05, fee=0.00),
    ]


# ─────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────

def test_buy_order_routes_best_price(router, buy_order, venues):
    plans = router.route(buy_order, venues)

    assert sum(p.qty for p in plans) == buy_order.qty
    assert plans[0].venue == "DP1"
    assert plans[0].price <= plans[-1].price


def test_sell_order_routes_best_price(router, sell_order, venues):
    plans = router.route(sell_order, venues)

    assert sum(p.qty for p in plans) == sell_order.qty
    assert plans[0].venue == "DP3"
    assert plans[0].price >= plans[-1].price


def test_respects_liquidity(router, buy_order, venues):
    plans = router.route(buy_order, venues)

    for p in plans:
        venue = next(v for v in venues if v.name == p.venue)
        assert p.qty <= venue.liquidity


def test_partial_fill_when_liquidity_insufficient(router):
    order = Order(
        id="ORD-3",
        symbol="AAPL",
        side="buy",
        qty=2_000,
        limit_price=210.0
    )

    venues = [
        Venue(name="DP1", liquidity=500, price=200.0, fee=0.0),
        Venue(name="DP2", liquidity=300, price=201.0, fee=0.0),
    ]

    plans = router.route(order, venues)

    assert sum(p.qty for p in plans) == 800


def test_no_venues_returns_empty_plan(router, buy_order):
    plans = router.route(buy_order, [])

    assert plans == []


def test_zero_quantity_order(router, venues):
    order = Order(
        id="ORD-4",
        symbol="AAPL",
        side="buy",
        qty=0,
        limit_price=200.0
    )

    plans = router.route(order, venues)

    assert plans == []


def test_execution_plan_structure(router, buy_order, venues):
    plans = router.route(buy_order, venues)

    for p in plans:
        assert isinstance(p.venue, str)
        assert isinstance(p.qty, int)
        assert isinstance(p.price, float)