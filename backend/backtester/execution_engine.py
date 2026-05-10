# backend/backtester/execution_engine.py
"""
Full execution engine: latency, slippage models, cost models, order routing.

Slippage models  : fixed_bps, percentage, volume_impact, orderbook_impact
Cost models      : maker_fee, taker_fee, borrow_fee, funding_rate, tiered_exchange_fee
Latency          : fixed + stochastic (log-normal)
Order lifecycle  : PENDING → OPEN → PARTIAL | FILLED | CANCELLED | EXPIRED
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Tuple

import numpy as np

from backend.backtester.events import (
    FillEvent, FillType, MarketEvent, OrderEvent, OrderSide, OrderStatus, OrderType,
)
from backend.backtester.order_types import FillResult, OrderHandlerRegistry


# ── Slippage models ───────────────────────────────────────────────────────────

class SlippageModel(Enum):
    FIXED_BPS       = "fixed_bps"
    PERCENTAGE      = "percentage"
    VOLUME_IMPACT   = "volume_impact"
    ORDERBOOK       = "orderbook"


def slippage_fixed_bps(price: float, bps: float, side: OrderSide) -> float:
    """Constant slippage: bps of mid price, directional."""
    delta = price * bps / 10_000.0
    return price + delta if side == OrderSide.BUY else price - delta


def slippage_percentage(price: float, pct: float, side: OrderSide) -> float:
    """Percentage slippage (same as fixed_bps but in percent units)."""
    delta = price * pct / 100.0
    return price + delta if side == OrderSide.BUY else price - delta


def slippage_volume_impact(
    price: float,
    qty: float,
    bar_volume: float,
    side: OrderSide,
    impact_eta: float = 0.1,
) -> float:
    """
    Square-root market impact: impact ∝ eta * sqrt(qty / ADV).
    Almgren-Chriss linear model simplification for bar-level simulation.
    """
    participation = qty / max(bar_volume, 1.0)
    impact_pct = impact_eta * math.sqrt(participation)
    delta = price * impact_pct
    return price + delta if side == OrderSide.BUY else price - delta


def slippage_orderbook(
    price: float,
    qty: float,
    bid_depth: float,
    ask_depth: float,
    side: OrderSide,
    tick_size: float = 0.05,
) -> float:
    """
    Orderbook impact: walk through simulated bid/ask depth to find avg fill price.
    depth is in currency units (e.g. INR notional available at NBBO±1 tick).
    """
    notional = qty * price
    if side == OrderSide.BUY:
        available = ask_depth
        if notional <= available:
            return price + tick_size
        levels_consumed = math.ceil(notional / max(available, 1.0))
        return price + tick_size * levels_consumed
    else:
        available = bid_depth
        if notional <= available:
            return price - tick_size
        levels_consumed = math.ceil(notional / max(available, 1.0))
        return price - tick_size * levels_consumed


# ── Cost models ───────────────────────────────────────────────────────────────

@dataclass
class CostBreakdown:
    commission: float = 0.0
    spread_cost: float = 0.0
    market_impact: float = 0.0
    borrow_fee: float = 0.0
    funding_rate: float = 0.0
    total: float = 0.0

    def compute_total(self) -> None:
        self.total = self.commission + self.spread_cost + self.market_impact + self.borrow_fee + self.funding_rate


def cost_maker_fee(notional: float, fee_bps: float) -> float:
    return notional * fee_bps / 10_000.0


def cost_taker_fee(notional: float, fee_bps: float) -> float:
    return notional * fee_bps / 10_000.0


def cost_borrow_fee(notional: float, annual_rate_bps: float, holding_days: float = 1.0) -> float:
    """Short-sale borrow: annualized bps, prorated to holding_days."""
    return notional * (annual_rate_bps / 10_000.0) * (holding_days / 365.0)


def cost_funding_rate(notional: float, rate_pct: float = 0.01) -> float:
    """Funding rate for perpetuals (8h rate by default, in percent)."""
    return notional * rate_pct / 100.0


def cost_tiered_exchange_fee(notional: float, tier: str = "retail") -> float:
    """
    NSE/BSE tiered fee model (simplified).
    tier: "retail" | "hni" | "institutional"
    """
    rates = {"retail": 2.0, "hni": 1.5, "institutional": 0.5}  # bps
    bps = rates.get(tier, 2.0)
    return notional * bps / 10_000.0


def compute_costs(
    notional: float,
    side: OrderSide,
    is_short: bool = False,
    fee_bps: float = 2.0,
    short_fee_bps: float = 50.0,
    spread: float = 0.0,
    market_impact_abs: float = 0.0,
    holding_days: float = 1.0,
) -> CostBreakdown:
    cb = CostBreakdown()
    cb.commission = cost_taker_fee(notional, fee_bps)
    cb.spread_cost = notional * spread / 2.0   # half-spread per side
    cb.market_impact = market_impact_abs
    if is_short and side == OrderSide.BUY:
        # Paying borrow on short position
        cb.borrow_fee = cost_borrow_fee(notional, short_fee_bps, holding_days)
    cb.compute_total()
    return cb


# ── Latency simulation ────────────────────────────────────────────────────────

def simulate_latency(
    base_ms: float = 50.0,
    sigma_ms: float = 20.0,
    rng: Optional[np.random.Generator] = None,
) -> float:
    """Log-normal latency: mean ≈ base_ms, right-tailed to model network jitter."""
    rng = rng or np.random.default_rng()
    sigma_log = math.sqrt(math.log(1 + (sigma_ms / base_ms) ** 2))
    mu_log = math.log(base_ms) - sigma_log ** 2 / 2.0
    return float(rng.lognormal(mu_log, sigma_log))


# ── Execution engine ──────────────────────────────────────────────────────────

class ExecutionEngine:
    """
    Processes pending OrderEvents against incoming MarketEvents.

    Responsibilities:
    - Maintain live order book (open orders)
    - Route each order to correct handler (via OrderHandlerRegistry)
    - Apply slippage + cost models to produce FillEvents
    - Handle cancellations and modifications
    - Enforce participation rate limits
    """

    def __init__(
        self,
        fee_bps: float = 2.0,
        slippage_bps: float = 5.0,
        slippage_model: SlippageModel = SlippageModel.VOLUME_IMPACT,
        price_impact_eta: float = 0.1,
        max_participation_rate: float = 0.20,
        short_fee_bps: float = 50.0,
        latency_base_ms: float = 50.0,
        latency_sigma_ms: float = 20.0,
        seed: int = 42,
    ):
        self.fee_bps = fee_bps
        self.slippage_bps = slippage_bps
        self.slippage_model = slippage_model
        self.price_impact_eta = price_impact_eta
        self.max_participation_rate = max_participation_rate
        self.short_fee_bps = short_fee_bps
        self.latency_base_ms = latency_base_ms
        self.latency_sigma_ms = latency_sigma_ms

        self._rng = np.random.default_rng(seed)
        self._registry = OrderHandlerRegistry()

        # Open order book: order_id → OrderEvent
        self._open_orders: Dict[str, OrderEvent] = {}
        # Track which orders are short (for borrow fee)
        self._short_orders: set[str] = set()

        # Filled events accumulated this session
        self.fill_log: List[FillEvent] = []
        self.rejected_log: List[OrderEvent] = []

    # ── Order management ──────────────────────────────────────────────────────

    def submit_order(self, order: OrderEvent) -> None:
        """Accept an order into the execution queue."""
        order.status = OrderStatus.OPEN
        self._open_orders[order.order_id] = order

    def cancel_order(self, order_id: str) -> bool:
        """Cancel an open order. Returns True if found and cancelled."""
        order = self._open_orders.pop(order_id, None)
        if order is None:
            return False
        order.status = OrderStatus.CANCELLED
        self._registry.cancel(order)
        return True

    def modify_order(
        self,
        order_id: str,
        *,
        qty: Optional[float] = None,
        limit_price: Optional[float] = None,
        stop_price: Optional[float] = None,
        trail_pct: Optional[float] = None,
    ) -> bool:
        """Modify an open order's parameters. Returns True if found."""
        order = self._open_orders.get(order_id)
        if order is None:
            return False
        if qty is not None:
            order.qty = qty
        if limit_price is not None:
            order.limit_price = limit_price
        if stop_price is not None:
            order.stop_price = stop_price
        if trail_pct is not None:
            order.trail_pct = trail_pct
        return True

    def mark_short(self, order_id: str) -> None:
        """Flag an order as a short-sale (applies borrow fee on fills)."""
        self._short_orders.add(order_id)

    # ── Bar processing ────────────────────────────────────────────────────────

    def process_bar(self, bar: MarketEvent) -> List[FillEvent]:
        """
        Process all open orders against a single bar.
        Returns list of FillEvents generated this bar.
        """
        fills: List[FillEvent] = []
        to_remove: List[str] = []

        # Max fillable qty for this symbol this bar (participation rate)
        available_qty = self._max_fill_qty(bar)

        for oid, order in list(self._open_orders.items()):
            if order.symbol != bar.symbol:
                continue

            result = self._registry.process(order, bar, available_qty)

            if result.filled and result.fill_qty > 0:
                fill = self._build_fill(order, bar, result)
                fills.append(fill)
                self.fill_log.append(fill)

                # Update order state
                order.filled_qty += result.fill_qty
                total_fill = order.filled_qty * result.fill_price
                prev_fill = (order.filled_qty - result.fill_qty) * order.avg_fill_price
                order.avg_fill_price = (prev_fill + total_fill) / max(order.filled_qty, 1e-9)

                if order.remaining_qty() <= 1e-9:
                    order.status = OrderStatus.FILLED
                    to_remove.append(oid)
                elif result.partial:
                    order.status = OrderStatus.PARTIAL
                elif result.cancel:
                    order.status = OrderStatus.FILLED
                    to_remove.append(oid)

                available_qty = max(0.0, available_qty - result.fill_qty)

            elif result.cancel:
                order.status = OrderStatus.CANCELLED
                self._registry.cancel(order)
                to_remove.append(oid)

        for oid in to_remove:
            self._open_orders.pop(oid, None)
            self._short_orders.discard(oid)

        return fills

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _max_fill_qty(self, bar: MarketEvent) -> float:
        """Max qty fillable this bar given participation rate constraint."""
        if bar.adv_20 > 0 and bar.close > 0:
            max_notional = bar.adv_20 * self.max_participation_rate  # adv_20 is already daily
            return max_notional / bar.close
        if bar.volume > 0 and bar.close > 0:
            return bar.volume * self.max_participation_rate / bar.close
        return float("inf")

    def _compute_slippage(self, order: OrderEvent, bar: MarketEvent, raw_price: float) -> float:
        """Apply selected slippage model to get final execution price."""
        qty = order.remaining_qty()

        if self.slippage_model == SlippageModel.FIXED_BPS:
            return slippage_fixed_bps(raw_price, self.slippage_bps, order.side)

        elif self.slippage_model == SlippageModel.PERCENTAGE:
            return slippage_percentage(raw_price, self.slippage_bps / 100.0, order.side)

        elif self.slippage_model == SlippageModel.VOLUME_IMPACT:
            return slippage_volume_impact(
                raw_price, qty, max(bar.volume, 1.0), order.side, self.price_impact_eta
            )

        elif self.slippage_model == SlippageModel.ORDERBOOK:
            bid_depth = bar.liquidity * 0.5
            ask_depth = bar.liquidity * 0.5
            return slippage_orderbook(raw_price, qty, bid_depth, ask_depth, order.side)

        return raw_price

    def _build_fill(
        self, order: OrderEvent, bar: MarketEvent, result: FillResult
    ) -> FillEvent:
        """Convert a FillResult into a full FillEvent with cost breakdown."""
        mark_price = bar.close
        raw_price = result.fill_price
        exec_price = self._compute_slippage(order, bar, raw_price)

        # Enforce price bounds (can't fill worse than bar extremes)
        if order.side == OrderSide.BUY:
            exec_price = min(exec_price, bar.high)
        else:
            exec_price = max(exec_price, bar.low)

        notional = result.fill_qty * exec_price
        slippage_abs = abs(exec_price - mark_price) * result.fill_qty
        slippage_bps_val = abs(exec_price - mark_price) / max(mark_price, 1e-9) * 10_000.0

        # Market impact (Almgren-Chriss) — only when not already baked into exec_price
        impact_abs = 0.0
        impact_bps_val = 0.0
        if bar.volume > 0 and self.slippage_model != SlippageModel.VOLUME_IMPACT:
            participation = result.fill_qty / max(bar.volume, 1.0)
            impact_frac = self.price_impact_eta * math.sqrt(participation)
            impact_abs = notional * impact_frac
            impact_bps_val = impact_frac * 10_000.0

        is_short = order.order_id in self._short_orders
        spread_cost_frac = bar.spread / max(mark_price, 1e-9) if bar.spread > 0 else self.slippage_bps / 10_000.0
        costs = compute_costs(
            notional=notional,
            side=order.side,
            is_short=is_short,
            fee_bps=self.fee_bps,
            short_fee_bps=self.short_fee_bps,
            spread=spread_cost_frac,
            market_impact_abs=impact_abs,
        )

        latency_ms = simulate_latency(self.latency_base_ms, self.latency_sigma_ms, self._rng)

        fill_type = FillType.FULL if not result.partial else FillType.PARTIAL

        return FillEvent(
            ts=bar.ts,
            order_id=order.order_id,
            strategy=order.strategy,
            symbol=order.symbol,
            side=order.side,
            fill_type=fill_type,
            fill_qty=result.fill_qty,
            fill_price=exec_price,
            mark_price=mark_price,
            commission=costs.commission,
            slippage=slippage_abs,
            spread_cost=costs.spread_cost,
            market_impact=impact_abs,
            borrow_fee=costs.borrow_fee,
            total_cost=costs.total,
            latency_ms=latency_ms,
            notional=notional,
            slippage_bps=slippage_bps_val,
            impact_bps=impact_bps_val,
        )

    # ── Liquidity check ───────────────────────────────────────────────────────

    def check_liquidity(self, order: OrderEvent, bar: MarketEvent) -> Tuple[bool, str]:
        """
        Pre-submit liquidity check. Returns (ok, reason).
        """
        qty = order.qty
        if qty <= 0:
            return False, "zero_qty"

        notional = qty * (order.mark_price or bar.close)

        # ADV check
        if bar.adv_20 > 0:
            participation = notional / bar.adv_20
            if participation > self.max_participation_rate:
                return False, f"participation_rate_{participation:.1%}_exceeds_{self.max_participation_rate:.1%}"

        # Min liquidity check
        if bar.liquidity > 0 and notional > bar.liquidity * 10:
            return False, "insufficient_liquidity"

        return True, "ok"

    # ── State ─────────────────────────────────────────────────────────────────

    def open_order_count(self) -> int:
        return len(self._open_orders)

    def open_orders(self, symbol: Optional[str] = None) -> List[OrderEvent]:
        orders = list(self._open_orders.values())
        if symbol:
            orders = [o for o in orders if o.symbol == symbol]
        return orders

    def reset(self) -> None:
        self._open_orders.clear()
        self._short_orders.clear()
        self.fill_log.clear()
        self.rejected_log.clear()
