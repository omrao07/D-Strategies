# backend/common/schemas.py
"""
Shared data-transfer schemas used across agents, backtester, and analytics.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional


@dataclass
class Quote:
    """NBBO / venue quote snapshot."""
    symbol: str
    ts_ms: int
    bid: Optional[float] = None
    ask: Optional[float] = None
    bid_size: Optional[float] = None
    ask_size: Optional[float] = None
    venue: Optional[str] = None

    def mid(self) -> Optional[float]:
        if self.bid is not None and self.ask is not None and self.ask >= self.bid:
            return 0.5 * (self.bid + self.ask)
        return None

    def spread_bps(self) -> Optional[float]:
        m = self.mid()
        if m and self.ask is not None and self.bid is not None and m > 0:
            return (self.ask - self.bid) / m * 1e4
        return None


@dataclass
class PortfolioSnapshot:
    """Point-in-time portfolio state."""
    nav: float = 0.0
    cash: float = 0.0
    ts_ms: int = 0
    positions: Dict[str, float] = field(default_factory=dict)
    pnl: float = 0.0
    drawdown: float = 0.0


@dataclass
class LedgerEvent:
    """Single accounting/audit event (trade, fee, dividend, etc.)."""
    ts_ms: int = 0
    event_type: str = ""  # 'trade' | 'fee' | 'dividend' | 'margin_call' | 'transfer'
    symbol: str = ""
    qty: float = 0.0
    price: float = 0.0
    notional: float = 0.0
    fee: float = 0.0
    detail: Dict[str, Any] = field(default_factory=dict)
