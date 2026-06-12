# backend/tests/test_portfolio_construction.py
"""Tests for backend/portfolio_construction/ modules."""
import numpy as np
import pandas as pd

from backend.portfolio_construction.kelly import (
    continuous_kelly,
    kelly_position_size,
    vol_parity_weights,
)
from backend.portfolio_construction.risk_parity import risk_parity_weights

# ---- Kelly tests -----------------------------------------------------------

def test_kelly_zero_edge():
    size = kelly_position_size(win_rate=0.5, win_loss_ratio=1.0, capital=100_000)
    assert size == 0.0  # zero edge → zero position


def test_kelly_positive_edge():
    size = kelly_position_size(win_rate=0.6, win_loss_ratio=2.0, capital=100_000)
    assert size > 0
    assert size <= 100_000 * 0.10  # capped at 10%


def test_kelly_fractional():
    full = kelly_position_size(0.6, 2.0, 100_000, kelly_fraction=1.0)
    half = kelly_position_size(0.6, 2.0, 100_000, kelly_fraction=0.5)
    assert abs(full - 2 * half) < 1e-9


def test_vol_parity_weights_sum():
    vols = {"AAPL": 0.30, "MSFT": 0.25, "GOOG": 0.35}
    weights = vol_parity_weights(vols, target_vol=0.10, capital=1_000_000)
    assert abs(sum(weights.values()) - 1_000_000) < 1.0


def test_vol_parity_inverse():
    vols = {"HIGH": 0.60, "LOW": 0.20}
    weights = vol_parity_weights(vols, capital=1.0)
    # Low vol asset should have 3x weight of high vol asset
    ratio = weights["LOW"] / weights["HIGH"]
    assert abs(ratio - 3.0) < 0.01


def test_continuous_kelly_positive():
    f = continuous_kelly(mu=0.20, sigma=0.20, rf=0.05)
    assert 0 < f <= 1.0


def test_continuous_kelly_negative_edge():
    f = continuous_kelly(mu=0.03, sigma=0.30, rf=0.05)
    assert f == 0.0  # mu < rf → no position


# ---- Risk Parity tests -----------------------------------------------------

def test_risk_parity_sums_to_one():
    rng = np.random.default_rng(42)
    n = 5
    A = rng.standard_normal((200, n))
    cov = pd.DataFrame(np.cov(A.T), columns=list("ABCDE"), index=list("ABCDE"))
    weights = risk_parity_weights(cov)
    assert abs(weights.sum() - 1.0) < 1e-6


def test_risk_parity_equal_vol():
    # Equal vol assets → equal weight
    cov = pd.DataFrame(
        np.diag([0.04, 0.04, 0.04]),
        columns=["X", "Y", "Z"],
        index=["X", "Y", "Z"],
    )
    weights = risk_parity_weights(cov)
    assert abs(weights["X"] - 1 / 3) < 1e-4
    assert abs(weights["Y"] - 1 / 3) < 1e-4


def test_risk_parity_all_positive():
    rng = np.random.default_rng(7)
    n = 4
    A = rng.standard_normal((100, n))
    cov = pd.DataFrame(np.cov(A.T) + np.eye(n) * 0.01)
    weights = risk_parity_weights(cov)
    assert (weights > 0).all()
