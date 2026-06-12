# backend/backtester/signal_engine.py
"""
Signal engine: feature generation, asset ranking, indicator calculation,
regime detection, and signal aggregation for the backtesting engine.
"""
from __future__ import annotations

import math
from typing import Dict, Optional, Tuple

import numpy as np
import pandas as pd

# ── Technical indicators ──────────────────────────────────────────────────────

def sma(series: pd.Series, window: int) -> pd.Series:
    return series.rolling(window, min_periods=1).mean()


def ema(series: pd.Series, window: int) -> pd.Series:
    return series.ewm(span=window, adjust=False).mean()


def rsi(series: pd.Series, window: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0).rolling(window, min_periods=1).mean()
    loss = (-delta.clip(upper=0)).rolling(window, min_periods=1).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100.0 - 100.0 / (1.0 + rs)


def macd(
    series: pd.Series,
    fast: int = 12,
    slow: int = 26,
    signal_period: int = 9,
) -> Tuple[pd.Series, pd.Series, pd.Series]:
    """Returns (macd_line, signal_line, histogram)."""
    fast_ema = ema(series, fast)
    slow_ema = ema(series, slow)
    macd_line = fast_ema - slow_ema
    signal_line = ema(macd_line, signal_period)
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram


def bollinger_bands(
    series: pd.Series, window: int = 20, n_std: float = 2.0
) -> Tuple[pd.Series, pd.Series, pd.Series]:
    """Returns (upper, mid, lower)."""
    mid = sma(series, window)
    std = series.rolling(window, min_periods=1).std()
    return mid + n_std * std, mid, mid - n_std * std


def atr(high: pd.Series, low: pd.Series, close: pd.Series, window: int = 14) -> pd.Series:
    tr = pd.concat([
        high - low,
        (high - close.shift(1)).abs(),
        (low - close.shift(1)).abs(),
    ], axis=1).max(axis=1)
    return tr.rolling(window, min_periods=1).mean()


def stochastic(
    high: pd.Series, low: pd.Series, close: pd.Series,
    k_window: int = 14, d_window: int = 3
) -> Tuple[pd.Series, pd.Series]:
    """Returns (%K, %D)."""
    lowest_low = low.rolling(k_window, min_periods=1).min()
    highest_high = high.rolling(k_window, min_periods=1).max()
    denom = (highest_high - lowest_low).replace(0, np.nan)
    k = 100.0 * (close - lowest_low) / denom
    d = k.rolling(d_window, min_periods=1).mean()
    return k, d


def adx(
    high: pd.Series, low: pd.Series, close: pd.Series, window: int = 14
) -> pd.Series:
    """Average Directional Index (trend strength, not direction)."""
    tr_series = atr(high, low, close, window=1)
    plus_dm = (high.diff()).clip(lower=0)
    minus_dm = (-low.diff()).clip(lower=0)
    # Zero out when the other direction is larger
    plus_dm[plus_dm < minus_dm] = 0.0
    minus_dm[minus_dm < plus_dm] = 0.0

    smooth_tr = tr_series.rolling(window).mean()
    smooth_plus = plus_dm.rolling(window).mean()
    smooth_minus = minus_dm.rolling(window).mean()

    plus_di = 100.0 * smooth_plus / smooth_tr.replace(0, np.nan)
    minus_di = 100.0 * smooth_minus / smooth_tr.replace(0, np.nan)
    dx = 100.0 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return dx.rolling(window).mean()


def obv(close: pd.Series, volume: pd.Series) -> pd.Series:
    """On-Balance Volume."""
    direction = np.sign(close.diff()).fillna(0)
    return (direction * volume).cumsum()


def vwap_series(
    close: pd.Series, volume: pd.Series, window: int = 20
) -> pd.Series:
    """Rolling VWAP."""
    pv = close * volume
    return pv.rolling(window, min_periods=1).sum() / volume.rolling(window, min_periods=1).sum()


def momentum(series: pd.Series, window: int = 20) -> pd.Series:
    """Simple price momentum: (price / price_n_bars_ago) - 1."""
    return series / series.shift(window) - 1.0


