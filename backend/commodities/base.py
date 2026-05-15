# backend/commodities/base.py
"""
CommodityStrategy — unified base class for all commodity strategies.

Standardizes:
  - Signal schema (CommoditySignal) with strength, direction, confidence, horizon
  - Position sizing via vol-targeted Kelly
  - Risk metadata (sector, physical_commodity, exchange, contract_spec)
  - Integration with CommoditySignalHub for satellite/AIS/COT/weather/EIA inputs
  - Backtest interface: generate_signals(prices_df) → pd.Series of positions
  - Explanation interface: explain_signal(signal) → str
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Tuple

import numpy as np
import pandas as pd


# ─────────────────────────────────────────────────────────────
# Enumerations
# ─────────────────────────────────────────────────────────────

class CommoditySector(str, Enum):
    ENERGY         = "energy"
    METALS_PRECIOUS = "metals_precious"
    METALS_BASE    = "metals_base"
    METALS_BATTERY = "metals_battery"
    AGRICULTURE    = "agriculture"
    SOFTS          = "softs"
    CARBON         = "carbon"
    SHIPPING       = "shipping"
    WEATHER        = "weather"

class SignalDirection(str, Enum):
    LONG           = "long"
    SHORT          = "short"
    SPREAD_LONG    = "spread_long"   # long near / short far
    SPREAD_SHORT   = "spread_short"  # short near / long far
    NEUTRAL        = "neutral"

class SignalSource(str, Enum):
    FUNDAMENTAL    = "fundamental"
    SATELLITE      = "satellite"
    AIS_SHIPPING   = "ais_shipping"
    COT            = "cot"
    WEATHER        = "weather"
    EIA            = "eia"
    CURVE          = "curve"
    MACRO          = "macro"
    TECHNICAL      = "technical"
    AI             = "ai"


# ─────────────────────────────────────────────────────────────
# Data models
# ─────────────────────────────────────────────────────────────

@dataclass
class ContractSpec:
    """Exchange contract metadata."""
    symbol: str
    exchange: str                       # CME | ICE | LME | MCX | NYMEX
    lot_size: float = 1.0               # units per contract
    tick_size: float = 0.01
    currency: str = "USD"
    delivery_months: List[str] = field(default_factory=list)
    first_notice_days: int = 5          # days before expiry to roll
    margin_pct: float = 0.05            # initial margin as % of notional

@dataclass
class CommoditySignal:
    """Standardized signal output from any commodity strategy."""
    strategy: str
    sector: CommoditySector
    commodity: str                      # "crude_oil", "gold", "corn", etc.
    direction: SignalDirection
    strength: float                     # 0..1 signal strength
    confidence: float                   # 0..1 model confidence
    horizon_days: int                   # expected holding period
    source: SignalSource
    timestamp: str                      # ISO8601
    contracts: List[str]                # e.g. ["CLZ5", "CLH6"] for spreads
    sizing_hint: float = 1.0            # relative sizing (1.0 = full, 0.5 = half)
    metadata: Dict[str, Any] = field(default_factory=dict)
    rationale: str = ""

@dataclass
class CommodityRiskParams:
    """Risk controls for a commodity position."""
    max_risk_bps: float = 50.0          # max risk as bps of portfolio
    stop_loss_pct: float = 0.02         # 2% stop loss
    target_pct: float = 0.04           # 4% profit target
    vol_target_ann: float = 0.10        # 10% annualized vol target for sizing
    max_contracts: int = 10
    max_concentration: float = 0.05    # 5% of portfolio per commodity


# ─────────────────────────────────────────────────────────────
# Base strategy class
# ─────────────────────────────────────────────────────────────

class CommodityStrategy:
    """
    Base class for all commodity strategies.

    Subclasses implement:
      - generate_signals(prices: pd.DataFrame, aux: dict) -> List[CommoditySignal]
      - _describe() -> str

    And optionally:
      - generate_positions(prices: pd.DataFrame) -> pd.Series  (for backtesting)
    """

    name: str = "base_commodity"
    sector: CommoditySector = CommoditySector.ENERGY
    commodity: str = "generic"
    contract_spec: Optional[ContractSpec] = None
    risk_params: CommodityRiskParams = field(default_factory=CommodityRiskParams)

    def __init__(self, risk_params: Optional[CommodityRiskParams] = None):
        self._risk = risk_params or CommodityRiskParams()

    # ── must override ──

    def generate_signals(self, prices: pd.DataFrame,
                         aux: Optional[Dict[str, Any]] = None) -> List[CommoditySignal]:
        """Main entry point.  aux may contain satellite, AIS, COT, EIA data."""
        raise NotImplementedError

    def _describe(self) -> str:
        return f"{self.name}: base commodity strategy"

    # ── convenience: vol-targeted position sizing ──

    def vol_target_size(self, price: float, hist_returns: pd.Series,
                        capital: float, target_vol_ann: Optional[float] = None) -> float:
        """
        Kelly-inspired vol-targeted sizing.
        Returns number of contracts to trade.
        """
        tv = target_vol_ann or self._risk.vol_target_ann
        if hist_returns.empty or hist_returns.std() < 1e-9:
            return 1.0
        daily_vol = hist_returns.std()
        ann_vol   = daily_vol * math.sqrt(252)
        # position = (target_vol / actual_vol) * capital / notional_per_contract
        notional = price * (self.contract_spec.lot_size if self.contract_spec else 1.0)
        raw = (tv / max(ann_vol, 1e-4)) * capital / max(notional, 1.0)
        return min(float(max(0.0, raw)), float(self._risk.max_contracts))

    # ── common technical helpers ──

    @staticmethod
    def zscore(series: pd.Series, window: int = 252) -> pd.Series:
        """Rolling z-score."""
        mu  = series.rolling(window, min_periods=window//2).mean()
        std = series.rolling(window, min_periods=window//2).std()
        return (series - mu) / std.replace(0, np.nan)

    @staticmethod
    def percentile_rank(series: pd.Series, window: int = 252) -> pd.Series:
        """Rolling percentile rank 0..100."""
        return series.rolling(window, min_periods=window//4).rank(pct=True) * 100

    @staticmethod
    def ema(series: pd.Series, span: int) -> pd.Series:
        return series.ewm(span=span, adjust=False).mean()

    @staticmethod
    def rolling_corr(a: pd.Series, b: pd.Series, window: int = 60) -> pd.Series:
        return a.rolling(window).corr(b)

    @staticmethod
    def annualized_sharpe(returns: pd.Series) -> float:
        if returns.std() < 1e-9: return 0.0
        return float(returns.mean() / returns.std() * math.sqrt(252))

    @staticmethod
    def max_drawdown(equity: pd.Series) -> float:
        peak = equity.cummax()
        dd = (equity - peak) / peak.replace(0, np.nan)
        return float(dd.min())

    # ── signal constructors ──

    def _make_signal(self, direction: SignalDirection, strength: float,
                     confidence: float, horizon_days: int,
                     source: SignalSource, contracts: List[str],
                     rationale: str = "", **meta) -> CommoditySignal:
        import datetime
        return CommoditySignal(
            strategy=self.name,
            sector=self.sector,
            commodity=self.commodity,
            direction=direction,
            strength=max(0.0, min(1.0, strength)),
            confidence=max(0.0, min(1.0, confidence)),
            horizon_days=horizon_days,
            source=source,
            timestamp=datetime.datetime.utcnow().isoformat() + "Z",
            contracts=contracts,
            sizing_hint=strength * confidence,
            metadata=meta,
            rationale=rationale,
        )

    def explain(self) -> str:
        return self._describe()

    def heartbeat(self) -> Dict[str, Any]:
        import time
        return {"ok": True, "strategy": self.name, "sector": str(self.sector),
                "commodity": self.commodity, "ts": int(time.time())}


# ─────────────────────────────────────────────────────────────
# Signal aggregation utility
# ─────────────────────────────────────────────────────────────

def aggregate_signals(signals: List[CommoditySignal],
                      weights: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    """
    Aggregate a list of signals into a single directional view.
    Returns {direction, net_strength, avg_confidence, n_agreeing, n_opposing}.
    """
    if not signals:
        return {"direction": "neutral", "net_strength": 0.0, "avg_confidence": 0.0,
                "n_agreeing": 0, "n_opposing": 0}

    long_strength  = sum(s.strength * s.confidence for s in signals
                         if s.direction in (SignalDirection.LONG, SignalDirection.SPREAD_LONG))
    short_strength = sum(s.strength * s.confidence for s in signals
                         if s.direction in (SignalDirection.SHORT, SignalDirection.SPREAD_SHORT))
    n_long  = sum(1 for s in signals if s.direction in (SignalDirection.LONG, SignalDirection.SPREAD_LONG))
    n_short = sum(1 for s in signals if s.direction in (SignalDirection.SHORT, SignalDirection.SPREAD_SHORT))

    net = long_strength - short_strength
    total = long_strength + short_strength + 1e-9
    avg_conf = sum(s.confidence for s in signals) / len(signals)

    if net > 0.1 * total:
        direction = "long"
    elif net < -0.1 * total:
        direction = "short"
    else:
        direction = "neutral"

    return {
        "direction": direction,
        "net_strength": round(abs(net) / total, 4),
        "avg_confidence": round(avg_conf, 4),
        "n_agreeing": max(n_long, n_short),
        "n_opposing": min(n_long, n_short),
        "long_strength": round(long_strength, 4),
        "short_strength": round(short_strength, 4),
    }
