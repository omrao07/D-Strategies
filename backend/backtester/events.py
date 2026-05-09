# backend/backtester/events.py
"""
Formal event system for the backtesting engine.

Events flow through the engine in order:
  MarketEvent → SignalEvent → OrderEvent → FillEvent → RiskEvent

Each event carries a timestamp, source, and typed payload so the engine
can replay them deterministically or audit the full event log.
"""
from __future__ import annotations

import datetime
import uuid
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Any, Dict, List, Optional


# ── Event types ───────────────────────────────────────────────────────────────

class EventType(Enum):
    MARKET  = auto()   # New bar or tick arrived
    SIGNAL  = auto()   # Strategy emitted a signal
    ORDER   = auto()   # Order submitted (pre-fill)
    FILL    = auto()   # Order filled (partial or full)
    RISK    = auto()   # Risk gate triggered
    CANCEL  = auto()   # Order cancelled
    MODIFY  = auto()   # Order modified


class OrderSide(Enum):
    BUY  = "buy"
    SELL = "sell"


class OrderType(Enum):
    MARKET        = "market"
    LIMIT         = "limit"
    STOP          = "stop"
    STOP_LIMIT    = "stop_limit"
    TRAILING_STOP = "trailing_stop"
    TWAP          = "twap"
    VWAP          = "vwap"
    ICEBERG       = "iceberg"


class OrderStatus(Enum):
    PENDING   = "pending"
    OPEN      = "open"
    PARTIAL   = "partial"
    FILLED    = "filled"
    CANCELLED = "cancelled"
    REJECTED  = "rejected"
    EXPIRED   = "expired"


class FillType(Enum):
    FULL    = "full"
    PARTIAL = "partial"


class RiskGateType(Enum):
    DAILY_LOSS       = "daily_loss"
    DRAWDOWN         = "drawdown"
    BETA             = "beta"
    POSITION_SIZE    = "position_size"
    VIX              = "vix"
    SECTOR           = "sector"
    ORDER_RATE       = "order_rate"
    MARGIN           = "margin"
    CIRCUIT_BREAKER  = "circuit_breaker"
    FO_BAN           = "fo_ban"
    CORRELATION      = "correlation"
    LEVERAGE         = "leverage"
    CONCENTRATION    = "concentration"


# ── Base event ────────────────────────────────────────────────────────────────

@dataclass
class BaseEvent:
    ts: datetime.datetime
    event_type: EventType
    event_id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    source: str = ""        # strategy name, "engine", "risk", etc.

    def to_dict(self) -> Dict[str, Any]:
        return {
            "event_id": self.event_id,
            "event_type": self.event_type.name,
            "ts": self.ts.isoformat(),
            "source": self.source,
        }


# ── MarketEvent ───────────────────────────────────────────────────────────────

@dataclass
class MarketEvent(BaseEvent):
    """
    Fired once per bar (or tick). Contains the full OHLCV data and
    optional order book snapshot.
    """
    event_type: EventType = field(default=EventType.MARKET, init=False)
    symbol: str = ""
    open: float = 0.0
    high: float = 0.0
    low: float = 0.0
    close: float = 0.0
    volume: float = 0.0
    vwap: float = 0.0
    bid: float = 0.0
    ask: float = 0.0
    spread: float = 0.0
    # Tick-level data (populated when available)
    tick_price: Optional[float] = None
    tick_size: Optional[float] = None
    # Market microstructure
    bid_size: float = 0.0
    ask_size: float = 0.0
    liquidity: float = 0.0    # estimated $ available within 1bp
    adv_20: float = 0.0       # 20-day avg daily volume in $
    # Metadata
    exchange: str = "NSE"
    currency: str = "INR"
    is_adjusted: bool = True

    def to_dict(self) -> Dict[str, Any]:
        d = super().to_dict()
        d.update({
            "symbol": self.symbol,
            "open": self.open, "high": self.high, "low": self.low,
            "close": self.close, "volume": self.volume, "vwap": self.vwap,
            "bid": self.bid, "ask": self.ask, "spread": self.spread,
            "adv_20": self.adv_20,
        })
        return d


# ── SignalEvent ───────────────────────────────────────────────────────────────

@dataclass
class SignalEvent(BaseEvent):
    """
    Emitted by a strategy after processing a MarketEvent.
    score ∈ [-1, +1]: -1 = max short, +1 = max long, 0 = flat.
    """
    event_type: EventType = field(default=EventType.SIGNAL, init=False)
    strategy: str = ""
    symbol: str = ""
    score: float = 0.0          # [-1, +1]
    strength: float = 1.0       # signal conviction [0, 1]
    vol: float = 0.15           # strategy estimated volatility
    drawdown: float = 0.0
    # Feature vector that generated this signal (for attribution)
    features: Dict[str, float] = field(default_factory=dict)
    regime: str = "unknown"     # "bull" | "bear" | "sideways" | "crisis"
    horizon_bars: int = 1       # intended holding period

    def to_dict(self) -> Dict[str, Any]:
        d = super().to_dict()
        d.update({
            "strategy": self.strategy,
            "symbol": self.symbol,
            "score": self.score,
            "strength": self.strength,
            "vol": self.vol,
            "regime": self.regime,
        })
        return d


# ── OrderEvent ────────────────────────────────────────────────────────────────

