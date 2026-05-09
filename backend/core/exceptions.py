# backend/core/exceptions.py
"""
Platform-wide exception hierarchy.
"""
from __future__ import annotations


class DStrategiesError(Exception):
    """Base exception for the D-Strategies platform."""


# ---- Data / Feed -----------------------------------------------------------
class DataError(DStrategiesError):
    """Generic data pipeline error."""

class FeedUnavailableError(DataError):
    """Market data feed is down or returning stale data."""

class InstrumentNotFoundError(DataError):
    """Symbol not found in the data source."""


# ---- Order / OMS -----------------------------------------------------------
class OrderError(DStrategiesError):
    """Generic order management error."""

class RiskGateError(OrderError):
    """Order blocked by a risk gate."""
    def __init__(self, gate: str, reason: str):
        self.gate = gate
        self.reason = reason
        super().__init__(f"Risk gate '{gate}' blocked order: {reason}")

class VenueError(OrderError):
    """Broker/venue rejected or failed to route the order."""

class InsufficientMarginError(OrderError):
    """Not enough margin to place the order."""


# ---- Strategy --------------------------------------------------------------
class StrategyError(DStrategiesError):
    """Generic strategy error."""

class StrategyNotFoundError(StrategyError):
    """Strategy name not found in the registry."""

class StrategyConfigError(StrategyError):
    """Invalid strategy configuration."""


# ---- Backtest --------------------------------------------------------------
class BacktestError(DStrategiesError):
    """Generic backtesting error."""

class LookaheadBiasError(BacktestError):
    """Detected potential lookahead bias in data alignment."""


# ---- India Specific --------------------------------------------------------
class IndiaMarketError(DStrategiesError):
    """Base for India-specific market errors."""

class CircuitBreakerError(IndiaMarketError):
    """Order blocked by NSE/BSE circuit breaker."""

class FoBanError(IndiaMarketError):
    """Symbol is on the F&O ban list."""

class MarketClosedError(IndiaMarketError):
    """NSE market is currently closed."""
