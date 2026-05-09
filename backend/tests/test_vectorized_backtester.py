# backend/tests/test_vectorized_backtester.py
"""Tests for backend/backtester/vectorized_backtester.py"""
import numpy as np
import pandas as pd
import pytest

from backend.backtester.vectorized_backtester import (
    run_backtest,
    walk_forward,
    monte_carlo,
    BacktestResult,
)


@pytest.fixture
def trending_prices():
    """Simple uptrending price series."""
    rng = np.random.default_rng(99)
    n = 300
    t = 3
    returns = np.tile(np.array([[0.002, -0.001, 0.001]]), (n // t + 1, 1))[:n]
    prices = 100 * np.cumprod(1 + returns + rng.normal(0, 0.005, (n, t)), axis=0)
    return pd.DataFrame(prices, columns=["A", "B", "C"])


@pytest.fixture
def buy_signals(trending_prices):
    """Always-long signals."""
    return pd.DataFrame(
        np.ones(trending_prices.shape),
        columns=trending_prices.columns,
        index=trending_prices.index,
    )


def test_backtest_returns_result(trending_prices, buy_signals):
    result = run_backtest(trending_prices, buy_signals, capital=100_000)
    assert isinstance(result, BacktestResult)


def test_backtest_pnl_shape(trending_prices, buy_signals):
    result = run_backtest(trending_prices, buy_signals)
    assert len(result.daily_pnl) == len(trending_prices)
    assert len(result.cumulative_pnl) == len(trending_prices)


def test_backtest_no_lookahead(trending_prices):
    """First day should have zero P&L (positions from shifted signals)."""
    signals = pd.DataFrame(
        np.ones(trending_prices.shape),
        columns=trending_prices.columns,
    )
    result = run_backtest(trending_prices, signals)
    assert result.daily_pnl[0] == 0.0


def test_backtest_sharpe_finite(trending_prices, buy_signals):
    result = run_backtest(trending_prices, buy_signals)
    assert np.isfinite(result.sharpe)


def test_backtest_zero_signals(trending_prices):
    """Zero signals → zero P&L always."""
    signals = pd.DataFrame(
        np.zeros(trending_prices.shape),
        columns=trending_prices.columns,
    )
    result = run_backtest(trending_prices, signals)
    np.testing.assert_array_equal(result.daily_pnl, 0.0)


def test_backtest_summary_keys(trending_prices, buy_signals):
    result = run_backtest(trending_prices, buy_signals)
    summary = result.summary()
    for key in ["sharpe", "max_drawdown", "calmar", "total_return", "win_rate"]:
        assert key in summary


def test_walk_forward_returns_list(trending_prices, buy_signals):
    results = walk_forward(
        trending_prices, buy_signals,
        train_size=100, test_size=50,
    )
    assert isinstance(results, list)
    assert len(results) > 0
    assert all(isinstance(r, BacktestResult) for r in results)


def test_walk_forward_windows(trending_prices, buy_signals):
    """Should produce floor((300 - 100) / 50) = 4 windows."""
    results = walk_forward(
        trending_prices, buy_signals,
        train_size=100, test_size=50,
    )
    assert len(results) == 4


def test_monte_carlo_shape():
    daily_rets = np.random.default_rng(1).normal(0.001, 0.02, 252)
    mc = monte_carlo(daily_rets, n_paths=100, horizon=63, seed=42)
    assert mc["paths"].shape == (100, 63)
    assert mc["percentiles"].shape == (5, 63)


def test_monte_carlo_positive_capital():
    daily_rets = np.ones(100) * 0.01  # 1% gain per day
    mc = monte_carlo(daily_rets, n_paths=50, horizon=30, capital=100_000)
    assert (mc["paths"] > 0).all()
