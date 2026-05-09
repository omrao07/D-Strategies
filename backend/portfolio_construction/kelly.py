# backend/portfolio_construction/kelly.py
"""
Kelly criterion and vol-parity position sizing.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from typing import Dict, Optional


def kelly_position_size(
    win_rate: float,
    win_loss_ratio: float,
    capital: float,
    kelly_fraction: float = 0.25,
    max_pct: float = 0.10,
) -> float:
    """
    Full Kelly: f = p - q/b  where p=win_rate, q=1-p, b=win_loss_ratio.
    Returns fractional Kelly position size in $ (capped at max_pct of capital).
    """
    if win_loss_ratio <= 0 or win_rate <= 0:
        return 0.0
    q = 1.0 - win_rate
    f = win_rate - q / win_loss_ratio
    f = max(0.0, min(f, 1.0))
    return min(capital * f * kelly_fraction, capital * max_pct)


def vol_parity_weights(
    vols: Dict[str, float],
    target_vol: float = 0.10,
    capital: float = 1.0,
) -> Dict[str, float]:
    """
    Inverse-volatility weighting (vol parity):
    w_i = (target_vol / vol_i) / sum(target_vol / vol_j)
    Scaled to sum to `capital`.

    vols: {asset_name: annualized_vol} e.g. {"AAPL": 0.30, "MSFT": 0.25}
    Returns: {asset_name: dollar_weight}
    """
    if not vols:
        return {}
    raw = {k: target_vol / max(v, 1e-9) for k, v in vols.items()}
    total = sum(raw.values()) or 1.0
    return {k: (v / total) * capital for k, v in raw.items()}


def continuous_kelly(
    mu: float,         # expected return (annualized)
    sigma: float,      # annualized volatility
    rf: float = 0.05,  # risk-free rate
    fraction: float = 0.25,
) -> float:
    """
    Continuous-time Kelly fraction: f* = (mu - rf) / sigma^2
    Returns fractional position (0-1).
    """
    if sigma <= 0:
        return 0.0
    f = (mu - rf) / (sigma ** 2)
    return float(np.clip(f * fraction, 0.0, 1.0))
