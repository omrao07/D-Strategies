# backend/commodities/cot_positioning.py
"""
CFTC Commitment of Traders (COT) Positioning Engine
----------------------------------------------------
Processes CFTC COT reports to extract managed money (hedge fund) net positions,
positioning extremes, crowding signals, and momentum vs contrarian signals.

Data sources:
  - CFTC legacy COT: https://www.cftc.gov/dea/newcot/deacot.zip
  - CFTC disaggregated COT (DCOT): separate managed_money, producer, swap_dealer
  - Roper / Quandl / CFTC CSV format supported

Key signals:
  - managed_money_net: hedge fund net long contracts
  - commercial_net:    commercial hedger net (usually opposite of spec)
  - net_pct_oi:        net position as % of open interest (standardized)
  - positioning_z:     z-score vs 1-year / 3-year history
  - positioning_pct:   percentile rank (0=extreme short, 100=extreme long)
  - crowding_signal:   LONG when speculators too short → contrarian long
  - momentum_signal:   LONG when managed money increasing longs (momentum)
  - composite_signal:  blend of crowding + momentum
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd


# ─────────────────────────────────────────────────────────────
# Data models
# ─────────────────────────────────────────────────────────────

@dataclass
class COTRecord:
    """Single week's COT data for one commodity."""
    date: str
    commodity: str
    contract_name: str

    # Managed money (speculators / hedge funds)
    mm_long: float = 0.0
    mm_short: float = 0.0
    mm_spreading: float = 0.0

    # Commercial (producers / end-users — natural hedgers)
    comm_long: float = 0.0
    comm_short: float = 0.0

    # Non-commercial (legacy format)
    noncomm_long: float = 0.0
    noncomm_short: float = 0.0
    noncomm_spreading: float = 0.0

    # Total open interest
    open_interest: float = 0.0

    @property
    def mm_net(self) -> float:
        return self.mm_long - self.mm_short

    @property
    def comm_net(self) -> float:
        return self.comm_long - self.comm_short

    @property
    def noncomm_net(self) -> float:
        return self.noncomm_long - self.noncomm_short


@dataclass
class COTSignal:
    """Processed COT-derived trading signal."""
    commodity: str
    date: str

    mm_net: float
    mm_net_pct_oi: float            # net as % of open interest

    z_score_1yr: float              # z-score vs 52-week history
    z_score_3yr: float              # z-score vs 156-week history
    percentile_1yr: float           # 0..100
    percentile_3yr: float

    # Crowding signal (contrarian): extreme spec longs → cautious; extreme short → long
    crowding_direction: str         # "long" | "short" | "neutral"
    crowding_strength: float        # 0..1

    # Momentum signal: direction of change in spec positioning
    momentum_direction: str
    momentum_strength: float

    # Composite
    composite_direction: str
    composite_strength: float

    # Commentary
    interpretation: str


# ─────────────────────────────────────────────────────────────
# Core engine
# ─────────────────────────────────────────────────────────────

