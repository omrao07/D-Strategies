# backend/execution/broker_interface.py
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Protocol

# --- Optional Kite Connect (Zerodha) ---
try:
    from kiteconnect import KiteConnect as _KiteConnect  # pip install kiteconnect
    _HAVE_KITE = True
except ImportError:
    _KiteConnect = None  # type: ignore
    _HAVE_KITE = False

# --- Optional ib_insync (IBKR) ---
try:
    from ib_insync import IB as _IB  # pip install ib_insync
    from ib_insync import LimitOrder as _LimitOrder
    from ib_insync import MarketOrder as _MarketOrder
    from ib_insync import Stock as _Stock
    _HAVE_IB = True
except ImportError:
    _IB = None  # type: ignore
    _HAVE_IB = False


# =======================
# Data Models
# =======================

@dataclass
class Order:
    id: str
    symbol: str
    side: str          # "buy" | "sell"
    qty: float         # absolute units (shares/contracts)
    price: float       # decision/limit reference (for market we still keep last seen)
    type: str = "market"     # "market" | "limit"
    tif: str = "day"         # "day" | "ioc" | "gtc"
    strategy: str = "unknown"
    ts: float = field(default_factory=lambda: time.time())
    attrs: Dict[str, Any] = field(default_factory=dict)  # venue, algo, etc.


@dataclass
class Fill:
    order_id: str
    symbol: str
    side: str
    qty: float         # signed (+buy, -sell)
    price: float
    fee: float
    ts: float


@dataclass
class Position:
    symbol: str
    qty: float = 0.0
    avg_price: float = 0.0

    def apply_fill(self, f: Fill):
        # update average price logically for long/short
        if self.qty == 0 or (self.qty > 0 and f.qty > 0) or (self.qty < 0 and f.qty < 0):
            new_qty = self.qty + f.qty
            if abs(new_qty) > 1e-12:
                self.avg_price = ((abs(self.qty) * self.avg_price) + (abs(f.qty) * f.price)) / abs(new_qty)
            else:
                self.avg_price = 0.0
            self.qty = new_qty
            return

        # offsetting or flipping
        offset = -min(abs(self.qty), abs(f.qty)) * (1 if f.qty < 0 else -1)
        self.qty += offset
        remainder = f.qty - offset
        if remainder != 0:
            # flipped
            self.avg_price = f.price
            self.qty += remainder
        elif abs(self.qty) < 1e-12:
            self.avg_price = 0.0


@dataclass
class Account:
    equity: float
    cash: float
    buying_power: float
    currency: str = "USD"


# =======================
# Broker Interface
# =======================

class BaseBroker(Protocol):
    name: str

    # lifecycle
    def connect(self) -> None: ...
    def disconnect(self) -> None: ...

    # state
    def get_account(self) -> Account: ...
    def get_positions(self) -> Dict[str, Position]: ...
    def get_open_orders(self) -> Dict[str, Order]: ...

    # trading
    def place_order(self, order: Order) -> Fill: ...
    def cancel_order(self, order_id: str) -> bool: ...
    def replace_order(self, order_id: str, new_qty: Optional[float] = None, new_price: Optional[float] = None) -> bool: ...

    # (optional) market context (used by PaperBroker)
    def set_prices(self, prices: Dict[str, float]) -> None: ...


# =======================
# Paper Broker (local sim)
# =======================

