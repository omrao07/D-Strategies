"""
oanda.py

OANDA execution adapter (FX / CFDs).
Supports practice & live trading via OANDA v20 REST API.

Requirements:
  pip install oandapyV20==0.7.*
"""

from __future__ import annotations

import time
from typing import Dict, Any, Optional, List
from dataclasses import dataclass

from oandapyV20 import API
from oandapyV20.endpoints.accounts import AccountSummary
from oandapyV20.endpoints.orders import OrderCreate, OrderCancel
from oandapyV20.endpoints.positions import OpenPositions
from oandapyV20.endpoints.trades import TradeDetails


# ============================
# Types
# ============================

Side = str          # "buy" | "sell"
OrderType = str     # "market" | "limit"
TimeInForce = str   # "FOK" | "IOC" | "GTC"


@dataclass
class OrderRequest:
    instrument: str              # e.g. EUR_USD
    side: Side                   # buy / sell
    units: int
    order_type: OrderType = "market"
    price: Optional[float] = None
    tif: TimeInForce = "FOK"
    client_order_id: Optional[str] = None


@dataclass
class OrderResult:
    id: str
    instrument: str
    side: Side
    units: int
    filled_units: int
    status: str
    submitted_at: float


# ============================
# Broker
# ============================

class OandaBroker:
    """
    OANDA execution adapter.
    """

    def __init__(
        self,
        *,
        access_token: str,
        account_id: str,
        practice: bool = True,
        timeout: int = 10,
    ):
        """
        practice=True → practice account
        practice=False → live account
        """
        self.account_id = account_id
        self.api = API(
            access_token=access_token,
            environment="practice" if practice else "live",
            timeout=timeout,
        )

    # =========================
    # Account
    # =========================

    def account(self) -> Dict[str, Any]:
        r = AccountSummary(self.account_id)
        resp = self.api.request(r)
        a = resp["account"]

        return {
            "id": a["id"],
            "currency": a["currency"],
            "balance": float(a["balance"]),
            "nav": float(a["NAV"]),
            "margin_used": float(a["marginUsed"]),
            "margin_available": float(a["marginAvailable"]),
        }

    # =========================
    # Orders
    # =========================

    def submit_order(self, req: OrderRequest) -> OrderResult:
        units = req.units if req.side == "buy" else -abs(req.units)

        order = {
            "order": {
                "instrument": req.instrument,
                "units": str(units),
                "timeInForce": req.tif,
                "type": "MARKET" if req.order_type == "market" else "LIMIT",
                "positionFill": "DEFAULT",
            }
        }

        if req.order_type == "limit":
            if req.price is None:
                raise ValueError("limit order requires price")
            order["order"]["price"] = str(req.price)

        if req.client_order_id:
            order["order"]["clientExtensions"] = {
                "id": req.client_order_id
            }

        r = OrderCreate(self.account_id, data=order)
        resp = self.api.request(r)

        tx = (
            resp.get("orderFillTransaction")
            or resp.get("orderCreateTransaction")
            or {}
        )

        filled = int(float(tx.get("units", 0)))
        status = tx.get("type", "UNKNOWN")

        return OrderResult(
            id=tx.get("id", ""),
            instrument=req.instrument,
            side=req.side,
            units=req.units,
            filled_units=abs(filled),
            status=status.lower(),
            submitted_at=time.time(),
        )

    def cancel_order(self, order_id: str) -> bool:
        try:
            r = OrderCancel(self.account_id, order_id)
            self.api.request(r)
            return True
        except Exception:
            return False

    # =========================
    # Positions
    # =========================

    def positions(self) -> List[Dict[str, Any]]:
        r = OpenPositions(self.account_id)
        resp = self.api.request(r)

        out: List[Dict[str, Any]] = []

        for p in resp.get("positions", []):
            long_units = int(float(p["long"]["units"]))
            short_units = int(float(p["short"]["units"]))

            if long_units != 0:
                out.append(
                    {
                        "instrument": p["instrument"],
                        "units": long_units,
                        "side": "long",
                        "avg_price": float(p["long"]["averagePrice"]),
                        "unrealized_pl": float(p["long"]["unrealizedPL"]),
                    }
                )

            if short_units != 0:
                out.append(
                    {
                        "instrument": p["instrument"],
                        "units": abs(short_units),
                        "side": "short",
                        "avg_price": float(p["short"]["averagePrice"]),
                        "unrealized_pl": float(p["short"]["unrealizedPL"]),
                    }
                )

        return out

    # =========================
    # Health
    # =========================

    def ping(self) -> bool:
        try:
            self.account()
            return True
        except Exception:
            return False


# ============================
# Example Usage
# ============================

if __name__ == "__main__":
    broker = OandaBroker(
        access_token="YOUR_ACCESS_TOKEN",
        account_id="YOUR_ACCOUNT_ID",
        practice=True,
    )

    print("Account:", broker.account())

    order = broker.submit_order(
        OrderRequest(
            instrument="EUR_USD",
            side="buy",
            units=1000,
            order_type="market",
            client_order_id=f"test-{int(time.time())}",
        )
    )

    print("Order:", order)