# backend/backtester/vectorized_backtester.py
"""
Vectorized backtester with:
  - No-lookahead (uses shifted positions)
  - Walk-forward validation windows
  - Monte Carlo P&L simulation
  - NumPy-native; Numba JIT optional

Input:
  prices:    np.ndarray or pd.DataFrame  [dates x assets], close prices
  signals:   np.ndarray or pd.DataFrame  [dates x assets], raw signals in [-1, +1]
             (each row is one day's signal; position applied NEXT day)

Output:
  BacktestResult with daily P&L, Sharpe, max drawdown, etc.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Union

import numpy as np
import pandas as pd

try:
    from numba import njit as _njit  # type: ignore
    _HAVE_NUMBA = True
except ImportError:
    _HAVE_NUMBA = False
    def _njit(fn):  # type: ignore
        return fn


# ---- Numba-acceleratable core -----------------------------------------------

@_njit
def _compute_pnl_vec(
    prices: np.ndarray,     # [T x N]
    positions: np.ndarray,  # [T x N] (already shifted by 1 for no-lookahead)
    fee_bps: float,
    slippage_bps: float,
) -> np.ndarray:
    """Returns daily portfolio P&L as 1-D array of length T."""
    T, N = prices.shape
    pnl = np.zeros(T)
    cost_factor = (fee_bps + slippage_bps) * 1e-4

    for t in range(1, T):
        ret_t = (prices[t] - prices[t - 1]) / (prices[t - 1] + 1e-12)
        pnl_t = 0.0
        turnover_t = 0.0
        for n in range(N):
            pnl_t += positions[t, n] * ret_t[n]
            turnover_t += abs(positions[t, n] - positions[t - 1, n])
        pnl[t] = pnl_t - cost_factor * turnover_t

    return pnl


# ---- Metrics ----------------------------------------------------------------

def _sharpe(daily_returns: np.ndarray, periods: int = 252) -> float:
    mu = np.nanmean(daily_returns)
    sigma = np.nanstd(daily_returns, ddof=1)
    return float(mu / sigma * np.sqrt(periods)) if sigma > 1e-12 else 0.0


def _max_drawdown(cumulative_pnl: np.ndarray) -> float:
    hwm = np.maximum.accumulate(cumulative_pnl)
    dd = cumulative_pnl - hwm
    return float(np.min(dd))


def _calmar(total_pnl: float, max_dd: float, years: float) -> float:
    if max_dd >= 0 or years < 1e-6:
        return 0.0
    return float((total_pnl / years) / abs(max_dd))


# ---- Result container -------------------------------------------------------

@dataclass
class BacktestResult:
    daily_pnl: np.ndarray
    cumulative_pnl: np.ndarray
    sharpe: float
    max_drawdown: float
    calmar: float
    total_return: float
    annualized_return: float
    win_rate: float
    dates: Optional[pd.Index] = None
    per_asset_pnl: Optional[np.ndarray] = None
    metadata: Dict = field(default_factory=dict)

    def summary(self) -> Dict:
        return {
            "sharpe": round(self.sharpe, 3),
            "max_drawdown": round(self.max_drawdown, 4),
            "calmar": round(self.calmar, 3),
            "total_return": round(self.total_return, 4),
            "annualized_return": round(self.annualized_return, 4),
            "win_rate": round(self.win_rate, 4),
        }

    def to_series(self) -> pd.Series:
        idx = self.dates if self.dates is not None else range(len(self.daily_pnl))
        return pd.Series(self.daily_pnl, index=idx, name="daily_pnl")


# ---- Main backtester --------------------------------------------------------

def run_backtest(
    prices: Union[np.ndarray, pd.DataFrame],
    signals: Union[np.ndarray, pd.DataFrame],
    capital: float = 1_000_000.0,
    fee_bps: float = 1.0,
    slippage_bps: float = 2.0,
    signal_scale: float = 1.0,
    periods_per_year: int = 252,
) -> BacktestResult:
    """
    Run vectorized backtest.

    signals: each signal[t] generates position[t+1] (no-lookahead).
    Capital is allocated proportionally to signal magnitude, summing to 1.
    """
    dates = None
    if isinstance(prices, pd.DataFrame):
        dates = prices.index
        prices = prices.values.astype(float)
    if isinstance(signals, pd.DataFrame):
        signals = signals.values.astype(float)

    prices = np.asarray(prices, dtype=float)
    signals = np.asarray(signals, dtype=float)
    T, N = prices.shape

    # Normalize signals → positions (lag by 1 for no-lookahead)
    raw_pos = np.zeros_like(signals)
    for t in range(T):
        row = signals[t] * signal_scale
        abs_sum = np.sum(np.abs(row))
        raw_pos[t] = row / abs_sum if abs_sum > 1e-12 else row

    # Lag: position applied next day
    positions = np.zeros_like(raw_pos)
    positions[1:] = raw_pos[:-1]

    daily_pnl = _compute_pnl_vec(prices, positions, fee_bps, slippage_bps)
    daily_pnl = daily_pnl * capital

    cumulative_pnl = np.cumsum(daily_pnl)
    sharpe = _sharpe(daily_pnl / capital, periods_per_year)
    max_dd = _max_drawdown(cumulative_pnl)
    years = T / periods_per_year
    calmar = _calmar(cumulative_pnl[-1] if T > 0 else 0.0, max_dd, years)
    total_ret = cumulative_pnl[-1] / capital if T > 0 else 0.0
    ann_ret = (1 + total_ret) ** (1 / years) - 1 if years > 0 else 0.0
    win_rate = float(np.sum(daily_pnl > 0) / max(np.sum(daily_pnl != 0), 1))

    return BacktestResult(
        daily_pnl=daily_pnl,
        cumulative_pnl=cumulative_pnl,
        sharpe=sharpe,
        max_drawdown=max_dd,
        calmar=calmar,
        total_return=total_ret,
        annualized_return=ann_ret,
        win_rate=win_rate,
        dates=dates,
    )


# ---- Walk-forward validation ------------------------------------------------

def walk_forward(
    prices: Union[np.ndarray, pd.DataFrame],
    signals: Union[np.ndarray, pd.DataFrame],
    train_size: int = 252,
    test_size: int = 63,
    **backtest_kwargs,
) -> List[BacktestResult]:
    """
    Rolling walk-forward: train on [0:train_size], test on [train_size:train_size+test_size],
    then slide by test_size.
    Returns list of BacktestResult for each out-of-sample window.
    """
    if isinstance(prices, pd.DataFrame):
        prices_arr = prices.values.astype(float)
        dates_idx = prices.index
    else:
        prices_arr = np.asarray(prices, dtype=float)
        dates_idx = None

    if isinstance(signals, pd.DataFrame):
        signals_arr = signals.values.astype(float)
    else:
        signals_arr = np.asarray(signals, dtype=float)

    T = prices_arr.shape[0]
    results = []
    start = 0

    while start + train_size + test_size <= T:
        oos_start = start + train_size
        oos_end = oos_start + test_size

        p_oos = prices_arr[oos_start:oos_end]
        s_oos = signals_arr[oos_start:oos_end]

        d_oos = None
        if dates_idx is not None:
            d_oos = dates_idx[oos_start:oos_end]

        p_df = pd.DataFrame(p_oos, index=d_oos) if d_oos is not None else p_oos
        s_df = pd.DataFrame(s_oos, index=d_oos) if d_oos is not None else s_oos

        result = run_backtest(p_df, s_df, **backtest_kwargs)
        results.append(result)
        start += test_size

    return results


# ---- Monte Carlo simulation -------------------------------------------------

def monte_carlo(
    daily_returns: np.ndarray,
    n_paths: int = 1000,
    horizon: int = 252,
    capital: float = 1_000_000.0,
    seed: Optional[int] = 42,
) -> Dict[str, np.ndarray]:
    """
    Bootstrap Monte Carlo: resample daily returns to simulate future paths.
    Returns dict with 'paths' [n_paths x horizon], 'percentiles' at 5/25/50/75/95.
    """
    rng = np.random.default_rng(seed)
    ret_clean = daily_returns[~np.isnan(daily_returns)]
    if len(ret_clean) == 0:
        return {"paths": np.zeros((n_paths, horizon)), "percentiles": np.zeros((5, horizon))}

    sampled = rng.choice(ret_clean, size=(n_paths, horizon), replace=True)
    paths = capital * np.cumprod(1 + sampled / capital, axis=1)

    pcts = np.percentile(paths, [5, 25, 50, 75, 95], axis=0)
    return {"paths": paths, "percentiles": pcts}
