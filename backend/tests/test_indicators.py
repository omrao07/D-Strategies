# backend/tests/test_indicators.py
"""Tests for backend/indicators/technical.py"""
import numpy as np
import pandas as pd
import pytest

from backend.indicators.technical import (
    atr,
    bollinger,
    ema,
    historical_vol,
    hurst_exponent,
    kalman_filter,
    macd,
    rsi,
    sma,
    vwap,
    zscore,
)


@pytest.fixture
def prices():
    rng = np.random.default_rng(42)
    n = 200
    raw = 100 + np.cumsum(rng.normal(0, 1, n))
    return pd.Series(raw, name="close")


def test_sma_length(prices):
    result = sma(prices, 20)
    assert len(result) == len(prices)
    assert result.iloc[:19].isna().all()
    assert result.iloc[19:].notna().all()


def test_ema_does_not_explode(prices):
    result = ema(prices, 20)
    assert not result.isna().any()
    assert result.max() < 1e6


def test_rsi_bounds(prices):
    result = rsi(prices, 14)
    valid = result.dropna()
    assert (valid >= 0).all()
    assert (valid <= 100).all()


def test_macd_signal_diff(prices):
    macd_line, signal, hist = macd(prices)
    assert len(macd_line) == len(prices)
    diff = macd_line - signal
    np.testing.assert_allclose(hist.dropna(), diff.dropna(), rtol=1e-6)


def test_bollinger_ordering(prices):
    lower, mid, upper = bollinger(prices, 20, 2.0)
    valid = lower.dropna().index
    assert (lower[valid] <= mid[valid]).all()
    assert (mid[valid] <= upper[valid]).all()


def test_atr_positive():
    rng = np.random.default_rng(0)
    n = 100
    close = pd.Series(100 + np.cumsum(rng.normal(0, 1, n)))
    high = close + rng.uniform(0, 2, n)
    low = close - rng.uniform(0, 2, n)
    result = atr(high, low, close, 14)
    assert (result.dropna() > 0).all()


def test_vwap_reasonable(prices):
    rng = np.random.default_rng(1)
    high = prices + rng.uniform(0, 1, len(prices))
    low = prices - rng.uniform(0, 1, len(prices))
    vol = pd.Series(rng.integers(1000, 100000, len(prices)).astype(float))
    result = vwap(high, low, prices, vol)
    assert not result.isna().any()
    # vwap should be close to price (within the high-low range)
    assert (result > prices.min() * 0.9).all()
    assert (result < prices.max() * 1.1).all()


def test_zscore_mean_zero(prices):
    result = zscore(prices, 50)
    valid = result.dropna()
    assert abs(valid.mean()) < 1.0  # rolling z-score mean should be near zero


def test_kalman_filter_smooth(prices):
    result = kalman_filter(prices)
    assert len(result) == len(prices)
    assert not result.isna().any()
    # Kalman output should be smoother (lower std) than input
    assert result.std() <= prices.std()


def test_hurst_trending():
    rng = np.random.default_rng(7)
    # Trending series: cumulative sum of +1
    trending = pd.Series(np.cumsum(np.ones(200) + rng.normal(0, 0.1, 200)))
    h = hurst_exponent(trending)
    assert 0 < h <= 1.5


def test_historical_vol_annualized(prices):
    hv = historical_vol(prices, 20, annualize=True)
    valid = hv.dropna()
    # Annualized vol of daily prices should be in plausible range (0-300%)
    assert (valid > 0).all()
    assert (valid < 3.0).all()