class COTEngine:
    """
    Process a time series of COT records and generate positioning signals.

    Usage:
        engine = COTEngine(crowding_pct_threshold=80, momentum_chg_threshold=0.05)
        signal = engine.process(records_list, commodity="crude_oil")
    """

    def __init__(self,
                 crowding_pct_threshold: float = 80.0,   # extreme positioning threshold
                 momentum_weeks: int = 4,                 # lookback for momentum signal
                 z_extreme: float = 2.0,                  # z-score for "extreme" classification
                 crowding_weight: float = 0.5,
                 momentum_weight: float = 0.5):
        self.crowding_pct_thr = crowding_pct_threshold
        self.momentum_weeks = momentum_weeks
        self.z_extreme = z_extreme
        self.cw = crowding_weight
        self.mw = momentum_weight

    def process(self, records: List[COTRecord], commodity: str = "commodity") -> Optional[COTSignal]:
        """Process a sorted list of COT records (oldest→newest). Returns signal for most recent."""
        if not records:
            return None

        df = pd.DataFrame([{
            "date": r.date,
            "mm_net": r.mm_net if r.mm_net != 0 else r.noncomm_net,
            "oi": max(r.open_interest, 1),
        } for r in records]).set_index("date").sort_index()

        df["mm_net_pct_oi"] = df["mm_net"] / df["oi"] * 100

        # Z-scores
        def _z(series: pd.Series, window: int) -> pd.Series:
            mu = series.rolling(window, min_periods=window//4).mean()
            std = series.rolling(window, min_periods=window//4).std()
            return (series - mu) / std.replace(0.0, np.nan)

        def _pct(series: pd.Series, window: int) -> pd.Series:
            return series.rolling(window, min_periods=window//4).rank(pct=True) * 100

        df["z_1yr"]  = _z(df["mm_net_pct_oi"], 52)
        df["z_3yr"]  = _z(df["mm_net_pct_oi"], 156)
        df["pct_1yr"] = _pct(df["mm_net_pct_oi"], 52)
        df["pct_3yr"] = _pct(df["mm_net_pct_oi"], 156)

        latest = df.iloc[-1]
        z1  = float(latest["z_1yr"])  if not math.isnan(latest["z_1yr"]) else 0.0
        z3  = float(latest["z_3yr"])  if not math.isnan(latest["z_3yr"]) else 0.0
        p1  = float(latest["pct_1yr"]) if not math.isnan(latest["pct_1yr"]) else 50.0
        p3  = float(latest["pct_3yr"]) if not math.isnan(latest["pct_3yr"]) else 50.0
        mm_pct = float(latest["mm_net_pct_oi"])

        # ── Crowding signal (contrarian) ──
        # Specs extremely long → contrarian SHORT; extremely short → contrarian LONG
        if p1 >= self.crowding_pct_thr:
            c_dir = "short"
            c_str = min(1.0, (p1 - self.crowding_pct_thr) / (100 - self.crowding_pct_thr))
        elif p1 <= (100 - self.crowding_pct_thr):
            c_dir = "long"
            c_str = min(1.0, ((100 - self.crowding_pct_thr) - p1) / (100 - self.crowding_pct_thr))
        else:
            c_dir = "neutral"
            c_str = 0.0

        # ── Momentum signal (follow smart money direction of change) ──
        if len(df) >= self.momentum_weeks + 1:
            prev_pct = float(df["mm_net_pct_oi"].iloc[-(self.momentum_weeks + 1)])
            chg = mm_pct - prev_pct
            chg_norm = min(1.0, abs(chg) / 10.0)   # normalize by 10% OI change = full strength
            m_dir = "long" if chg > 0.5 else ("short" if chg < -0.5 else "neutral")
            m_str = chg_norm if m_dir != "neutral" else 0.0
        else:
            m_dir = "neutral"
            m_str = 0.0

        # ── Composite ──
        long_score  = (c_str if c_dir == "long"  else 0) * self.cw + (m_str if m_dir == "long"  else 0) * self.mw
        short_score = (c_str if c_dir == "short" else 0) * self.cw + (m_str if m_dir == "short" else 0) * self.mw
        if long_score > short_score + 0.1:
            comp_dir = "long"
            comp_str = long_score
        elif short_score > long_score + 0.1:
            comp_dir = "short"
            comp_str = short_score
        else:
            comp_dir = "neutral"
            comp_str = 0.0

        interp = self._interpret(commodity, mm_pct, p1, z1, c_dir, m_dir)

        return COTSignal(
            commodity=commodity,
            date=str(df.index[-1]),
            mm_net=float(latest["mm_net"]),
            mm_net_pct_oi=round(mm_pct, 3),
            z_score_1yr=round(z1, 3),
            z_score_3yr=round(z3, 3),
            percentile_1yr=round(p1, 2),
            percentile_3yr=round(p3, 2),
            crowding_direction=c_dir,
            crowding_strength=round(c_str, 4),
            momentum_direction=m_dir,
            momentum_strength=round(m_str, 4),
            composite_direction=comp_dir,
            composite_strength=round(comp_str, 4),
            interpretation=interp,
        )

    @staticmethod
    def _interpret(commodity: str, mm_pct: float, p1: float, z1: float,
                   c_dir: str, m_dir: str) -> str:
        pos_desc = "extremely long" if p1 > 90 else ("long" if p1 > 65 else
                   ("short" if p1 < 35 else ("extremely short" if p1 < 10 else "neutral")))
        parts = [f"{commodity}: Managed money is {pos_desc} ({mm_pct:+.1f}% OI, z={z1:+.2f}, pct={p1:.0f}th)."]
        if c_dir == "long":
            parts.append("Contrarian signal: extreme spec shorts → potential squeeze → LONG.")
        elif c_dir == "short":
            parts.append("Contrarian signal: crowded longs → risk of unwind → SHORT.")
        if m_dir == "long":
            parts.append("Momentum: positioning improving (specs adding longs).")
        elif m_dir == "short":
            parts.append("Momentum: positioning deteriorating (specs adding shorts).")
        return " ".join(parts)


# ─────────────────────────────────────────────────────────────
# DataFrame-based COT signal pipeline (for backtesting)
# ─────────────────────────────────────────────────────────────

def cot_signals_from_df(df: pd.DataFrame,
                        mm_long_col: str = "mm_long",
                        mm_short_col: str = "mm_short",
                        oi_col: str = "open_interest",
                        lookback_52w: int = 52,
                        lookback_156w: int = 156,
                        crowding_thr: float = 80.0,
                        momentum_weeks: int = 4) -> pd.DataFrame:
    """
    Vectorized COT signal generation on a weekly DataFrame.

    Input df: weekly COT data indexed by date.
    Returns: df with [mm_net, mm_net_pct_oi, z_1yr, z_3yr, pct_1yr, pct_3yr,
                       crowding_signal, momentum_signal, composite_signal]
    """
    out = df.copy()
    mm_net = df[mm_long_col] - df[mm_short_col]
    oi = df[oi_col].replace(0, np.nan)
    mm_pct = (mm_net / oi * 100).fillna(method="ffill")

    out["mm_net"]        = mm_net
    out["mm_net_pct_oi"] = mm_pct

    # Z-scores
    for w, label in [(lookback_52w, "1yr"), (lookback_156w, "3yr")]:
        mu  = mm_pct.rolling(w, min_periods=w//4).mean()
        std = mm_pct.rolling(w, min_periods=w//4).std()
        out[f"z_{label}"]   = (mm_pct - mu) / std.replace(0, np.nan)
        out[f"pct_{label}"] = mm_pct.rolling(w, min_periods=w//4).rank(pct=True) * 100

    # Crowding signal (contrarian)
    pct = out["pct_1yr"]
    out["crowding_signal"] = np.where(pct >= crowding_thr, -1,
                             np.where(pct <= (100 - crowding_thr), 1, 0))
    out["crowding_strength"] = np.where(
        pct >= crowding_thr, (pct - crowding_thr) / (100 - crowding_thr),
        np.where(pct <= (100 - crowding_thr), ((100 - crowding_thr) - pct) / (100 - crowding_thr), 0)
    ).clip(0, 1)

    # Momentum signal
    mm_chg = mm_pct.diff(momentum_weeks)
    out["momentum_signal"]   = np.where(mm_chg > 0.5, 1, np.where(mm_chg < -0.5, -1, 0))
    out["momentum_strength"] = (mm_chg.abs() / 10.0).clip(0, 1)

    # Composite (50/50 blend)
    out["composite_signal"] = np.sign(
        0.5 * out["crowding_signal"] * out["crowding_strength"] +
        0.5 * out["momentum_signal"] * out["momentum_strength"]
    ).fillna(0).astype(int)

    return out


# ─────────────────────────────────────────────────────────────
# Synthetic data generator (for testing / demo)
# ─────────────────────────────────────────────────────────────

def generate_synthetic_cot(commodity: str = "crude_oil",
                            n_weeks: int = 260,   # 5 years
                            seed: int = 42) -> List[COTRecord]:
    """Generate synthetic weekly COT data for demo/testing."""
    rng = np.random.default_rng(seed)
    base_oi  = 500_000
    base_long = 150_000
    records = []
    import datetime
    date = datetime.date.today() - datetime.timedelta(weeks=n_weeks)
    for i in range(n_weeks):
        shock = rng.normal(0, 5000)
        base_long = max(50_000, min(300_000, base_long + shock))
        base_short = max(50_000, 300_000 - base_long + rng.normal(0, 3000))
        oi = base_oi + rng.normal(0, 20_000)
        records.append(COTRecord(
            date=str(date),
            commodity=commodity,
            contract_name=f"{commodity.upper()} futures",
            mm_long=float(base_long),
            mm_short=float(base_short),
            open_interest=float(max(oi, 100_000)),
        ))
        date += datetime.timedelta(weeks=1)
    return records
