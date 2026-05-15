# backend/strategies/commodities/corn_soybean_crush.py
"""
Corn-Soybean Crush Spread & Agricultural Processing Margins
===========================================================
The soybean crush spread (Gross Processing Margin / GPM) measures the profit
from crushing soybeans into soybean meal and soybean oil. When GPM is wide,
crush demand is high → bullish soybeans. When GPM narrows → bearish.

Corn-Soybean ratio (CSR) reflects relative planting economics:
  - High CSR (soybeans cheap vs corn) → farmers plant more corn → bearish soybeans
  - Low CSR (soybeans expensive vs corn) → more soybean planting → bearish corn

Satellite & weather overlay:
  - La Niña → drought in US Corn Belt & Argentina → bullish corn/soybeans
  - Brazilian safrinha crop → key for global soybean supply
  - USDA WASDE report positioning (pre/post trade)

Processing relationships:
  1 bushel soybeans (60lb) → ~11lb soybean oil + ~44lb meal + 5lb hull
  Crush spread = (meal_price × 0.022 + oil_price × 11) - bean_price
    where 0.022 = 44/2000 (short tons/bushel), 11 = lbs/bushel

Signals:
  1. GPM z-score → buy soybeans when GPM > historical avg (crush demand)
  2. Corn-Soybean ratio z-score → relative planting economics
  3. NDVI satellite signal → crop stress overlay
  4. Seasonal planting/harvest calendar
  5. COT managed money positioning
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

try:
    from backend.commodities.base import (
        CommodityStrategy, CommoditySignal, CommoditySector,
        SignalDirection, SignalSource, CommodityRiskParams, ContractSpec,
    )
    from backend.commodities.curve_analytics import crush_spread
except Exception:
    CommodityStrategy = object  # type: ignore
    def crush_spread(s, m, o): return m*0.022 + o*11 - s  # type: ignore


# ─────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────

# CBOT contract specs
SOYBEAN_LOT  = 5_000   # bushels
CORN_LOT     = 5_000
MEAL_LOT     = 100     # short tons
OIL_LOT      = 60_000  # pounds

# Conversion factors
LBS_OIL_PER_BUSHEL  = 11.0
TONS_MEAL_PER_BUSHEL = 44.0 / 2000.0   # 44 lb meal → short tons

# Seasonal planting calendar (US)
CORN_PLANTING   = range(4, 6)    # April-May
CORN_HARVEST    = range(9, 12)   # September-November
SOY_PLANTING    = range(5, 7)    # May-June
SOY_HARVEST     = range(9, 12)
REPORTING_WEEK  = "Tuesday"      # USDA WASDE usually 1st Tuesday of month


# ─────────────────────────────────────────────────────────────
# Analytics
# ─────────────────────────────────────────────────────────────

def compute_gpm(soy_bushel: float, meal_ton: float, oil_lb: float) -> float:
    """Gross Processing Margin in $/bushel."""
    return float(TONS_MEAL_PER_BUSHEL * meal_ton + LBS_OIL_PER_BUSHEL * oil_lb - soy_bushel)

def corn_soy_ratio(corn_bushel: float, soy_bushel: float) -> float:
    """Corn-to-soybean price ratio. >2.5 → plant more corn; <2.0 → plant more soy."""
    return float(corn_bushel / max(soy_bushel, 0.01))

def soy_corn_spread(soy_bushel: float, corn_bushel: float) -> float:
    """Soybean premium over corn per bushel."""
    return float(soy_bushel - corn_bushel)

def seasonal_planting_factor(month: int, crop: str = "soybeans") -> str:
    """Return seasonal phase for positioning."""
    if crop == "soybeans":
        if month in SOY_PLANTING:     return "planting"
        elif month in SOY_HARVEST:    return "harvest"
        elif month in range(1, 4):    return "south_american_harvest"
        else:                          return "growing_season"
    else:  # corn
        if month in CORN_PLANTING:    return "planting"
        elif month in CORN_HARVEST:   return "harvest"
        else:                          return "growing_season"


# ─────────────────────────────────────────────────────────────
# Strategy
# ─────────────────────────────────────────────────────────────

@dataclass
class CrushConfig:
    # Thresholds
    gpm_z_buy_threshold:   float = 1.0    # buy soybeans when GPM z-score > this
    gpm_z_sell_threshold:  float = -1.0   # sell soybeans when GPM z-score < this
    csr_low_threshold:     float = 2.2    # CSR below → favor soy planting → bearish soy
    csr_high_threshold:    float = 2.6    # CSR above → favor corn planting → bullish soy
    ndvi_drought_z:        float = -1.5   # NDVI z-score below → drought → bullish
    z_lookback:            int   = 252

    # Symbols (CBOT)
    soy_symbol:  str = "ZS"   # soybeans
    corn_symbol: str = "ZC"   # corn
    meal_symbol: str = "ZM"   # soybean meal
    oil_symbol:  str = "ZL"   # soybean oil

    vol_target_ann: float = 0.15
    max_contracts: int = 5


class CornSoybeanCrush(CommodityStrategy):  # type: ignore
    """
    Agricultural spread strategy trading the soybean crush (GPM) and
    corn-soybean ratio (CSR) with satellite NDVI and weather overlays.
    """

    name     = "corn_soybean_crush"
    sector   = CommoditySector.AGRICULTURE if hasattr(CommoditySector, 'AGRICULTURE') else "agriculture"  # type: ignore
    commodity = "soybeans"

    def __init__(self, cfg: Optional[CrushConfig] = None):
        super().__init__()
        self.cfg = cfg or CrushConfig()

    def generate_signals(self, prices: pd.DataFrame,
                         aux: Optional[Dict[str, Any]] = None) -> List[Any]:
        """
        prices: DataFrame with [soy_price, corn_price, meal_price, oil_price].
                Optional: [ndvi_z, hdd_z, precip_anom_pct]
        """
        signals = []
        aux = aux or {}
        if prices.empty or "soy_price" not in prices.columns:
            return signals

        row = prices.iloc[-1]
        soy  = float(row.get("soy_price", 1300))    # $/bushel × 100 cents = cents/bushel
        corn = float(row.get("corn_price", 490))
        meal = float(row.get("meal_price", 380))     # $/short ton
        oil  = float(row.get("oil_price", 0.58))     # $/lb

        # ── Crush spread (GPM) ──
        gpm = compute_gpm(soy / 100, meal, oil)     # convert cents → dollars
        csr = corn_soy_ratio(corn / 100, soy / 100)

        # Rolling z-scores (require history)
        gpm_z = csr_z = 0.0
        if "gpm" in prices.columns and len(prices) >= 60:
            g = prices["gpm"]
            gpm_z = float((gpm - g.rolling(self.cfg.z_lookback, min_periods=60).mean().iloc[-1]) /
                          max(g.rolling(self.cfg.z_lookback, min_periods=60).std().iloc[-1], 0.01))
        if "csr" in prices.columns and len(prices) >= 60:
            c = prices["csr"]
            csr_z = float((csr - c.rolling(self.cfg.z_lookback, min_periods=60).mean().iloc[-1]) /
                          max(c.rolling(self.cfg.z_lookback, min_periods=60).std().iloc[-1], 0.01))

        # Satellite NDVI
        ndvi_z = float(row.get("ndvi_z", 0.0)) if "ndvi_z" in prices.columns else \
                 float(aux.get("satellite", {}).get("ndvi_anomaly_zscore", 0.0) or 0.0)

        # Seasonal
        import datetime
        month = datetime.date.today().month
        soy_phase  = seasonal_planting_factor(month, "soybeans")
        corn_phase = seasonal_planting_factor(month, "corn")

        # ── Signal 1: Crush spread (GPM) ──
        if gpm_z > self.cfg.gpm_z_buy_threshold:
            # Wide crush margin → high crush demand → buy soybeans
            strength = min(1.0, gpm_z / 2.0)
            conf = 0.70 + (0.1 if ndvi_z < -1.0 else 0)  # drought adds conviction
            signals.append(self._make_signal(
                direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                strength=strength, confidence=min(0.85, conf),
                horizon_days=14,
                source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                contracts=[self.cfg.soy_symbol],
                rationale=(f"Wide crush margin (GPM={gpm:.2f}/bu, z={gpm_z:.2f}). "
                           f"High crush demand → bullish soybeans."),
                gpm=gpm, gpm_z=gpm_z, soy_phase=soy_phase,
            ))

        elif gpm_z < self.cfg.gpm_z_sell_threshold:
            # Narrow/negative crush → crushers cutting back → bearish soybeans
            strength = min(1.0, abs(gpm_z) / 2.0)
            signals.append(self._make_signal(
                direction=SignalDirection.SHORT if hasattr(SignalDirection, 'SHORT') else "short",  # type: ignore
                strength=strength, confidence=0.65,
                horizon_days=10,
                source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                contracts=[self.cfg.soy_symbol],
                rationale=f"Negative crush margin (GPM={gpm:.2f}/bu, z={gpm_z:.2f}). Crushers losing money → bearish.",
                gpm=gpm, gpm_z=gpm_z,
            ))

        # ── Signal 2: Corn-Soybean ratio ──
        if csr > self.cfg.csr_high_threshold:
            # High CSR → soy cheap relative to corn → farmers plant more soy → bearish soy long-term
            # But near-term: market realizes corn overvalued → short corn / long soy
            strength = min(1.0, (csr - self.cfg.csr_high_threshold) / 0.5)
            signals.append(self._make_signal(
                direction=SignalDirection.SPREAD_LONG if hasattr(SignalDirection, 'SPREAD_LONG') else "spread_long",  # type: ignore
                strength=strength * 0.7, confidence=0.60,
                horizon_days=30,
                source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                contracts=[self.cfg.soy_symbol, self.cfg.corn_symbol],
                rationale=(f"High CSR={csr:.2f} → soy undervalued vs corn. "
                           f"Planting shift signal: long soy / short corn."),
                csr=csr,
            ))

        elif csr < self.cfg.csr_low_threshold:
            # Low CSR → soy expensive → farmers shift to corn
            strength = min(1.0, (self.cfg.csr_low_threshold - csr) / 0.5)
            signals.append(self._make_signal(
                direction=SignalDirection.SPREAD_SHORT if hasattr(SignalDirection, 'SPREAD_SHORT') else "spread_short",  # type: ignore
                strength=strength * 0.7, confidence=0.60,
                horizon_days=30,
                source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                contracts=[self.cfg.soy_symbol, self.cfg.corn_symbol],
                rationale=f"Low CSR={csr:.2f} → soy overvalued. Planting shift to corn → short soy / long corn.",
                csr=csr,
            ))

        # ── Signal 3: Satellite NDVI drought overlay ──
        if ndvi_z < self.cfg.ndvi_drought_z and soy_phase == "growing_season":
            strength = min(1.0, abs(ndvi_z) / 3.0)
            signals.append(self._make_signal(
                direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                strength=strength, confidence=0.75,
                horizon_days=21,
                source=SignalSource.SATELLITE if hasattr(SignalSource, 'SATELLITE') else "satellite",  # type: ignore
                contracts=[self.cfg.soy_symbol, self.cfg.corn_symbol],
                rationale=(f"Satellite NDVI drought signal (z={ndvi_z:.2f}). "
                           f"Crop stress during growing season → yield loss → bullish."),
                ndvi_z=ndvi_z, soy_phase=soy_phase,
            ))

        return signals

    def run_backtest(self, prices: pd.DataFrame) -> pd.DataFrame:
        """
        Vectorized backtest. prices: [soy_price, corn_price, meal_price, oil_price]
        Returns: [gpm, csr, gpm_z, signal, pnl_daily, cumulative_pnl]
        """
        df = prices.copy().sort_index()
        df["gpm"] = df.apply(lambda r: compute_gpm(
            r["soy_price"]/100, r["meal_price"], r["oil_price"]), axis=1)
        df["csr"] = df.apply(lambda r: corn_soy_ratio(r["corn_price"]/100, r["soy_price"]/100), axis=1)

        df["gpm_z"] = (df["gpm"] - df["gpm"].rolling(self.cfg.z_lookback, min_periods=60).mean()) / \
                      df["gpm"].rolling(self.cfg.z_lookback, min_periods=60).std().replace(0, np.nan)

        df["pos_soy"] = np.where(df["gpm_z"] > self.cfg.gpm_z_buy_threshold,  1.0,
                        np.where(df["gpm_z"] < self.cfg.gpm_z_sell_threshold, -1.0, 0.0))

        soy_ret = df["soy_price"].pct_change()
        df["pnl_daily"] = df["pos_soy"].shift(1) * soy_ret
        df["cumulative_pnl"] = (1 + df["pnl_daily"].cumprod())

        sharpe = (df["pnl_daily"].mean() / df["pnl_daily"].std() * math.sqrt(252)
                  if df["pnl_daily"].std() > 0 else 0)
        df.attrs["sharpe"] = round(sharpe, 3)
        df.attrs["annual_return"] = round(df["pnl_daily"].mean() * 252 * 100, 2)
        return df

    def _describe(self) -> str:
        return ("Corn-Soybean crush spread strategy: trades GPM (gross processing margin), "
                "corn-soybean planting ratio, satellite NDVI drought signals, and "
                "South American harvest timing.")


if __name__ == "__main__":
    print("Corn-Soybean Crush Spread Strategy")
    soy, corn, meal, oil = 1350, 520, 395, 0.60
    gpm = compute_gpm(soy/100, meal, oil)
    csr = corn_soy_ratio(corn/100, soy/100)
    print(f"Soy={soy}¢/bu Corn={corn}¢/bu Meal=${meal}/ton Oil=${oil}/lb")
    print(f"GPM={gpm:.3f}/bu | CSR={csr:.2f}")
    print(f"Interpretation: {'wide crush → LONG SOY' if gpm > 0.5 else 'narrow crush → cautious'}")
    print(f"Planting: CSR {'high → more corn planting' if csr > 2.5 else 'low → more soy planting'}")
