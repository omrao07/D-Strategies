# backend/strategies/commodities/lng_henry_hub_ttf_arb.py
"""
LNG Global Arbitrage — Henry Hub (US) vs TTF (Europe) vs JKM (Asia)
=====================================================================
LNG arbitrage exploits price differentials between US Henry Hub, European TTF,
and Asian JKM (Japan-Korea Marker). When the spread > LNG shipping cost (~$2-3/MMBtu),
arbitrage is profitable. Strategy also captures seasonal / geopolitical regime shifts.

Physics of LNG Arbitrage:
  LNG shipping cost from US Gulf Coast:
    → Europe: ~$1.5–2.5/MMBtu (freight + liquefaction + regasification)
    → Asia:   ~$2.5–3.5/MMBtu

  Profitable long US / short Europe when:
    TTF_spot - HH_spot > total_logistics_cost_europe

  Profitable long US / short Asia when:
    JKM_spot - HH_spot > total_logistics_cost_asia

Signals:
  - LNG arbitrage spread (TTF-HH, JKM-HH)
  - Rolling z-score of spread
  - Shipping capacity utilization (from AIS tanker counts)
  - European gas storage level (seasonal factor)
  - Seasonal demand curve (winter heating premium)

Strategy:
  Long US natgas futures (Henry Hub NGZ5) + Short TTF/JKM forwards when spread is wide.
  Reverse when spread collapses (European supply glut).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

try:
    from backend.commodities.base import (
        CommoditySector,
        CommoditySignal,
        CommodityStrategy,
        ContractSpec,
        SignalDirection,
        SignalSource,
    )
except Exception:
    CommodityStrategy = object  # type: ignore
    CommoditySignal = dict  # type: ignore

# ─────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────

@dataclass
class LNGArbConfig:
    # Logistics costs ($/MMBtu)
    shipping_cost_europe: float = 2.0      # liquefaction + freight + regasification
    shipping_cost_asia:   float = 3.0
    fuel_cost:            float = 0.3      # fuel consumed in transit
    hedging_cost:         float = 0.2      # FX + financing

    # Signal thresholds
    arb_spread_threshold: float = 0.5     # min profitable spread above cost ($/MMBtu)
    z_threshold:          float = 1.5     # z-score for signal strength
    storage_bearish_pct:  float = 85.0    # EU storage % full → bearish TTF
    storage_bullish_pct:  float = 55.0    # EU storage % below → bullish TTF

    # Contract symbols
    hh_symbol:  str = "NG"               # Henry Hub front month
    ttf_symbol: str = "TTF"              # Dutch TTF (ICE)
    jkm_symbol: str = "JKM"             # Japan-Korea Marker

    # Lookback
    z_lookback_days: int = 252
    seasonal_window: int = 30            # days for seasonal smoothing

    # Sizing
    max_size_contracts: int = 10
    vol_target_ann: float = 0.12

    @property
    def total_cost_europe(self) -> float:
        return self.shipping_cost_europe + self.fuel_cost + self.hedging_cost

    @property
    def total_cost_asia(self) -> float:
        return self.shipping_cost_asia + self.fuel_cost + self.hedging_cost


# ─────────────────────────────────────────────────────────────
# Pure analytics (no strategy dependency)
# ─────────────────────────────────────────────────────────────

def compute_arb_spread(hh: float, ttf: float, jkm: float,
                       cfg: LNGArbConfig) -> Dict[str, float]:
    """
    Compute LNG arbitrage spreads and net profitability.
    Returns dict with gross spread, net spread, direction.
    """
    europe_gross = ttf - hh
    europe_net   = europe_gross - cfg.total_cost_europe
    asia_gross   = jkm - hh
    asia_net     = asia_gross - cfg.total_cost_asia

    return {
        "europe_gross_spread":   round(europe_gross, 4),
        "europe_net_spread":     round(europe_net, 4),
        "asia_gross_spread":     round(asia_gross, 4),
        "asia_net_spread":       round(asia_net, 4),
        "europe_arb_open":       europe_net > cfg.arb_spread_threshold,
        "asia_arb_open":         asia_net > cfg.arb_spread_threshold,
        "hh_price":              hh,
        "ttf_price":             ttf,
        "jkm_price":             jkm,
    }


def seasonal_demand_factor(month: int, hemisphere: str = "north") -> float:
    """
    Monthly seasonal demand index for LNG.
    Returns multiplier (>1 = peak demand, <1 = trough).
    """
    # Northern hemisphere: winter peak (Dec-Feb), summer shoulder (May-Aug)
    north = {1:1.4, 2:1.3, 3:1.1, 4:0.9, 5:0.8, 6:0.85, 7:0.9, 8:0.85,
             9:0.9, 10:1.0, 11:1.2, 12:1.4}
    south = {1:0.8, 2:0.85, 3:0.9, 4:1.0, 5:1.1, 6:1.3, 7:1.4, 8:1.3,
             9:1.2, 10:1.0, 11:0.9, 12:0.8}
    m = north if hemisphere == "north" else south
    return m.get(month % 12 or 12, 1.0)


def rolling_z_spread(df: pd.DataFrame, spread_col: str,
                     lookback: int = 252) -> pd.Series:
    mu  = df[spread_col].rolling(lookback, min_periods=lookback//4).mean()
    std = df[spread_col].rolling(lookback, min_periods=lookback//4).std()
    return (df[spread_col] - mu) / std.replace(0, np.nan)


# ─────────────────────────────────────────────────────────────
# Strategy class
# ─────────────────────────────────────────────────────────────

class LNGHenryHubTTFArb(CommodityStrategy):  # type: ignore
    """
    LNG Global Arbitrage Strategy.

    Generates signals based on:
    1. TTF-HH and JKM-HH spread vs logistics cost
    2. Z-score of spread (extreme = mean reversion bet)
    3. European gas storage level (seasonal supply/demand)
    4. LNG tanker fleet utilization (AIS signal)
    5. Seasonal demand factor
    """

    name     = "lng_henry_hub_ttf_arb"
    sector   = CommoditySector.ENERGY if hasattr(CommoditySector, 'ENERGY') else "energy"  # type: ignore
    commodity = "natural_gas"

    def __init__(self, cfg: Optional[LNGArbConfig] = None):
        super().__init__()
        self.cfg = cfg or LNGArbConfig()
        self.contract_spec = ContractSpec(  # type: ignore
            symbol="NG", exchange="NYMEX", lot_size=10_000,   # 10,000 MMBtu
            tick_size=0.001, currency="USD",
            delivery_months=["F","G","H","J","K","M","N","Q","U","V","X","Z"],
        ) if hasattr(ContractSpec, '__init__') else None

    def generate_signals(self, prices: pd.DataFrame,
                         aux: Optional[Dict[str, Any]] = None) -> List[Any]:
        """
        prices: DataFrame with columns [hh_price, ttf_price, jkm_price].
                May also include [eu_storage_pct, ais_tanker_count].
        aux:    Optional dict with signal_hub outputs.
        """
        signals = []
        aux = aux or {}

        if prices.empty or "hh_price" not in prices.columns:
            return signals

        row = prices.iloc[-1]
        hh  = float(row.get("hh_price", 3.0))
        ttf = float(row.get("ttf_price", 8.0))
        jkm = float(row.get("jkm_price", 10.0))

        spreads = compute_arb_spread(hh, ttf, jkm, self.cfg)

        # Rolling z-scores
        z_eu = z_as = 0.0
        if "europe_net_spread" in prices.columns and len(prices) >= 60:
            zs = rolling_z_spread(prices, "europe_net_spread", self.cfg.z_lookback_days)
            z_eu = float(zs.iloc[-1]) if not math.isnan(zs.iloc[-1]) else 0.0
        if "asia_net_spread" in prices.columns and len(prices) >= 60:
            zs = rolling_z_spread(prices, "asia_net_spread", self.cfg.z_lookback_days)
            z_as = float(zs.iloc[-1]) if not math.isnan(zs.iloc[-1]) else 0.0

        # Seasonal factor
        import datetime
        month = datetime.date.today().month
        seasonal = seasonal_demand_factor(month)

        # EU storage adjustment
        eu_storage = float(row.get("eu_storage_pct", 70.0))
        storage_bearish = eu_storage > self.cfg.storage_bearish_pct

        # ── Europe arbitrage signal ──
        if spreads["europe_arb_open"] and not storage_bearish:
            strength = min(1.0, spreads["europe_net_spread"] / 2.0)
            strength *= min(1.0, abs(z_eu) / self.cfg.z_threshold) if abs(z_eu) > 0.5 else 1.0
            strength *= seasonal
            conf = 0.7 * (1 + 0.2 * (1 if not storage_bearish else -1))
            signals.append(self._make_signal(
                direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                strength=min(1.0, strength),
                confidence=min(0.85, conf),
                horizon_days=20,
                source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                contracts=[self.cfg.hh_symbol, self.cfg.ttf_symbol],
                rationale=(f"EU arb open: TTF-HH={spreads['europe_gross_spread']:.2f} > "
                           f"cost={self.cfg.total_cost_europe:.2f} → net={spreads['europe_net_spread']:.2f}/MMBtu. "
                           f"EU storage={eu_storage:.0f}% | Seasonal×={seasonal:.2f}"),
                europe_net_spread=spreads["europe_net_spread"],
                z_eu=z_eu, eu_storage=eu_storage,
            ))
        elif storage_bearish and z_eu > self.cfg.z_threshold:
            # TTF spread too wide + storage high → short TTF (spread will compress)
            signals.append(self._make_signal(
                direction=SignalDirection.SHORT if hasattr(SignalDirection, 'SHORT') else "short",  # type: ignore
                strength=min(1.0, z_eu / 3.0),
                confidence=0.65,
                horizon_days=10,
                source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                contracts=[self.cfg.ttf_symbol],
                rationale=f"TTF spread stretched (z={z_eu:.2f}) + EU storage {eu_storage:.0f}% full → mean reversion short TTF.",
                z_eu=z_eu, eu_storage=eu_storage,
            ))

        # ── Asia arbitrage signal ──
        if spreads["asia_arb_open"]:
            strength = min(1.0, spreads["asia_net_spread"] / 2.5) * seasonal
            conf = 0.60
            if abs(z_as) > 0.5:
                conf = min(0.80, conf + 0.1 * min(abs(z_as), 2.0))
            signals.append(self._make_signal(
                direction=SignalDirection.LONG if hasattr(SignalDirection, 'LONG') else "long",  # type: ignore
                strength=min(1.0, strength),
                confidence=conf,
                horizon_days=30,
                source=SignalSource.FUNDAMENTAL if hasattr(SignalSource, 'FUNDAMENTAL') else "fundamental",  # type: ignore
                contracts=[self.cfg.hh_symbol, self.cfg.jkm_symbol],
                rationale=(f"Asia arb: JKM-HH={spreads['asia_gross_spread']:.2f} > "
                           f"cost={self.cfg.total_cost_asia:.2f} → net={spreads['asia_net_spread']:.2f}/MMBtu."),
                asia_net_spread=spreads["asia_net_spread"], z_as=z_as,
            ))

        return signals

    def run_backtest(self, prices: pd.DataFrame) -> pd.DataFrame:
        """
        Vectorized backtest on historical data.
        prices: [date, hh_price, ttf_price, jkm_price, eu_storage_pct]
        Returns: [date, eu_spread, asia_spread, position_eu, position_asia, pnl_daily]
        """
        df = prices.copy().sort_index()
        df["eu_net_spread"]   = df["ttf_price"] - df["hh_price"] - self.cfg.total_cost_europe
        df["asia_net_spread"] = df["jkm_price"] - df["hh_price"] - self.cfg.total_cost_asia

        df["z_eu"]   = rolling_z_spread(df, "eu_net_spread",   self.cfg.z_lookback_days)
        df["z_asia"] = rolling_z_spread(df, "asia_net_spread", self.cfg.z_lookback_days)

        # Position: +1 = long HH short TTF (arb), -1 = reverse
        df["pos_eu"]   = np.where(df["eu_net_spread"]   > self.cfg.arb_spread_threshold, 1.0,
                         np.where(df["eu_net_spread"]   < -self.cfg.arb_spread_threshold, -1.0, 0.0))
        df["pos_asia"] = np.where(df["asia_net_spread"] > self.cfg.arb_spread_threshold, 1.0,
                         np.where(df["asia_net_spread"] < -self.cfg.arb_spread_threshold, -1.0, 0.0))

        hh_ret  = df["hh_price"].pct_change()
        ttf_ret = df["ttf_price"].pct_change()
        jkm_ret = df["jkm_price"].pct_change()

        df["pnl_eu"]   = df["pos_eu"].shift(1)   * (hh_ret - ttf_ret)  # long HH, short TTF
        df["pnl_asia"] = df["pos_asia"].shift(1) * (hh_ret - jkm_ret)
        df["pnl_daily"] = 0.5 * df["pnl_eu"] + 0.5 * df["pnl_asia"]
        df["cumulative_pnl"] = (1 + df["pnl_daily"]).cumprod()

        sharpe = (df["pnl_daily"].mean() / df["pnl_daily"].std() * math.sqrt(252)
                  if df["pnl_daily"].std() > 0 else 0)
        df.attrs["sharpe"] = round(sharpe, 3)
        df.attrs["annual_return"] = round(df["pnl_daily"].mean() * 252 * 100, 2)
        return df

    def _describe(self) -> str:
        return ("LNG Global Arbitrage: long US Henry Hub / short EU TTF or Asian JKM "
                "when logistics-adjusted spread is profitable. Incorporates European "
                "storage levels, seasonal demand, and AIS tanker fleet utilization.")


# ─────────────────────────────────────────────────────────────
# CLI entry point
# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    import json
    ap = argparse.ArgumentParser(description="LNG Henry Hub–TTF Arbitrage")
    ap.add_argument("--hh",  type=float, default=2.8,  help="Henry Hub spot $/MMBtu")
    ap.add_argument("--ttf", type=float, default=9.5,  help="Dutch TTF spot $/MMBtu")
    ap.add_argument("--jkm", type=float, default=12.0, help="JKM spot $/MMBtu")
    ap.add_argument("--eu-storage", type=float, default=72.0, help="EU storage % full")
    args = ap.parse_args()

    cfg = LNGArbConfig()
    spreads = compute_arb_spread(args.hh, args.ttf, args.jkm, cfg)
    print(json.dumps(spreads, indent=2))

    strategy = LNGHenryHubTTFArb(cfg)
    prices = pd.DataFrame([{
        "hh_price": args.hh, "ttf_price": args.ttf, "jkm_price": args.jkm,
        "eu_storage_pct": args.eu_storage,
    }])
    sigs = strategy.generate_signals(prices)
    print(f"\nGenerated {len(sigs)} signal(s):")
    for s in sigs:
        if hasattr(s, 'rationale'):
            print(f"  [{s.direction}] {s.rationale}")