class PaperBroker:
    """
    Simple synchronous simulator.
    - Fills at current price (last mark) with optional slippage/fees.
    - Tracks cash, positions, equity.
    """
    name = "paper"

    def __init__(
        self,
        starting_cash: float = 100_000.0,
        fees_bps: float = 2.0,
        slippage_bps: float = 1.0,
        base_ccy: str = "USD",
    ):
        self._cash = float(starting_cash)
        self._fees_bps = float(fees_bps)
        self._slip_bps = float(slippage_bps)
        self._ccy = base_ccy

        self._positions: Dict[str, Position] = {}
        self._orders: Dict[str, Order] = {}
        self._prices: Dict[str, float] = {}

    # ----- lifecycle -----
    def connect(self) -> None:  # noqa
        pass

    def disconnect(self) -> None:  # noqa
        pass

    # ----- state -----
    def get_account(self) -> Account:
        equity = self._cash + sum(pos.qty * self._prices.get(sym, pos.avg_price) for sym, pos in self._positions.items())
        # naive x2 buying power
        bp = self._cash * 2.0
        return Account(equity=equity, cash=self._cash, buying_power=bp, currency=self._ccy)

    def get_positions(self) -> Dict[str, Position]:
        return {k: Position(symbol=v.symbol, qty=v.qty, avg_price=v.avg_price) for k, v in self._positions.items()}

    def get_open_orders(self) -> Dict[str, Order]:
        return dict(self._orders)

    # ----- market context -----
    def set_prices(self, prices: Dict[str, float]) -> None:
        self._prices.update({k: float(v) for k, v in prices.items()})

    # ----- trading -----
    def _slip_price(self, side: str, px: float) -> float:
        sgn = +1 if side.lower().startswith("b") else -1
        return px * (1.0 + sgn * self._slip_bps / 1e4)

    def _fee_for_notional(self, qty: float, px: float) -> float:
        return abs(qty * px) * (self._fees_bps / 1e4)

    def place_order(self, order: Order) -> Fill:
        sym = order.symbol
        px = order.price
        last = self._prices.get(sym, px)
        fill_px = self._slip_price(order.side, last)
        fee = self._fee_for_notional(order.qty, fill_px)

        # cash move: buys spend, sells receive
        signed_qty = order.qty if order.side.lower().startswith("b") else -order.qty
        cash_delta = -(signed_qty * fill_px) - fee  # negative when buy
        self._cash += cash_delta

        # positions
        pos = self._positions.get(sym, Position(symbol=sym))
        f = Fill(
            order_id=order.id,
            symbol=sym,
            side=order.side,
            qty=signed_qty,
            price=fill_px,
            fee=fee,
            ts=time.time(),
        )
        pos.apply_fill(f)
        self._positions[sym] = pos

        # record & close immediately (market IOC fill model)
        self._orders[order.id] = order

        return f

    def cancel_order(self, order_id: str) -> bool:
        return self._orders.pop(order_id, None) is not None

    def replace_order(self, order_id: str, new_qty: Optional[float] = None, new_price: Optional[float] = None) -> bool:
        o = self._orders.get(order_id)
        if not o:
            return False
        if new_qty is not None:
            o.qty = float(new_qty)
        if new_price is not None:
            o.price = float(new_price)
        return True


# =======================
# IBKR Adapter (skeleton)
# =======================

class IBKRBroker:
    """
    Adapter over ib_insync (pip install ib_insync).
    Connects to IB Gateway or TWS on host:port.
    """
    name = "ibkr"

    def __init__(self, host: str = "127.0.0.1", port: int = 7497, client_id: int = 1, currency: str = "USD"):
        if not _HAVE_IB:
            raise RuntimeError("pip install ib_insync to use IBKRBroker")
        self.host = host
        self.port = port
        self.client_id = client_id
        self.currency = currency
        self._connected = False
        self.ib = _IB()

    def connect(self) -> None:
        self.ib.connect(self.host, self.port, clientId=self.client_id)
        self._connected = True

    def disconnect(self) -> None:
        if self._connected:
            self.ib.disconnect()
        self._connected = False

    def get_account(self) -> Account:
        vals = {v.tag: v.value for v in self.ib.accountValues() if v.currency == self.currency or v.currency == ""}
        equity = float(vals.get("NetLiquidation", 0.0))
        cash = float(vals.get("TotalCashValue", 0.0))
        bp = float(vals.get("BuyingPower", cash * 2))
        return Account(equity=equity, cash=cash, buying_power=bp, currency=self.currency)

    def get_positions(self) -> Dict[str, Position]:
        out: Dict[str, Position] = {}
        for p in self.ib.positions():
            sym = p.contract.symbol
            out[sym] = Position(symbol=sym, qty=float(p.position), avg_price=float(p.avgCost))
        return out

    def get_open_orders(self) -> Dict[str, Order]:
        out: Dict[str, Order] = {}
        for trade in self.ib.openTrades():
            o = trade.order
            c = trade.contract
            key = str(o.orderId)
            out[key] = Order(
                id=key,
                symbol=c.symbol,
                side="buy" if o.action == "BUY" else "sell",
                qty=float(o.totalQuantity),
                price=float(getattr(o, "lmtPrice", 0.0) or 0.0),
                type="limit" if hasattr(o, "lmtPrice") and o.lmtPrice else "market",
            )
        return out

    def place_order(self, order: Order) -> Fill:
        contract = _Stock(order.symbol, "SMART", self.currency)
        action = "BUY" if order.side.lower().startswith("b") else "SELL"
        if order.type == "limit":
            ib_order = _LimitOrder(action, order.qty, order.price)
        else:
            ib_order = _MarketOrder(action, order.qty)
        trade = self.ib.placeOrder(contract, ib_order)
        self.ib.sleep(0.5)  # brief yield for fill
        fill_price = order.price
        if trade.fills:
            fill_price = float(trade.fills[-1].execution.price)
        signed_qty = order.qty if action == "BUY" else -order.qty
        return Fill(
            order_id=order.id,
            symbol=order.symbol,
            side=order.side,
            qty=signed_qty,
            price=fill_price,
            fee=0.0,
            ts=time.time(),
        )

    def cancel_order(self, order_id: str) -> bool:
        for trade in self.ib.openTrades():
            if str(trade.order.orderId) == order_id:
                self.ib.cancelOrder(trade.order)
                return True
        return False

    def replace_order(self, order_id: str, new_qty: Optional[float] = None, new_price: Optional[float] = None) -> bool:
        for trade in self.ib.openTrades():
            if str(trade.order.orderId) == order_id:
                o = trade.order
                if new_qty is not None:
                    o.totalQuantity = new_qty
                if new_price is not None and hasattr(o, "lmtPrice"):
                    o.lmtPrice = new_price
                self.ib.placeOrder(trade.contract, o)
                return True
        return False

    def set_prices(self, prices: Dict[str, float]) -> None:
        pass