def volatility_realized(returns: pd.Series, window: int = 20) -> pd.Series:
    """Annualized realized volatility."""
    return returns.rolling(window, min_periods=2).std() * math.sqrt(252)


def z_score(series: pd.Series, window: int = 20) -> pd.Series:
    mu = series.rolling(window, min_periods=1).mean()
    sigma = series.rolling(window, min_periods=1).std()
    return (series - mu) / sigma.replace(0, np.nan)


# ── Feature generation ────────────────────────────────────────────────────────

def generate_features(
    ohlcv: pd.DataFrame,
    symbol: str,
    extra: Optional[Dict] = None,
) -> pd.DataFrame:
    """
    Generate a full feature matrix for a single symbol from OHLCV data.
    Returns DataFrame with all features as columns, DatetimeIndex.
    """
    df = ohlcv.copy()
    close = df["close"]
    high = df.get("high", close)
    low = df.get("low", close)
    volume = df.get("volume", pd.Series(1.0, index=df.index))
    returns = close.pct_change().fillna(0)

    feats = pd.DataFrame(index=df.index)
    feats["ret_1d"] = returns
    feats["ret_5d"] = close.pct_change(5)
    feats["ret_20d"] = close.pct_change(20)
    feats["ret_60d"] = close.pct_change(60)

    feats["sma_5"] = sma(close, 5)
    feats["sma_20"] = sma(close, 20)
    feats["sma_50"] = sma(close, 50)
    feats["sma_200"] = sma(close, 200)

    feats["ema_9"] = ema(close, 9)
    feats["ema_21"] = ema(close, 21)

    feats["rsi_14"] = rsi(close, 14)
    feats["rsi_28"] = rsi(close, 28)

    macd_l, macd_s, macd_h = macd(close)
    feats["macd_line"] = macd_l
    feats["macd_signal"] = macd_s
    feats["macd_hist"] = macd_h

    bb_up, bb_mid, bb_lo = bollinger_bands(close)
    feats["bb_pct_b"] = (close - bb_lo) / (bb_up - bb_lo).replace(0, np.nan)
    feats["bb_width"] = (bb_up - bb_lo) / bb_mid.replace(0, np.nan)

    feats["atr_14"] = atr(high, low, close, 14)
    feats["atr_pct"] = feats["atr_14"] / close

    k, d = stochastic(high, low, close)
    feats["stoch_k"] = k
    feats["stoch_d"] = d

    feats["adx_14"] = adx(high, low, close, 14)

    feats["obv"] = obv(close, volume)
    feats["vwap_20"] = vwap_series(close, volume, 20)
    feats["price_vs_vwap"] = close / feats["vwap_20"] - 1.0

    feats["momentum_20"] = momentum(close, 20)
    feats["momentum_60"] = momentum(close, 60)

    feats["vol_20d"] = volatility_realized(returns, 20)
    feats["vol_60d"] = volatility_realized(returns, 60)

    feats["zscore_20"] = z_score(close, 20)
    feats["zscore_60"] = z_score(close, 60)

    feats["sma_cross"] = (feats["sma_5"] > feats["sma_20"]).astype(float) * 2 - 1
    feats["price_above_200sma"] = (close > feats["sma_200"]).astype(float)

    if extra:
        for k, v in extra.items():
            feats[k] = v

    return feats.fillna(0)


# ── Regime detection ──────────────────────────────────────────────────────────

def detect_regime(
    returns: pd.Series,
    vol_window: int = 20,
    trend_window: int = 50,
) -> pd.Series:
    """
    Rule-based regime classification:
    Returns Series of strings: "bull" | "bear" | "sideways" | "crisis"
    """
    vol = volatility_realized(returns, vol_window)
    trend = returns.rolling(trend_window, min_periods=5).mean() * 252   # annualized

    regime = pd.Series("sideways", index=returns.index)
    regime[trend > 0.15] = "bull"
    regime[trend < -0.15] = "bear"
    # Crisis: high vol regime
    vol_threshold = vol.quantile(0.90)
    regime[vol > vol_threshold] = "crisis"

    return regime


