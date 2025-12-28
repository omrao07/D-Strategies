"""
paper.py

Paper trading broker.
Simulates execution, positions, and PnL in-memory.

Design goals:
- Deterministic
- Engine-safe
- No external dependencies
- Same interface shape as real brokers
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Dict, Any, Optional, List


# ============================
# Types
# ============================

Side = str          # "buy" | "sell"
OrderType = str     # "market" | "limit"
TimeInForce = str   # "day" | "gtc"


@dataclass
class OrderRequest:
    symbol: str
    side: Side
    qty: float
    order_type: OrderType = "market"
    limit_price: Optional[float] = None
    tif: TimeInForce = "day"
    client_order_id: Optional[str] = None
    price_hint: Optional[float] = None   # last known price


@dataclass
class OrderResult:
    id: str
    symbol: str
    side: Side
    qty: float
    filled_qty: float
    status: str
    submitted_at: float
    fill_price: Optional[float] = None


# ============================
# Broker
# ============================

class PaperBroker:
    """
    In-memory paper trading broker.
    """

    def __init__(
        self,
        *,
        starting_cash: float = 100_000.0,
        fee_bps: float = 0.0,
        slippage_bps: float = 0.0,
    ):
        self.cash = starting_cash
        self.fee_bps = fee_bps
        self.slippage_bps = slippage_bps

        self.positions: Dict[str, Dict[str, Any]] = {}
        self.orders: Dict[str, OrderResult] = {}
        self._oid = 1

    # =========================
    # Account
    # =========================

    def account(self) -> Dict[str, Any]:
        equity = self.cash + sum(
            p["qty"] * p["last_price"]
            for p in self.positions.values()
        )

        return {
            "cash": round(self.cash, 2),
            "equity": round(equity, 2),
            "positions": len(self.positions),
        }

    # =========================
    # Orders
    # =========================

    def submit_order(self, req: OrderRequest) -> OrderResult:
        if req.qty <= 0:
            raise ValueError("qty must be positive")

        if req.order_type == "limit" and req.limit_price is None:
            raise ValueError("limit order requires limit_price")

        price = self._execution_price(req)
        cost = price * req.qty
        fee = cost * self.fee_bps * 1e-4

        if req.side == "buy" and self.cash < cost + fee:
            status = "rejected"
            filled = 0.0
        else:
            self._apply_fill(req.symbol, req.side, req.qty, price, fee)
            status = "filled"
            filled = req.qty

        oid = f"paper-{self._oid}"
        self._oid += 1

        res = OrderResult(
            id=oid,
            symbol=req.symbol,
            side=req.side,
            qty=req.qty,
            filled_qty=filled,
            status=status,
            submitted_at=time.time(),
            fill_price=price if filled else None,
        )

        self.orders[oid] = res
        return res

    def cancel_order(self, order_id: str) -> bool:
        o = self.orders.get(order_id)
        if not o or o.status != "open":
            return False
        o.status = "canceled"
        return True

    def get_order(self, order_id: str) -> Optional[OrderResult]:
        return self.orders.get(order_id)

    def list_orders(self) -> List[OrderResult]:
        return list(self.orders.values())

    # =========================
    # Positions
    # =========================

    def positions_view(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for sym, p in self.positions.items():
            out.append(
                {
                    "symbol": sym,
                    "qty": p["qty"],
                    "avg_price": p["avg_price"],
                    "last_price": p["last_price"],
                    "unrealized_pl": round(
                        (p["last_price"] - p["avg_price"]) * p["qty"], 2
                    ),
                    "side": "long" if p["qty"] > 0 else "short",
                }
            )
        return out

    def close_position(self, symbol: str, price: float) -> bool:
        p = self.positions.get(symbol)
        if not p:
            return False

        qty = abs(p["qty"])
        side = "sell" if p["qty"] > 0 else "buy"
        self.submit_order(
            OrderRequest(
                symbol=symbol,
                side=side,
                qty=qty,
                price_hint=price,
            )
        )
        return True

    # =========================
    # Internals
    # =========================

    def _execution_price(self, req: OrderRequest) -> float:
        base = (
            req.limit_price
            if req.order_type == "limit"
            else req.price_hint
        )

        if base is None:
            raise ValueError("price_hint required for paper execution")

        slip = base * self.slippage_bps * 1e-4
        return base + slip if req.side == "buy" else base - slip

    def _apply_fill(
        self,
        symbol: str,
        side: Side,
        qty: float,
        price: float,
        fee: float,
    ) -> None:
        signed_qty = qty if side == "buy" else -qty
        cost = signed_qty * price

        self.cash -= cost + fee

        p = self.positions.get(symbol)
        if not p:
            self.positions[symbol] = {
                "qty": signed_qty,
                "avg_price": price,
                "last_price": price,
            }
            return

        new_qty = p["qty"] + signed_qty

        if p["qty"] == 0 or (p["qty"] > 0) == (signed_qty > 0):
            # increasing position
            total_cost = (
                p["avg_price"] * abs(p["qty"])
                + price * abs(signed_qty)
            )
            p["qty"] = new_qty
            p["avg_price"] = total_cost / abs(new_qty)
        else:
            # reducing / flipping
            p["qty"] = new_qty
            if p["qty"] == 0:
                p["avg_price"] = 0.0

        p["last_price"] = price

    # =========================
    # Health
    # =========================

    def ping(self) -> bool:
        return True


# ============================
# Example Usage
# ============================

if __name__ == "__main__":
    broker = PaperBroker(starting_cash=10_000)

    print("Account:", broker.account())

    o1 = broker.submit_order(
        OrderRequest(
            symbol="AAPL",
            side="buy",
            qty=10,
            price_hint=150.0,
        )
    )
    print("Order:", o1)
    print("Positions:", broker.positions_view())

    o2 = broker.submit_order(
        OrderRequest(
            symbol="AAPL",
            side="sell",
            qty=5,
            price_hint=155.0,
        )
    )
    print("Order:", o2)
    print("Positions:", broker.positions_view())
    print("Account:", broker.account())