# =======================
# Zerodha (Kite) Adapter (skeleton)
# =======================

class ZerodhaBroker:
    """
    Adapter over Kite Connect SDK (pip install kiteconnect).
    Uses environment credentials by default; override in constructor.
    """
    name = "zerodha"

    def __init__(self, api_key: str, access_token: str, user_id: Optional[str] = None, currency: str = "INR"):
        if not _HAVE_KITE:
            raise RuntimeError("pip install kiteconnect to use ZerodhaBroker")
        self.api_key = api_key
        self.access_token = access_token
        self.user_id = user_id
        self.currency = currency
        self._connected = False
        self.kite: Any = None

    def connect(self) -> None:
        self.kite = _KiteConnect(api_key=self.api_key)
        self.kite.set_access_token(self.access_token)
        # Verify auth — raises KiteException on bad token
        profile = self.kite.profile()
        self.user_id = self.user_id or profile.get("user_id")
        self._connected = True

    def disconnect(self) -> None:
        self._connected = False
        self.kite = None

    def get_account(self) -> Account:
        if not self.kite:
            raise RuntimeError("Not connected")
        margins = self.kite.margins("equity")
        net = margins.get("net", {})
        available = net.get("available", {})
        equity = float(net.get("net", available.get("cash", 0.0)))
        cash = float(available.get("live_balance", available.get("cash", 0.0)))
        bp = float(available.get("intraday_payin", cash))
        return Account(equity=equity, cash=cash, buying_power=bp, currency=self.currency)

    def get_positions(self) -> Dict[str, Position]:
        if not self.kite:
            raise RuntimeError("Not connected")
        out: Dict[str, Position] = {}
        for p in self.kite.positions().get("net", []):
            sym = p["tradingsymbol"]
            out[sym] = Position(
                symbol=sym,
                qty=float(p.get("quantity", 0)),
                avg_price=float(p.get("average_price", 0.0)),
            )
        return out

    def get_open_orders(self) -> Dict[str, Order]:
        if not self.kite:
            raise RuntimeError("Not connected")
        out: Dict[str, Order] = {}
        for o in self.kite.orders():
            if o.get("status") not in ("COMPLETE", "CANCELLED", "REJECTED"):
                oid = str(o["order_id"])
                out[oid] = Order(
                    id=oid,
                    symbol=o["tradingsymbol"],
                    side="buy" if o["transaction_type"] == "BUY" else "sell",
                    qty=float(o.get("quantity", 0)),
                    price=float(o.get("price", 0.0)),
                    type=o.get("order_type", "MARKET").lower(),
                )
        return out

    def place_order(self, order: Order) -> Fill:
        if not self.kite:
            raise RuntimeError("Not connected")
        txn = self.kite.TRANSACTION_TYPE_BUY if order.side.lower().startswith("b") else self.kite.TRANSACTION_TYPE_SELL
        order_type = self.kite.ORDER_TYPE_LIMIT if order.type == "limit" else self.kite.ORDER_TYPE_MARKET
        params: Dict[str, Any] = dict(
            variety=self.kite.VARIETY_REGULAR,
            exchange=self.kite.EXCHANGE_NSE,
            tradingsymbol=order.symbol,
            transaction_type=txn,
            quantity=int(order.qty),
            product=self.kite.PRODUCT_MIS,
            order_type=order_type,
        )
        if order.type == "limit":
            params["price"] = order.price
        order_id = self.kite.place_order(**params)
        # Fetch fill details
        fill_price = order.price
        try:
            history = self.kite.order_history(order_id)
            completed = [h for h in history if h.get("status") == "COMPLETE"]
            if completed:
                fill_price = float(completed[-1].get("average_price", order.price))
        except Exception:
            pass
        signed_qty = order.qty if txn == self.kite.TRANSACTION_TYPE_BUY else -order.qty
        fee = abs(signed_qty * fill_price) * 0.0003  # ~0.03% NSE transaction charge approx
        return Fill(
            order_id=str(order_id),
            symbol=order.symbol,
            side=order.side,
            qty=signed_qty,
            price=fill_price,
            fee=fee,
            ts=time.time(),
        )

    def cancel_order(self, order_id: str) -> bool:
        if not self.kite:
            raise RuntimeError("Not connected")
        try:
            self.kite.cancel_order(variety=self.kite.VARIETY_REGULAR, order_id=order_id)
            return True
        except Exception:
            return False

    def replace_order(self, order_id: str, new_qty: Optional[float] = None, new_price: Optional[float] = None) -> bool:
        if not self.kite:
            raise RuntimeError("Not connected")
        try:
            params: Dict[str, Any] = dict(variety=self.kite.VARIETY_REGULAR, order_id=order_id)
            if new_qty is not None:
                params["quantity"] = int(new_qty)
            if new_price is not None:
                params["price"] = new_price
            self.kite.modify_order(**params)
            return True
        except Exception:
            return False

    def set_prices(self, prices: Dict[str, float]) -> None:
        pass


