# backend/backtester/order_types.py
"""
All 8 order types with proper execution logic for the backtesting engine.

Market, Limit, Stop, Stop-Limit, Trailing Stop, TWAP, VWAP, Iceberg.
"""
from __future__ import annotations

from dataclasses import dataclass

from backend.backtester.events import (
    MarketEvent,
    OrderEvent,
    OrderSide,
    OrderType,
)

# ── Fill result ───────────────────────────────────────────────────────────────

@dataclass
class FillResult:
    filled: bool
    fill_qty: float = 0.0
    fill_price: float = 0.0
    partial: bool = False
    reason: str = ""          # "fully_filled", "partial", "no_fill", "cancelled"
    cancel: bool = False      # True = remove order from book


# ── Base order handler ────────────────────────────────────────────────────────

class BaseOrderHandler:
    """Base class for order-type handlers. Each handles one bar's worth of execution."""

    def on_bar(self, order: OrderEvent, bar: MarketEvent, available_qty: float) -> FillResult:
        """
        Called once per bar. Returns FillResult.
        available_qty = max qty we can fill given participation rate constraints.
        """
        raise NotImplementedError

    def _make_no_fill(self, reason: str = "no_fill") -> FillResult:
        return FillResult(filled=False, reason=reason)

    def _make_fill(self, qty: float, price: float, partial: bool = False) -> FillResult:
        reason = "partial" if partial else "fully_filled"
        return FillResult(filled=True, fill_qty=qty, fill_price=price, partial=partial, reason=reason)


# ── 1. Market Order ───────────────────────────────────────────────────────────

class MarketOrderHandler(BaseOrderHandler):
    """
    Market order: fill immediately at open price of next bar (no price guarantee).
    Fill qty limited by available_qty (participation rate).
    """

    def on_bar(self, order: OrderEvent, bar: MarketEvent, available_qty: float) -> FillResult:
        fill_price = bar.open if bar.open > 0 else bar.close
        fill_qty = min(order.remaining_qty(), available_qty)
        if fill_qty <= 0:
            return self._make_no_fill("no_liquidity")
        partial = fill_qty < order.remaining_qty()
        return self._make_fill(fill_qty, fill_price, partial)


# ── 2. Limit Order ────────────────────────────────────────────────────────────

class LimitOrderHandler(BaseOrderHandler):
    """
    Limit order: fills only if the bar's range crosses the limit price.
    - BUY limit: fills when bar.low <= limit_price
    - SELL limit: fills when bar.high >= limit_price
    Fill price = limit_price (conservative; in reality could be better on gaps).
    """

    def on_bar(self, order: OrderEvent, bar: MarketEvent, available_qty: float) -> FillResult:
        lp = order.limit_price
        if lp is None:
            return self._make_no_fill("no_limit_price")

        if order.side == OrderSide.BUY:
            if bar.low > lp:
                return self._make_no_fill("limit_not_reached")
            fill_price = min(lp, bar.open)   # gap-down → better fill
        else:
            if bar.high < lp:
                return self._make_no_fill("limit_not_reached")
            fill_price = max(lp, bar.open)   # gap-up → better fill

        fill_qty = min(order.remaining_qty(), available_qty)
        partial = fill_qty < order.remaining_qty()
        return self._make_fill(fill_qty, fill_price, partial)


# ── 3. Stop Order ─────────────────────────────────────────────────────────────

class StopOrderHandler(BaseOrderHandler):
    """
    Stop (market) order: becomes a market order once stop_price is touched.
    - BUY stop: triggers when bar.high >= stop_price
    - SELL stop: triggers when bar.low <= stop_price
    Once triggered, fills at stop_price (may be worse if gapped through).
    """

    def on_bar(self, order: OrderEvent, bar: MarketEvent, available_qty: float) -> FillResult:
        sp = order.stop_price
        if sp is None:
            return self._make_no_fill("no_stop_price")

        if order.side == OrderSide.BUY:
            if bar.high < sp:
                return self._make_no_fill("stop_not_triggered")
            fill_price = max(sp, bar.open)    # gap-up → worse fill
        else:
            if bar.low > sp:
                return self._make_no_fill("stop_not_triggered")
            fill_price = min(sp, bar.open)    # gap-down → worse fill

        fill_qty = min(order.remaining_qty(), available_qty)
        partial = fill_qty < order.remaining_qty()
        return self._make_fill(fill_qty, fill_price, partial)


