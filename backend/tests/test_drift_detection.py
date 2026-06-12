# backend/tests/test_drift_detection.py
"""
Tests for backend.engine.monitoring.drift
"""

import numpy as np
import pytest

from backend.engine.monitoring.drift import DriftDetector, DriftResult

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
# KS test
# ─────────────────────────────────────────────────────────────

def test_ks_no_drift(stable_reference, stable_current):
    det = DriftDetector(method="ks", alpha=0.05)
    det.fit(stable_reference)
    result = det.detect(stable_current)

    assert isinstance(result, DriftResult)
    assert result.drifted is False
    assert result.p_value is not None
    assert result.p_value >= 0.05


def test_ks_detects_drift(stable_reference, drifted_current):
    det = DriftDetector(method="ks", alpha=0.05)
    det.fit(stable_reference)
    result = det.detect(drifted_current)

    assert result.drifted is True
    assert result.p_value < 0.05
    assert result.statistic > 0


def test_ks_identical_arrays_no_drift(stable_reference):
    det = DriftDetector(method="ks")
    det.fit(stable_reference)
    result = det.detect(stable_reference.copy())

    assert result.drifted is False
    assert result.statistic == 0.0 or result.p_value == 1.0


# ─────────────────────────────────────────────────────────────
# PSI
# ─────────────────────────────────────────────────────────────

def test_psi_no_drift(stable_reference, stable_current):
    det = DriftDetector(method="psi")
    det.fit(stable_reference)
    result = det.detect(stable_current)

    assert result.drifted is False
    assert result.statistic < result.threshold
    assert result.p_value is None


def test_psi_detects_drift(stable_reference, drifted_current):
    det = DriftDetector(method="psi")
    det.fit(stable_reference)
    result = det.detect(drifted_current)

    assert result.drifted is True
    assert result.statistic > result.threshold


# ─────────────────────────────────────────────────────────────
# Edge cases / error handling
# ─────────────────────────────────────────────────────────────

def test_empty_current_raises(stable_reference):
    det = DriftDetector(method="ks")
    det.fit(stable_reference)

    with pytest.raises(ValueError, match="empty"):
        det.detect(np.array([]))


def test_detect_without_fit_raises():
    det = DriftDetector(method="ks")

    with pytest.raises(RuntimeError, match="fit"):
        det.detect(np.random.randn(100))


def test_empty_reference_raises():
    det = DriftDetector(method="ks")

    with pytest.raises(ValueError, match="empty"):
        det.fit(np.array([]))


def test_unknown_method_raises():
    with pytest.raises(ValueError, match="Unknown drift method"):
        DriftDetector(method="chi2")


def test_fit_returns_self(stable_reference):
    det = DriftDetector()
    ret = det.fit(stable_reference)
    assert ret is det


def test_result_fields_present(stable_reference, stable_current):
    det = DriftDetector(method="ks")
    det.fit(stable_reference)
    result = det.detect(stable_current)

    assert hasattr(result, "drifted")
    assert hasattr(result, "statistic")
    assert hasattr(result, "threshold")
    assert hasattr(result, "p_value")
    assert isinstance(result.drifted, bool)
    assert result.statistic >= 0