# =======================
# Factory
# =======================

def make_broker(cfg: Dict[str, Any]) -> BaseBroker:
    """
    Factory: chooses broker based on cfg.
    Example cfg:
        {
          "broker": {"name": "paper", "fees_bps": 2.0, "slippage_bps": 1.5, "starting_cash": 200000},
          # or
          "broker": {"name": "ibkr", "host":"127.0.0.1","port":7497,"client_id":1},
          # or
          "broker": {"name": "zerodha", "api_key":"...", "access_token":"..."}
        }
    """
    bcfg = cfg.get("broker", {}) or {}
    name = str(bcfg.get("name", "paper")).lower()

    if name == "paper":
        return PaperBroker(
            starting_cash=float(bcfg.get("starting_cash", 100_000)),
            fees_bps=float(bcfg.get("fees_bps", 2.0)),
            slippage_bps=float(bcfg.get("slippage_bps", 1.0)),
            base_ccy=str(bcfg.get("currency", "USD")),
        )

    if name == "ibkr":
        return IBKRBroker(
            host=str(bcfg.get("host", "127.0.0.1")),
            port=int(bcfg.get("port", 7497)),
            client_id=int(bcfg.get("client_id", 1)),
            currency=str(bcfg.get("currency", "USD")),
        )

    if name == "zerodha":
        return ZerodhaBroker(
            api_key=str(bcfg["api_key"]),
            access_token=str(bcfg["access_token"]),
            user_id=bcfg.get("user_id"),
            currency=str(bcfg.get("currency", "INR")),
        )

    raise ValueError(f"Unknown broker: {name}")


# =======================
# Convenience helpers
# =======================

def new_order(
    symbol: str,
    side: str,
    qty: float,
    price: float,
    *,
    type: str = "market",
    tif: str = "day",
    strategy: str = "unknown",
    attrs: Optional[Dict[str, Any]] = None,
) -> Order:
    return Order(
        id=str(uuid.uuid4()),
        symbol=symbol,
        side=side.lower(),
        qty=float(abs(qty)),
        price=float(price),
        type=type,
        tif=tif,
        strategy=strategy,
        attrs=dict(attrs or {}),
    )