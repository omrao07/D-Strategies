# backend/portfolio_construction/black_litterman.py
"""
Black-Litterman portfolio construction.
No external optimizer required — pure numpy.
"""
from __future__ import annotations

from typing import Optional, Tuple

import numpy as np


def market_implied_returns(
    cov: np.ndarray,
    market_weights: np.ndarray,
    risk_aversion: float = 2.5,
) -> np.ndarray:
    """Compute equilibrium excess returns Π = λ Σ w."""
    return risk_aversion * cov @ market_weights


def black_litterman(
    cov: np.ndarray,
    market_weights: np.ndarray,
    views_P: np.ndarray,
    views_q: np.ndarray,
    views_omega: Optional[np.ndarray] = None,
    risk_aversion: float = 2.5,
    tau: float = 0.05,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Black-Litterman posterior mean and covariance.

    Args:
        cov: (n×n) asset covariance matrix
        market_weights: (n,) market cap weights
        views_P: (k×n) pick matrix — each row is one view
        views_q: (k,) view returns
        views_omega: (k×k) view uncertainty matrix; defaults to tau * P @ cov @ P'
        risk_aversion: λ
        tau: scalar weight on prior uncertainty

    Returns:
        mu_bl: (n,) posterior expected returns
        cov_bl: (n×n) posterior covariance
    """
    pi = market_implied_returns(cov, market_weights, risk_aversion)
    tau_sigma = tau * cov

    if views_omega is None:
        views_omega = tau * views_P @ cov @ views_P.T

    # BL posterior
    M = np.linalg.inv(views_P @ tau_sigma @ views_P.T + views_omega)
    mu_bl = pi + tau_sigma @ views_P.T @ M @ (views_q - views_P @ pi)
    cov_bl = cov + tau_sigma - tau_sigma @ views_P.T @ M @ views_P @ tau_sigma
    return mu_bl, cov_bl


def bl_weights(
    cov: np.ndarray,
    market_weights: np.ndarray,
    views_P: np.ndarray,
    views_q: np.ndarray,
    views_omega: Optional[np.ndarray] = None,
    risk_aversion: float = 2.5,
    tau: float = 0.05,
) -> np.ndarray:
    """Return normalized long-only BL weights."""
    mu_bl, cov_bl = black_litterman(
        cov, market_weights, views_P, views_q, views_omega, risk_aversion, tau
    )
    # Mean-variance optimal weights proportional to Σ^{-1} μ
    w = np.linalg.solve(cov_bl, mu_bl)
    w = np.clip(w, 0, None)  # long-only
    total = w.sum()
    return w / total if total > 0 else np.ones(len(w)) / len(w)
