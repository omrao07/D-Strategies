# backend/india/circuit_breakers.py
"""
NSE/BSE circuit breaker and price band checker.
Index-level: 10%/15%/20% halt thresholds.
Stock-level: 5%/10%/20% upper/lower circuit bands.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

# Index-level circuit breaker thresholds (SEBI)
INDEX_HALT_THRESHOLDS = [
    (10.0, 45),   # 10% move → 45 min halt before 1 PM, 15 min after 1PM, no halt after 2:30PM
    (15.0, 105),  # 15% move → 105 min halt before 1 PM, 45 min after, no halt after 2PM
    (20.0, None), # 20% move → trading halted for the day
]

# Default stock circuit bands (percentage). Some stocks may have narrower bands set by NSE.
STOCK_CIRCUIT_BANDS: dict[str, float] = {
    # Most stocks: 20%
    "__default__": 20.0,
}

# Stocks on 5% circuit (T2T / trade-to-trade category):
FIVE_PCT_CIRCUIT: frozenset[str] = frozenset()

# Stocks on 10% circuit (can be fetched from NSE daily):
TEN_PCT_CIRCUIT: frozenset[str] = frozenset()


@dataclass
class CircuitBreakerChecker:
    """Check if a price move violates circuit breaker / price band rules."""

    @staticmethod
    def stock_band_pct(symbol: str) -> float:
        sym = symbol.upper()
        if sym in FIVE_PCT_CIRCUIT:
            return 5.0
        if sym in TEN_PCT_CIRCUIT:
            return 10.0
        return STOCK_CIRCUIT_BANDS.get(sym, STOCK_CIRCUIT_BANDS["__default__"])

    @classmethod
    def is_within_band(
        cls, symbol: str, ref_price: float, proposed_price: float
    ) -> bool:
        """Return True if proposed_price is within the stock's price band."""
        if ref_price <= 0:
            return True
        band = cls.stock_band_pct(symbol) / 100.0
        lower = ref_price * (1 - band)
        upper = ref_price * (1 + band)
        return lower <= proposed_price <= upper

    @staticmethod
    def index_halt_level(index_move_pct: float) -> Optional[int]:
        """
        Returns halt duration in minutes for the given index % move, or None if no halt.
        index_move_pct: absolute percentage decline (e.g., 12.0 for a 12% drop).
        """
        for threshold, halt_min in sorted(INDEX_HALT_THRESHOLDS, reverse=True):
            if abs(index_move_pct) >= threshold:
                return halt_min
        return None

    @classmethod
    def check_order(
        cls, symbol: str, ref_price: float, order_price: float
    ) -> tuple[bool, str]:
        """
        Returns (allowed, reason). If not allowed, reason explains why.
        """
        if symbol.upper() in ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"):
            return True, "index"
        if not cls.is_within_band(symbol, ref_price, order_price):
            band = cls.stock_band_pct(symbol)
            return False, f"price_band_{band:.0f}pct"
        return True, "ok"
