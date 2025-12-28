"""
preprocessor.py

Deterministic preprocessing layer for external data (macro, market, alt).
Transforms raw MacroPoint records into engine-ready features.

Responsibilities:
- Validation & filtering
- Time alignment / resampling
- Feature engineering (returns, diffs, z-scores)
- Windowed aggregation
- Emission to downstream sink
"""

from __future__ import annotations

import math
import json
from typing import Iterable, Dict, List, Any, Optional, Callable
from collections import defaultdict, deque
from statistics import mean, pstdev


# ============================
# Types
# ============================

Timestamp = int  # unix ms

MacroPoint = Dict[str, Any]
FeatureRow = Dict[str, Any]


# ============================
# Config
# ============================

DEFAULT_WINDOWS = [5, 20, 60]          # rolling windows
MAX_BUFFER_SIZE = 10_000               # safety cap


# ============================
# Utilities
# ============================

def is_finite(x: Any) -> bool:
    try:
        return x is not None and math.isfinite(float(x))
    except Exception:
        return False


def zscore(x: float, mu: float, sd: float) -> float:
    return 0.0 if sd == 0 else (x - mu) / sd


# ============================
# Validation
# ============================

def validate_point(p: MacroPoint) -> bool:
    required = ("id", "region", "metric", "value", "ts", "source")
    for k in required:
        if k not in p:
            return False
    return is_finite(p["value"]) and isinstance(p["ts"], int)


# ============================
# Rolling Window Buffer
# ============================

class RollingBuffer:
    """
    Fixed-size rolling buffer for numeric values.
    """

    def __init__(self, maxlen: int):
        self.buf = deque(maxlen=maxlen)

    def push(self, v: float) -> None:
        self.buf.append(float(v))

    def values(self) -> List[float]:
        return list(self.buf)

    def mean(self) -> float:
        return mean(self.buf) if self.buf else float("nan")

    def std(self) -> float:
        return pstdev(self.buf) if len(self.buf) > 1 else 0.0

    def last(self) -> Optional[float]:
        return self.buf[-1] if self.buf else None


# ============================
# Feature Builder
# ============================

class FeatureBuilder:
    """
    Builds rolling features per (region, metric).
    """

    def __init__(self, windows: Iterable[int] = DEFAULT_WINDOWS):
        self.windows = sorted(windows)
        self.buffers: Dict[str, Dict[int, RollingBuffer]] = defaultdict(dict)

    def _key(self, p: MacroPoint) -> str:
        return f"{p['region']}::{p['metric']}"

    def update(self, p: MacroPoint) -> List[FeatureRow]:
        key = self._key(p)
        value = float(p["value"])

        out: List[FeatureRow] = []

        for w in self.windows:
            buf = self.buffers[key].get(w)
            if not buf:
                buf = RollingBuffer(w)
                self.buffers[key][w] = buf

            prev = buf.last()
            buf.push(value)

            mu = buf.mean()
            sd = buf.std()
            ret = None if prev is None else value - prev

            out.append({
                "id": p["id"],
                "ts": p["ts"],
                "region": p["region"],
                "metric": p["metric"],
                "window": w,
                "value": value,
                "mean": mu,
                "std": sd,
                "z": zscore(value, mu, sd),
                "diff": ret,
                "source": p["source"],
            })

        return out


# ============================
# Preprocessor
# ============================

class Preprocessor:
    """
    End-to-end preprocessing pipeline.
    """

    def __init__(
        self,
        *,
        windows: Iterable[int] = DEFAULT_WINDOWS,
        filters: Optional[List[Callable[[MacroPoint], bool]]] = None,
    ):
        self.features = FeatureBuilder(windows)
        self.filters = filters or []

    def process(self, points: Iterable[MacroPoint]) -> List[FeatureRow]:
        out: List[FeatureRow] = []

        for p in points:
            if not validate_point(p):
                continue

            if any(not f(p) for f in self.filters):
                continue

            feats = self.features.update(p)
            out.extend(feats)

            if len(out) > MAX_BUFFER_SIZE:
                break

        return out

    def emit(self, rows: Iterable[FeatureRow], sink: str = "stdout") -> None:
        if sink == "stdout":
            for r in rows:
                print(json.dumps(r, separators=(",", ":")))


# ============================
# Example Filters
# ============================

def region_filter(allowed: List[str]) -> Callable[[MacroPoint], bool]:
    return lambda p: p.get("region") in allowed


def metric_filter(prefixes: List[str]) -> Callable[[MacroPoint], bool]:
    return lambda p: any(p.get("metric", "").startswith(x) for x in prefixes)


# ============================
# Example Usage
# ============================

if __name__ == "__main__":
    # Example input (normally from macro_bridge)
    sample = [
        {
            "id": "US:CPI:1",
            "region": "US",
            "metric": "CPI",
            "value": 305.1,
            "ts": 1700000000000,
            "source": "fred",
        },
        {
            "id": "US:CPI:2",
            "region": "US",
            "metric": "CPI",
            "value": 305.6,
            "ts": 1700086400000,
            "source": "fred",
        },
    ]

    pp = Preprocessor(
        windows=[3, 12],
        filters=[
            region_filter(["US", "CNHK"]),
            metric_filter(["CPI", "FX"]),
        ],
    )

    features = pp.process(sample)
    pp.emit(features)