# backend/data_ext/climate/sources/noaa.py
"""
NOAA climate/weather ingestion (stub with optional real API hooks).

Purpose
-------
Emit climate-relevant metrics per region, such as:
- precip_24h_mm     : 24-hour accumulated precipitation (mm)
- temp_mean_c       : mean 2m air temperature (°C)
- wind_gust_ms      : 10m wind gust (m/s)
- drought_spi       : Standardized Precipitation Index (SPI, -3..+3)
- storm_alerts      : count of active tropical alerts (integer)

These are useful precursors for energy, agri, insurance, and transport signals.

Config (example)
----------------
sources:
  climate:
    enabled: true
    provider: "noaa"
    api_token: "${NOAA_API_TOKEN}"           # optional; for CDO API
    variables:
      - precip_24h_mm
      - temp_mean_c
      - wind_gust_ms
      - drought_spi
      - storm_alerts
    lookback_hours: 6                        # how far back to sample/latest
    regions:
      - name: "texas_gulf_coast"
        bbox: [-97.5, 26.0, -93.0, 30.5]    # lon_min, lat_min, lon_max, lat_max
      - name: "central_india"
        bbox: [75.0, 18.0, 82.0, 24.0]

Contract
--------
fetch(cfg: dict) -> List[dict]
Record schema (raw; your normalizer/transformer will standardize):
{
  "metric": "precip_24h_mm" | "temp_mean_c" | "wind_gust_ms" | "drought_spi" | "storm_alerts",
  "value": <float|int>,
  "timestamp": ISO8601 str (UTC),
  "region": "<region name>",
  "meta": {
    "provider": "noaa",
    "bbox": [...],
    "lookback_hours": <int>,
    "dataset": "CDO|NHC|GFS|CPC",            # indicative source
    "units": "mm|degC|m/s|index|count"
  }
}
"""

from __future__ import annotations

import datetime as dt
import random
from typing import Any, Dict, List, Sequence, Union

# If you later wire real calls, you'll likely use:
# import requests
# NOAA_CDO_BASE = "https://www.ncdc.noaa.gov/cdo-web/api/v2"
# NOMADS/GFS, NHC RSS/KML feeds, CPC drought indices, etc.


def _iso_now_minus(hours: int) -> str:
    t = dt.datetime.utcnow().replace(microsecond=0) - dt.timedelta(hours=hours)
    return t.isoformat() + "Z"


# ---------------------------
# Demo generators (plausible)
# ---------------------------

def _fake_precip_mm(region: str) -> float:
    # Coastal/monsoon bias
    monsoonish = any(k in region.lower() for k in ("india", "coast", "gulf"))
    base = random.uniform(0.0, 15.0)
    if monsoonish:
        base += random.uniform(0.0, 30.0)
    return round(base, 1)

def _fake_temp_c(region: str) -> float:
    # Warmer for tropics, cooler elsewhere
    tropic = any(k in region.lower() for k in ("india", "gulf"))
    base = random.uniform(18.0, 35.0) if tropic else random.uniform(5.0, 28.0)
    return round(base, 1)

def _fake_gust_ms(region: str) -> float:
    # Occasional storms spike gusts
    stormy = any(k in region.lower() for k in ("gulf", "coast", "cyclone", "hurricane"))
    base = random.uniform(4.0, 14.0)
    if stormy and random.random() < 0.25:
        base += random.uniform(6.0, 20.0)
    return round(base, 1)

def _fake_spi(region: str) -> float:
    # SPI index in [-3, +3], centered around 0
    val = random.uniform(-2.0, 2.0)
    # Slight drought bias for "central" inland regions
    if "central" in region.lower():
        val -= random.uniform(0.1, 0.6)
    return round(max(-3.0, min(3.0, val)), 2)

def _fake_alerts(region: str) -> int:
    # Storm alerts rare but clustered in basins
    basin = any(k in region.lower() for k in ("gulf", "atlantic", "bay", "coast"))
    if basin and random.random() < 0.15:
        return random.randint(1, 4)
    return 0


# ---------------------------
# (Placeholder) real fetchers
# ---------------------------

_NOAA_CDO_BASE = "https://www.ncdc.noaa.gov/cdo-web/api/v2"

# NOAA CDO dataset IDs for common variables
_CDO_DATASET_MAP: Dict[str, str] = {
    "precip_24h_mm": "GHCND",    # Daily summaries — PRCP
    "temp_mean_c":   "GHCND",    # Daily summaries — TAVG
    "wind_gust_ms":  "GHCND",    # Daily summaries — AWND
}

# NOAA CDO data type IDs
_CDO_DTYPE_MAP: Dict[str, str] = {
    "precip_24h_mm": "PRCP",
    "temp_mean_c":   "TAVG",
    "wind_gust_ms":  "AWND",
}

# Conversion factors from CDO tenths to standard units
_CDO_UNIT_SCALE: Dict[str, float] = {
    "PRCP": 0.1,   # tenths of mm -> mm
    "TAVG": 0.1,   # tenths of degC -> degC
    "AWND": 0.1,   # tenths of m/s -> m/s
}


def _bbox_to_extent(bbox: List[float]) -> Dict[str, float]:
    """Convert [lon_min, lat_min, lon_max, lat_max] to NOAA extent params."""
    return {"maxlon": bbox[2], "minlat": bbox[1], "maxlat": bbox[3], "minlon": bbox[0]}


