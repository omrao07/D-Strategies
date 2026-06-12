# backend/portfolio_construction/hrp.py
"""
Hierarchical Risk Parity (HRP) — Lopez de Prado (2016).
Pure numpy/scipy; no external portfolio libraries needed.
"""
from __future__ import annotations

from typing import Dict, List

import numpy as np
import pandas as pd
from scipy.cluster.hierarchy import linkage, to_tree
from scipy.spatial.distance import squareform


def _corr_to_dist(corr: np.ndarray) -> np.ndarray:
    """Convert correlation matrix to distance matrix: d_ij = sqrt(0.5*(1-rho_ij))."""
    return np.sqrt(np.clip(0.5 * (1.0 - corr), 0, 1))


def _cluster_var(cov: pd.DataFrame, items: List) -> float:
    """Variance of the cluster's inverse-vol-weighted portfolio."""
    sub_cov = cov.loc[items, items].values
    w = 1.0 / np.diag(sub_cov)
    w /= w.sum()
    return float(w @ sub_cov @ w)


def _recursive_bisection(
    cov: pd.DataFrame, items: List, weights: Dict[str, float]
) -> None:
    if len(items) == 1:
        weights[items[0]] = weights.get(items[0], 1.0)
        return

    mid = len(items) // 2
    left, right = items[:mid], items[mid:]

    var_left = _cluster_var(cov, left)
    var_right = _cluster_var(cov, right)

    alpha = 1.0 - var_left / (var_left + var_right + 1e-12)

    for item in left:
        weights[item] = weights.get(item, 1.0) * alpha
    for item in right:
        weights[item] = weights.get(item, 1.0) * (1 - alpha)

    _recursive_bisection(cov, left, weights)
    _recursive_bisection(cov, right, weights)


def hrp_weights(
    returns: pd.DataFrame,
    linkage_method: str = "single",
) -> pd.Series:
    """
    Compute HRP weights from a returns DataFrame (rows=dates, cols=assets).

    Returns: pd.Series of weights indexed by asset names, summing to 1.
    """
    corr = returns.corr()
    cov = returns.cov()
    assets = list(corr.columns)

    # Distance matrix → hierarchical clustering → quasi-diagonal ordering
    dist = _corr_to_dist(corr.values)
    np.fill_diagonal(dist, 0.0)
    condensed = squareform(dist)
    link = linkage(condensed, method=linkage_method)

    # Quasi-diagonal ordering of assets from the dendrogram
    tree = to_tree(link, rd=False)
    ordered: List[int] = []

    def _traverse(node):
        if node.is_leaf():
            ordered.append(node.id)
        else:
            _traverse(node.left)
            _traverse(node.right)

    _traverse(tree)
    ordered_assets = [assets[i] for i in ordered]

    weights: Dict[str, float] = {a: 1.0 for a in ordered_assets}
    _recursive_bisection(cov, ordered_assets, weights)

    w = pd.Series(weights)
    return w / w.sum()
