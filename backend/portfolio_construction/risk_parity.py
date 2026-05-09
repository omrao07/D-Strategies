# backend/portfolio_construction/risk_parity.py
"""
Risk parity portfolio construction via iterative (Jacobi) solver.
Targets equal risk contribution from each asset.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from typing import Optional


def _portfolio_vol(w: np.ndarray, cov: np.ndarray) -> float:
    var = w @ cov @ w
    return float(np.sqrt(max(var, 0.0)))


def _risk_contribution(w: np.ndarray, cov: np.ndarray) -> np.ndarray:
    sigma = _portfolio_vol(w, cov)
    if sigma < 1e-12:
        return np.zeros_like(w)
    mrc = cov @ w  # marginal risk contribution
    return w * mrc / sigma


def risk_parity_weights(
    cov: pd.DataFrame,
    target_risk: Optional[np.ndarray] = None,
    max_iter: int = 500,
    tol: float = 1e-8,
    initial_weights: Optional[np.ndarray] = None,
) -> pd.Series:
    """
    Equal risk contribution (ERC) portfolio weights via iterative solver.

    cov: covariance matrix (DataFrame, assets as both index and columns)
    target_risk: desired fractional risk budget per asset (None = equal)
    Returns: pd.Series of weights summing to 1.
    """
    assets = list(cov.columns)
    n = len(assets)
    cov_arr = cov.values.astype(float)

    budget = target_risk if target_risk is not None else np.ones(n) / n
    budget = budget / budget.sum()

    w = initial_weights if initial_weights is not None else np.ones(n) / n
    w = w / w.sum()

    for _ in range(max_iter):
        rc = _risk_contribution(w, cov_arr)
        sigma = _portfolio_vol(w, cov_arr)
        if sigma < 1e-12:
            break
        # Update: scale each weight by budget/current_contribution ratio
        target_rc = budget * sigma
        new_w = w * (target_rc / (rc + 1e-12))
        new_w = new_w / new_w.sum()
        if np.max(np.abs(new_w - w)) < tol:
            w = new_w
            break
        w = new_w

    return pd.Series(w / w.sum(), index=assets)
