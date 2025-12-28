"""
zerodha.py

Zerodha Kite execution adapter.
Supports equity, futures, and options via Kite Connect.

Requirements:
  pip install kiteconnect==4.*
"""

from __future__ import annotations

import time
from typing import Dict, Any, Optional, List
from dataclasses import dataclass

from kiteconnect import KiteConnect


# ============================
# Types
# ============================

Side = str          # "buy" | "sell"
OrderType = str     # "market" | "limit"
Product = str       # "CNC" | "MIS" | "NRML"
Exchange = str      # "NSE" | "BSE" | "NFO"


@dataclass
class OrderRequest:
    symbol: str                  # e.g. RELIANCE
    exchange: Exchange = "NSE"
    side: Side = "buy"
    qty: int = 1
    order_type: OrderType = "market"
    price: Optional[float] = None
    product: Product = "CNC"
    validity: str = "DAY"
    tag: Optional[str] = None


@dataclass
class OrderResult:
    id: str
    symbol: str
    side: Side
    qty: int
    filled_qty: int
    status: str
    submitted_at: float


# ============================
# Broker
# ============================

class ZerodhaBroker:
    """
    Zerodha Kite broker adapter.
    """

    def __init__(
        self,
        *,
        api_key: str,
        access_token: str,
    ):
        self.kite = KiteConnect(api_key=api_key)
        self.kite.set_access_token(access_token)

    # =========================
    # Account
    # =========================

    def account(self) -> Dict[str, Any]:
        margins = self.kite.margins()
        equity = margins.get("equity", {})

        return {
            "available_cash": float(equity.get("available", {}).get("cash", 0)),
            "net": float(equity.get("net", 0)),
            "utilised": float(equity.get("utilised", {}).get("debits", 0)),
        }

    # =========================
    # Orders
    # =========================

    def submit_order(self, req: OrderRequest) -> OrderResult:
        transaction_type = (
            self.kite.TRANSACTION_TYPE_BUY
            if req.side == "buy"
            else self.kite.TRANSACTION_TYPE_SELL
        )

        order_type = (
            self.kite.ORDER_TYPE_MARKET
            if req.order_type == "market"
            else self.kite.ORDER_TYPE_LIMIT
        )

        order_id = self.kite.place_order(
            variety=self.kite.VARIETY_REGULAR,
            exchange=req.exchange,
            tradingsymbol=req.symbol,
            transaction_type=transaction_type,
            quantity=req.qty,
            product=req.product,
            order_type=order_type,
            price=req.price,
            validity=req.validity,
            tag=req.tag,
        )

        return OrderResult(
            id=order_id,
            symbol=req.symbol,
            side=req.side,
            qty=req.qty,
            filled_qty=0,
            status="submitted",
            submitted_at=time.time(),
        )

    def cancel_order(self, order_id: str) -> bool:
        try:
            self.kite.cancel_order(
                variety=self.kite.VARIETY_REGULAR,
                order_id=order_id,
            )
            return True
        except Exception:
            return False

    def get_order(self, order_id: str) -> Optional[OrderResult]:
        try:
            orders = self.kite.orders()
        except Exception:
            return None

        for o in orders:
            if o["order_id"] == order_id:
                return OrderResult(
                    id=o["order_id"],
                    symbol=o["tradingsymbol"],
                    side="buy" if o["transaction_type"] == "BUY" else "sell",
                    qty=int(o["quantity"]),
                    filled_qty=int(o["filled_quantity"]),
                    status=o["status"].lower(),
                    submitted_at=time.time(),
                )
        return None

    def list_orders(self) -> List[OrderResult]:
        out: List[OrderResult] = []
        for o in self.kite.orders():
            out.append(
                OrderResult(
                    id=o["order_id"],
                    symbol=o["tradingsymbol"],
                    side="buy" if o["transaction_type"] == "BUY" else "sell",
                    qty=int(o["quantity"]),
                    filled_qty=int(o["filled_quantity"]),
                    status=o["status"].lower(),
                    submitted_at=time.time(),
                )
            )
        return out

    # =========================
    # Positions
    # =========================

    def positions(self) -> List[Dict[str, Any]]:
        data = self.kite.positions()
        out: List[Dict[str, Any]] = []

        for p in data.get("net", []):
            if p["quantity"] == 0:
                continue

            out.append(
                {
                    "symbol": p["tradingsymbol"],
                    "exchange": p["exchange"],
                    "qty": int(p["quantity"]),
                    "avg_price": float(p["average_price"]),
                    "pnl": float(p["pnl"]),
                    "side": "long" if p["quantity"] > 0 else "short",
                }
            )

        return out

    # =========================
    # Health
    # =========================

    def ping(self) -> bool:
        try:
            self.kite.profile()
            return True
        except Exception:
            return False


# ============================
# Example Usage
# ============================

if __name__ == "__main__":
    broker = ZerodhaBroker(
        api_key="YOUR_API_KEY",
        access_token="YOUR_ACCESS_TOKEN",
    )

    print("Account:", broker.account())

    order = broker.submit_order(
        OrderRequest(
            symbol="RELIANCE",
            side="buy",
            qty=1,
            order_type="market",
            product="CNC",
            tag="engine-test",
        )
    )

    print("Order:", order)