# ── 4. Stop-Limit Order ───────────────────────────────────────────────────────

class StopLimitOrderHandler(BaseOrderHandler):
    """
    Stop-limit order: stop triggers it, then limit controls the fill price.
    - BUY stop-limit: triggers when high >= stop_price, fills only if low <= limit_price
    - SELL stop-limit: triggers when low <= stop_price, fills only if high >= limit_price
    """

    def on_bar(self, order: OrderEvent, bar: MarketEvent, available_qty: float) -> FillResult:
        sp = order.stop_price
        lp = order.limit_price
        if sp is None or lp is None:
            return self._make_no_fill("missing_prices")

        if order.side == OrderSide.BUY:
            triggered = bar.high >= sp
            if not triggered:
                return self._make_no_fill("stop_not_triggered")
            can_fill = bar.low <= lp
            fill_price = min(lp, max(sp, bar.open))
        else:
            triggered = bar.low <= sp
            if not triggered:
                return self._make_no_fill("stop_not_triggered")
            can_fill = bar.high >= lp
            fill_price = max(lp, min(sp, bar.open))

        if not can_fill:
            return self._make_no_fill("limit_not_reached_after_stop")

        fill_qty = min(order.remaining_qty(), available_qty)
        partial = fill_qty < order.remaining_qty()
        return self._make_fill(fill_qty, fill_price, partial)


# ── 5. Trailing Stop Order ────────────────────────────────────────────────────

@dataclass
class TrailingStopState:
    """Mutable state maintained per trailing stop order across bars."""
    peak_price: float     # highest high (buy) or lowest low (sell) seen so far
    stop_price: float     # current trailing stop level


class TrailingStopOrderHandler(BaseOrderHandler):
    """
    Trailing stop order.
    - trail_pct: distance of stop from peak as a fraction (e.g. 0.02 = 2%)
    - BUY trailing: stop rises as bar.low falls (inverted — protecting short)
    - SELL trailing: stop falls as bar.high rises (protecting long)
    State must be tracked externally via _state dict keyed on order_id.
    """

    def __init__(self):
        self._state: dict[str, TrailingStopState] = {}

    def on_bar(self, order: OrderEvent, bar: MarketEvent, available_qty: float) -> FillResult:
        trail_pct = order.trail_pct
        if trail_pct is None:
            return self._make_no_fill("no_trail_pct")

        oid = order.order_id
        if oid not in self._state:
            ref = bar.close if bar.close > 0 else (order.mark_price or bar.close)
            if order.side == OrderSide.SELL:
                peak = ref
                stop = ref * (1.0 - trail_pct)
            else:
                peak = ref
                stop = ref * (1.0 + trail_pct)
            self._state[oid] = TrailingStopState(peak_price=peak, stop_price=stop)

        st = self._state[oid]

        if order.side == OrderSide.SELL:
            # Long position, trailing stop below
            if bar.high > st.peak_price:
                st.peak_price = bar.high
                st.stop_price = bar.high * (1.0 - trail_pct)
            triggered = bar.low <= st.stop_price
            fill_price = min(st.stop_price, bar.open)
        else:
            # Short position, trailing stop above
            if bar.low < st.peak_price:
                st.peak_price = bar.low
                st.stop_price = bar.low * (1.0 + trail_pct)
            triggered = bar.high >= st.stop_price
            fill_price = max(st.stop_price, bar.open)

        if not triggered:
            return self._make_no_fill("trailing_stop_not_triggered")

        del self._state[oid]   # triggered → consumed
        fill_qty = min(order.remaining_qty(), available_qty)
        partial = fill_qty < order.remaining_qty()
        return self._make_fill(fill_qty, fill_price, partial)

    def cleanup(self, order_id: str) -> None:
        self._state.pop(order_id, None)


