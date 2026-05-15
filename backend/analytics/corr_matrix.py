# backend/analytics/corr_matrix.py
"""Thin wrapper: exports compute_corr_matrix(df) -> np.ndarray."""
from __future__ import annotations

import math
from typing import Optional

import numpy as np
import pandas as pd


def compute_corr_matrix(
    returns: pd.DataFrame,
    method: str = "pearson",
    min_periods: int = 10,
) -> pd.DataFrame:
    """
    Compute a symmetric N×N correlation matrix from a T×N returns DataFrame.

    Parameters
    ----------
    returns  : T×N DataFrame of asset returns
    method   : 'pearson' | 'spearman' | 'kendall'
    min_periods : minimum non-NaN observations required; columns with fewer
                  observations will yield NaN correlations.

    Returns
    -------
    pd.DataFrame of shape (N, N) with column/index labels matching returns.columns
    """
    return returns.corr(method=method, min_periods=min_periods)


def compute_shrunk_corr_matrix(
    returns: pd.DataFrame,
    shrinkage: float = 0.1,
) -> np.ndarray:
    """Ledoit-Wolf style linear shrinkage toward identity."""
    rho = compute_corr_matrix(returns)
    n = rho.shape[0]
    identity = np.eye(n)
    return (1.0 - shrinkage) * rho + shrinkage * identity
