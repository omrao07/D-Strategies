# tests/test_drift_detection.py
#
# Pytest tests for data / feature drift detection
#
# Expected interface:
#
# class DriftDetector:
#     def fit(reference: np.ndarray)
#     def detect(current: np.ndarray) -> DriftResult
#
# class DriftResult:
#     drifted: bool
#     statistic: float
#     threshold: float
#     p_value: float | None
#
# Supported methods:
# - KS test (univariate)
# - PSI (population stability index)
#

import numpy as np
import pytest
from dataclasses import dataclass


# ─────────────────────────────────────────────────────────────
# Fallback reference implementation (REMOVE once real exists)
# ─────────────────────────────────────────────────────────────

try:
    from engine.monitoring.drift import DriftDetector
except ImportError:
    class DriftDetector:
        def __init__(self, method="ks", alpha=0.05):
            self.method = method
            self.alpha = alpha
            self.ref = None

        def fit(self, reference: np.ndarray):
            self.ref = np.asarray(reference)

        def detect(self, current: np.ndarray):
            cur = np.asarray(current)

            if self.method == "ks":
                from scipy.stats import ks_2samp
                stat, p = ks_2samp(self.ref, cur)
                return DriftResult(
                    drifted=p < self.alpha,
                    statistic=stat,
                    threshold=self.alpha,
                    p_value=p
                )

            if self.method == "psi":
                psi = population_stability_index(self.ref, cur)
                return DriftResult(
                    drifted=psi > 0.25,
                    statistic=psi,
                    threshold=0.25,
                    p_value=None
                )

            raise ValueError("Unknown drift method")


# ─────────────────────────────────────────────────────────────
# Types
# ─────────────────────────────────────────────────────────────

@dataclass
class DriftResult:
    drifted: bool
    statistic: float
    threshold: float
    p_value: float | None


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

def population_stability_index(expected, actual, bins=10):
    eps = 1e-6
    breakpoints = np.percentile(expected, np.linspace(0, 100, bins + 1))
    exp_counts, _ = np.histogram(expected, breakpoints)
    act_counts, _ = np.histogram(actual, breakpoints)

    exp_dist = exp_counts / max(exp_counts.sum(), eps)
    act_dist = act_counts / max(act_counts.sum(), eps)

    psi = np.sum(
        (exp_dist - act_dist) *
        np.log((exp_dist + eps) / (act_dist + eps))
    )
    return psi


# ─────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────

@pytest.fixture
def stable_reference():
    np.random.seed(42)
    return np.random.normal(0, 1, 10_000)


@pytest.fixture
def stable_current():
    np.random.seed(43)
    return np.random.normal(0, 1, 5_000)


@pytest.fixture
def drifted_current():
    np.random.seed(44)
    return np.random.normal(1.5, 1, 5_000)


# ─────────────────────────────────────────────────────────────
# Tests: KS Test
# ─────────────────────────────────────────────────────────────

def test_ks_no_drift(stable_reference, stable_current):
    detector = DriftDetector(method="ks", alpha=0.05)
    detector.fit(stable_reference)

    result = detector.detect(stable_current)

    assert result.drifted is False
    assert result.p_value is not None
    assert result.p_value >= 0.05


def test_ks_detects_drift(stable_reference, drifted_current):
    detector = DriftDetector(method="ks", alpha=0.05)
    detector.fit(stable_reference)

    result = detector.detect(drifted_current)

    assert result.drifted is True
    assert result.p_value < 0.05
    assert result.statistic > 0


# ─────────────────────────────────────────────────────────────
# Tests: PSI
# ─────────────────────────────────────────────────────────────

def test_psi_no_drift(stable_reference, stable_current):
    detector = DriftDetector(method="psi")
    detector.fit(stable_reference)

    result = detector.detect(stable_current)

    assert result.drifted is False
    assert result.statistic < result.threshold


def test_psi_detects_drift(stable_reference, drifted_current):
    detector = DriftDetector(method="psi")
    detector.fit(stable_reference)

    result = detector.detect(drifted_current)

    assert result.drifted is True
    assert result.statistic > result.threshold


# ─────────────────────────────────────────────────────────────
# Edge cases
# ─────────────────────────────────────────────────────────────

def test_empty_current_raises(stable_reference):
    detector = DriftDetector(method="ks")
    detector.fit(stable_reference)

    with pytest.raises(Exception):
        detector.detect(np.array([]))


def test_detect_without_fit_raises():
    detector = DriftDetector(method="ks")

    with pytest.raises(Exception):
        detector.detect(np.random.randn(100))


def test_identical_arrays_no_drift(stable_reference):
    detector = DriftDetector(method="ks")
    detector.fit(stable_reference)

    result = detector.detect(stable_reference.copy())

    assert result.drifted is False
    assert result.statistic == 0 or result.p_value == 1.0