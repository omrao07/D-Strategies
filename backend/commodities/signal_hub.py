# backend/commodities/signal_hub.py
"""
CommoditySignalHub
------------------
Aggregates ALL commodity alternative data signals into a unified
CommoditySignalSet per commodity. This is the single source of truth
for the CommodityAIAgent and all commodity strategies.

Data inputs aggregated:
  1. Satellite NDVI         → crop condition / yield signal
  2. AIS vessel tracking    → oil/LNG supply-in-transit signal
  3. EIA petroleum data     → crude/gasoline inventory signal
  4. CFTC COT positioning   → managed money crowding signal
  5. Curve analytics        → roll yield / carry / contango signal
  6. Weather (NOAA/ECMWF)   → temperature / precipitation anomaly signal
  7. Port congestion (AIS)  → freight / shipping rate signal

Output:
  CommoditySignalSet per commodity with normalized [-1..+1] scores
  and composite direction (long/short/neutral).
"""
from __future__ import annotations

import datetime
from dataclasses import dataclass
from typing import Dict, List, Optional

import numpy as np

try:
    from backend.commodities.cot_positioning import COTEngine, generate_synthetic_cot
    _HAS_COT = True
except Exception:
    _HAS_COT = False

try:
    _HAS_CURVE = True
except Exception:
    _HAS_CURVE = False

try:
    _HAS_SAT = True
except Exception:
    _HAS_SAT = False

try:
    _HAS_AIS = True
except Exception:
    _HAS_AIS = False


# ─────────────────────────────────────────────────────────────
# Signal data models
# ─────────────────────────────────────────────────────────────

@dataclass
class SatelliteSignal:
    commodity: str
    ndvi_score: Optional[float] = None        # +1=excellent crops (bearish), -1=drought (bullish)
    ndvi_anomaly_zscore: Optional[float] = None
    nightlights_score: Optional[float] = None # industrial activity proxy
    soil_moisture: Optional[float] = None
    region: str = ""
    timestamp: str = ""

@dataclass
class AISSignal:
    commodity: str                             # "crude_oil" | "lng" | "dry_bulk"
    laden_to_ballast_ratio: Optional[float] = None  # high = supply glut (bearish)
    tanker_count: Optional[int] = None
    avg_speed_knots: Optional[float] = None   # low speed = congestion
    port_dwell_hours: Optional[float] = None
    cargo_estimate_mbd: Optional[float] = None # million barrels/day in transit
    region: str = ""
    direction: str = "neutral"                # "bullish" | "bearish" | "neutral"
    strength: float = 0.0

@dataclass
class EIASignal:
    commodity: str                             # "crude_oil" | "gasoline" | "distillate" | "natgas"
    inventory_bcf_or_mb: Optional[float] = None   # current inventory
    vs_5yr_avg_pct: Optional[float] = None    # surplus/deficit vs 5-yr average
    vs_prior_week_pct: Optional[float] = None
    refinery_utilization_pct: Optional[float] = None
    implied_demand_mbd: Optional[float] = None
    direction: str = "neutral"
    strength: float = 0.0

@dataclass
class WeatherSignal:
    region: str
    commodity_impact: str                      # "corn" | "natgas" | "wheat" | "coffee" | etc.
    temp_anomaly_c: Optional[float] = None    # above/below normal
    precip_anomaly_pct: Optional[float] = None # % above/below normal
    hdd_anomaly: Optional[float] = None       # heating degree days
    cdd_anomaly: Optional[float] = None       # cooling degree days
    drought_index: Optional[float] = None     # Palmer DSI or similar
    direction: str = "neutral"
    strength: float = 0.0

@dataclass
class CurveSignal:
    commodity: str
    roll_yield_ann_pct: float = 0.0
    structure: str = "flat"                    # "backwardation" | "contango" | "flat"
    z_score: float = 0.0
    carry_direction: str = "neutral"           # "long" | "short" | "neutral"
    carry_strength: float = 0.0

@dataclass
class COTPositioningSignal:
    commodity: str
    mm_net_pct_oi: float = 0.0
    percentile_1yr: float = 50.0
    z_score_1yr: float = 0.0
    crowding_direction: str = "neutral"
    crowding_strength: float = 0.0
    momentum_direction: str = "neutral"
    momentum_strength: float = 0.0
    composite_direction: str = "neutral"
    composite_strength: float = 0.0

