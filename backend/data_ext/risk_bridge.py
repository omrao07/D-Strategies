"""
risk_bridge.py

Central risk synthesis layer.
Consumes processed feature rows and produces normalized risk signals.

Design goals:
- Stateless per-batch evaluation
- Deterministic outputs
- Strategy-agnostic
- Plug-and-play with registry & engine
"""

from __future__ import annotations

import math
from typing import Dict, List, Any, Iterable
from statistics import mean, stdev
from datetime import datetime, timezone


# ============================
# Types
# ============================

FeatureRow = Dict[str, Any]
RiskSignal = Dict[str, Any]


# ============================
# Utilities
# ============================

def utc_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def safe_std(xs: List[float]) -> float:
    return stdev(xs) if len(xs) > 1 else 0.0


# ============================
# Risk Models
# ============================

class VolatilityRisk:
    """
    Measures rolling volatility regime risk.
    """

    def compute(self, values: List[float]) -> float:
        if len(values) < 2:
            return 0.0

        vol = safe_std(values)
        norm = abs(vol) / (abs(mean(values)) + 1e-9)
        return clamp(norm)


class DrawdownRisk:
    """
    Measures drawdown severity from peak.
    """

    def compute(self, values: List[float]) -> float:
        if not values:
            return 0.0

        peak = values[0]
        max_dd = 0.0

        for v in values:
            peak = max(peak, v)
            if peak > 0:
                dd = (peak - v) / peak
                max_dd = max(max_dd, dd)

        return clamp(max_dd)


class ZScoreStress:
    """
    Flags extreme z-score conditions.
    """

    def compute(self, z_scores: List[float]) -> float:
        if not z_scores:
            return 0.0

        extreme = [abs(z) for z in z_scores if abs(z) > 2]
        if not extreme:
            return 0.0

        return clamp(mean(extreme) / 5.0)


# ============================
# Risk Bridge
# ============================

class RiskBridge:
    """
    Aggregates macro + market features into risk signals.
    """

    def __init__(self):
        self.vol_model = VolatilityRisk()
        self.dd_model = DrawdownRisk()
        self.z_model = ZScoreStress()

    def evaluate(
        self,
        *,
        region: str,
        rows: Iterable[FeatureRow],
    ) -> RiskSignal:
        """
        Evaluate risk for a region using feature rows.
        """

        values: List[float] = []
        z_scores: List[float] = []

        for r in rows:
            if r.get("region") != region:
                continue
            if "value" in r and isinstance(r["value"], (int, float)):
                values.append(float(r["value"]))
            if "z" in r and isinstance(r["z"], (int, float)):
                z_scores.append(float(r["z"]))

        vol_risk = self.vol_model.compute(values)
        dd_risk = self.dd_model.compute(values)
        stress_risk = self.z_model.compute(z_scores)

        composite = clamp(
            0.4 * vol_risk +
            0.4 * dd_risk +
            0.2 * stress_risk
        )

        return {
            "region": region,
            "timestamp": utc_now(),
            "risk": {
                "volatility": vol_risk,
                "drawdown": dd_risk,
                "stress": stress_risk,
                "composite": composite,
            },
            "flags": {
                "risk_off": composite > 0.6,
                "extreme_risk": composite > 0.85,
            },
        }

    # ------------------------
    # Bulk Evaluation
    # ------------------------

    def evaluate_all(
        self,
        rows: Iterable[FeatureRow],
    ) -> List[RiskSignal]:
        regions = sorted({r["region"] for r in rows if "region" in r})
        return [self.evaluate(region=r, rows=rows) for r in regions]


# ============================
# Example Usage
# ============================

if __name__ == "__main__":
    bridge = RiskBridge()

    sample_features = [
        {
            "region": "US",
            "metric": "CPI",
            "value": 305.6,
            "z": 1.8,
        },
        {
            "region": "US",
            "metric": "PMI",
            "value": 49.2,
            "z": -2.3,
        },
        {
            "region": "CNHK",
            "metric": "FX_USD_CNY",
            "value": 7.12,
            "z": 2.6,
        },
    ]

    risks = bridge.evaluate_all(sample_features)
    for r in risks:
        print(r)