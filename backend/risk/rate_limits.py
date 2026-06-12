# backend/risk/rate_limits.py
"""
Interest-rate shock limits for fixed-income risk management.

RateLimits  — holds maximum/minimum allowed shock magnitudes in basis points
RateShock   — represents a yield-curve shock (parallel shift + per-tenor moves)

Usage
-----
rl = RateLimits(max_parallel_bp=200, min_parallel_bp=-100, max_per_tenor_bp=300)
shock = RateShock(parallel_bp=250, rates_by_tenor={"10y": 350})
clamped = rl.apply(shock)  # parallel_bp=200, rates_by_tenor={"10y": 300}
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict


@dataclass
class RateShock:
    """
    Yield-curve shock expressed in basis points.

    parallel_bp      : parallel shift applied to all tenors
    rates_by_tenor   : per-tenor incremental shocks (stacked on top of parallel)
    """
    parallel_bp: float = 0.0
    rates_by_tenor: Dict[str, float] = field(default_factory=dict)


class RateLimits:
    """
    Enforces hard caps on interest-rate shock magnitudes.

    Parameters
    ----------
    max_parallel_bp   : maximum allowed parallel shift (up)
    min_parallel_bp   : maximum allowed parallel shift (down, negative OK)
    max_per_tenor_bp  : per-tenor cap (applied symmetrically ±)
    """

    def __init__(
        self,
        max_parallel_bp: float = 500.0,
        min_parallel_bp: float = -500.0,
        max_per_tenor_bp: float = 1000.0,
    ):
        self.max_parallel_bp = float(max_parallel_bp)
        self.min_parallel_bp = float(min_parallel_bp)
        self.max_per_tenor_bp = float(max_per_tenor_bp)

    def apply(self, shock: RateShock) -> RateShock:
        """Return a new RateShock with all values clamped to configured limits."""
        clamped_parallel = max(self.min_parallel_bp, min(self.max_parallel_bp, shock.parallel_bp))
        clamped_tenors: Dict[str, float] = {}
        for tenor, bp in shock.rates_by_tenor.items():
            clamped_tenors[tenor] = max(-self.max_per_tenor_bp, min(self.max_per_tenor_bp, bp))
        return RateShock(parallel_bp=clamped_parallel, rates_by_tenor=clamped_tenors)
