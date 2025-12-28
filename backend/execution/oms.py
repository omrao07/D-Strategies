"""
oms.py

Order Management System (OMS)

Responsibilities:
- Route orders to brokers
- Enforce idempotency
- Track order lifecycle
- Normalize broker responses
- Provide a single execution interface to the engine
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


@dataclass
class OMSOrder:
    id: str
    broker: str
    symbol: str
    side: Side
    qty: float
    order_type: OrderType
    status: str
    submitted_at: float
    broker_order_id: Optional[str] = None
    fill_price: Optional[float] = None
    filled_qty: float = 0.0
    raw: Optional[Dict[str, Any]] = None


@dataclass
class OMSOrderRequest:
    broker: str
    symbol: str
    side: Side
    qty: float
    order_type: OrderType = "market"
    limit_price: Optional[float] = None
    metadata: Optional[Dict[str, Any]] = None


# ============================
# OMS
# ============================

class OMS:
    """
    Central Order Management System.
    """

    def __init__(self):
        self.brokers: Dict[str, Any] = {}
        self.orders: Dict[str, OMSOrder] = {}
        self._oid = 1

    # =========================
    # Broker Registration
    # =========================

    def register_broker(self, name: str, broker: Any) -> None:
        """
        Register a broker adapter.
        """
        self.brokers[name] = broker

    # =========================
    # Orders
    # =========================

    def submit(self, req: OMSOrderRequest) -> OMSOrder:
        if req.broker not in self.brokers:
            raise ValueError(f"Broker not registered: {req.broker}")

        broker = self.brokers[req.broker]

        oms_id = f"OMS-{self._oid}"
        self._oid += 1

        # Build broker-specific order request dynamically
        broker_req = self._build_broker_request(req, oms_id)

        result = broker.submit_order(broker_req)

        order = OMSOrder(
            id=oms_id,
            broker=req.broker,
            symbol=req.symbol,
            side=req.side,
            qty=req.qty,
            order_type=req.order_type,
            status=result.status,
            submitted_at=time.time(),
            broker_order_id=result.id,
            filled_qty=getattr(result, "filled_qty", 0),
            fill_price=getattr(result, "fill_price", None),
            raw=result.__dict__,
        )

        self.orders[oms_id] = order
        return order

    def cancel(self, oms_order_id: str) -> bool:
        order = self.orders.get(oms_order_id)
        if not order:
            return False

        broker = self.brokers[order.broker]

        if not order.broker_order_id:
            return False

        ok = broker.cancel_order(order.broker_order_id)
        if ok:
            order.status = "canceled"
        return ok

    def get(self, oms_order_id: str) -> Optional[OMSOrder]:
        return self.orders.get(oms_order_id)

    def list(self) -> List[OMSOrder]:
        return list(self.orders.values())

    # =========================
    # Account / Positions
    # =========================

    def account(self, broker_name: str) -> Dict[str, Any]:
        broker = self.brokers.get(broker_name)
        if not broker:
            raise ValueError(f"Broker not registered: {broker_name}")
        return broker.account()

    def positions(self, broker_name: str) -> List[Dict[str, Any]]:
        broker = self.brokers.get(broker_name)
        if not broker:
            raise ValueError(f"Broker not registered: {broker_name}")

        if hasattr(broker, "positions"):
            return broker.positions()
        if hasattr(broker, "positions_view"):
            return broker.positions_view()

        return []

    # =========================
    # Internals
    # =========================

    def _build_broker_request(self, req: OMSOrderRequest, oms_id: str):
        """
        Dynamically construct the broker OrderRequest
        without coupling OMS to broker classes.
        """

        broker = self.brokers[req.broker]
        OrderReq = broker.__class__.__dict__.get("OrderRequest")

        if OrderReq is None:
            # fallback: dynamic object
            return type(
                "DynamicOrderRequest",
                (),
                {
                    "symbol": req.symbol,
                    "side": req.side,
                    "qty": req.qty,
                    "order_type": req.order_type,
                    "limit_price": req.limit_price,
                    "client_order_id": oms_id,
                },
            )()

        return OrderReq(
            symbol=req.symbol,
            side=req.side,
            qty=req.qty,
            order_type=req.order_type,
            limit_price=req.limit_price,
            client_order_id=oms_id,
        )


# ============================
# Example Usage
# ============================

if __name__ == "__main__":
    from brokers.paper import PaperBroker, OrderRequest as PaperOrderRequest

    oms = OMS()

    paper = PaperBroker(starting_cash=50_000)
    oms.register_broker("paper", paper)

    order = oms.submit(
        OMSOrderRequest(
            broker="paper",
            symbol="AAPL",
            side="buy",
            qty=10,
            metadata={"strategy": "test"},
        )
    )

    print("OMS Order:", order)
    print("Positions:", oms.positions("paper"))
    print("Account:", oms.account("paper"))