# backend/portfolio_construction/mean_variance.py
"""
Markowitz mean-variance optimization — pure numpy, no cvxpy required.
Uses analytical solution for minimum variance and max-Sharpe portfolios.
"""
from __future__ import annotations

from typing import Optional, Tuple
import numpy as np


def min_variance_weights(cov: np.ndarray) -> np.ndarray:
    """Global minimum variance weights: w = Σ^{-1} 1 / (1' Σ^{-1} 1)."""
    n = cov.shape[0]
    ones = np.ones(n)
    inv_cov = np.linalg.pinv(cov)
    w = inv_cov @ ones
    w = np.clip(w, 0, None)
    total = w.sum()
    return w / total if total > 0 else ones / n


def max_sharpe_weights(
    expected_returns: np.ndarray,
    cov: np.ndarray,
    rf_rate: float = 0.0,
) -> np.ndarray:
    """Tangency portfolio weights: w ∝ Σ^{-1} (μ - rf)."""
    excess = expected_returns - rf_rate
    inv_cov = np.linalg.pinv(cov)
    w = inv_cov @ excess
    w = np.clip(w, 0, None)
    total = w.sum()
    return w / total if total > 0 else np.ones(len(w)) / len(w)


def efficient_frontier(
    expected_returns: np.ndarray,
    cov: np.ndarray,
    n_points: int = 50,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Trace the efficient frontier by sweeping target returns.

    Returns:
        returns_arr: (n_points,) portfolio expected returns
        vols_arr: (n_points,) portfolio volatilities
        weights_arr: (n_points, n) weight matrix
    """
    n = len(expected_returns)
    ones = np.ones(n)
    inv_cov = np.linalg.pinv(cov)

    A = ones @ inv_cov @ expected_returns
    B = expected_returns @ inv_cov @ expected_returns
    C = ones @ inv_cov @ ones
    D = B * C - A ** 2

    mu_min = expected_returns.min()
    mu_max = expected_returns.max()
    target_returns = np.linspace(mu_min, mu_max, n_points)

    weights_arr = []
    for mu_t in target_returns:
        # Lagrangian solution on unconstrained frontier
        lam = (C * mu_t - A) / D
        gam = (B - A * mu_t) / D
        w = lam * inv_cov @ expected_returns + gam * inv_cov @ ones
        w = np.clip(w, 0, None)
        total = w.sum()
        weights_arr.append(w / total if total > 0 else ones / n)

    weights_arr = np.array(weights_arr)
    returns_arr = weights_arr @ expected_returns
    vols_arr = np.sqrt(np.einsum("ij,jk,ik->i", weights_arr, cov, weights_arr))
    return returns_arr, vols_arr, weights_arr
