"""
Test-suite conftest for backend/tests/.

Patches math.isclose to accept legacy kwargs 'rel' and 'abs' (some test files
use these non-standard aliases instead of rel_tol/abs_tol).

Provides a minimal 'benchmark' fixture so tests that use pytest-benchmark
don't error when the plugin is not installed.

Provides per-strategy-family fixtures with minimal synthetic price DataFrames.
"""
import math as _math_module
import time

import numpy as np
import pandas as pd
import pytest

_orig_isclose = _math_module.isclose


def _isclose_compat(a, b, *, rel=None, abs=None, rel_tol=1e-9, abs_tol=0.0, **kw):
    if rel is not None:
        rel_tol = rel
    if abs is not None:
        abs_tol = abs
    return _orig_isclose(a, b, rel_tol=rel_tol, abs_tol=abs_tol)


_math_module.isclose = _isclose_compat


# ---------------------------------------------------------------------------
# Minimal benchmark fixture (fallback when pytest-benchmark is not installed)
# ---------------------------------------------------------------------------

try:
    import pytest_benchmark  # noqa: F401  — if installed, it provides its own fixture
except ImportError:
    class _BenchmarkResult(float):
        """Float subclass so `duration >= 0.0` passes in latency tests."""

    @pytest.fixture()
    def benchmark():
        """Minimal stand-in: run the callable once and return elapsed seconds."""
        def _run(fn, *args, **kwargs):
            t0 = time.perf_counter()
            fn(*args, **kwargs)
            return _BenchmarkResult(time.perf_counter() - t0)
        return _run


# ---------------------------------------------------------------------------
# Per-strategy-family fixtures with minimal synthetic price DataFrames
# ---------------------------------------------------------------------------

def _synthetic_prices(n_days: int = 252, n_stocks: int = 5, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    tickers = [f"SYM{i}" for i in range(n_stocks)]
    dates = pd.date_range("2023-01-01", periods=n_days, freq="B")
    returns = rng.normal(0.0005, 0.01, size=(n_days, n_stocks))
    prices = 100.0 * np.cumprod(1 + returns, axis=0)
    return pd.DataFrame(prices, index=dates, columns=tickers)


@pytest.fixture()
def equity_ls_prices() -> pd.DataFrame:
    """Synthetic daily price DataFrame for equity long-short strategy tests."""
    return _synthetic_prices(n_days=252, n_stocks=10, seed=1)


@pytest.fixture()
def stat_arb_prices() -> pd.DataFrame:
    """Synthetic cointegrated pair prices for statistical arbitrage tests."""
    rng = np.random.default_rng(2)
    dates = pd.date_range("2023-01-01", periods=252, freq="B")
    common = np.cumsum(rng.normal(0, 0.5, 252))
    x = 100 + common + rng.normal(0, 0.2, 252)
    y = 100 + 0.9 * common + rng.normal(0, 0.2, 252)
    return pd.DataFrame({"X": x, "Y": y}, index=dates)


@pytest.fixture()
def macro_prices() -> pd.DataFrame:
    """Synthetic daily OHLCV-style DataFrame for macro/futures strategy tests."""
    rng = np.random.default_rng(3)
    dates = pd.date_range("2020-01-01", periods=500, freq="B")
    close = 100 + np.cumsum(rng.normal(0.1, 1.5, 500))
    high = close + abs(rng.normal(0, 0.5, 500))
    low = close - abs(rng.normal(0, 0.5, 500))
    volume = rng.integers(1_000_000, 5_000_000, 500).astype(float)
    return pd.DataFrame({"close": close, "high": high, "low": low, "volume": volume}, index=dates)


@pytest.fixture()
def options_vol_surface() -> dict:
    """Minimal implied vol surface dict for options/vol strategy tests."""
    strikes = [90, 95, 100, 105, 110]
    expiries = [0.083, 0.25, 0.5, 1.0]
    rng = np.random.default_rng(4)
    surface = {}
    for T in expiries:
        for K in strikes:
            moneyness = K / 100.0
            base_vol = 0.20 + 0.05 * (moneyness - 1.0) ** 2
            surface[(K, T)] = base_vol + rng.normal(0, 0.005)
    return surface


@pytest.fixture()
def credit_cds_params() -> dict:
    """Minimal CDS pricing parameters for credit strategy tests."""
    return {
        "notional": 10_000_000.0,
        "spread_bps": 120.0,
        "recovery_rate": 0.40,
        "risk_free_rate": 0.04,
        "hazard_rate": 0.02,
        "tenor_years": 5.0,
        "payment_freq": 4,
    }