# ── 6. TWAP Order ─────────────────────────────────────────────────────────────

@dataclass
class TWAPState:
    bars_remaining: int
    qty_remaining: float
    qty_per_bar: float


class TWAPOrderHandler(BaseOrderHandler):
    """
    Time-Weighted Average Price order.
    Splits total qty evenly over duration_bars bars.
    Fills each slice at the bar's VWAP (or midpoint if VWAP unavailable).
    """

    def __init__(self):
        self._state: dict[str, TWAPState] = {}

    def on_bar(self, order: OrderEvent, bar: MarketEvent, available_qty: float) -> FillResult:
        oid = order.order_id
        if oid not in self._state:
            n = max(1, order.duration_bars)
            self._state[oid] = TWAPState(
                bars_remaining=n,
                qty_remaining=order.remaining_qty(),
                qty_per_bar=order.remaining_qty() / n,
            )

        st = self._state[oid]
        if st.bars_remaining <= 0 or st.qty_remaining <= 0:
            del self._state[oid]
            return FillResult(filled=False, cancel=True, reason="twap_exhausted")

        # Slice qty for this bar
        slice_qty = st.qty_per_bar
        fill_qty = min(slice_qty, available_qty, st.qty_remaining)

        # TWAP execution price = VWAP if available, else (open+high+low+close)/4
        if bar.vwap > 0:
            fill_price = bar.vwap
        else:
            fill_price = (bar.open + bar.high + bar.low + bar.close) / 4.0

        st.qty_remaining -= fill_qty
        st.bars_remaining -= 1

        done = st.qty_remaining <= 1e-9 or st.bars_remaining <= 0
        if done:
            del self._state[oid]

        return FillResult(
            filled=fill_qty > 0,
            fill_qty=fill_qty,
            fill_price=fill_price,
            partial=not done,
            reason="partial" if not done else "fully_filled",
            cancel=done,
        )

    def cleanup(self, order_id: str) -> None:
        self._state.pop(order_id, None)


# ── 7. VWAP Order ─────────────────────────────────────────────────────────────

@dataclass
class VWAPState:
    bars_remaining: int
    qty_remaining: float
    cum_volume: float
    total_volume_estimate: float
    qty_target: float


class VWAPOrderHandler(BaseOrderHandler):
    """
    Volume-Weighted Average Price order.
    Paces fills proportional to bar volume relative to estimated daily volume (ADV).
    Target: fill at close of session at or near the day's VWAP.
    """

    def __init__(self):
        self._state: dict[str, VWAPState] = {}

    def on_bar(self, order: OrderEvent, bar: MarketEvent, available_qty: float) -> FillResult:
        oid = order.order_id
        n = max(1, order.duration_bars)

        if oid not in self._state:
            adv = bar.adv_20 if bar.adv_20 > 0 else bar.volume * n
            self._state[oid] = VWAPState(
                bars_remaining=n,
                qty_remaining=order.remaining_qty(),
                cum_volume=0.0,
                total_volume_estimate=adv,
                qty_target=order.remaining_qty(),
            )

        st = self._state[oid]
        if st.bars_remaining <= 0 or st.qty_remaining <= 0:
            del self._state[oid]
            return FillResult(filled=False, cancel=True, reason="vwap_exhausted")

        # Volume-paced slice
        vol_share = bar.volume / max(st.total_volume_estimate, 1e-9)
        slice_qty = st.qty_target * vol_share
        fill_qty = min(slice_qty, available_qty, st.qty_remaining)

        fill_price = bar.vwap if bar.vwap > 0 else (bar.high + bar.low) / 2.0

        st.cum_volume += bar.volume
        st.qty_remaining -= fill_qty
        st.bars_remaining -= 1

        done = st.qty_remaining <= 1e-9 or st.bars_remaining <= 0
        if done:
            del self._state[oid]

        return FillResult(
            filled=fill_qty > 0,
            fill_qty=fill_qty,
            fill_price=fill_price,
            partial=not done,
            reason="partial" if not done else "fully_filled",
            cancel=done,
        )

    def cleanup(self, order_id: str) -> None:
        self._state.pop(order_id, None)


