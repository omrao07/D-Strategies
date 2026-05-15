# backend/strategies/commodities/battery_metals_ev_demand.py
"""
Battery Metals & EV Supply Chain — Institutional Strategy
==========================================================
Nickel, Cobalt, Lithium, and Manganese are the four critical inputs for
EV battery cathodes. This strategy trades the full battery metals complex
as an integrated supply-chain play on the EV adoption cycle.

Key relationships:
  1. EV penetration growth (YoY) → demand pull for all battery metals
  2. NMC vs LFP cathode shift → bearish cobalt, neutral lithium (LFP uses no Co)
  3. Nickel class I (>99.8%) premium over class II → battery-grade scarcity
  4. Indonesian HPAL (High Pressure Acid Leach) output → supply shock bearish Ni
  5. DRC cobalt artisanal mining risk → supply-side political premium
  6. Satellite: mine activity proxy (nightlights over key mining regions)
  7. Shipping AIS: battery-grade chemical tanker fleet utilization

Price hierarchy by volatility:
  Cobalt >> Lithium Carbonate > Nickel Class I > Manganese

Supply concentration risk:
  - Cobalt: 70%+ DRC
  - Lithium: Chile/Australia/Argentina (Lithium Triangle)
  - Nickel: Indonesia/Philippines dominant (class II → HPAL → class I)

Cathode chemistry market share (2024 trend):
  NMC 622/811 → high Ni, less Co
  LFP          → no Co, no Ni, cheaper, safer (BYD dominant)
  LMFP         → Mn addition (manganese demand positive)
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

# Battery metal benchmark prices (context, $/tonne unless noted)
NICKEL_CLASS1_SPREAD_PREMIUM = 200.0   # $/t premium for class I over LME class II
COBALT_PRICE_FLOOR = 25_000.0          # $/t — artisanal cost floor
LITHIUM_PRICE_SUPPORT = 10_000.0       # $/t LCE — all-in cost floor

# Cathode chemistry market share dynamics (2024 baseline)
LFP_MARKET_SHARE_THRESHOLD = 0.40      # LFP >40% → bearish cobalt
NMC_PREMIUM_CATHODE = ["NMC811", "NMC622"]  # high-Ni cathodes → bullish Ni

# EV penetration thresholds (global)
EV_PEN_GROWTH_BULLISH = 0.30           # >30% YoY growth in EV sales → demand surge
EV_PEN_GROWTH_NEUTRAL = 0.10           # 10–30% = steady
EV_PEN_GLOBAL_TIPPING  = 0.25          # >25% penetration → structural deficit

# Key mining region coordinates (for satellite overlay)
DRC_COBALT_REGION   = "DRC_Katanga"
ATACAMA_LITHIUM     = "Chile_Atacama"
SULAWESI_NICKEL     = "Indonesia_Sulawesi"
PILBARA_LITHIUM     = "Australia_Pilbara"

# LME contract symbols
NICKEL_SYMBOL   = "LNI"    # LME Nickel (3M)
COBALT_SYMBOL   = "LCO"    # LME Cobalt
LITHIUM_SYMBOL  = "LITHC"  # CME Lithium Carbonate
MANGANESE_SYMBOL = "HMNG"  # hypothetical


# ─────────────────────────────────────────────────────────────
# Analytics
# ─────────────────────────────────────────────────────────────

def ev_demand_score(ev_yoy_pct: float, ev_penetration: float,
                    lfp_share: float = 0.35) -> Dict[str, float]:
    """
    Composite EV demand score for battery metals.

    Returns normalized scores [-1..+1] per metal:
      nickel, cobalt, lithium, manganese
    """
    # Base EV demand (all metals benefit from adoption growth)
    if ev_yoy_pct > EV_PEN_GROWTH_BULLISH * 100:
        base = 1.0
    elif ev_yoy_pct > EV_PEN_GROWTH_NEUTRAL * 100:
        base = (ev_yoy_pct / 100 - EV_PEN_GROWTH_NEUTRAL) / (EV_PEN_GROWTH_BULLISH - EV_PEN_GROWTH_NEUTRAL)
    else:
        base = -0.5 if ev_yoy_pct < 5 else 0.0

    # LFP cannibalization: every 10% LFP share above 35% cuts cobalt score by 0.3
    cobalt_lfp_penalty = max(0.0, (lfp_share - 0.35) / 0.10) * 0.3
    # LFP is lithium-positive (still needs lithium, just different form)
    lithium_lfp_boost = max(0.0, (lfp_share - 0.25) / 0.10) * 0.1

    # Penetration tipping point: structural deficit signal
    pen_boost = min(0.5, max(0.0, (ev_penetration - EV_PEN_GLOBAL_TIPPING) / 0.10))

    return {
        "nickel":    round(min(1.0, base + pen_boost * 0.8), 4),
        "cobalt":    round(min(1.0, max(-1.0, base - cobalt_lfp_penalty + pen_boost * 0.4)), 4),
        "lithium":   round(min(1.0, base + lithium_lfp_boost + pen_boost), 4),
        "manganese": round(min(1.0, base * 0.7 + pen_boost * 0.5), 4),  # LMFP benefits
        "base_ev":   round(base, 4),
        "lfp_share": lfp_share,
    }


def nickel_class_spread_signal(ni_class1: float, ni_lme: float,
                                hist_spread: Optional[float] = None) -> Dict[str, Any]:
    """
    Class I premium over LME (class I/II blend) → battery-grade scarcity.
    Widening spread = battery-grade tight = BULLISH class I nickel.
    """
    spread = ni_class1 - ni_lme
    pct_premium = spread / max(ni_lme, 1.0)

    if hist_spread is not None:
        z = (spread - hist_spread) / max(abs(hist_spread) * 0.15, 500)
    else:
        z = (spread - NICKEL_CLASS1_SPREAD_PREMIUM) / 300.0

    direction = "bullish" if z > 1.0 else ("bearish" if z < -1.0 else "neutral")
    return {
        "ni_class1_price":  ni_class1,
        "ni_lme_price":     ni_lme,
        "class1_spread":    round(spread, 0),
        "spread_pct":       round(pct_premium * 100, 2),
        "spread_z":         round(z, 3),
        "direction":        direction,
        "interpretation": (f"Class I premium ${spread:,.0f}/t ({pct_premium*100:.1f}%). "
                           f"{'Battery-grade scarcity → bullish' if direction=='bullish' else 'Spread compressed → neutral'}."),
    }


def supply_risk_score(drc_instability: float = 0.0,
                      indonesia_policy_risk: float = 0.0,
                      chile_water_stress: float = 0.0) -> Dict[str, float]:
    """
    Political/operational supply risk [-1=supply disruption risk high, 0=neutral].
    Returns per-metal supply risk (positive = bullish for price).
    """
    return {
        "cobalt_supply_risk":  round(min(1.0, drc_instability * 1.5), 3),
        "nickel_supply_risk":  round(min(1.0, indonesia_policy_risk), 3),
        "lithium_supply_risk": round(min(1.0, chile_water_stress * 0.8), 3),
    }


# ─────────────────────────────────────────────────────────────
# Strategy
# ─────────────────────────────────────────────────────────────

@dataclass
class BatteryMetalsConfig:
    # EV demand thresholds
    ev_yoy_bullish_pct: float = 25.0       # >25% EV sales growth → bullish
    ev_penetration_tipping: float = 0.20   # >20% penetration → structural long

    # Technical z-score
    z_lookback: int = 252
    z_buy: float = -1.5
    z_sell: float = 1.5

    # Cathode mix
    lfp_share_bearish_cobalt: float = 0.45  # LFP >45% → reduce cobalt long

    # Symbols (LME/CME)
    ni_symbol:  str = NICKEL_SYMBOL
    co_symbol:  str = COBALT_SYMBOL
    li_symbol:  str = LITHIUM_SYMBOL
    mn_symbol:  str = MANGANESE_SYMBOL

    # Risk
    vol_target_ann: float = 0.18
    max_contracts: int = 5
    stop_loss_pct: float = 0.12


class BatteryMetalsEVDemand(CommodityStrategy):  # type: ignore
    """
    Battery Metals complex strategy for the EV supply chain.

    Combines:
    - EV adoption curve demand scoring (Ni/Co/Li/Mn differentiated)
    - Nickel Class I vs LME spread (battery-grade scarcity)
    - Cathode chemistry market share (NMC vs LFP cannibalization)
    - Satellite mining activity (DRC, Indonesia, Atacama)
    - AIS chemical tanker utilization (battery precursor trade flows)
    - Technical z-score mean reversion
    - Supply concentration political risk overlay
    """

    name     = "battery_metals_ev_demand"
    sector   = (CommoditySector.METALS_BATTERY  # type: ignore
                if hasattr(CommoditySector, 'METALS_BATTERY') else "metals_battery")
    commodity = "nickel"

    def __init__(self, cfg: Optional[BatteryMetalsConfig] = None):
        super().__init__()
        self.cfg = cfg or BatteryMetalsConfig()

    def generate_signals(self, prices: pd.DataFrame,
                         aux: Optional[Dict[str, Any]] = None) -> List[Any]:
        """
        prices: DataFrame with columns:
          [ni_price, co_price, li_price, mn_price (optional),
           ni_class1_price (optional — class I premium),
           ev_yoy_pct, ev_penetration, lfp_market_share (optional)]
        aux: optional dict from CommoditySignalHub with:
          satellite.{nightlights_score, ndvi_anomaly_zscore}
          ais.{laden_to_ballast_ratio}
          supply_risk.{drc_instability, indonesia_policy_risk, chile_water_stress}
        """
        signals = []
        aux = aux or {}

        if prices.empty or "ni_price" not in prices.columns:
            return signals

        row = prices.iloc[-1]
        ni    = float(row.get("ni_price",  18_000.0))
        co    = float(row.get("co_price",  28_000.0))
        li    = float(row.get("li_price",  12_000.0))
        ev_yoy = float(row.get("ev_yoy_pct", 20.0))
        ev_pen  = float(row.get("ev_penetration", 0.18))
        lfp     = float(row.get("lfp_market_share", 0.38))

        # ── Signal 1: EV demand score ──
        demand = ev_demand_score(ev_yoy, ev_pen, lfp)

        if demand["nickel"] > 0.5:
            signals.append(self._make_signal(
                direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                strength=round(demand["nickel"], 3),
                confidence=0.72,
                horizon_days=45,
                source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                contracts=[self.cfg.ni_symbol],
                rationale=(f"EV demand surge: {ev_yoy:.1f}%YoY growth, {ev_pen*100:.0f}% penetration. "
                           f"NMC cathode demand for battery-grade nickel rising. "
                           f"LFP share={lfp*100:.0f}% — {'NMC still dominant' if lfp < 0.45 else 'LFP headwind'}. LONG Ni."),
                ev_yoy_pct=ev_yoy, ev_penetration=ev_pen, lfp_share=lfp,
            ))

        if demand["cobalt"] > 0.4 and lfp < self.cfg.lfp_share_bearish_cobalt:
            signals.append(self._make_signal(
                direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                strength=round(demand["cobalt"], 3),
                confidence=0.65,
                horizon_days=30,
                source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                contracts=[self.cfg.co_symbol],
                rationale=(f"EV cobalt demand: NMC cathodes still dominant ({(1-lfp)*100:.0f}% share). "
                           f"DRC supply concentration + EV adoption → LONG Cobalt."),
                ev_yoy_pct=ev_yoy, lfp_share=lfp,
            ))
        elif lfp >= self.cfg.lfp_share_bearish_cobalt:
            signals.append(self._make_signal(
                direction=SignalDirection.SHORT if hasattr(SignalDirection, 'SHORT') else "short",  # type: ignore
                strength=round(min(1.0, (lfp - self.cfg.lfp_share_bearish_cobalt) / 0.15), 3),
                confidence=0.68,
                horizon_days=60,
                source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                contracts=[self.cfg.co_symbol],
                rationale=(f"LFP cathode dominance ({lfp*100:.0f}% market share > {self.cfg.lfp_share_bearish_cobalt*100:.0f}% threshold). "
                           f"Structural cobalt demand destruction from chemistry shift → SHORT Co."),
                lfp_share=lfp,
            ))

        if demand["lithium"] > 0.4:
            signals.append(self._make_signal(
                direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                strength=round(demand["lithium"], 3),
                confidence=0.70,
                horizon_days=60,
                source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                contracts=[self.cfg.li_symbol],
                rationale=(f"Lithium demand: ALL cathode chemistries need Li. "
                           f"EV YoY={ev_yoy:.0f}%, penetration={ev_pen*100:.0f}%. "
                           f"{'LFP growth additionally boosts Li demand.' if lfp > 0.40 else 'NMC demand driver.'} LONG Li."),
                ev_yoy_pct=ev_yoy, ev_penetration=ev_pen,
            ))

        # ── Signal 2: Nickel Class I spread (battery-grade scarcity) ──
        if "ni_class1_price" in prices.columns:
            ni1 = float(row.get("ni_class1_price", ni + NICKEL_CLASS1_SPREAD_PREMIUM))
            hist_spread = None
            if len(prices) >= 60:
                hist_spread_series = prices.get("ni_class1_price", prices.get("ni_price")) - prices["ni_price"]
                hist_spread = float(hist_spread_series.rolling(252, min_periods=60).mean().iloc[-1])
            ns = nickel_class_spread_signal(ni1, ni, hist_spread)
            if ns["direction"] == "bullish":
                signals.append(self._make_signal(
                    direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                    strength=min(1.0, ns["spread_z"] / 2.5),
                    confidence=0.73,
                    horizon_days=20,
                    source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                    contracts=[self.cfg.ni_symbol],
                    rationale=ns["interpretation"],
                    **{k: v for k, v in ns.items() if k != "interpretation"},
                ))

        # ── Signal 3: Technical z-score per metal ──
        metal_cols = {
            "ni_price": (self.cfg.ni_symbol, "Nickel"),
            "co_price": (self.cfg.co_symbol, "Cobalt"),
            "li_price": (self.cfg.li_symbol, "Lithium"),
        }
        if len(prices) >= 60:
            for col, (sym, name) in metal_cols.items():
                if col not in prices.columns:
                    continue
                mu  = prices[col].rolling(self.cfg.z_lookback, min_periods=60).mean().iloc[-1]
                std = prices[col].rolling(self.cfg.z_lookback, min_periods=60).std().iloc[-1]
                z   = (float(row.get(col, 0)) - mu) / max(std, 1.0)

                if z < self.cfg.z_buy:
                    signals.append(self._make_signal(
                        direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                        strength=min(1.0, abs(z) / 3.0), confidence=0.64,
                        horizon_days=14,
                        source=SignalSource.TECHNICAL if hasattr(SignalSource, 'TECHNICAL') else "technical",  # type: ignore
                        contracts=[sym],
                        rationale=f"{name} oversold (z={z:.2f}). EV structural floor → mean reversion LONG.",
                        z_score=z, metal=name,
                    ))
                elif z > self.cfg.z_sell:
                    signals.append(self._make_signal(
                        direction=SignalDirection.SHORT if hasattr(SignalDirection, 'SHORT') else "short",  # type: ignore
                        strength=min(1.0, z / 3.0), confidence=0.60,
                        horizon_days=10,
                        source=SignalSource.TECHNICAL if hasattr(SignalSource, 'TECHNICAL') else "technical",  # type: ignore
                        contracts=[sym],
                        rationale=f"{name} extended (z={z:.2f}). Short-term overbought → mean reversion SHORT.",
                        z_score=z, metal=name,
                    ))

        # ── Signal 4: Satellite mining activity overlay ──
        sat = aux.get("satellite", {})
        nightlights_z = float(sat.get("nightlights_score", 0.0) or 0.0)
        region = str(sat.get("region", ""))

        if nightlights_z < -1.5 and region in (DRC_COBALT_REGION, SULAWESI_NICKEL, ATACAMA_LITHIUM):
            metal_map = {DRC_COBALT_REGION: (self.cfg.co_symbol, "Cobalt"),
                         SULAWESI_NICKEL:   (self.cfg.ni_symbol, "Nickel"),
                         ATACAMA_LITHIUM:   (self.cfg.li_symbol, "Lithium")}
            sym, metal_name = metal_map.get(region, (self.cfg.ni_symbol, "Battery metal"))
            signals.append(self._make_signal(
                direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                strength=min(1.0, abs(nightlights_z) / 3.0),
                confidence=0.76,
                horizon_days=21,
                source=SignalSource.SATELLITE if hasattr(SignalSource, 'SATELLITE') else "satellite",  # type: ignore
                contracts=[sym],
                rationale=(f"Satellite nightlights anomaly (z={nightlights_z:.2f}) over {region}. "
                           f"Mine activity decline → supply disruption risk → LONG {metal_name}."),
                nightlights_z=nightlights_z, region=region,
            ))

        # ── Signal 5: AIS chemical tanker utilization ──
        ais = aux.get("ais", {})
        if ais:
            l2b = float(ais.get("laden_to_ballast_ratio", 1.0) or 1.0)
            # High l2b = tankers full → lots of battery chemicals in transit → bearish
            # Low l2b = tankers empty/repositioning → supply falling → bullish
            if l2b < 0.7:
                signals.append(self._make_signal(
                    direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                    strength=round(min(1.0, (0.7 - l2b) / 0.3), 3),
                    confidence=0.62,
                    horizon_days=14,
                    source=SignalSource.AIS_SHIPPING if hasattr(SignalSource, 'AIS_SHIPPING') else "ais_shipping",  # type: ignore
                    contracts=[self.cfg.ni_symbol, self.cfg.li_symbol],
                    rationale=(f"AIS chemical tanker laden/ballast={l2b:.2f} (low). "
                               f"Battery precursor shipments falling → supply tightening → LONG battery metals."),
                    laden_to_ballast=l2b,
                ))
            elif l2b > 1.5:
                signals.append(self._make_signal(
                    direction=SignalDirection.SHORT if hasattr(SignalDirection, 'SHORT') else "short",  # type: ignore
                    strength=round(min(1.0, (l2b - 1.5) / 0.5), 3),
                    confidence=0.58,
                    horizon_days=10,
                    source=SignalSource.AIS_SHIPPING if hasattr(SignalSource, 'AIS_SHIPPING') else "ais_shipping",  # type: ignore
                    contracts=[self.cfg.li_symbol],
                    rationale=f"AIS tanker glut (l/b={l2b:.2f}). Battery chemical oversupply in transit → bearish lithium.",
                    laden_to_ballast=l2b,
                ))

        # ── Signal 6: Supply concentration political risk ──
        supply_risk_data = aux.get("supply_risk", {})
        if supply_risk_data:
            srisk = supply_risk_score(
                drc_instability=float(supply_risk_data.get("drc_instability", 0)),
                indonesia_policy_risk=float(supply_risk_data.get("indonesia_policy_risk", 0)),
                chile_water_stress=float(supply_risk_data.get("chile_water_stress", 0)),
            )
            for risk_key, sym, metal_name in [
                ("cobalt_supply_risk",  self.cfg.co_symbol, "Cobalt"),
                ("nickel_supply_risk",  self.cfg.ni_symbol, "Nickel"),
                ("lithium_supply_risk", self.cfg.li_symbol, "Lithium"),
            ]:
                r = srisk.get(risk_key, 0.0)
                if r > 0.5:
                    signals.append(self._make_signal(
                        direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                        strength=round(r, 3),
                        confidence=0.70,
                        horizon_days=30,
                        source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                        contracts=[sym],
                        rationale=(f"{metal_name} supply risk elevated (score={r:.2f}). "
                                   f"Geopolitical/operational disruption premium → LONG."),
                        supply_risk=r,
                    ))

        return signals

    def _describe(self) -> str:
        return ("Battery metals EV demand strategy. Trades Ni/Co/Li/Mn complex based on "
                "EV adoption curve, cathode chemistry market share (NMC vs LFP), "
                "nickel class I battery-grade spread, satellite mining activity, "
                "AIS chemical tanker flows, and supply concentration political risk.")


if __name__ == "__main__":
    print("=== Battery Metals / EV Demand Strategy ===")
    demand = ev_demand_score(ev_yoy=35.0, ev_penetration=0.22, lfp_share=0.42)
    print(f"EV growth=35%YoY, penetration=22%, LFP share=42%")
    for metal, score in demand.items():
        if metal not in ("base_ev", "lfp_share"):
            print(f"  {metal:10}: score={score:+.3f}")
    ns = nickel_class_spread_signal(18_500, 17_800, 200.0)
    print(f"\nNi Class I spread: ${ns['class1_spread']:,.0f}/t | {ns['direction']} | z={ns['spread_z']:.2f}")
