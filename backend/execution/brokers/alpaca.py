"""
alpaca.py

Alpaca execution adapter.
Supports paper & live trading, order placement, cancelation, and position sync.

Requirements:
  pip install alpaca-trade-api==3.*
"""

from __future__ import annotations

import time
from typing import Dict, Any, Optional, List
from dataclasses import dataclass

import alpaca_trade_api as alpaca


# ============================
# Types
# ============================

Side = str          # "buy" | "sell"
OrderType = str     # "market" | "limit" | "stop"
TimeInForce = str   # "day" | "gtc"


@dataclass
class OrderRequest:
    symbol: str
    side: Side
    qty: int
    order_type: OrderType = "market"
    limit_price: Optional[float] = None
    stop_price: Optional[float] = None
    tif: TimeInForce = "day"
    client_order_id: Optional[str] = None


@dataclass
class OrderResult:
    id: str
    symbol: str
    side: Side
    qty: int
    filled_qty: int
    status: str
    submitted_at: str


# ============================
# Broker
# ============================

class AlpacaBroker:
    """
    Alpaca broker adapter.
    """

    def __init__(
        self,
        *,
        api_key: str,
        api_secret: str,
        paper: bool = True,
        base_url: Optional[str] = None,
        timeout: int = 10,
    ):
        self.paper = paper
        self.base_url = (
            base_url
            or ("https://paper-api.alpaca.markets" if paper else "https://api.alpaca.markets")
        )

        self.client = alpaca.REST(
            api_key,
            api_secret,
            base_url=self.base_url,
            timeout=timeout,
        )

    # =========================
    # Account
    # =========================

    def account(self) -> Dict[str, Any]:
        a = self.client.get_account()
        return {
            "id": a.id,
            "equity": float(a.equity),
            "cash": float(a.cash),
            "buying_power": float(a.buying_power),
            "status": a.status,
        }

    # =========================
    # Orders
    # =========================

    def submit_order(self, req: OrderRequest) -> OrderResult:
        """
        Submit an order to Alpaca.
        """

        kwargs = {
            "symbol": req.symbol,
            "qty": req.qty,
            "side": req.side,
            "type": req.order_type,
            "time_in_force": req.tif,
        }

        if req.limit_price is not None:
            kwargs["limit_price"] = req.limit_price
        if req.stop_price is not None:
            kwargs["stop_price"] = req.stop_price
        if req.client_order_id:
            kwargs["client_order_id"] = req.client_order_id

        o = self.client.submit_order(**kwargs)

        return OrderResult(
            id=o.id,
            symbol=o.symbol,
            side=o.side,
            qty=int(o.qty),
            filled_qty=int(o.filled_qty),
            status=o.status,
            submitted_at=str(o.submitted_at),
        )

    def cancel_order(self, order_id: str) -> bool:
        try:
            self.client.cancel_order(order_id)
            return True
        except Exception:
            return False

    def get_order(self, order_id: str) -> Optional[OrderResult]:
        try:
            o = self.client.get_order(order_id)
        except Exception:
            return None

        return OrderResult(
            id=o.id,
            symbol=o.symbol,
            side=o.side,
            qty=int(o.qty),
            filled_qty=int(o.filled_qty),
            status=o.status,
            submitted_at=str(o.submitted_at),
        )

    def list_orders(self, status: str = "open") -> List[OrderResult]:
        orders = self.client.list_orders(status=status)
        out: List[OrderResult] = []
        for o in orders:
            out.append(
                OrderResult(
                    id=o.id,
                    symbol=o.symbol,
                    side=o.side,
                    qty=int(o.qty),
                    filled_qty=int(o.filled_qty),
                    status=o.status,
                    submitted_at=str(o.submitted_at),
                )
            )
        return out

    # =========================
    # Positions
    # =========================

    def positions(self) -> List[Dict[str, Any]]:
        ps = self.client.list_positions()
        out: List[Dict[str, Any]] = []

        for p in ps:
            out.append(
                {
                    "symbol": p.symbol,
                    "qty": int(float(p.qty)),
                    "avg_price": float(p.avg_entry_price),
                    "market_value": float(p.market_value),
                    "unrealized_pl": float(p.unrealized_pl),
                    "side": "long" if float(p.qty) > 0 else "short",
                }
            )

        return out

    def close_position(self, symbol: str) -> bool:
        try:
            self.client.close_position(symbol)
            return True
        except Exception:
            return False

    def close_all(self) -> None:
        self.client.close_all_positions()

    # =========================
    # Health
    # =========================

    def ping(self) -> bool:
        try:
            self.client.get_clock()
            return True
        except Exception:
            return False


# ============================
# Example Usage
# ============================

if __name__ == "__main__":
    broker = AlpacaBroker(
        api_key="YOUR_KEY",
        api_secret="YOUR_SECRET",
        paper=True,
    )

    print("Account:", broker.account())

    order = broker.submit_order(
        OrderRequest(
            symbol="AAPL",
            side="buy",
            qty=1,
            order_type="market",
            client_order_id=f"test-{int(time.time())}",
        )
    )

    print("Order:", order)