@dataclass
class OrderEvent(BaseEvent):
    """
    An order submitted by a strategy (before risk check and execution).
    """
    event_type: EventType = field(default=EventType.ORDER, init=False)
    order_id: str = field(default_factory=lambda: f"ORD-{str(uuid.uuid4())[:8].upper()}")
    strategy: str = ""
    symbol: str = ""
    side: OrderSide = OrderSide.BUY
    order_type: OrderType = OrderType.MARKET
    qty: float = 0.0
    # Price parameters (used by limit / stop / trailing-stop)
    limit_price: Optional[float] = None
    stop_price: Optional[float] = None
    trail_pct: Optional[float] = None   # trailing stop %
    # Algo order parameters
    duration_bars: int = 1              # TWAP / VWAP window
    iceberg_qty: Optional[float] = None # iceberg visible qty
    # Execution hints
    venue: str = "NSE"
    mark_price: Optional[float] = None
    urgency: float = 0.5                # 0=patient, 1=aggressive
    # State
    status: OrderStatus = OrderStatus.PENDING
    filled_qty: float = 0.0
    avg_fill_price: float = 0.0
    # Signal that generated this order
    signal_ref: Optional[str] = None   # SignalEvent.event_id

    def is_buy(self) -> bool:
        return self.side == OrderSide.BUY

    def remaining_qty(self) -> float:
        return max(0.0, self.qty - self.filled_qty)

    def to_dict(self) -> Dict[str, Any]:
        d = super().to_dict()
        d.update({
            "order_id": self.order_id,
            "strategy": self.strategy,
            "symbol": self.symbol,
            "side": self.side.value,
            "order_type": self.order_type.value,
            "qty": self.qty,
            "limit_price": self.limit_price,
            "stop_price": self.stop_price,
            "status": self.status.value,
            "filled_qty": self.filled_qty,
            "avg_fill_price": self.avg_fill_price,
        })
        return d


# ── FillEvent ─────────────────────────────────────────────────────────────────

@dataclass
class FillEvent(BaseEvent):
    """
    Emitted when an order is (partially) filled by the execution engine.
    """
    event_type: EventType = field(default=EventType.FILL, init=False)
    order_id: str = ""
    strategy: str = ""
    symbol: str = ""
    side: OrderSide = OrderSide.BUY
    fill_type: FillType = FillType.FULL
    # Fill details
    fill_qty: float = 0.0
    fill_price: float = 0.0          # actual execution price
    mark_price: float = 0.0          # reference / mid price
    # Cost breakdown
    commission: float = 0.0
    slippage: float = 0.0            # abs $ slippage vs mark
    spread_cost: float = 0.0
    market_impact: float = 0.0       # Almgren-Chriss impact
    borrow_fee: float = 0.0          # for short fills
    total_cost: float = 0.0          # all-in execution cost
    # Latency
    latency_ms: float = 0.0
    # Derived
    notional: float = 0.0
    slippage_bps: float = 0.0
    impact_bps: float = 0.0

    def net_proceeds(self) -> float:
        """Net cash impact: positive for sells, negative for buys."""
        sign = -1.0 if self.side == OrderSide.BUY else 1.0
        return sign * (self.notional + self.total_cost)

    def to_dict(self) -> Dict[str, Any]:
        d = super().to_dict()
        d.update({
            "order_id": self.order_id,
            "strategy": self.strategy,
            "symbol": self.symbol,
            "side": self.side.value,
            "fill_qty": self.fill_qty,
            "fill_price": self.fill_price,
            "commission": self.commission,
            "slippage": self.slippage,
            "market_impact": self.market_impact,
            "total_cost": self.total_cost,
            "latency_ms": self.latency_ms,
            "notional": self.notional,
            "slippage_bps": self.slippage_bps,
        })
        return d


# ── RiskEvent ─────────────────────────────────────────────────────────────────

@dataclass
class RiskEvent(BaseEvent):
    """
    Fired when a risk gate is checked (pass or fail).
    """
    event_type: EventType = field(default=EventType.RISK, init=False)
    gate: RiskGateType = RiskGateType.POSITION_SIZE
    triggered: bool = False          # True = gate FAILED
    reason: str = ""
    # Order that triggered the check (if applicable)
    order_id: Optional[str] = None
    strategy: Optional[str] = None
    symbol: Optional[str] = None
    # Values at trigger
    current_value: float = 0.0
    limit_value: float = 0.0
    # Action taken
    action: str = ""                 # "block", "halt", "reduce", "warn"

    def to_dict(self) -> Dict[str, Any]:
        d = super().to_dict()
        d.update({
            "gate": self.gate.name,
            "triggered": self.triggered,
            "reason": self.reason,
            "action": self.action,
            "current_value": self.current_value,
            "limit_value": self.limit_value,
        })
        return d


# ── Event queue ───────────────────────────────────────────────────────────────

class EventQueue:
    """
    Ordered event queue for the backtesting event loop.
    Events are processed in timestamp order; ties broken by EventType order.
    """

    _PRIORITY = {
        EventType.MARKET:  0,
        EventType.RISK:    1,
        EventType.SIGNAL:  2,
        EventType.ORDER:   3,
        EventType.FILL:    4,
        EventType.CANCEL:  5,
        EventType.MODIFY:  6,
    }

    def __init__(self):
        self._queue: List[BaseEvent] = []
        self.processed: List[BaseEvent] = []

    def put(self, event: BaseEvent) -> None:
        self._queue.append(event)

    def get(self) -> Optional[BaseEvent]:
        if not self._queue:
            return None
        # Sort by (ts, event_type priority)
        self._queue.sort(key=lambda e: (e.ts, self._PRIORITY.get(e.event_type, 9)))
        return self._queue.pop(0)

    def __len__(self) -> int:
        return len(self._queue)

    def is_empty(self) -> bool:
        return len(self._queue) == 0

    def log_all(self) -> List[Dict]:
        return [e.to_dict() for e in self.processed]
