# backend/data/quality.py
"""
Data quality checker for OHLCV DataFrames.
Validates: no gaps, no negative prices, OHLC integrity, volume >= 0, stale feeds.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import List

import pandas as pd

logger = logging.getLogger("data.quality")


@dataclass
class QualityReport:
    symbol: str
    passed: bool
    issues: List[str] = field(default_factory=list)
    n_rows: int = 0
    n_nulls: int = 0
    n_gaps: int = 0
    n_negative_prices: int = 0
    n_ohlc_violations: int = 0


def check_ohlcv(df: pd.DataFrame, symbol: str = "UNKNOWN",
                max_gap_days: int = 3) -> QualityReport:
    """
    Full quality check on a OHLCV DataFrame.
    Returns a QualityReport with all violations listed.
    """
    report = QualityReport(symbol=symbol, passed=True, n_rows=len(df))
    issues = []

    if df.empty:
        issues.append("EMPTY: DataFrame has no rows")
        return QualityReport(symbol=symbol, passed=False, issues=issues)

    required = ["open", "high", "low", "close"]
    missing_cols = [c for c in required if c not in df.columns]
    if missing_cols:
        issues.append(f"MISSING_COLS: {missing_cols}")
        return QualityReport(symbol=symbol, passed=False, issues=issues)

    # Nulls
    n_nulls = int(df[required].isnull().sum().sum())
    report.n_nulls = n_nulls
    if n_nulls > 0:
        issues.append(f"NULLS: {n_nulls} null values in OHLC columns")

    # Negative prices
    n_neg = int((df[required] < 0).sum().sum())
    report.n_negative_prices = n_neg
    if n_neg > 0:
        issues.append(f"NEGATIVE_PRICES: {n_neg} negative values")

    # OHLC integrity
    violations = (
        (df["high"] < df["low"]) |
        (df["high"] < df["open"]) |
        (df["high"] < df["close"]) |
        (df["low"] > df["open"]) |
        (df["low"] > df["close"])
    ).sum()
    report.n_ohlc_violations = int(violations)
    if violations > 0:
        issues.append(f"OHLC_VIOLATIONS: {violations} rows where H<L or H<O or H<C etc.")

    # Volume
    if "volume" in df.columns:
        neg_vol = int((df["volume"] < 0).sum())
        if neg_vol > 0:
            issues.append(f"NEGATIVE_VOLUME: {neg_vol} rows")

    # Time gaps
    if isinstance(df.index, pd.DatetimeIndex) and len(df) > 1:
        diffs = df.index.to_series().diff().dt.days.dropna()
        big_gaps = int((diffs > max_gap_days).sum())
        report.n_gaps = big_gaps
        if big_gaps > 0:
            issues.append(f"TIME_GAPS: {big_gaps} gaps > {max_gap_days} days")

    # Stale check (last row > 7 days old)
    if isinstance(df.index, pd.DatetimeIndex) and len(df) > 0:
        last = df.index[-1]
        now = pd.Timestamp.utcnow().tz_localize(None)
        age_days = (now - last).days
        if age_days > 7:
            issues.append(f"STALE: last bar is {age_days} days old")

    report.issues = issues
    report.passed = len(issues) == 0
    if not report.passed:
        logger.warning(f"[quality] {symbol}: {len(issues)} issues — {issues}")
    else:
        logger.debug(f"[quality] {symbol}: OK ({len(df)} rows)")
    return report


def drop_bad_rows(df: pd.DataFrame) -> pd.DataFrame:
    """Remove rows with any OHLC null or OHLC integrity violations."""
    if df.empty:
        return df
    cols = [c for c in ["open", "high", "low", "close"] if c in df.columns]
    df = df.dropna(subset=cols)
    if all(c in df.columns for c in ["open", "high", "low", "close"]):
        mask = (
            (df["high"] >= df["low"]) &
            (df["high"] >= df["open"]) &
            (df["high"] >= df["close"]) &
            (df["low"] <= df["open"]) &
            (df["low"] <= df["close"])
        )
        df = df[mask]
    return df
