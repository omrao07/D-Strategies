"""
ibkr.py

Interactive Brokers execution adapter.
Supports paper & live trading via TWS / IB Gateway.

Requirements:
  pip install ib-insync==0.9.*
  IB Gateway or TWS must be running.
"""

from __future__ import annotations

import asyncio
import time
from typing import Dict, Any, Optional, List
from dataclasses import dataclass

from ib_insync import (
    IB,
    Stock,
    util,
    Trade,
)


# ============================
# Types
# ============================

Side = str          # "buy" | "sell"
OrderType = str     # "market" | "limit"
TimeInForce = str   # "DAY" | "GTC"


@dataclass
class OrderRequest:
    symbol: str
    exchange: str = "SMART"
    currency: str = "USD"
    side: Side = "buy"
    qty: int = 1
    order_type: OrderType = "market"
    limit_price: Optional[float] = None
    tif: TimeInForce = "DAY"
    client_order_id: Optional[str] = None


@dataclass
class OrderResult:
    id: int
    symbol: str
    side: Side
    qty: int
    filled_qty: int
    status: str
    submitted_at: float


# ============================
# Broker
# ============================

class IBKRBroker:
    """
    Interactive Brokers execution adapter.
    """

    def __init__(
        self,
        *,
        host: str = "127.0.0.1",
        port: int = 7497,          # 7497 = paper, 7496 = live
        client_id: int = 1,
        timeout: int = 5,
    ):
        self.ib = IB()
        self.host = host
        self.port = port
        self.client_id = client_id
        self.timeout = timeout

        util.startLoop()  # allow sync usage

        self.ib.connect(
            host=self.host,
            port=self.port,
            clientId=self.client_id,
            timeout=self.timeout,
        )

    # =========================
    # Account
    # =========================

    def account(self) -> Dict[str, Any]:
        summary = self.ib.accountSummary()
        lookup = {s.tag: s.value for s in summary}

        return {
            "account": lookup.get("Account"),
            "equity": float(lookup.get("NetLiquidation", 0)),
            "cash": float(lookup.get("AvailableFunds", 0)),
            "buying_power": float(lookup.get("BuyingPower", 0)),
        }

    # =========================
    # Orders
    # =========================

    def submit_order(self, req: OrderRequest) -> OrderResult:
        contract = Stock(
            req.symbol,
            exchange=req.exchange,
            currency=req.currency,
        )

        self.ib.qualifyContracts(contract)

        order = self.ib.createOrder(
            action="BUY" if req.side == "buy" else "SELL",
            totalQuantity=req.qty,
            orderType="MKT" if req.order_type == "market" else "LMT",
            lmtPrice=req.limit_price,
            tif=req.tif,
        )

        if req.client_order_id:
            order.orderRef = req.client_order_id

        trade: Trade = self.ib.placeOrder(contract, order)

        # Wait until order is acknowledged
        self.ib.waitOnUpdate(timeout=5)

        filled = trade.orderStatus.filled or 0

        return OrderResult(
            id=trade.order.orderId,
            symbol=req.symbol,
            side=req.side,
            qty=req.qty,
            filled_qty=int(filled),
            status=trade.orderStatus.status,
            submitted_at=time.time(),
        )

    def cancel_order(self, order_id: int) -> bool:
        try:
            self.ib.cancelOrder(order_id)
            return True
        except Exception:
            return False

    def get_order(self, order_id: int) -> Optional[OrderResult]:
        trades = self.ib.trades()
        for t in trades:
            if t.order.orderId == order_id:
                return OrderResult(
                    id=t.order.orderId,
                    symbol=t.contract.symbol,
                    side="buy" if t.order.action == "BUY" else "sell",
                    qty=t.order.totalQuantity,
                    filled_qty=int(t.orderStatus.filled or 0),
                    status=t.orderStatus.status,
                    submitted_at=time.time(),
                )
        return None

    def list_orders(self) -> List[OrderResult]:
        out: List[OrderResult] = []
        for t in self.ib.trades():
            out.append(
                OrderResult(
                    id=t.order.orderId,
                    symbol=t.contract.symbol,
                    side="buy" if t.order.action == "BUY" else "sell",
                    qty=t.order.totalQuantity,
                    filled_qty=int(t.orderStatus.filled or 0),
                    status=t.orderStatus.status,
                    submitted_at=time.time(),
                )
            )
        return out

    # =========================
    # Positions
    # =========================

    def positions(self) -> List[Dict[str, Any]]:
        ps = self.ib.positions()
        out: List[Dict[str, Any]] = []

        for p in ps:
            out.append(
                {
                    "symbol": p.contract.symbol,
                    "qty": int(p.position),
                    "avg_price": float(p.avgCost),
                    "market_value": float(p.marketValue),
                    "side": "long" if p.position > 0 else "short",
                }
            )

        return out

    # =========================
    # Health
    # =========================

    def ping(self) -> bool:
        try:
            self.ib.reqCurrentTime()
            return True
        except Exception:
            return False

    def close(self) -> None:
        self.ib.disconnect()


# ============================
# Example Usage
# ============================

if __name__ == "__main__":
    broker = IBKRBroker(
        host="127.0.0.1",
        port=7497,       # paper
        client_id=42,
    )

    print("Account:", broker.account())

    order = broker.submit_order(
        OrderRequest(
            symbol="AAPL",
            side="buy",
            qty=1,
            client_order_id=f"test-{int(time.time())}",
        )
    )

    print("Order:", order)