# ── 8. Iceberg Order ──────────────────────────────────────────────────────────

@dataclass
class IcebergState:
    total_qty: float
    hidden_qty: float     # qty not yet revealed
    visible_qty: float    # current visible slice


class IcebergOrderHandler(BaseOrderHandler):
    """
    Iceberg order: shows only iceberg_qty to the market at a time.
    When visible slice is filled, next slice is revealed.
    All slices execute at limit_price (passive) or better.
    """

    def __init__(self):
        self._state: dict[str, IcebergState] = {}

    def on_bar(self, order: OrderEvent, bar: MarketEvent, available_qty: float) -> FillResult:
        oid = order.order_id
        total = order.remaining_qty()
        slice_size = order.iceberg_qty or (total / 5.0)   # default 5 slices

        if oid not in self._state:
            visible = min(slice_size, total)
            self._state[oid] = IcebergState(
                total_qty=total,
                hidden_qty=max(0.0, total - visible),
                visible_qty=visible,
            )

        st = self._state[oid]
        lp = order.limit_price

        # Check if limit is reachable
        if lp is not None:
            if order.side == OrderSide.BUY and bar.low > lp:
                return self._make_no_fill("limit_not_reached")
            if order.side == OrderSide.SELL and bar.high < lp:
                return self._make_no_fill("limit_not_reached")
            fill_price = lp
        else:
            fill_price = bar.open

        fill_qty = min(st.visible_qty, available_qty)

        if fill_qty <= 0:
            return self._make_no_fill("no_liquidity")

        st.visible_qty -= fill_qty

        # Refill visible slice from hidden pool
        if st.visible_qty <= 1e-9 and st.hidden_qty > 0:
            refill = min(slice_size, st.hidden_qty)
            st.hidden_qty -= refill
            st.visible_qty = refill

        total_remaining = st.visible_qty + st.hidden_qty
        done = total_remaining <= 1e-9
        if done:
            del self._state[oid]

        return FillResult(
            filled=True,
            fill_qty=fill_qty,
            fill_price=fill_price,
            partial=not done,
            reason="partial" if not done else "fully_filled",
            cancel=done,
        )

    def cleanup(self, order_id: str) -> None:
        self._state.pop(order_id, None)


# ── Order handler registry ────────────────────────────────────────────────────

class OrderHandlerRegistry:
    """Maps OrderType → handler instance (stateful handlers are singletons)."""

    def __init__(self):
        self._trailing = TrailingStopOrderHandler()
        self._twap = TWAPOrderHandler()
        self._vwap = VWAPOrderHandler()
        self._iceberg = IcebergOrderHandler()

        self._handlers: dict[OrderType, BaseOrderHandler] = {
            OrderType.MARKET:        MarketOrderHandler(),
            OrderType.LIMIT:         LimitOrderHandler(),
            OrderType.STOP:          StopOrderHandler(),
            OrderType.STOP_LIMIT:    StopLimitOrderHandler(),
            OrderType.TRAILING_STOP: self._trailing,
            OrderType.TWAP:          self._twap,
            OrderType.VWAP:          self._vwap,
            OrderType.ICEBERG:       self._iceberg,
        }

    def get(self, order_type: OrderType) -> BaseOrderHandler:
        return self._handlers[order_type]

    def process(self, order: OrderEvent, bar: MarketEvent, available_qty: float) -> FillResult:
        handler = self._handlers.get(order.order_type)
        if handler is None:
            return FillResult(filled=False, reason=f"unknown_order_type:{order.order_type}")
        return handler.on_bar(order, bar, available_qty)

    def cancel(self, order: OrderEvent) -> None:
        """Release any stateful resources for a cancelled order."""
        oid = order.order_id
        self._trailing.cleanup(oid)
        self._twap.cleanup(oid)
        self._vwap.cleanup(oid)
        self._iceberg.cleanup(oid)
