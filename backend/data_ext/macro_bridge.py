"""
macro_bridge.py

External macro data ingestion & normalization layer.
Bridges third-party macro sources → internal engine-ready format.

Design goals:
- Source-agnostic
- Deterministic schemas
- No engine coupling
- Easy to extend (new feeds)
"""

from __future__ import annotations

import time
import json
import requests
from typing import Dict, List, Optional, Any
from datetime import datetime, timezone


# ============================
# Types
# ============================

Timestamp = int  # unix ms


class MacroPoint(dict):
    """
    Canonical macro datapoint format.

    Required fields:
    - id
    - region
    - metric
    - value
    - ts
    - source
    """

    @staticmethod
    def build(
        *,
        region: str,
        metric: str,
        value: float,
        ts: Timestamp,
        source: str,
        unit: Optional[str] = None,
        meta: Optional[Dict[str, Any]] = None,
    ) -> "MacroPoint":
        return MacroPoint(
            id=f"{region}:{metric}:{ts}",
            region=region,
            metric=metric,
            value=value,
            ts=ts,
            source=source,
            unit=unit,
            meta=meta or {},
        )


# ============================
# Utilities
# ============================

def now_ms() -> Timestamp:
    return int(time.time() * 1000)


def to_ms(dt: datetime) -> Timestamp:
    return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)


# ============================
# Base Source Interface
# ============================

class MacroSource:
    """Abstract macro data source."""

    name: str = "unknown"

    def fetch(self) -> List[MacroPoint]:
        raise NotImplementedError


# ============================
# Example Sources
# ============================

class FREDSource(MacroSource):
    """
    Federal Reserve Economic Data (FRED) example.
    """

    name = "fred"

    def __init__(self, api_key: str, series: Dict[str, str], region: str = "US"):
        """
        series: { metric_name: fred_series_id }
        """
        self.api_key = api_key
        self.series = series
        self.region = region

    def fetch(self) -> List[MacroPoint]:
        out: List[MacroPoint] = []

        for metric, series_id in self.series.items():
            url = (
                "https://api.stlouisfed.org/fred/series/observations"
                f"?series_id={series_id}"
                f"&api_key={self.api_key}"
                "&file_type=json"
            )

            r = requests.get(url, timeout=10)
            r.raise_for_status()
            data = r.json()

            for obs in data.get("observations", []):
                if obs["value"] == ".":
                    continue

                ts = to_ms(datetime.fromisoformat(obs["date"]))
                value = float(obs["value"])

                out.append(
                    MacroPoint.build(
                        region=self.region,
                        metric=metric,
                        value=value,
                        ts=ts,
                        source=self.name,
                    )
                )

        return out


class FXRatesSource(MacroSource):
    """
    Example FX macro source (spot rates).
    """

    name = "fx"

    def __init__(self, base: str, pairs: List[str]):
        self.base = base
        self.pairs = pairs

    def fetch(self) -> List[MacroPoint]:
        url = f"https://api.exchangerate.host/latest?base={self.base}"
        r = requests.get(url, timeout=10)
        r.raise_for_status()
        data = r.json()

        ts = now_ms()
        out: List[MacroPoint] = []

        for pair in self.pairs:
            if pair not in data["rates"]:
                continue

            out.append(
                MacroPoint.build(
                    region="GLOBAL",
                    metric=f"FX_{self.base}_{pair}",
                    value=float(data["rates"][pair]),
                    ts=ts,
                    source=self.name,
                )
            )

        return out


# ============================
# Bridge
# ============================

class MacroBridge:
    """
    Orchestrates macro ingestion from multiple sources
    and emits normalized records.
    """

    def __init__(self, sources: List[MacroSource]):
        self.sources = sources

    def collect(self) -> List[MacroPoint]:
        all_points: List[MacroPoint] = []

        for src in self.sources:
            try:
                points = src.fetch()
                all_points.extend(points)
            except Exception as e:
                # Never crash the engine on macro failures
                print(f"[macro_bridge] source={src.name} error={e}")

        return all_points

    def emit(self, points: List[MacroPoint], sink: str = "stdout") -> None:
        """
        Emit macro points to a sink.
        Replace this with Kafka / Redis / S3 / API as needed.
        """
        if sink == "stdout":
            for p in points:
                print(json.dumps(p, separators=(",", ":")))


# ============================
# Example Usage
# ============================

if __name__ == "__main__":
    fred = FREDSource(
        api_key="YOUR_FRED_API_KEY",
        region="US",
        series={
            "CPI_YoY": "CPIAUCSL",
            "FED_FUNDS": "FEDFUNDS",
        },
    )

    fx = FXRatesSource(base="USD", pairs=["CNY", "HKD", "EUR"])

    bridge = MacroBridge([fred, fx])
    points = bridge.collect()
    bridge.emit(points)