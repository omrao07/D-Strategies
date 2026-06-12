# backend/commodities/curve_analytics.py
"""
Commodity Curve Analytics
--------------------------
Forward curve construction, roll yield decomposition, carry signals,
and contango/backwardation classification for commodity futures.

Key functions:
  - build_curve(contracts_df)         → ForwardCurve
  - roll_yield(curve, near, far)      → float (annualized %)
  - carry_signal(curve, threshold)    → CarrySignal
  - classify_structure(curve)         → CurveStructure
  - fit_nelson_siegel(curve)          → NelsonSiegelParams
  - butterfly_spread(m1, m2, m3)      → float (calendar butterfly)
  - crack_spread(crude, gasoline, heating_oil) → float
  - spark_spread(gas_price, power_price, efficiency) → float
  - dark_spread(coal_price, power_price, efficiency) → float
  - crush_spread(soy, meal, oil)      → float ($/bushel)
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

# ─────────────────────────────────────────────────────────────
# Data models
# ─────────────────────────────────────────────────────────────

@dataclass
class CurvePoint:
    contract: str           # e.g. "CL_M1", "CL_M3"
    maturity_days: float    # days to expiry
    price: float
    volume: float = 0.0
    open_interest: float = 0.0

@dataclass
class ForwardCurve:
    commodity: str
    date: str
    points: List[CurvePoint]           # sorted by maturity_days

    @property
    def prices(self) -> np.ndarray:
        return np.array([p.price for p in self.points])

    @property
    def maturities(self) -> np.ndarray:
        return np.array([p.maturity_days for p in self.points])

    @property
    def front(self) -> CurvePoint:
        return self.points[0]

    @property
    def back(self) -> CurvePoint:
        return self.points[-1]

    def at_maturity(self, days: float) -> Optional[float]:
        """Linearly interpolate price at given maturity."""
        mats = self.maturities
        prices = self.prices
        if len(mats) < 2:
            return prices[0] if prices.size else None
        return float(np.interp(days, mats, prices))

@dataclass
class CarrySignal:
    commodity: str
    roll_yield_ann_pct: float          # annualized roll yield %
    structure: str                     # "backwardation" | "contango" | "flat"
    direction: str                     # "long" | "short" | "neutral"
    strength: float                    # 0..1
    m1_price: float
    m2_price: float
    m1m6_spread: float
    m1m12_spread: float
    z_score: float                     # vs historical
    percentile: float                  # 0..100

@dataclass
class CurveStructure:
    is_backwardation: bool
    is_contango: bool
    slope_pct_per_month: float        # monthly slope % (neg = backwardation)
    curvature: float                  # butterfly curvature (M1-2*M2+M3)
    kink_month: Optional[int]         # where the slope changes sign


# ─────────────────────────────────────────────────────────────
# Core analytics
# ─────────────────────────────────────────────────────────────

def build_curve(df: pd.DataFrame, commodity: str = "commodity",
                date: Optional[str] = None) -> ForwardCurve:
    """
    Build ForwardCurve from a DataFrame with columns:
      [contract, maturity_days, price] + optional [volume, open_interest]
    """
    df = df.copy().sort_values("maturity_days").reset_index(drop=True)
    points = []
    for _, row in df.iterrows():
        points.append(CurvePoint(
            contract=str(row.get("contract", f"M{_+1}")),
            maturity_days=float(row["maturity_days"]),
            price=float(row["price"]),
            volume=float(row.get("volume", 0)),
            open_interest=float(row.get("open_interest", 0)),
        ))
    import datetime
    return ForwardCurve(
        commodity=commodity,
        date=date or datetime.datetime.utcnow().strftime("%Y-%m-%d"),
        points=points,
    )


def roll_yield(curve: ForwardCurve, near_days: float = 30, far_days: float = 60,
               holding_days: float = 30) -> float:
    """
    Annualized roll yield from rolling near contract to far contract.
    Positive = backwardation (near > far, rolling profitable).
    """
    near_px = curve.at_maturity(near_days)
    far_px  = curve.at_maturity(far_days)
    if near_px is None or far_px is None or near_px <= 0 or far_px <= 0:
        return 0.0
    raw_yield = (near_px - far_px) / near_px
    ann_factor = 365.0 / max(holding_days, 1)
    return float(raw_yield * ann_factor * 100)  # in %


def classify_structure(curve: ForwardCurve, lookback_df: Optional[pd.DataFrame] = None) -> CurveStructure:
    """
    Classify the curve structure (backwardation/contango) and compute curvature.
    lookback_df: historical m1-m6 spreads with column 'm1m6_spread' for z-score.
    """
    if len(curve.points) < 2:
        return CurveStructure(False, False, 0.0, 0.0, None)

    prices = curve.prices
    mats   = curve.maturities

    # Monthly slope (% per 30 days)
    slope = (prices[-1] - prices[0]) / prices[0] / (mats[-1] - mats[0]) * 30 * 100

    # Backwardation: near > far; Contango: far > near
    is_back = prices[0] > prices[-1]
    is_cont = prices[0] < prices[-1]

    # Curvature = M1 - 2*M2 + M3 (butterfly; negative = humped / super-backwardation)
    curvature = 0.0
    if len(prices) >= 3:
        curvature = float(prices[0] - 2*prices[1] + prices[2])

    # Find kink (where slope changes sign)
    kink = None
    for i in range(1, len(prices)-1):
        s1 = prices[i] - prices[i-1]
        s2 = prices[i+1] - prices[i]
        if s1 * s2 < 0:
            kink = i + 1
            break

    return CurveStructure(
        is_backwardation=is_back,
        is_contango=is_cont,
        slope_pct_per_month=round(slope, 4),
        curvature=round(curvature, 4),
        kink_month=kink,
    )


def carry_signal(curve: ForwardCurve, hist_spreads: Optional[pd.Series] = None,
                 roll_threshold_pct: float = 5.0) -> CarrySignal:
    """
    Generate a carry/roll-yield trading signal.

    hist_spreads: historical M1-M6 spreads for z-score / percentile.
    roll_threshold_pct: minimum annualized roll yield to generate signal.
    """
    m1_px  = curve.at_maturity(30)  or curve.front.price
    m2_px  = curve.at_maturity(60)  or m1_px
    m6_px  = curve.at_maturity(180) or m1_px
    m12_px = curve.at_maturity(365) or m1_px

    m1m6_spread  = m1_px - m6_px
    m1m12_spread = m1_px - m12_px
    ry = roll_yield(curve, near_days=30, far_days=60)

    # Z-score vs historical
    z = 0.0
    pct = 50.0
    if hist_spreads is not None and len(hist_spreads) > 30:
        mu  = float(hist_spreads.mean())
        std = float(hist_spreads.std())
        z   = (m1m6_spread - mu) / max(std, 1e-9)
        pct = float((hist_spreads < m1m6_spread).mean() * 100)

    # Structure
    if m1m6_spread > 1.0:
        structure = "backwardation"
    elif m1m6_spread < -1.0:
        structure = "contango"
    else:
        structure = "flat"

    # Signal
    strength = min(1.0, abs(ry) / max(roll_threshold_pct * 2, 1))
    if ry >= roll_threshold_pct:
        direction = "long"    # positive roll yield → long futures
    elif ry <= -roll_threshold_pct:
        direction = "short"   # negative roll yield → short or avoid
    else:
        direction = "neutral"

    return CarrySignal(
        commodity=curve.commodity,
        roll_yield_ann_pct=round(ry, 3),
        structure=structure,
        direction=direction,
        strength=round(strength, 4),
        m1_price=m1_px, m2_price=m2_px,
        m1m6_spread=round(m1m6_spread, 4),
        m1m12_spread=round(m1m12_spread, 4),
        z_score=round(z, 4),
        percentile=round(pct, 2),
    )


# ─────────────────────────────────────────────────────────────
# Spread analytics
# ─────────────────────────────────────────────────────────────

def butterfly_spread(m1: float, m2: float, m3: float) -> float:
    """Calendar butterfly: M1 - 2*M2 + M3. Measures curve curvature."""
    return float(m1 - 2*m2 + m3)


def crack_spread(crude_bbl: float, gasoline_gal: float,
                 heating_oil_gal: float, refinery_ratio: Tuple[float,float,float] = (3,2,1)) -> float:
    """
    3-2-1 crack spread: proxy for refinery margin.
    refinery_ratio = (crude barrels, gasoline barrels, heating oil barrels).
    Returns $/bbl.
    """
    rc, rg, rh = refinery_ratio
    # gasoline & HO are in $/gallon → convert to $/bbl (42 gal/bbl)
    return float((rg * gasoline_gal * 42 + rh * heating_oil_gal * 42 - rc * crude_bbl) / rc)


def spark_spread(gas_mmbtu: float, power_mwh: float, efficiency_btu_per_kwh: float = 7_000) -> float:
    """
    Spark spread: power generation margin (gas-fired plant).
    spark_spread = power_price_per_mwh - gas_price_per_mmbtu * heat_rate_mmbtu_per_mwh
    efficiency_btu_per_kwh → heat_rate_mmbtu_per_mwh = efficiency / 1000
    Returns $/MWh.
    """
    heat_rate_mmbtu_mwh = efficiency_btu_per_kwh / 1_000
    return float(power_mwh - gas_mmbtu * heat_rate_mmbtu_mwh)


def dark_spread(coal_tonne: float, power_mwh: float, efficiency_gj_per_mwh: float = 10.0,
                coal_gj_per_tonne: float = 24.0) -> float:
    """
    Dark spread: power generation margin (coal-fired plant).
    dark_spread = power_price - coal_price_per_GJ * heat_rate_GJ_per_MWh
    Returns $/MWh.
    """
    coal_per_gj = coal_tonne / coal_gj_per_tonne
    return float(power_mwh - coal_per_gj * efficiency_gj_per_mwh)


def crush_spread(soybeans_bushel: float, soybean_meal_ton: float,
                 soybean_oil_lb: float) -> float:
    """
    Gross processing margin (crush spread) for soybeans.
    1 bushel (60 lb) soybeans → ~11 lb oil + ~44 lb meal (+ ~5 lb hull)
    soybean_meal in $/short ton; soybean_oil in $/lb.
    Returns $/bushel.
    """
    meal_per_bushel = (44.0 / 2000.0) * soybean_meal_ton  # short tons per bushel × price
    oil_per_bushel  = 11.0 * soybean_oil_lb               # lbs per bushel × price
    return float(meal_per_bushel + oil_per_bushel - soybeans_bushel)


def frac_spread(nat_gas_mmbtu: float, ngl_prices: Dict[str, float],
                gpm_ratio: Optional[Dict[str, float]] = None) -> float:
    """
    Frac spread: NGL extraction margin (fractionation spread).
    gpm_ratio: gallons of each NGL per Mcf of gas feed.
    Returns $/MMBtu.
    """
    default_gpm = {"ethane": 1.5, "propane": 0.5, "butane": 0.3, "pentane": 0.15}
    gpm = gpm_ratio or default_gpm
    ngl_value = sum(gpm.get(ngl, 0) * price / 42  # $/gallon to $/bbl: /42 not needed here; $/gal×gal/Mcf
                    for ngl, price in ngl_prices.items())
    return float(ngl_value - nat_gas_mmbtu * 1.0)  # rough: 1 MMBtu ≈ 1 Mcf


# ─────────────────────────────────────────────────────────────
# Nelson-Siegel curve fitting
# ─────────────────────────────────────────────────────────────

@dataclass
class NelsonSiegelParams:
    beta0: float   # long-run level
    beta1: float   # short-term component
    beta2: float   # medium-term hump
    tau: float     # decay factor (months)
    rmse: float    # fit quality

def fit_nelson_siegel(curve: ForwardCurve, tau_init: float = 24.0) -> NelsonSiegelParams:
    """
    Fit Nelson-Siegel model to forward curve.
    F(t) = β0 + β1*(1-e^(-t/τ))/(t/τ) + β2*((1-e^(-t/τ))/(t/τ) - e^(-t/τ))
    t in months.
    """
    mats_months = curve.maturities / 30.0
    prices      = curve.prices

    if len(prices) < 3:
        return NelsonSiegelParams(prices[0] if prices.size else 0, 0, 0, tau_init, float("nan"))

    def ns_model(t: np.ndarray, b0: float, b1: float, b2: float, tau: float) -> np.ndarray:
        tau = max(tau, 0.01)
        x   = t / tau
        exp_x = np.exp(-x)
        term1 = np.where(x > 1e-6, (1 - exp_x) / x, 1.0)
        term2 = term1 - exp_x
        return b0 + b1 * term1 + b2 * term2

    try:
        from scipy.optimize import curve_fit
        popt, _ = curve_fit(ns_model, mats_months, prices,
                            p0=[prices[-1], prices[0]-prices[-1], 0.0, tau_init],
                            maxfev=5000, bounds=([0,-1000,-1000,1],[10000,1000,1000,120]))
        b0, b1, b2, tau = popt
        pred = ns_model(mats_months, *popt)
        rmse = float(np.sqrt(np.mean((prices - pred)**2)))
        return NelsonSiegelParams(beta0=float(b0), beta1=float(b1), beta2=float(b2),
                                  tau=float(tau), rmse=rmse)
    except Exception:
        return NelsonSiegelParams(beta0=float(prices[-1]), beta1=float(prices[0]-prices[-1]),
                                  beta2=0.0, tau=tau_init, rmse=float("nan"))


# ─────────────────────────────────────────────────────────────
# Historical curve signal from wide price data
# ─────────────────────────────────────────────────────────────

def curve_carry_history(futures_wide: pd.DataFrame,
                        m1_col: str = "M1", m2_col: str = "M2",
                        m6_col: str = "M6", m12_col: str = "M12",
                        lookback: int = 252) -> pd.DataFrame:
    """
    Compute daily roll yield + z-score from a wide futures DataFrame.
    futures_wide: columns [M1, M2, M6, M12] (prices by maturity).
    Returns DataFrame with [m1m2_spread, m1m6_spread, roll_yield_ann, z_score, signal].
    """
    df = futures_wide.copy()
    m1 = df[m1_col]
    m2 = df[m2_col] if m2_col in df.columns else m1
    m6 = df[m6_col] if m6_col in df.columns else m1
    m12= df[m12_col] if m12_col in df.columns else m1

    df["m1m2_spread"]  = m1 - m2
    df["m1m6_spread"]  = m1 - m6
    df["m1m12_spread"] = m1 - m12

    # Annualized roll yield M1→M2 (30-day roll, 30-day hold)
    df["roll_yield_ann"] = df["m1m2_spread"] / m1.replace(0, np.nan) * 12 * 100

    # Z-score vs lookback
    mu  = df["m1m6_spread"].rolling(lookback, min_periods=lookback//4).mean()
    std = df["m1m6_spread"].rolling(lookback, min_periods=lookback//4).std()
    df["z_score"] = (df["m1m6_spread"] - mu) / std.replace(0, np.nan)
    df["pct_rank"] = df["m1m6_spread"].rolling(lookback, min_periods=lookback//4).rank(pct=True) * 100

    # Signal
    def _sig(row):
        ry = row.get("roll_yield_ann", 0)
        z  = row.get("z_score", 0)
        if ry > 5 and z > 0.5:   return "long"
        if ry < -5 and z < -0.5: return "short"
        return "neutral"
    df["signal"] = df.apply(_sig, axis=1)

    return df[["m1m2_spread","m1m6_spread","m1m12_spread","roll_yield_ann","z_score","pct_rank","signal"]]
