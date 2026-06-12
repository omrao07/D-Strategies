# backend/indicators/technical.py
"""
Shared TA library used by all 323 strategies.
Pure numpy/pandas — no external TA libraries required.
All functions accept pandas Series or numpy arrays; return Series.
"""
from __future__ import annotations

from typing import Tuple, Union

import numpy as np
import pandas as pd

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
        lower_band.iat[i - 1]
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


# ---- HMA / KAMA / T3 -------------------------------------------------------

def hma(series: ArrayLike, period: int) -> pd.Series:
    """Hull Moving Average: sqrt(period) WMA of (2*WMA(n/2) - WMA(n))."""
    s = _s(series)
    half = max(1, period // 2)
    sqrt_p = max(1, int(period ** 0.5))
    return wma(2 * wma(s, half) - wma(s, period), sqrt_p)


def kama(series: ArrayLike, period: int = 10,
         fast: int = 2, slow: int = 30) -> pd.Series:
    """Kaufman Adaptive Moving Average."""
    s = _s(series).values.astype(float)
    fast_sc = 2.0 / (fast + 1)
    slow_sc = 2.0 / (slow + 1)
    result = np.full(len(s), np.nan)
    if len(s) <= period:
        return pd.Series(result)
    result[period - 1] = s[period - 1]
    for i in range(period, len(s)):
        direction = abs(s[i] - s[i - period])
        volatility = sum(abs(s[j] - s[j - 1]) for j in range(i - period + 1, i + 1))
        er = direction / volatility if volatility > 0 else 0.0
        sc = (er * (fast_sc - slow_sc) + slow_sc) ** 2
        result[i] = result[i - 1] + sc * (s[i] - result[i - 1])
    return pd.Series(result)


def t3(series: ArrayLike, period: int = 5, v: float = 0.7) -> pd.Series:
    """Tillson T3 moving average."""
    c1 = -(v ** 3)
    c2 = 3 * v ** 2 + 3 * v ** 3
    c3 = -6 * v ** 2 - 3 * v - 3 * v ** 3
    c4 = 1 + 3 * v + v ** 3 + 3 * v ** 2
    e1 = ema(series, period)
    e2 = ema(e1, period)
    e3 = ema(e2, period)
    e4 = ema(e3, period)
    e5 = ema(e4, period)
    e6 = ema(e5, period)
    return c1 * e6 + c2 * e5 + c3 * e4 + c4 * e3


# ---- Stochastic RSI ---------------------------------------------------------

def stoch_rsi(series: ArrayLike, rsi_period: int = 14,
              stoch_period: int = 14, smooth_k: int = 3,
              smooth_d: int = 3) -> Tuple[pd.Series, pd.Series]:
    """Stochastic RSI: %K and %D."""
    r = rsi(series, rsi_period)
    r_min = r.rolling(stoch_period).min()
    r_max = r.rolling(stoch_period).max()
    denom = r_max - r_min
    k = ((r - r_min) / denom.replace(0, np.nan)).fillna(0.5) * 100
    k_smooth = k.rolling(smooth_k).mean()
    d_smooth = k_smooth.rolling(smooth_d).mean()
    return k_smooth, d_smooth


# ---- GARCH(1,1) Volatility --------------------------------------------------

def garch_vol(returns: ArrayLike, omega: float = 1e-6,
              alpha: float = 0.1, beta: float = 0.85,
              annualize: bool = True) -> pd.Series:
    """
    GARCH(1,1) conditional volatility estimate.
    omega, alpha, beta: model parameters (alpha+beta < 1 for stationarity).
    """
    r = _s(returns).values.astype(float)
    n = len(r)
    sigma2 = np.full(n, np.var(r))
    for t in range(1, n):
        sigma2[t] = omega + alpha * r[t - 1] ** 2 + beta * sigma2[t - 1]
    vol = np.sqrt(sigma2)
    if annualize:
        vol = vol * (252 ** 0.5)
    return pd.Series(vol)


# ---- Anchored VWAP ----------------------------------------------------------

def avwap(close: ArrayLike, volume: ArrayLike, anchor_idx: int = 0) -> pd.Series:
    """Anchored VWAP from a specified bar index."""
    c, v = _s(close), _s(volume)
    cum_pv = (c * v).cumsum()
    cum_v = v.cumsum()
    # Subtract values before anchor
    if anchor_idx > 0:
        pv_base = (c * v).iloc[:anchor_idx].sum()
        v_base = v.iloc[:anchor_idx].sum()
        result = (cum_pv - pv_base) / (cum_v - v_base).replace(0, np.nan)
    else:
        result = cum_pv / cum_v.replace(0, np.nan)
    return result


# ---- Aroon ------------------------------------------------------------------

def aroon(high: ArrayLike, low: ArrayLike,
          period: int = 25) -> Tuple[pd.Series, pd.Series]:
    """Aroon Up and Down oscillators."""
    h, l = _s(high), _s(low)
    up = h.rolling(period + 1).apply(
        lambda x: (period - (len(x) - 1 - np.argmax(x))) / period * 100, raw=True
    )
    down = l.rolling(period + 1).apply(
        lambda x: (period - (len(x) - 1 - np.argmin(x))) / period * 100, raw=True
    )
    return up, down


# ---- Ichimoku Cloud ---------------------------------------------------------

def ichimoku(
    high: ArrayLike, low: ArrayLike, close: ArrayLike,
    tenkan: int = 9, kijun: int = 26, senkou_b: int = 52, displacement: int = 26,
) -> dict:
    """
    Ichimoku Cloud components.
    Returns dict: tenkan_sen, kijun_sen, senkou_a, senkou_b, chikou_span.
    """
    h, l, c = _s(high), _s(low), _s(close)

    def mid_range(s_h, s_l, p):
        return (s_h.rolling(p).max() + s_l.rolling(p).min()) / 2

    tenkan_sen = mid_range(h, l, tenkan)
    kijun_sen = mid_range(h, l, kijun)
    senkou_a = ((tenkan_sen + kijun_sen) / 2).shift(displacement)
    senkou_b_line = mid_range(h, l, senkou_b).shift(displacement)
    chikou_span = c.shift(-displacement)
    return {
        "tenkan_sen": tenkan_sen,
        "kijun_sen": kijun_sen,
        "senkou_a": senkou_a,
        "senkou_b": senkou_b_line,
        "chikou_span": chikou_span,
    }


# ---- Fibonacci Retracement --------------------------------------------------

def fibonacci_levels(high: float, low: float) -> dict:
    """
    Classic Fibonacci retracement and extension levels.
    Returns levels keyed by ratio string.
    """
    diff = high - low
    return {
        "0.0": low,
        "23.6": low + 0.236 * diff,
        "38.2": low + 0.382 * diff,
        "50.0": low + 0.500 * diff,
        "61.8": low + 0.618 * diff,
        "78.6": low + 0.786 * diff,
        "100.0": high,
        "127.2": high + 0.272 * diff,
        "161.8": high + 0.618 * diff,
    }


# ---- Pivot Points -----------------------------------------------------------

def pivot_points(
    prev_high: float, prev_low: float, prev_close: float
) -> dict:
    """Classic floor trader pivot points with S1/S2/S3 and R1/R2/R3."""
    pp = (prev_high + prev_low + prev_close) / 3
    r1 = 2 * pp - prev_low
    s1 = 2 * pp - prev_high
    r2 = pp + (prev_high - prev_low)
    s2 = pp - (prev_high - prev_low)
    r3 = prev_high + 2 * (pp - prev_low)
    s3 = prev_low - 2 * (prev_high - pp)
    return {"pp": pp, "r1": r1, "r2": r2, "r3": r3, "s1": s1, "s2": s2, "s3": s3}


def camarilla_pivots(prev_high: float, prev_low: float, prev_close: float) -> dict:
    """Camarilla pivot point levels (tighter S/R near close)."""
    diff = prev_high - prev_low
    return {
        "h4": prev_close + diff * 1.1 / 2,
        "h3": prev_close + diff * 1.1 / 4,
        "l3": prev_close - diff * 1.1 / 4,
        "l4": prev_close - diff * 1.1 / 2,
    }
