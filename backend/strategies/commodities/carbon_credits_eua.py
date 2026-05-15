# backend/strategies/commodities/carbon_credits_eua.py
"""
EU Emissions Trading System (ETS) Carbon Credits — EUA Futures Strategy
========================================================================
EU Allowances (EUAs) are the primary liquid carbon market globally.
Each EUA = right to emit 1 tonne CO₂ equivalent.

Price drivers:
  1. Energy price spread (gas-coal spark/dark spread)  — power switching
  2. Economic activity (industrial production)          — demand for allowances
  3. Weather (temperature anomalies)                   — heating/cooling demand
  4. EU regulatory calendar (TNAC, MSR, REPowerEU)    — supply adjustment
  5. CTA/spec positioning                              — momentum
  6. Cross-market: EUA vs UK ETS, California CARB     — relative value

Key relationships:
  - Dark-spark spread > threshold → coal more economic → more coal burning
    → more CO₂ emissions → higher EUA demand → LONG EUA
  - Gas cheaper than coal → gas switching → fewer allowances needed → bearish

  - MSR (Market Stability Reserve): absorbs surplus when total oi > 833M
    → structural supply constraint → long-term bullish

  - Phase 4 (2021-2030): Free allocation declining 2.2%/yr → structural scarcity

Strategy modes:
  A. Dark-spark spread arbitrage: EUA moves with coal-gas switching
  B. Macro/activity: EUA as industrial cycle proxy
  C. Regulatory event trading: TNAC announcements, auctions
  D. Cross-market: EUA vs RGGI (US), CCA (California)
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
    from backend.commodities.curve_analytics import dark_spread, spark_spread
except Exception:
    CommodityStrategy = object  # type: ignore
    def dark_spread(coal, pwr, eff=10.0, gcal=24.0): return pwr - coal/gcal*eff  # type: ignore
    def spark_spread(gas, pwr, eff=7000): return pwr - gas*eff/1000  # type: ignore


# ─────────────────────────────────────────────────────────────
# EUA-specific constants
# ─────────────────────────────────────────────────────────────

# EU ETS parameters
MSR_THRESHOLD_LOW  = 400_000_000   # tonnes: MSR injection threshold
MSR_THRESHOLD_HIGH = 833_000_000   # tonnes: MSR surplus threshold
FREE_ALLOCATION_DECLINE = 0.022    # % per year decline in free allocation
PHASE4_END = 2030

# Carbon price ranges (historical context €/tonne)
PRICE_FLOOR_ESTIMATE    = 20.0
PRICE_SUPPORT_RANGE     = (40.0, 60.0)
PRICE_BULL_TARGET       = 100.0

# Energy efficiency factors
COAL_CO2_PER_MWH = 0.82    # tonnes CO₂/MWh coal-fired
GAS_CO2_PER_MWH  = 0.35    # tonnes CO₂/MWh gas-fired
COAL_GJ_PER_TONNE = 24.0
GAS_MMBTU_PER_MWH = 7.0


# ─────────────────────────────────────────────────────────────
# Analytics
# ─────────────────────────────────────────────────────────────

def implied_carbon_price_from_switching(gas_mmbtu: float, coal_tonne: float,
                                        power_mwh: float) -> float:
    """
    The carbon price at which gas becomes economically equivalent to coal for power gen.
    At this price: dark_spread + carbon_coal_cost = spark_spread + carbon_gas_cost
    EUA_implied = (dark_spread - spark_spread) / (COAL_CO2 - GAS_CO2) × per-MWh scaling
    Returns implied EUA price (€/tonne).
    """
    ds = dark_spread(coal_tonne, power_mwh)
    ss = spark_spread(gas_mmbtu, power_mwh)
    delta_co2 = COAL_CO2_PER_MWH - GAS_CO2_PER_MWH   # 0.47 tCO₂/MWh
    if delta_co2 < 1e-6:
        return 50.0
    # When EUA > implied, gas is economical → less carbon demand → bearish
    return float((ds - ss) / delta_co2)


def fuel_switching_signal(gas_mmbtu: float, coal_tonne: float,
                          power_mwh: float, eua_price: float) -> Dict[str, Any]:
    """
    Compute fuel-switching regime and EUA directional signal.
    Returns dict with regime and direction.
    """
    implied = implied_carbon_price_from_switching(gas_mmbtu, coal_tonne, power_mwh)
    gap = eua_price - implied

    if gap > 5:
        regime = "gas_dispatch"
        direction = "bearish"   # EUA above switching price → gas already preferred → less demand
    elif gap < -5:
        regime = "coal_dispatch"
        direction = "bullish"   # EUA below switching price → coal economic → more EUA demand
    else:
        regime = "marginal"
        direction = "neutral"

    return {
        "implied_switching_price": round(implied, 2),
        "eua_price":  eua_price,
        "gap_eur":    round(gap, 2),
        "regime":     regime,
        "direction":  direction,
        "ds": round(dark_spread(coal_tonne, power_mwh), 2),
        "ss": round(spark_spread(gas_mmbtu, power_mwh), 2),
    }


def regulatory_calendar_signal(month: int, day: int) -> Dict[str, Any]:
    """
    EUA seasonal/regulatory patterns.
    Returns signal metadata around key dates.
    """
    # EUA auction calendar: daily Mon-Fri except Q4 pre-holiday
    # Free allocation surrenders: April 30 deadline → buy pressure March-April
    # TNAC announcement: typically October → supply signal
    events = {}
    if month == 3:
        events["surrender_season"] = True
        events["direction"] = "bullish"
        events["rationale"] = "March-April: companies buying EUAs ahead of April 30 surrender deadline"
    elif month == 4 and day <= 30:
        events["surrender_deadline"] = True
        events["direction"] = "bullish"
        events["rationale"] = "April surrender deadline → peak buying pressure"
    elif month == 10:
        events["tnac_window"] = True
        events["direction"] = "volatile"
        events["rationale"] = "TNAC announcement in October: MSR supply adjustment signal"
    elif month in (12, 1):
        events["year_end"] = True
        events["direction"] = "bearish"
        events["rationale"] = "Year-end position squaring → selling pressure"
    else:
        events["direction"] = "neutral"
    return events


# ─────────────────────────────────────────────────────────────
# Strategy
# ─────────────────────────────────────────────────────────────

@dataclass
class EUAConfig:
    # Switching thresholds
    switching_gap_threshold: float = 5.0      # €/tonne gap to generate signal
    price_support_lower:     float = 40.0     # structural price floor
    price_target_upper:      float = 100.0    # bull scenario target

    # Technical
    z_lookback_days: int = 252
    momentum_days:   int = 20
    z_buy_threshold: float = -1.5             # oversold
    z_sell_threshold: float = 1.5             # overbought

    # Symbols
    eua_symbol: str = "EUAN5"    # ICE EUA futures (Dec vintage)
    uk_ets_symbol: str = "UKA"   # UK ETS (post-Brexit)

    # Risk
    vol_target_ann: float = 0.20
    max_contracts:  int = 10
    stop_loss_pct:  float = 0.10    # wider stop for policy risk


class CarbonCreditsEUA(CommodityStrategy):  # type: ignore
    """
    EU ETS Carbon Credits (EUA) strategy.

    Combines:
    - Fuel-switching price signal (coal vs gas economics)
    - Regulatory calendar (surrender season, TNAC)
    - Technical momentum / mean reversion
    - Cross-market arbitrage (EUA vs UK ETS, RGGI)
    - MSR (Market Stability Reserve) structural supply constraint
    """

    name     = "carbon_credits_eua"
    sector   = CommoditySector.CARBON if hasattr(CommoditySector, 'CARBON') else "carbon"  # type: ignore
    commodity = "carbon_eua"

    def __init__(self, cfg: Optional[EUAConfig] = None):
        super().__init__()
        self.cfg = cfg or EUAConfig()

    def generate_signals(self, prices: pd.DataFrame,
                         aux: Optional[Dict[str, Any]] = None) -> List[Any]:
        """
        prices: DataFrame with [eua_price, gas_price_mmbtu, coal_price_tonne,
                                 power_price_mwh, ip_index (industrial production)].
                Optional: [uk_ets_price, rggi_price]
        """
        signals = []
        aux = aux or {}
        if prices.empty or "eua_price" not in prices.columns:
            return signals

        row = prices.iloc[-1]
        eua   = float(row.get("eua_price", 65.0))
        gas   = float(row.get("gas_price_mmbtu", 3.0))
        coal  = float(row.get("coal_price_tonne", 80.0))
        power = float(row.get("power_price_mwh", 65.0))
        ip    = float(row.get("ip_index", 100.0))

        # ── Signal 1: Fuel-switching ──
        sw = fuel_switching_signal(gas, coal, power, eua)
        if sw["direction"] == "bullish":
            strength = min(1.0, abs(sw["gap_eur"]) / 15.0)
            signals.append(self._make_signal(
                direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                strength=strength, confidence=0.72,
                horizon_days=10,
                source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                contracts=[self.cfg.eua_symbol],
                rationale=(f"Coal dispatch regime: EUA={eua:.0f}€/t below implied switching "
                           f"price={sw['implied_switching_price']:.0f}€/t. "
                           f"Coal burning → EUA demand → LONG."),
                **{k: v for k, v in sw.items()},
            ))
        elif sw["direction"] == "bearish":
            strength = min(1.0, abs(sw["gap_eur"]) / 15.0)
            signals.append(self._make_signal(
                direction=SignalDirection.SHORT if hasattr(SignalDirection, 'SHORT') else "short",  # type: ignore
                strength=strength * 0.8, confidence=0.65,
                horizon_days=7,
                source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                contracts=[self.cfg.eua_symbol],
                rationale=(f"Gas dispatch: EUA above switching price → less carbon demand. "
                           f"Gap={sw['gap_eur']:+.1f}€/t → SHORT."),
                **{k: v for k, v in sw.items()},
            ))

        # ── Signal 2: Technical z-score ──
        eua_z = 0.0
        if "eua_price" in prices.columns and len(prices) >= 60:
            mu  = prices["eua_price"].rolling(self.cfg.z_lookback_days, min_periods=60).mean().iloc[-1]
            std = prices["eua_price"].rolling(self.cfg.z_lookback_days, min_periods=60).std().iloc[-1]
            eua_z = (eua - mu) / max(std, 0.01)

        if eua_z < self.cfg.z_buy_threshold:
            signals.append(self._make_signal(
                direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                strength=min(1.0, abs(eua_z) / 3.0), confidence=0.68,
                horizon_days=14,
                source=SignalSource.TECHNICAL if hasattr(SignalSource, 'TECHNICAL') else "technical",  # type: ignore
                contracts=[self.cfg.eua_symbol],
                rationale=f"EUA oversold (z={eua_z:.2f}). Policy floor + structural scarcity → mean reversion LONG.",
                eua_z=eua_z, eua_price=eua,
            ))
        elif eua_z > self.cfg.z_sell_threshold:
            signals.append(self._make_signal(
                direction=SignalDirection.SHORT if hasattr(SignalDirection, 'SHORT') else "short",  # type: ignore
                strength=min(1.0, eua_z / 3.0), confidence=0.62,
                horizon_days=10,
                source=SignalSource.TECHNICAL if hasattr(SignalSource, 'TECHNICAL') else "technical",  # type: ignore
                contracts=[self.cfg.eua_symbol],
                rationale=f"EUA extended (z={eua_z:.2f}). Overbought → SHORT mean reversion.",
                eua_z=eua_z, eua_price=eua,
            ))

        # ── Signal 3: Regulatory calendar ──
        import datetime
        t = datetime.date.today()
        cal = regulatory_calendar_signal(t.month, t.day)
        if cal.get("direction") == "bullish":
            signals.append(self._make_signal(
                direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                strength=0.6, confidence=0.70,
                horizon_days=30,
                source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                contracts=[self.cfg.eua_symbol],
                rationale=cal.get("rationale", "Regulatory calendar bullish window."),
                calendar_event=str(list(cal.keys())[0] if cal else ""),
            ))

        # ── Signal 4: Industrial production proxy ──
        if len(prices) >= 60 and "ip_index" in prices.columns:
            ip_chg = prices["ip_index"].pct_change(21).iloc[-1]  # 1-month change
            if ip_chg > 0.005:   # IP accelerating → more industrial output → more EUA demand
                signals.append(self._make_signal(
                    direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                    strength=min(1.0, ip_chg * 30), confidence=0.62,
                    horizon_days=20,
                    source=SignalSource.MACRO if hasattr(SignalSource, 'MACRO') else "macro",  # type: ignore
                    contracts=[self.cfg.eua_symbol],
                    rationale=f"IP accelerating ({ip_chg*100:.2f}%/month) → more EUA demand → LONG.",
                    ip_change_1m=ip_chg,
                ))

        # ── Signal 5: Cross-market EUA vs UK ETS ──
        if "uk_ets_price" in prices.columns:
            uk  = float(row.get("uk_ets_price", 45.0))
            spread = eua - uk
            if len(prices) >= 60 and "uk_ets_price" in prices.columns:
                hist_spread = prices["eua_price"] - prices["uk_ets_price"]
                hs_mu  = hist_spread.rolling(252, min_periods=60).mean().iloc[-1]
                hs_std = hist_spread.rolling(252, min_periods=60).std().iloc[-1]
                spread_z = (spread - hs_mu) / max(hs_std, 0.01)
                if spread_z > 2.0:
                    signals.append(self._make_signal(
                        direction=SignalDirection.SPREAD_SHORT if hasattr(SignalDirection, 'SPREAD_SHORT') else "spread_short",  # type: ignore
                        strength=min(1.0, spread_z / 4.0), confidence=0.60,
                        horizon_days=15,
                        source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                        contracts=[self.cfg.eua_symbol, self.cfg.uk_ets_symbol],
                        rationale=f"EUA/UKA spread stretched (z={spread_z:.2f}). Short EUA vs UK ETS (mean reversion).",
                        spread=spread, spread_z=spread_z,
                    ))

        return signals

    def _describe(self) -> str:
        return ("EU ETS Carbon Credits (EUA) strategy. Trades fuel-switching dynamics "
                "(coal-gas dispatch), regulatory calendar seasonality (surrender season, TNAC), "
                "technical z-score mean reversion, industrial production proxy, and "
                "cross-market EUA/UKA relative value.")


if __name__ == "__main__":
    print("=== EU ETS Carbon Credits Strategy ===")
    gas, coal, power, eua = 3.0, 80.0, 65.0, 65.0
    sw = fuel_switching_signal(gas, coal, power, eua)
    print(f"Gas=${gas}/MMBtu Coal=${coal}/t Power=${power}/MWh EUA={eua}€/t")
    print(f"Dark spread={sw['ds']:.2f} Spark spread={sw['ss']:.2f}")
    print(f"Implied switching price={sw['implied_switching_price']:.1f}€/t")
    print(f"Regime: {sw['regime']} → {sw['direction']}")
