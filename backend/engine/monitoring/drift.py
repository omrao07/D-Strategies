# backend/engine/monitoring/drift.py
"""
Data / Feature Drift Detection
================================
Detects distribution shift between a reference dataset and a current window.

Supported methods:
  - "ks"  : Kolmogorov-Smirnov two-sample test (univariate, p-value based)
  - "psi" : Population Stability Index (binned divergence, no p-value)

Usage:
    detector = DriftDetector(method="ks", alpha=0.05)
    detector.fit(reference_array)
    result = detector.detect(current_array)
    if result.drifted:
        alert(f"Drift detected: statistic={result.statistic:.4f}")
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass
class DriftResult:
    """Result of a drift detection check."""
    drifted: bool
    statistic: float       # KS-stat or PSI value
    threshold: float       # alpha (KS) or 0.25 (PSI)
    p_value: Optional[float]  # None for PSI


class DriftDetector:
    """
    Univariate drift detector supporting KS test and PSI.

    Parameters
    ----------
    method : "ks" | "psi"
    alpha  : significance level for KS test (default 0.05)
    bins   : number of bins for PSI (default 10)
    """

    def __init__(self, method: str = "ks", alpha: float = 0.05, bins: int = 10):
        if method not in ("ks", "psi"):
            raise ValueError(f"Unknown drift method '{method}'. Choose 'ks' or 'psi'.")
        self.method = method
        self.alpha = alpha
        self.bins = bins
        self._ref: Optional[np.ndarray] = None

    def fit(self, reference: np.ndarray) -> "DriftDetector":
        """Store the reference distribution."""
        ref = np.asarray(reference, dtype=float)
        if ref.ndim != 1:
            raise ValueError("reference must be a 1-D array.")
        if len(ref) == 0:
            raise ValueError("reference array must not be empty.")
        self._ref = ref
        return self

    def detect(self, current: np.ndarray) -> DriftResult:
        """
        Compare current distribution against the fitted reference.

        Raises
        ------
        RuntimeError  : if fit() has not been called.
        ValueError    : if current is empty.
        """
        if self._ref is None:
            raise RuntimeError("Call fit() before detect().")

        cur = np.asarray(current, dtype=float)
        if cur.ndim != 1:
            raise ValueError("current must be a 1-D array.")
        if len(cur) == 0:
            raise ValueError("current array must not be empty.")

        if self.method == "ks":
            return self._ks(cur)
        return self._psi(cur)

    # ── Private ──────────────────────────────────────────────

    def _ks(self, cur: np.ndarray) -> DriftResult:
        from scipy.stats import ks_2samp
        stat, p = ks_2samp(self._ref, cur)
        return DriftResult(
            drifted=bool(p < self.alpha),
            statistic=float(stat),
            threshold=self.alpha,
            p_value=float(p),
        )

    def _psi(self, cur: np.ndarray) -> DriftResult:
        psi = _population_stability_index(self._ref, cur, bins=self.bins)
        return DriftResult(
            drifted=bool(psi > 0.25),
            statistic=float(psi),
            threshold=0.25,
            p_value=None,
        )


# ── Standalone helpers ────────────────────────────────────────

def _population_stability_index(expected: np.ndarray, actual: np.ndarray,
                                 bins: int = 10, eps: float = 1e-6) -> float:
    """
    Population Stability Index between two 1-D distributions.

    PSI < 0.10  → no significant change
    PSI 0.10–0.25 → moderate change, investigate
    PSI > 0.25  → significant shift, action required
    """
    breakpoints = np.unique(np.percentile(expected, np.linspace(0, 100, bins + 1)))
    if len(breakpoints) < 2:
        return 0.0

    exp_cnt, _ = np.histogram(expected, bins=breakpoints)
    act_cnt, _ = np.histogram(actual,   bins=breakpoints)

    exp_dist = exp_cnt / max(exp_cnt.sum(), eps)
    act_dist = act_cnt / max(act_cnt.sum(), eps)

    return float(np.sum((exp_dist - act_dist) * np.log((exp_dist + eps) / (act_dist + eps))))
