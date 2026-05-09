# backend/indicators/technical.py
"""
Shared TA library used by all 323 strategies.
Pure numpy/pandas — no external TA libraries required.
All functions accept pandas Series or numpy arrays; return Series.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from typing import Optional, Tuple, Union

ArrayLike = Union[pd.Series, np.ndarray]


def _s(x: ArrayLike) -> pd.Series:
    return x if isinstance(x, pd.Series) else pd.Series(x)


# ---- Moving Averages -------------------------------------------------------

def sma(series: ArrayLike, period: int) -> pd.Series:
    return _s(series).rolling(period, min_periods=period).mean()


def ema(series: ArrayLike, period: int, adjust: bool = False) -> pd.Series:
    return _s(series).ewm(span=period, adjust=adjust).mean()


def wma(series: ArrayLike, period: int) -> pd.Series:
    w = np.arange(1, period + 1, dtype=float)
    return _s(series).rolling(period).apply(lambda x: np.dot(x, w) / w.sum(), raw=True)


def dema(series: ArrayLike, period: int) -> pd.Series:
    e = ema(series, period)
    return 2 * e - ema(e, period)


def tema(series: ArrayLike, period: int) -> pd.Series:
    e1 = ema(series, period)
    e2 = ema(e1, period)
    e3 = ema(e2, period)
    return 3 * e1 - 3 * e2 + e3


# ---- Volatility / Bands ----------------------------------------------------

def atr(high: ArrayLike, low: ArrayLike, close: ArrayLike, period: int = 14) -> pd.Series:
    h, l, c = _s(high), _s(low), _s(close)
    prev_c = c.shift(1)
    tr = pd.concat([h - l, (h - prev_c).abs(), (l - prev_c).abs()], axis=1).max(axis=1)
    return tr.ewm(span=period, adjust=False).mean()


def bollinger(
    series: ArrayLike, period: int = 20, std_mult: float = 2.0
) -> Tuple[pd.Series, pd.Series, pd.Series]:
    s = _s(series)
    mid = sma(s, period)
    std = s.rolling(period, min_periods=period).std()
    return mid - std_mult * std, mid, mid + std_mult * std


def keltner(
    high: ArrayLike, low: ArrayLike, close: ArrayLike,
    period: int = 20, mult: float = 2.0
) -> Tuple[pd.Series, pd.Series, pd.Series]:
    mid = ema(close, period)
    a = atr(high, low, close, period)
    return mid - mult * a, mid, mid + mult * a


def donchian(
    high: ArrayLike, low: ArrayLike, period: int = 20
) -> Tuple[pd.Series, pd.Series, pd.Series]:
    h, l = _s(high), _s(low)
    upper = h.rolling(period).max()
    lower = l.rolling(period).min()
    return lower, (upper + lower) / 2, upper


def historical_vol(
    close: ArrayLike, period: int = 20, annualize: bool = True
) -> pd.Series:
    log_ret = np.log(_s(close) / _s(close).shift(1))
    hv = log_ret.rolling(period).std()
    return hv * np.sqrt(252) if annualize else hv


# ---- Momentum / Oscillators ------------------------------------------------

def rsi(series: ArrayLike, period: int = 14) -> pd.Series:
    delta = _s(series).diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def macd(
    series: ArrayLike, fast: int = 12, slow: int = 26, signal: int = 9
) -> Tuple[pd.Series, pd.Series, pd.Series]:
    e_fast = ema(series, fast)
    e_slow = ema(series, slow)
    macd_line = e_fast - e_slow
    sig_line = ema(macd_line, signal)
    return macd_line, sig_line, macd_line - sig_line


def stochastic(
    high: ArrayLike, low: ArrayLike, close: ArrayLike,
    k_period: int = 14, d_period: int = 3
) -> Tuple[pd.Series, pd.Series]:
    h, l, c = _s(high), _s(low), _s(close)
    low_min = l.rolling(k_period).min()
    high_max = h.rolling(k_period).max()
    k = 100 * (c - low_min) / (high_max - low_min).replace(0, np.nan)
    d = k.rolling(d_period).mean()
    return k, d


def cci(
    high: ArrayLike, low: ArrayLike, close: ArrayLike, period: int = 20
) -> pd.Series:
    tp = (_s(high) + _s(low) + _s(close)) / 3
    mean_tp = tp.rolling(period).mean()
    mad = tp.rolling(period).apply(lambda x: np.mean(np.abs(x - x.mean())), raw=True)
    return (tp - mean_tp) / (0.015 * mad.replace(0, np.nan))


def williams_r(
    high: ArrayLike, low: ArrayLike, close: ArrayLike, period: int = 14
) -> pd.Series:
    h, l, c = _s(high), _s(low), _s(close)
    hh = h.rolling(period).max()
    ll = l.rolling(period).min()
    return -100 * (hh - c) / (hh - ll).replace(0, np.nan)


def roc(series: ArrayLike, period: int = 10) -> pd.Series:
    s = _s(series)
    return (s / s.shift(period) - 1) * 100


# ---- Volume ----------------------------------------------------------------

def vwap(
    high: ArrayLike, low: ArrayLike, close: ArrayLike, volume: ArrayLike
) -> pd.Series:
    tp = (_s(high) + _s(low) + _s(close)) / 3
    v = _s(volume)
    return (tp * v).cumsum() / v.cumsum()


def obv(close: ArrayLike, volume: ArrayLike) -> pd.Series:
    c, v = _s(close), _s(volume)
    direction = np.sign(c.diff()).fillna(0)
    return (direction * v).cumsum()


def mfi(
    high: ArrayLike, low: ArrayLike, close: ArrayLike,
    volume: ArrayLike, period: int = 14
) -> pd.Series:
    tp = (_s(high) + _s(low) + _s(close)) / 3
    v = _s(volume)
    raw_mf = tp * v
    pos_mf = raw_mf.where(tp > tp.shift(1), 0.0)
    neg_mf = raw_mf.where(tp < tp.shift(1), 0.0)
    pos_sum = pos_mf.rolling(period).sum()
    neg_sum = neg_mf.rolling(period).sum()
    mfr = pos_sum / neg_sum.replace(0, np.nan)
    return 100 - (100 / (1 + mfr))


# ---- Trend -----------------------------------------------------------------

def adx(
    high: ArrayLike, low: ArrayLike, close: ArrayLike, period: int = 14
) -> Tuple[pd.Series, pd.Series, pd.Series]:
    """Returns (ADX, +DI, -DI)."""
    h, l, c = _s(high), _s(low), _s(close)
    up = h - h.shift(1)
    down = l.shift(1) - l
    plus_dm = up.where((up > down) & (up > 0), 0.0)
    minus_dm = down.where((down > up) & (down > 0), 0.0)
    tr_series = atr(h, l, c, period)
    alpha = 1 / period
    plus_di = 100 * plus_dm.ewm(alpha=alpha, adjust=False).mean() / tr_series.replace(0, np.nan)
    minus_di = 100 * minus_dm.ewm(alpha=alpha, adjust=False).mean() / tr_series.replace(0, np.nan)
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    adx_series = dx.ewm(alpha=alpha, adjust=False).mean()
    return adx_series, plus_di, minus_di


def supertrend(
    high: ArrayLike, low: ArrayLike, close: ArrayLike,
    period: int = 10, mult: float = 3.0
) -> Tuple[pd.Series, pd.Series]:
    """Returns (supertrend line, direction: 1=up, -1=down)."""
    h, l, c = _s(high), _s(low), _s(close)
    hl2 = (h + l) / 2
    a = atr(h, l, c, period)
    upper_band = hl2 + mult * a
    lower_band = hl2 - mult * a

    trend = pd.Series(np.nan, index=c.index)
    direction = pd.Series(1, index=c.index)
    for i in range(1, len(c)):
        prev_upper = upper_band.iat[i - 1]
        prev_lower = lower_band.iat[i - 1]
        if c.iat[i] <= (prev_upper if np.isnan(trend.iat[i - 1]) else trend.iat[i - 1]):
            trend.iat[i] = upper_band.iat[i]
            direction.iat[i] = -1
        else:
            trend.iat[i] = lower_band.iat[i]
            direction.iat[i] = 1
    return trend, direction


# ---- Statistical / Regime --------------------------------------------------

def zscore(series: ArrayLike, period: int = 20) -> pd.Series:
    s = _s(series)
    m = s.rolling(period).mean()
    std = s.rolling(period).std()
    return (s - m) / std.replace(0, np.nan)


def kalman_filter(
    series: ArrayLike,
    process_var: float = 1e-5,
    measurement_var: float = 1e-2,
) -> pd.Series:
    """Scalar Kalman filter (1D random walk model)."""
    s = _s(series).values
    n = len(s)
    est = np.zeros(n)
    err = np.zeros(n)
    est[0] = s[0]
    err[0] = 1.0
    for i in range(1, n):
        pred_err = err[i - 1] + process_var
        kg = pred_err / (pred_err + measurement_var)
        est[i] = est[i - 1] + kg * (s[i] - est[i - 1])
        err[i] = (1 - kg) * pred_err
    return pd.Series(est, index=_s(series).index)


def hurst_exponent(series: ArrayLike, min_lag: int = 2, max_lag: int = 20) -> float:
    """
    Hurst exponent via R/S analysis. Returns scalar.
    H < 0.5 → mean-reverting, H > 0.5 → trending, H ≈ 0.5 → random walk.
    """
    s = np.array(_s(series).dropna(), dtype=float)
    lags = range(min_lag, min(max_lag, len(s) // 2))
    rs = []
    for lag in lags:
        chunks = [s[i: i + lag] for i in range(0, len(s) - lag, lag)]
        if not chunks:
            continue
        rs_vals = []
        for chunk in chunks:
            r = np.max(np.cumsum(chunk - chunk.mean())) - np.min(np.cumsum(chunk - chunk.mean()))
            std = chunk.std(ddof=1)
            if std > 0:
                rs_vals.append(r / std)
        if rs_vals:
            rs.append(np.mean(rs_vals))
    if len(rs) < 2:
        return 0.5
    h, _ = np.polyfit(np.log(list(lags)[: len(rs)]), np.log(rs), 1)
    return float(h)


def cointegration_score(x: ArrayLike, y: ArrayLike, period: int = 60) -> pd.Series:
    """
    Rolling OLS residual z-score (proxy for cointegration spread stationarity).
    """
    xs, ys = _s(x), _s(y)
    spread = pd.Series(np.nan, index=xs.index)
    for i in range(period, len(xs)):
        xi = xs.iloc[i - period: i].values
        yi = ys.iloc[i - period: i].values
        if np.std(xi) == 0:
            continue
        beta = np.cov(xi, yi)[0, 1] / np.var(xi)
        alpha = yi.mean() - beta * xi.mean()
        spread.iat[i] = ys.iat[i] - (beta * xs.iat[i] + alpha)
    return zscore(spread, period)