@dataclass
class CommoditySignalSet:
    """
    Full aggregated signal set for one commodity.
    All individual signal types + composite score.
    """
    commodity: str
    sector: str
    timestamp: str

    satellite: Optional[SatelliteSignal] = None
    ais: Optional[AISSignal] = None
    eia: Optional[EIASignal] = None
    weather: Optional[WeatherSignal] = None
    curve: Optional[CurveSignal] = None
    cot: Optional[COTPositioningSignal] = None

    # Composite
    composite_score: float = 0.0               # -1 (strong short) .. +1 (strong long)
    composite_direction: str = "neutral"        # "long" | "short" | "neutral"
    composite_confidence: float = 0.0
    n_signals: int = 0
    n_agreeing: int = 0
    summary: str = ""


# ─────────────────────────────────────────────────────────────
# Hub
# ─────────────────────────────────────────────────────────────

class CommoditySignalHub:
    """
    Aggregates satellite, AIS, EIA, COT, curve, and weather signals
    into CommoditySignalSets. Each method can be called independently
    or all at once via get_signals().

    Uses synthetic/demo data when real vendors are not connected.
    Replace _fetch_* methods with real API calls in production.
    """

    # ── commodity → sector mapping ──
    COMMODITY_SECTORS: Dict[str, str] = {
        "crude_oil": "energy", "brent": "energy", "wti": "energy",
        "natural_gas": "energy", "lng": "energy", "gasoline": "energy",
        "heating_oil": "energy", "jet_fuel": "energy",
        "gold": "metals_precious", "silver": "metals_precious",
        "platinum": "metals_precious", "palladium": "metals_precious",
        "copper": "metals_base", "aluminum": "metals_base",
        "zinc": "metals_base", "nickel": "metals_base", "iron_ore": "metals_base",
        "lithium": "metals_battery", "cobalt": "metals_battery",
        "corn": "agriculture", "wheat": "agriculture", "soybeans": "agriculture",
        "soybean_oil": "agriculture", "soybean_meal": "agriculture",
        "cotton": "softs", "coffee": "softs", "cocoa": "softs", "sugar": "softs",
        "palm_oil": "softs", "rubber": "softs",
        "carbon_eua": "carbon", "carbon_rgi": "carbon",
        "bdi": "shipping", "vlcc_tcx": "shipping",
    }

    # ── satellite region → commodity ──
    SAT_REGION_COMMODITY: Dict[str, List[str]] = {
        "us_corn_belt":       ["corn", "soybeans"],
        "brazil_mato_grosso": ["soybeans", "corn", "cotton"],
        "brazil_cerrado":     ["coffee", "sugar"],
        "ukraine_breadbasket": ["wheat"],
        "india_punjab":       ["wheat"],
        "indonesia_borneo":   ["palm_oil"],
        "argentina_pampas":   ["soybeans", "corn", "wheat"],
        "china_industrial":   ["copper", "iron_ore"],
        "strait_of_hormuz":   ["crude_oil"],
        "singapore_strait":   ["crude_oil", "lng"],
    }

    def __init__(self, demo_mode: bool = True):
        self.demo_mode = demo_mode
        self._cot_engine = COTEngine() if _HAS_COT else None

    def get_signals(self, commodities: List[str]) -> Dict[str, CommoditySignalSet]:
        """Get all signals for a list of commodities."""
        return {c: self.get_signal(c) for c in commodities}

    def get_signal(self, commodity: str) -> CommoditySignalSet:
        """Get full signal set for a single commodity."""
        sector = self.COMMODITY_SECTORS.get(commodity, "generic")
        ts = datetime.datetime.utcnow().isoformat() + "Z"

        sat     = self._satellite_signal(commodity)
        ais     = self._ais_signal(commodity)
        eia     = self._eia_signal(commodity)
        weather = self._weather_signal(commodity)
        curve   = self._curve_signal(commodity)
        cot     = self._cot_signal(commodity)

        composite, direction, confidence, n_total, n_agree, summary = self._composite(
            commodity, sat, ais, eia, weather, curve, cot
        )

        return CommoditySignalSet(
            commodity=commodity, sector=sector, timestamp=ts,
            satellite=sat, ais=ais, eia=eia,
            weather=weather, curve=curve, cot=cot,
            composite_score=composite,
            composite_direction=direction,
            composite_confidence=confidence,
            n_signals=n_total,
            n_agreeing=n_agree,
            summary=summary,
        )

    # ─────────────────────────────────────────────────────────
    # Individual signal fetchers (demo + real hook)
    # ─────────────────────────────────────────────────────────

    def _satellite_signal(self, commodity: str) -> Optional[SatelliteSignal]:
        """Satellite NDVI / nightlights → crop/industrial signal."""
        # Agricultural commodities get NDVI signal
        agri = ["corn", "wheat", "soybeans", "cotton", "coffee", "cocoa", "sugar", "palm_oil"]
        if commodity not in agri:
            if commodity in ("copper", "iron_ore"):
                # Nightlights for industrial metals
                val = self._demo_float(commodity + "_nightlights", 0.3, 0.15)
                (val - 0.3) / 0.15  # z-score proxy
                return SatelliteSignal(commodity=commodity, nightlights_score=val,
                                       ndvi_anomaly_zscore=None, region="china_industrial",
                                       timestamp=datetime.datetime.utcnow().isoformat()+"Z")
            return None

        # NDVI for agriculture
        ndvi = self._demo_float(commodity + "_ndvi", 0.55, 0.10)
        ndvi_z = self._demo_float(commodity + "_ndvi_z", 0.0, 1.0)
        soil  = self._demo_float(commodity + "_soil", 0.30, 0.08)
        # Interpretation: NDVI below avg → drought → bullish price; above avg → bearish
        return SatelliteSignal(
            commodity=commodity,
            ndvi_score=round(ndvi, 4),
            ndvi_anomaly_zscore=round(ndvi_z, 3),
            soil_moisture=round(soil, 4),
            region=self._commodity_region(commodity),
            timestamp=datetime.datetime.utcnow().isoformat() + "Z",
        )

    def _ais_signal(self, commodity: str) -> Optional[AISSignal]:
        """AIS vessel tracking → supply-in-transit signal."""
        if commodity not in ("crude_oil", "brent", "wti", "natural_gas", "lng"):
            return None

        tankers = self._demo_int(commodity + "_tankers", 120, 25)
        speed   = self._demo_float(commodity + "_speed", 13.0, 2.0)
        dwell   = self._demo_float(commodity + "_dwell", 20.0, 5.0)
        lb_ratio = self._demo_float(commodity + "_lb_ratio", 1.2, 0.3)

        # High LB ratio = more laden than ballast = supply glut incoming = bearish
        dir_score = -(lb_ratio - 1.2) / 0.3  # negative = bearish
        direction = "bearish" if dir_score < -0.3 else ("bullish" if dir_score > 0.3 else "neutral")
        strength  = min(1.0, abs(dir_score))

        return AISSignal(
            commodity=commodity,
            laden_to_ballast_ratio=round(lb_ratio, 3),
            tanker_count=tankers,
            avg_speed_knots=round(speed, 2),
            port_dwell_hours=round(dwell, 1),
            region="global",
            direction=direction,
            strength=round(strength, 4),
        )

    def _eia_signal(self, commodity: str) -> Optional[EIASignal]:
        """EIA weekly data → inventory signal."""
        if commodity not in ("crude_oil", "brent", "wti", "gasoline", "heating_oil",
                             "natural_gas", "distillate", "jet_fuel"):
            return None

        vs_5yr = self._demo_float(commodity + "_vs5yr", 0.0, 5.0)  # % above/below 5yr avg
        vs_wk  = self._demo_float(commodity + "_vswk", 0.0, 2.0)
        refinery = self._demo_float(commodity + "_refinery", 92.0, 3.0) if "crude" in commodity else None

        # Below 5yr avg = bullish (tight supply); above = bearish
        dir_score = -vs_5yr / 5.0
        direction = "bullish" if dir_score > 0.3 else ("bearish" if dir_score < -0.3 else "neutral")
        strength  = min(1.0, abs(dir_score))

        return EIASignal(
            commodity=commodity,
            vs_5yr_avg_pct=round(vs_5yr, 2),
            vs_prior_week_pct=round(vs_wk, 2),
            refinery_utilization_pct=round(refinery, 1) if refinery else None,
            direction=direction,
            strength=round(strength, 4),
        )

    def _weather_signal(self, commodity: str) -> Optional[WeatherSignal]:
        """Weather anomalies → commodity supply/demand signal."""
        weather_map = {
            "corn": ("us_corn_belt", "corn"), "wheat": ("ukraine_breadbasket", "wheat"),
            "soybeans": ("brazil_mato_grosso", "soybeans"),
            "coffee": ("brazil_cerrado", "coffee"), "cocoa": ("ivory_coast", "cocoa"),
            "natural_gas": ("us_northeast", "natgas"), "palm_oil": ("indonesia", "palm_oil"),
            "sugar": ("brazil_cerrado", "sugar"), "cotton": ("us_southeast", "cotton"),
        }
        if commodity not in weather_map:
            return None

        region, impact = weather_map[commodity]
        temp_anom = self._demo_float(commodity + "_temp", 0.0, 2.0)
        precip_anom = self._demo_float(commodity + "_precip", 0.0, 15.0)
        hdd = self._demo_float(commodity + "_hdd", 0.0, 50.0) if commodity == "natural_gas" else None
        drought = self._demo_float(commodity + "_drought", 0.0, 1.0)

        # For agriculture: drought (high drought index, negative precip) = bullish price
        dir_score = 0.0
        if commodity in ("corn", "wheat", "soybeans", "coffee", "cocoa", "cotton", "sugar", "palm_oil"):
            dir_score = -precip_anom / 15.0 + drought / 2.0
        elif commodity == "natural_gas":
            dir_score = (temp_anom / 2.0 if temp_anom < 0 else 0) + (hdd or 0) / 50.0

        direction = "long" if dir_score > 0.25 else ("short" if dir_score < -0.25 else "neutral")
        strength  = min(1.0, abs(dir_score))

        return WeatherSignal(
            region=region, commodity_impact=impact,
            temp_anomaly_c=round(temp_anom, 2),
            precip_anomaly_pct=round(precip_anom, 2),
            hdd_anomaly=round(hdd, 1) if hdd else None,
            drought_index=round(drought, 3),
            direction=direction,
            strength=round(strength, 4),
        )

    def _curve_signal(self, commodity: str) -> Optional[CurveSignal]:
        """Forward curve carry signal."""
        if not _HAS_CURVE:
            ry = self._demo_float(commodity + "_ry", 0.0, 8.0)
            struct = "backwardation" if ry > 3 else ("contango" if ry < -3 else "flat")
            dir = "long" if ry > 5 else ("short" if ry < -5 else "neutral")
            return CurveSignal(commodity=commodity, roll_yield_ann_pct=round(ry, 2),
                               structure=struct, carry_direction=dir,
                               carry_strength=min(1.0, abs(ry)/10))

        # Build synthetic forward curve
        m1 = self._demo_float(commodity+"_m1", 80.0, 5.0)
        slope = self._demo_float(commodity+"_slope", 0.0, 2.0)  # per month
        points_data = [{"contract": f"M{i+1}", "maturity_days": 30*(i+1), "price": max(1, m1 + slope*i)}
                       for i in range(6)]
        import pandas as pd
        curve_df = pd.DataFrame(points_data)
        from backend.commodities.curve_analytics import build_curve, carry_signal
        curve = build_curve(curve_df, commodity=commodity)
        sig = carry_signal(curve)
        return CurveSignal(
            commodity=commodity,
            roll_yield_ann_pct=sig.roll_yield_ann_pct,
            structure=sig.structure,
            carry_direction=sig.direction,
            carry_strength=sig.strength,
            z_score=sig.z_score,
        )

    def _cot_signal(self, commodity: str) -> Optional[COTPositioningSignal]:
        """CFTC COT managed money positioning signal."""
        if not _HAS_COT or self._cot_engine is None:
            mm_pct = self._demo_float(commodity + "_mm_pct", 0.0, 10.0)
            pct_rank = self._demo_float(commodity + "_pct_rank", 50.0, 25.0)
            pct_rank = max(0, min(100, pct_rank))
            c_dir = "short" if pct_rank > 80 else ("long" if pct_rank < 20 else "neutral")
            c_str = abs(pct_rank - 50) / 50.0
            return COTPositioningSignal(
                commodity=commodity, mm_net_pct_oi=round(mm_pct, 2),
                percentile_1yr=round(pct_rank, 1),
                crowding_direction=c_dir, crowding_strength=round(c_str, 4),
                composite_direction=c_dir, composite_strength=round(c_str * 0.6, 4),
            )

        records = generate_synthetic_cot(commodity, n_weeks=156, seed=hash(commodity) & 0xFFFF)
        sig = self._cot_engine.process(records, commodity)
        if sig is None:
            return None
        return COTPositioningSignal(
            commodity=commodity,
            mm_net_pct_oi=sig.mm_net_pct_oi,
            percentile_1yr=sig.percentile_1yr,
            z_score_1yr=sig.z_score_1yr,
            crowding_direction=sig.crowding_direction,
            crowding_strength=sig.crowding_strength,
            momentum_direction=sig.momentum_direction,
            momentum_strength=sig.momentum_strength,
            composite_direction=sig.composite_direction,
            composite_strength=sig.composite_strength,
        )

    # ─────────────────────────────────────────────────────────
    # Composite aggregation
    # ─────────────────────────────────────────────────────────

    def _composite(self, commodity: str,
                   sat: Optional[SatelliteSignal],
                   ais: Optional[AISSignal],
                   eia: Optional[EIASignal],
                   weather: Optional[WeatherSignal],
                   curve: Optional[CurveSignal],
                   cot: Optional[COTPositioningSignal]) -> tuple:
        """
        Aggregate all signals into a composite score [-1..+1] and direction.
        Returns (score, direction, confidence, n_total, n_agree, summary).
        """
        scores: List[float] = []

        # Satellite NDVI: below-avg NDVI (drought) → long (bullish); above → short
        if sat and sat.ndvi_anomaly_zscore is not None:
            scores.append(-sat.ndvi_anomaly_zscore * 0.5)   # neg z → drought → long

        # AIS: high LB ratio → bearish crude
        if ais and ais.direction != "neutral":
            s = ais.strength * (-1 if ais.direction == "bearish" else 1)
            scores.append(s)

        # EIA: below 5yr avg → bullish
        if eia and eia.direction != "neutral":
            s = eia.strength * (1 if eia.direction == "bullish" else -1)
            scores.append(s)

        # Weather
        if weather and weather.direction != "neutral":
            s = weather.strength * (1 if weather.direction == "long" else -1)
            scores.append(s)

        # Curve carry
        if curve and curve.carry_direction != "neutral":
            s = curve.carry_strength * (1 if curve.carry_direction == "long" else -1)
            scores.append(s)

        # COT positioning (contrarian composite)
        if cot and cot.composite_direction != "neutral":
            s = cot.composite_strength * (1 if cot.composite_direction == "long" else -1)
            scores.append(s)

        if not scores:
            return 0.0, "neutral", 0.0, 0, 0, f"{commodity}: insufficient data."

        arr = np.array(scores)
        composite = float(np.mean(arr))
        confidence = float(min(1.0, len(arr) / 6.0))  # max confidence with all 6 sources
        n_total = len(arr)
        n_agree = int((arr > 0).sum()) if composite > 0 else int((arr < 0).sum())

        direction = "long" if composite > 0.1 else ("short" if composite < -0.1 else "neutral")

        # Build summary
        parts = [f"{commodity}:"]
        if eis := eia:
            parts.append(f"EIA {eis.vs_5yr_avg_pct:+.1f}% vs 5yr.")
        if cot and cot.composite_direction != "neutral":
            parts.append(f"COT {cot.composite_direction} (pct={cot.percentile_1yr:.0f}).")
        if curve and curve.carry_direction != "neutral":
            parts.append(f"Carry {curve.carry_direction} (RY={curve.roll_yield_ann_pct:+.1f}%).")
        if weather and weather.direction != "neutral":
            parts.append(f"Weather {weather.direction}.")
        parts.append(f"→ {direction.upper()} ({composite:+.3f}, {n_agree}/{n_total} agreeing).")
        summary = " ".join(parts)

        return round(composite, 4), direction, round(confidence, 4), n_total, n_agree, summary

    # ─────────────────────────────────────────────────────────
    # Helpers
    # ─────────────────────────────────────────────────────────

    def _demo_float(self, key: str, mu: float, sigma: float) -> float:
        rng = np.random.default_rng(abs(hash(key)) % (2**32))
        return float(rng.normal(mu, sigma))

    def _demo_int(self, key: str, mu: int, sigma: int) -> int:
        rng = np.random.default_rng(abs(hash(key)) % (2**32))
        return max(0, int(rng.normal(mu, sigma)))

    def _commodity_region(self, commodity: str) -> str:
        mapping = {
            "corn": "us_corn_belt", "soybeans": "brazil_mato_grosso",
            "wheat": "ukraine_breadbasket", "coffee": "brazil_cerrado",
            "cocoa": "ivory_coast", "sugar": "brazil_cerrado",
            "cotton": "us_southeast", "palm_oil": "indonesia_borneo",
        }
        return mapping.get(commodity, "global")
