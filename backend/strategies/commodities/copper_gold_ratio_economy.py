# backend/strategies/commodities/copper_gold_ratio_economy.py
"""
Copper-Gold Ratio — Dr. Copper as Macro Regime Indicator
=========================================================
The copper/gold ratio (Cu/Au) is one of the most reliable macro leading indicators:
  - Rising Cu/Au → risk-on: global growth, higher yields, equity outperformance
  - Falling Cu/Au → risk-off: recession fears, flight to safety, bond rally

The ratio leads 10-year Treasury yields by ~3-6 months (bond market signal).
When Cu/Au diverges from US 10y yield for >60 days, it predicts mean reversion.

Price drivers:
  1. Global manufacturing PMI (copper demand)
  2. China credit impulse (35% of global copper demand)
  3. Chile/Peru mining disruptions (supply)
  4. Geopolitical risk (gold safe-haven bid)
  5. USD index (both priced in USD)
  6. Real interest rates (gold is sensitive; copper less so)

Strategy modes:
  A. Macro regime filter: use Cu/Au trend to tilt equity/bond/commodity positioning
  B. Rate market signal: Cu/Au vs 10y yield divergence → yield mean reversion
  C. Cross-commodity: long copper / short gold when Cu/Au rising
  D. Supply-side: Chile/Peru strike risk → short-term bullish copper
  E. China PMI proxy: copper demand as real-time China activity gauge

Supply concentration:
  - Chile (Escondida) + Peru → 40% of global copper mine supply
  - DR Congo (Kamoa-Kakula) → growing share
  - Indonesia (Grasberg) → deep underground transition
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
        SignalDirection, SignalSource, CommodityRiskParams,
    )
except Exception:
    CommodityStrategy = object  # type: ignore


# ─────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────

# Cu/Au ratio thresholds (copper $/lb vs gold $/oz → ratio × 1000 for scaling)
# Typically: Cu ~$4/lb, Au ~$2000/oz → ratio = 4/2000 = 0.002 → ×1000 = 2.0
CUAU_RATIO_SCALE      = 1000.0          # multiply raw Cu$/lb ÷ Au$/oz by this
CUAU_EXPANSION_ZONE   = 2.5            # ratio × 1000 > 2.5 → growth regime
CUAU_CONTRACTION_ZONE = 1.5            # ratio × 1000 < 1.5 → contraction

# 10y Treasury yield thresholds
YIELD_HIGH_CYCLE  = 4.5               # % — high rates, copper typically soft
YIELD_TROUGH      = 2.0               # % — low rates, gold strong

# China PMI signal
PMI_EXPANSION = 50.0
PMI_STRONG    = 52.0

# LME Copper contract specs
COPPER_LOT_TONNES  = 25               # LME lot = 25 metric tonnes
COPPER_LME_SYMBOL  = "LCA"            # LME Copper 3M
GOLD_COMEX_SYMBOL  = "GC"             # COMEX gold
GOLD_LBMA_SYMBOL   = "LBMA_GOLD"


# ─────────────────────────────────────────────────────────────
# Analytics
# ─────────────────────────────────────────────────────────────

def compute_cuau(copper_lb: float, gold_oz: float) -> float:
    """
    Compute Cu/Au ratio scaled by 1000.
    copper_lb: $/lb;  gold_oz: $/troy oz
    Typical range: 1.5–4.0
    """
    if gold_oz < 1.0:
        return 0.0
    return float(copper_lb / gold_oz * CUAU_RATIO_SCALE)


def macro_regime(cuau_ratio: float, cuau_z: float,
                 pmi: Optional[float] = None,
                 yield_10y: Optional[float] = None) -> Dict[str, Any]:
    """
    Classify macro regime from Cu/Au ratio.

    Returns:
      regime: "growth" | "slowdown" | "recession" | "neutral"
      direction: "risk_on" | "risk_off" | "neutral"
      confidence: float
    """
    # Primary: ratio level
    if cuau_ratio > CUAU_EXPANSION_ZONE:
        regime = "growth"
        risk   = "risk_on"
        conf   = 0.70
    elif cuau_ratio < CUAU_CONTRACTION_ZONE:
        regime = "recession"
        risk   = "risk_off"
        conf   = 0.68
    elif cuau_ratio > 2.0:
        regime = "expansion"
        risk   = "risk_on"
        conf   = 0.55
    else:
        regime = "slowdown"
        risk   = "risk_off"
        conf   = 0.55

    # Confirm with z-score trend
    if abs(cuau_z) > 1.5:
        conf = min(0.85, conf + 0.10)
        if cuau_z > 1.5 and risk == "risk_on":
            conf = min(0.88, conf + 0.05)

    # PMI overlay
    if pmi is not None:
        if pmi > PMI_STRONG and regime in ("growth", "expansion"):
            conf = min(0.90, conf + 0.08)
        elif pmi < PMI_EXPANSION and regime == "growth":
            conf -= 0.10   # PMI contradicts Cu/Au

    # Yield overlay (yield rising + Cu/Au rising = strong growth)
    if yield_10y is not None:
        if yield_10y > YIELD_HIGH_CYCLE and risk == "risk_off":
            conf = min(0.85, conf + 0.05)   # high rates confirm risk-off

    return {
        "regime":       regime,
        "direction":    risk,
        "confidence":   round(max(0.40, min(0.92, conf)), 3),
        "cuau_ratio":   round(cuau_ratio, 4),
        "cuau_z":       round(cuau_z, 3),
        "pmi":          pmi,
        "yield_10y":    yield_10y,
    }


def cuau_yield_divergence(cuau_z: float, yield_z: float) -> Dict[str, Any]:
    """
    Cu/Au ratio divergence from 10y Treasury yield.
    They typically move together (both up = growth).
    Divergence > 1.5 stdev → mean reversion in yield is coming.
    """
    divergence = cuau_z - yield_z
    if divergence > 1.5:
        return {"divergence": round(divergence, 3),
                "signal": "yield_will_rise",
                "rationale": f"Cu/Au outrunning yield (div={divergence:.2f}). Bonds will sell off → short bonds.",
                "strength": min(1.0, divergence / 3.0)}
    elif divergence < -1.5:
        return {"divergence": round(divergence, 3),
                "signal": "yield_will_fall",
                "rationale": f"Yield outrunning Cu/Au (div={divergence:.2f}). Copper will rally or yields fall → long bonds or long copper.",
                "strength": min(1.0, abs(divergence) / 3.0)}
    return {"divergence": round(divergence, 3), "signal": "neutral", "strength": 0.0}


def chile_peru_strike_signal(strike_probability: float = 0.0,
                             output_loss_pct: float = 0.0) -> Optional[Dict[str, Any]]:
    """
    Chile/Peru mining strike/disruption signal.
    strike_probability: 0..1 (from news sentiment / options skew)
    output_loss_pct: expected % of global supply disrupted
    """
    if strike_probability < 0.2 and output_loss_pct < 1.0:
        return None
    impact = strike_probability * output_loss_pct / 5.0  # 5% supply loss = max signal
    return {
        "strike_probability":  round(strike_probability, 3),
        "output_loss_pct":     round(output_loss_pct, 2),
        "supply_impact_score": round(min(1.0, impact), 3),
        "direction": "bullish",
        "rationale": (f"Chile/Peru disruption risk: P={strike_probability*100:.0f}%, "
                      f"supply loss={output_loss_pct:.1f}% → LONG copper."),
    }


# ─────────────────────────────────────────────────────────────
# Strategy
# ─────────────────────────────────────────────────────────────

@dataclass
class CopperGoldConfig:
    # Ratio thresholds
    cuau_z_trend_threshold: float = 1.0    # z-score for regime confidence boost
    cuau_ratio_spread_entry: float = 0.3   # spread z for spread trade entry

    # Yield divergence
    yield_divergence_threshold: float = 1.5

    # Technical
    z_lookback: int = 252
    momentum_days: int = 20
    z_buy: float = -1.5
    z_sell: float = 1.5

    # Symbols
    copper_symbol: str = COPPER_LME_SYMBOL
    gold_symbol:   str = GOLD_COMEX_SYMBOL

    # Risk
    vol_target_ann: float = 0.15
    max_contracts: int = 8
    stop_loss_pct: float = 0.08


class CopperGoldRatioEconomy(CommodityStrategy):  # type: ignore
    """
    Dr. Copper — Copper/Gold macro regime strategy.

    Generates signals from:
    1. Cu/Au ratio level and trend (macro regime classifier)
    2. Copper vs gold relative momentum (spread trade)
    3. Cu/Au divergence from 10y Treasury yield (rate market signal)
    4. China PMI overlay (leading demand indicator)
    5. Chile/Peru supply disruption signal
    6. Technical z-score mean reversion per metal
    7. Satellite: copper mine nightlights (operational activity proxy)
    """

    name     = "copper_gold_ratio_economy"
    sector   = (CommoditySector.METALS_BASE  # type: ignore
                if hasattr(CommoditySector, 'METALS_BASE') else "metals_base")
    commodity = "copper"

    def __init__(self, cfg: Optional[CopperGoldConfig] = None):
        super().__init__()
        self.cfg = cfg or CopperGoldConfig()

    def generate_signals(self, prices: pd.DataFrame,
                         aux: Optional[Dict[str, Any]] = None) -> List[Any]:
        """
        prices: DataFrame with [copper_lb_price, gold_oz_price].
                Optional: [pmi_china, yield_10y, strike_probability, output_loss_pct]
        aux: CommoditySignalHub output dict (satellite, ais, etc.)
        """
        signals = []
        aux = aux or {}

        if prices.empty or "copper_lb_price" not in prices.columns:
            return signals

        row = prices.iloc[-1]
        cu    = float(row.get("copper_lb_price", 4.0))
        au    = float(row.get("gold_oz_price", 2000.0))
        pmi   = float(row.get("pmi_china", None) or 0.0) or None
        yield10 = float(row.get("yield_10y", None) or 0.0) or None

        cuau = compute_cuau(cu, au)

        # Z-score of Cu/Au ratio
        cuau_z = 0.0
        if len(prices) >= 60 and "copper_lb_price" in prices.columns and "gold_oz_price" in prices.columns:
            cuau_series = prices["copper_lb_price"] / prices["gold_oz_price"].replace(0, np.nan) * CUAU_RATIO_SCALE
            mu  = cuau_series.rolling(self.cfg.z_lookback, min_periods=60).mean().iloc[-1]
            std = cuau_series.rolling(self.cfg.z_lookback, min_periods=60).std().iloc[-1]
            cuau_z = (cuau - mu) / max(std, 0.01)

        # ── Signal 1: Macro regime (Cu/Au level + trend) ──
        regime_data = macro_regime(cuau, cuau_z, pmi, yield10)

        if regime_data["direction"] == "risk_on" and cuau_z > 0.5:
            signals.append(self._make_signal(
                direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                strength=min(1.0, abs(cuau_z) / 2.5), confidence=regime_data["confidence"],
                horizon_days=30,
                source=SignalSource.MACRO if hasattr(SignalSource, 'MACRO') else "macro",  # type: ignore
                contracts=[self.cfg.copper_symbol],
                rationale=(f"Dr. Copper risk-on: Cu/Au={cuau:.3f} (z={cuau_z:.2f}). "
                           f"Regime={regime_data['regime']}. "
                           f"{f'China PMI={pmi:.1f}.' if pmi else ''} LONG copper."),
                **{k: v for k, v in regime_data.items()},
            ))
        elif regime_data["direction"] == "risk_off" and cuau_z < -0.5:
            signals.append(self._make_signal(
                direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                strength=min(1.0, abs(cuau_z) / 2.5), confidence=regime_data["confidence"],
                horizon_days=25,
                source=SignalSource.MACRO if hasattr(SignalSource, 'MACRO') else "macro",  # type: ignore
                contracts=[self.cfg.gold_symbol],
                rationale=(f"Dr. Copper risk-off: Cu/Au={cuau:.3f} (z={cuau_z:.2f}). "
                           f"Regime={regime_data['regime']} → flight to gold. LONG gold."),
                **{k: v for k, v in regime_data.items()},
            ))

        # ── Signal 2: Spread trade — long Cu / short Au when Cu/Au rising ──
        spread_z = 0.0
        if len(prices) >= 60:
            cu_z_series = (prices["copper_lb_price"] -
                           prices["copper_lb_price"].rolling(self.cfg.z_lookback, min_periods=60).mean()) / \
                           prices["copper_lb_price"].rolling(self.cfg.z_lookback, min_periods=60).std().replace(0, np.nan)
            au_z_series = (prices["gold_oz_price"] -
                           prices["gold_oz_price"].rolling(self.cfg.z_lookback, min_periods=60).mean()) / \
                           prices["gold_oz_price"].rolling(self.cfg.z_lookback, min_periods=60).std().replace(0, np.nan)
            spread_z = float((cu_z_series - au_z_series).iloc[-1]) if not cu_z_series.empty else 0.0
            spread_z = 0.0 if math.isnan(spread_z) else spread_z

        if spread_z > self.cfg.cuau_ratio_spread_entry:
            # Copper outperforming gold → trend-following spread
            signals.append(self._make_signal(
                direction=SignalDirection.SPREAD_LONG if hasattr(SignalDirection, 'SPREAD_LONG') else "spread_long",  # type: ignore
                strength=min(1.0, spread_z / 2.0), confidence=0.63,
                horizon_days=15,
                source=SignalSource.TECHNICAL if hasattr(SignalSource, 'TECHNICAL') else "technical",  # type: ignore
                contracts=[self.cfg.copper_symbol, self.cfg.gold_symbol],
                rationale=f"Cu/Au spread momentum (z={spread_z:.2f}). Copper outperforming → long Cu / short Au.",
                spread_z=spread_z, cuau=cuau,
            ))
        elif spread_z < -self.cfg.cuau_ratio_spread_entry:
            # Gold outperforming copper → risk-off spread
            signals.append(self._make_signal(
                direction=SignalDirection.SPREAD_SHORT if hasattr(SignalDirection, 'SPREAD_SHORT') else "spread_short",  # type: ignore
                strength=min(1.0, abs(spread_z) / 2.0), confidence=0.63,
                horizon_days=15,
                source=SignalSource.TECHNICAL if hasattr(SignalSource, 'TECHNICAL') else "technical",  # type: ignore
                contracts=[self.cfg.copper_symbol, self.cfg.gold_symbol],
                rationale=f"Gold outperforming copper (z={spread_z:.2f}). Risk-off → short Cu / long Au.",
                spread_z=spread_z, cuau=cuau,
            ))

        # ── Signal 3: Cu/Au vs 10y yield divergence ──
        if "yield_10y" in prices.columns and len(prices) >= 60:
            yield_mu  = prices["yield_10y"].rolling(self.cfg.z_lookback, min_periods=60).mean().iloc[-1]
            yield_std = prices["yield_10y"].rolling(self.cfg.z_lookback, min_periods=60).std().iloc[-1]
            yield_z   = (float(row.get("yield_10y", 0)) - yield_mu) / max(yield_std, 0.01)
            div = cuau_yield_divergence(cuau_z, yield_z)
            if div["signal"] == "yield_will_rise" and div["strength"] > 0.4:
                signals.append(self._make_signal(
                    direction=SignalDirection.SHORT if hasattr(SignalDirection, 'SHORT') else "short",  # type: ignore
                    strength=div["strength"], confidence=0.66,
                    horizon_days=20,
                    source=SignalSource.MACRO if hasattr(SignalSource, 'MACRO') else "macro",  # type: ignore
                    contracts=["TY"],  # 10y Treasury
                    rationale=div["rationale"],
                    divergence=div["divergence"], cuau_z=cuau_z,
                ))
            elif div["signal"] == "yield_will_fall" and div["strength"] > 0.4:
                signals.append(self._make_signal(
                    direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                    strength=div["strength"], confidence=0.64,
                    horizon_days=20,
                    source=SignalSource.MACRO if hasattr(SignalSource, 'MACRO') else "macro",  # type: ignore
                    contracts=[self.cfg.copper_symbol],
                    rationale=div["rationale"],
                    divergence=div["divergence"], cuau_z=cuau_z,
                ))

        # ── Signal 4: Chile/Peru supply disruption ──
        strike_prob = float(row.get("strike_probability", 0.0))
        output_loss = float(row.get("output_loss_pct", 0.0))
        strike_sig  = chile_peru_strike_signal(strike_prob, output_loss)
        if strike_sig:
            signals.append(self._make_signal(
                direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                strength=strike_sig["supply_impact_score"], confidence=0.74,
                horizon_days=14,
                source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                contracts=[self.cfg.copper_symbol],
                rationale=strike_sig["rationale"],
                **{k: v for k, v in strike_sig.items() if k != "rationale"},
            ))

        # ── Signal 5: Technical z-score (copper individually) ──
        if len(prices) >= 60:
            cu_mu  = prices["copper_lb_price"].rolling(self.cfg.z_lookback, min_periods=60).mean().iloc[-1]
            cu_std = prices["copper_lb_price"].rolling(self.cfg.z_lookback, min_periods=60).std().iloc[-1]
            cu_z   = (cu - cu_mu) / max(cu_std, 0.001)

            if cu_z < self.cfg.z_buy:
                signals.append(self._make_signal(
                    direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                    strength=min(1.0, abs(cu_z) / 3.0), confidence=0.65,
                    horizon_days=14,
                    source=SignalSource.TECHNICAL if hasattr(SignalSource, 'TECHNICAL') else "technical",  # type: ignore
                    contracts=[self.cfg.copper_symbol],
                    rationale=f"Copper oversold (z={cu_z:.2f}). Structural industrial demand floor → mean reversion LONG.",
                    cu_z=cu_z,
                ))
            elif cu_z > self.cfg.z_sell:
                signals.append(self._make_signal(
                    direction=SignalDirection.SHORT if hasattr(SignalDirection, 'SHORT') else "short",  # type: ignore
                    strength=min(1.0, cu_z / 3.0), confidence=0.60,
                    horizon_days=10,
                    source=SignalSource.TECHNICAL if hasattr(SignalSource, 'TECHNICAL') else "technical",  # type: ignore
                    contracts=[self.cfg.copper_symbol],
                    rationale=f"Copper overbought (z={cu_z:.2f}). Extended → mean reversion SHORT.",
                    cu_z=cu_z,
                ))

        # ── Signal 6: Satellite mine activity ──
        sat = aux.get("satellite", {})
        nightlights_z = float(sat.get("nightlights_score", 0.0) or 0.0)
        if nightlights_z < -1.5:
            signals.append(self._make_signal(
                direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                strength=min(1.0, abs(nightlights_z) / 3.0), confidence=0.72,
                horizon_days=21,
                source=SignalSource.SATELLITE if hasattr(SignalSource, 'SATELLITE') else "satellite",  # type: ignore
                contracts=[self.cfg.copper_symbol],
                rationale=(f"Satellite nightlights anomaly over copper mining region (z={nightlights_z:.2f}). "
                           f"Mine operational activity declined → supply disruption → LONG copper."),
                nightlights_z=nightlights_z,
            ))

        # ── Signal 7: China PMI standalone ──
        if pmi is not None and pmi > PMI_STRONG:
            signals.append(self._make_signal(
                direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                strength=min(1.0, (pmi - PMI_EXPANSION) / 5.0), confidence=0.67,
                horizon_days=20,
                source=SignalSource.MACRO if hasattr(SignalSource, 'MACRO') else "macro",  # type: ignore
                contracts=[self.cfg.copper_symbol],
                rationale=f"China PMI={pmi:.1f} (expansion). China = 35% of global copper demand → bullish copper.",
                pmi_china=pmi,
            ))
        elif pmi is not None and pmi < PMI_EXPANSION - 2:
            signals.append(self._make_signal(
                direction=SignalDirection.SHORT if hasattr(SignalDirection, 'SHORT') else "short",  # type: ignore
                strength=min(1.0, (PMI_EXPANSION - pmi) / 5.0), confidence=0.64,
                horizon_days=20,
                source=SignalSource.MACRO if hasattr(SignalSource, 'MACRO') else "macro",  # type: ignore
                contracts=[self.cfg.copper_symbol],
                rationale=f"China PMI={pmi:.1f} (contraction). Demand destruction → bearish copper.",
                pmi_china=pmi,
            ))

        return signals

    def _describe(self) -> str:
        return ("Dr. Copper macro regime strategy. Cu/Au ratio as global growth indicator. "
                "Generates signals from: regime classification, relative momentum spread (Cu vs Au), "
                "Cu/Au divergence from 10y Treasury yields, China PMI overlay, "
                "Chile/Peru supply disruption risk, and satellite mining activity.")


if __name__ == "__main__":
    print("=== Copper-Gold Ratio Economy Strategy ===")
    cu, au = 4.15, 2100.0
    cuau = compute_cuau(cu, au)
    print(f"Copper=${cu}/lb, Gold=${au}/oz → Cu/Au ratio={cuau:.4f}")
    regime = macro_regime(cuau, cuau_z=0.8, pmi=52.3, yield_10y=4.2)
    print(f"Macro regime: {regime['regime']} → {regime['direction']} (confidence={regime['confidence']:.0%})")
    div = cuau_yield_divergence(cuau_z=1.2, yield_z=-0.5)
    print(f"Yield divergence: {div['signal']} (strength={div['strength']:.2f})")
