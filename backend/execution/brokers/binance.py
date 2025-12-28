"""
binance.py

Binance execution adapter (Spot).
Supports live & paper trading, order placement, cancelation, balances, and positions.

Requirements:
  pip install python-binance==1.*
"""

from __future__ import annotations

import time
from typing import Dict, Any, Optional, List
from dataclasses import dataclass

from binance.client import Client
from binance.exceptions import BinanceAPIException


# ============================
# Types
# ============================

Side = str          # "buy" | "sell"
OrderType = str     # "market" | "limit"
TimeInForce = str   # "GTC" | "IOC" | "FOK"


@dataclass
class OrderRequest:
    symbol: str                  # e.g. BTCUSDT
    side: Side                   # buy / sell
    qty: float
    order_type: OrderType = "market"
    limit_price: Optional[float] = None
    tif: TimeInForce = "GTC"
    client_order_id: Optional[str] = None


@dataclass
class OrderResult:
    id: str
    symbol: str
    side: Side
    qty: float
    filled_qty: float
    status: str
    submitted_at: int


# ============================
# Broker
# ============================

class BinanceBroker:
    """
    Binance Spot broker adapter.
    """

    def __init__(
        self,
        *,
        api_key: str,
        api_secret: str,
        paper: bool = False,
        testnet: bool = False,
        timeout: int = 10,
    ):
        """
        paper=True disables order submission (simulation only)
        testnet=True routes to Binance testnet
        """
        self.paper = paper
        self.client = Client(
            api_key,
            api_secret,
            testnet=testnet,
            requests_params={"timeout": timeout},
        )

    # =========================
    # Account
    # =========================

    def account(self) -> Dict[str, Any]:
        info = self.client.get_account()
        balances = {
            b["asset"]: float(b["free"])
            for b in info["balances"]
            if float(b["free"]) > 0
        }

        return {
            "can_trade": info["canTrade"],
            "balances": balances,
        }

    # =========================
    # Orders
    # =========================

    def submit_order(self, req: OrderRequest) -> OrderResult:
        """
        Submit a spot order.
        """

        if self.paper:
            return OrderResult(
                id=f"paper-{int(time.time())}",
                symbol=req.symbol,
                side=req.side,
                qty=req.qty,
                filled_qty=0.0,
                status="paper",
                submitted_at=int(time.time() * 1000),
            )

        params = {
            "symbol": req.symbol,
            "side": req.side.upper(),
            "quantity": req.qty,
            "newClientOrderId": req.client_order_id,
        }

        if req.order_type == "market":
            params["type"] = Client.ORDER_TYPE_MARKET
        else:
            params["type"] = Client.ORDER_TYPE_LIMIT
            params["price"] = req.limit_price
            params["timeInForce"] = req.tif

        try:
            o = self.client.create_order(**params)
        except BinanceAPIException as e:
            raise RuntimeError(f"Binance order failed: {e.message}") from e

        return OrderResult(
            id=str(o["orderId"]),
            symbol=o["symbol"],
            side=o["side"].lower(),
            qty=float(o["origQty"]),
            filled_qty=float(o["executedQty"]),
            status=o["status"].lower(),
            submitted_at=o["transactTime"],
        )

    def cancel_order(self, symbol: str, order_id: str) -> bool:
        try:
            self.client.cancel_order(symbol=symbol, orderId=order_id)
            return True
        except BinanceAPIException:
            return False

    def get_order(self, symbol: str, order_id: str) -> Optional[OrderResult]:
        try:
            o = self.client.get_order(symbol=symbol, orderId=order_id)
        except BinanceAPIException:
            return None

        return OrderResult(
            id=str(o["orderId"]),
            symbol=o["symbol"],
            side=o["side"].lower(),
            qty=float(o["origQty"]),
            filled_qty=float(o["executedQty"]),
            status=o["status"].lower(),
            submitted_at=o["time"],
        )

    def list_orders(self, symbol: str) -> List[OrderResult]:
        orders = self.client.get_all_orders(symbol=symbol)
        out: List[OrderResult] = []

        for o in orders:
            out.append(
                OrderResult(
                    id=str(o["orderId"]),
                    symbol=o["symbol"],
                    side=o["side"].lower(),
                    qty=float(o["origQty"]),
                    filled_qty=float(o["executedQty"]),
                    status=o["status"].lower(),
                    submitted_at=o["time"],
                )
            )
        return out

    # =========================
    # Positions / Balances
    # =========================

    def balances(self) -> Dict[str, float]:
        info = self.client.get_account()
        return {
            b["asset"]: float(b["free"])
            for b in info["balances"]
            if float(b["free"]) > 0
        }

    # =========================
    # Health
    # =========================

    def ping(self) -> bool:
        try:
            self.client.ping()
            return True
        except Exception:
            return False


# ============================
# Example Usage
# ============================

if __name__ == "__main__":
    broker = BinanceBroker(
        api_key="YOUR_API_KEY",
        api_secret="YOUR_API_SECRET",
        paper=True,
    )

    print("Account:", broker.account())

    order = broker.submit_order(
        OrderRequest(
            symbol="BTCUSDT",
            side="buy",
            qty=0.001,
            order_type="market",
            client_order_id=f"test-{int(time.time())}",
        )
    )

    print("Order:", order)