# ── Asset ranking ─────────────────────────────────────────────────────────────

def rank_assets(
    scores: pd.Series,           # symbol → raw score
    method: str = "cross_sectional",
    top_n: Optional[int] = None,
    long_short: bool = True,
) -> pd.Series:
    """
    Rank assets by score and produce normalized weights.

    method:
      "cross_sectional" — z-score normalize, then cap at ±1
      "percentile"      — rank → uniform [0,1]
      "top_n"           — binary: top N long, bottom N short
    Returns Series: symbol → weight ∈ [-1, +1]
    """
    if scores.empty:
        return scores

    if method == "cross_sectional":
        mu, sigma = scores.mean(), scores.std()
        if sigma < 1e-9:
            return pd.Series(0.0, index=scores.index)
        ranked = ((scores - mu) / sigma).clip(-3, 3) / 3.0
    elif method == "percentile":
        ranked = scores.rank(pct=True) * 2.0 - 1.0
    elif method == "top_n":
        n = top_n or max(1, len(scores) // 4)
        ranked = pd.Series(0.0, index=scores.index)
        sorted_scores = scores.sort_values(ascending=False)
        ranked[sorted_scores.head(n).index] = 1.0
        if long_short:
            ranked[sorted_scores.tail(n).index] = -1.0
    else:
        ranked = scores.copy()

    if not long_short:
        ranked = ranked.clip(lower=0)

    # Normalize so |weights| sum to 1
    total = ranked.abs().sum()
    if total > 0:
        ranked = ranked / total

    return ranked


# ── Signal aggregation ────────────────────────────────────────────────────────

def aggregate_signals(
    signals: Dict[str, pd.Series],   # strategy_name → score series
    weights: Optional[Dict[str, float]] = None,
    method: str = "weighted_mean",
) -> pd.Series:
    """
    Aggregate multiple strategy signal series into a single composite signal.

    method: "weighted_mean" | "median" | "majority_vote"
    """
    if not signals:
        return pd.Series(dtype=float)

    df = pd.DataFrame(signals)
    n = len(df.columns)

    if weights is None:
        weights = {s: 1.0 / n for s in df.columns}

    if method == "weighted_mean":
        w = np.array([weights.get(s, 1.0 / n) for s in df.columns])
        w = w / w.sum()
        return (df * w).sum(axis=1)
    elif method == "median":
        return df.median(axis=1)
    elif method == "majority_vote":
        votes = np.sign(df)
        return votes.mean(axis=1)
    else:
        return df.mean(axis=1)


# ── Calculate indicators bundle ────────────────────────────────────────────────

def calculate_indicators(
    ohlcv: pd.DataFrame,
    symbol: str = "",
) -> Dict[str, pd.Series]:
    """
    Convenience wrapper: returns dict of all indicator series for a symbol.
    """
    close = ohlcv["close"]
    high = ohlcv.get("high", close)
    low = ohlcv.get("low", close)
    volume = ohlcv.get("volume", pd.Series(1.0, index=ohlcv.index))
    returns = close.pct_change().fillna(0)

    macd_l, macd_s, macd_h = macd(close)
    bb_up, bb_mid, bb_lo = bollinger_bands(close)
    stoch_k, stoch_d = stochastic(high, low, close)

    return {
        "sma_20": sma(close, 20),
        "sma_50": sma(close, 50),
        "sma_200": sma(close, 200),
        "ema_9": ema(close, 9),
        "ema_21": ema(close, 21),
        "rsi_14": rsi(close, 14),
        "macd": macd_l,
        "macd_signal": macd_s,
        "macd_hist": macd_h,
        "bb_upper": bb_up,
        "bb_mid": bb_mid,
        "bb_lower": bb_lo,
        "atr_14": atr(high, low, close, 14),
        "stoch_k": stoch_k,
        "stoch_d": stoch_d,
        "adx_14": adx(high, low, close, 14),
        "obv": obv(close, volume),
        "vwap_20": vwap_series(close, volume, 20),
        "momentum_20": momentum(close, 20),
        "vol_20d": volatility_realized(returns, 20),
        "zscore_20": z_score(close, 20),
    }