def _fetch_noaa_cdo_real(cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Fetch climate data from NOAA CDO REST API.
    Requires NOAA_API_TOKEN env var or cfg.api_token (free registration at
    https://www.ncdc.noaa.gov/cdo-web/token).
    Returns [] on error or missing token, allowing fallback to synthetic data.
    """
    try:
        import requests as _requests  # type: ignore
    except ImportError:
        return []

    token = (cfg.get("api_token") or os.getenv("NOAA_API_TOKEN", "")).strip()
    if not token:
        return []

    regions: List[Dict[str, Any]] = list(cfg.get("regions") or [])
    variables: List[str] = [str(v).lower() for v in (cfg.get("variables") or [])]
    lookback_h: int = int(cfg.get("lookback_hours", 24))

    import datetime as _dt
    end_date = _dt.date.today()
    start_date = end_date - _dt.timedelta(days=max(1, lookback_h // 24))

    headers = {"token": token}
    out: List[Dict[str, Any]] = []

    for region in regions:
        name = str(region.get("name", "UNKNOWN"))
        bbox = region.get("bbox")
        if not bbox or len(bbox) < 4:
            continue

        extent = _bbox_to_extent(bbox)

        for var in variables:
            dtype = _CDO_DTYPE_MAP.get(var)
            dataset = _CDO_DATASET_MAP.get(var)
            if not dtype or not dataset:
                continue  # drought_spi and storm_alerts have no CDO equivalent; use synthetic

            params: Dict[str, Any] = {
                "datasetid": dataset,
                "datatypeid": dtype,
                "startdate": start_date.isoformat(),
                "enddate": end_date.isoformat(),
                "limit": 25,
                "units": "metric",
                **extent,
            }
            try:
                resp = _requests.get(
                    f"{_NOAA_CDO_BASE}/data",
                    headers=headers,
                    params=params,
                    timeout=8,
                )
                if resp.status_code != 200:
                    continue
                data = resp.json()
                results = data.get("results") or []
                if not results:
                    continue
                # Average across stations for the region
                values = [float(r["value"]) * _CDO_UNIT_SCALE.get(dtype, 1.0) for r in results if "value" in r]
                if not values:
                    continue
                avg_val = sum(values) / len(values)
                ts_str = results[-1].get("date", _iso_now_minus(lookback_h))
                out.append({
                    "metric": var,
                    "value": round(avg_val, 2),
                    "timestamp": ts_str,
                    "region": name,
                    "meta": {
                        "provider": "noaa",
                        "bbox": bbox,
                        "lookback_hours": lookback_h,
                        "dataset": dataset,
                        "units": "mm" if var == "precip_24h_mm" else ("degC" if var == "temp_mean_c" else "m/s"),
                        "n_stations": len(values),
                    },
                })
            except Exception:
                continue

    return out


# ---------------------------
# Public API
# ---------------------------

def fetch(cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Ingest NOAA signals for configured regions & variables.
    """
    if not cfg.get("enabled", False):
        return []

    provider = str(cfg.get("provider", "noaa")).lower()
    if provider != "noaa":
        return []

    regions: Sequence[Dict[str, Any]] = cfg.get("regions", []) or []
    variables: Sequence[str] = [str(v).lower() for v in (cfg.get("variables") or [])]
    lookback_h: int = int(cfg.get("lookback_hours", 6))

    # If you wire real NOAA CDO queries, try those first:
    real_records = _fetch_noaa_cdo_real(cfg)
    if real_records:
        return real_records

    # Demo fallback: synthesize plausible values at "now - lookback"
    ts = _iso_now_minus(lookback_h)
    if not variables:
        variables = ["precip_24h_mm", "temp_mean_c", "wind_gust_ms", "drought_spi", "storm_alerts"]

    out: List[Dict[str, Any]] = []

    for region in regions:
        name = str(region.get("name", "UNKNOWN"))
        bbox = region.get("bbox")

        for var in variables:
            if var == "precip_24h_mm":
                val, units, dataset = _fake_precip_mm(name), "mm", "CDO"
            elif var == "temp_mean_c":
                val, units, dataset = _fake_temp_c(name), "degC", "CDO"
            elif var == "wind_gust_ms":
                val, units, dataset = _fake_gust_ms(name), "m/s", "NOMADS"
            elif var == "drought_spi":
                val, units, dataset = _fake_spi(name), "index", "CPC"
            elif var == "storm_alerts":
                val, units, dataset = _fake_alerts(name), "count", "NHC"
            else:
                val, units, dataset = round(random.uniform(-1.0, 1.0), 3), "arb", "NOAA"

            out.append(
                {
                    "metric": var,
                    "value": float(val) if isinstance(val, (int, float)) else val,
                    "timestamp": ts,
                    "region": name,
                    "meta": {
                        "provider": "noaa",
                        "bbox": bbox,
                        "lookback_hours": lookback_h,
                        "dataset": dataset,
                        "units": units,
                    },
                }
            )

    return out


# ---------------------------
# Demo CLI
# ---------------------------

if __name__ == "__main__":
    demo_cfg = {
        "enabled": True,
        "provider": "noaa",
        "variables": ["precip_24h_mm", "temp_mean_c", "wind_gust_ms", "drought_spi", "storm_alerts"],
        "lookback_hours": 6,
        "regions": [
            {"name": "texas_gulf_coast", "bbox": [-97.5, 26.0, -93.0, 30.5]},
            {"name": "central_india", "bbox": [75.0, 18.0, 82.0, 24.0]},
        ],
    }
    for rec in fetch(demo_cfg):
        print(rec)