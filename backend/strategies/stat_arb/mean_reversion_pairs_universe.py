#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# mean_reversion_pairs_universe.py
#
# Mean-Reversion Pairs Universe — Engle-Granger cointegration on 500+ pairs
# -------------------------------------------------------------------------
# Runs the Engle-Granger two-step cointegration test on every candidate pair
# in a universe of equities.  For cointegrated pairs, fits the hedge ratio via
# OLS, computes a rolling z-score of the spread, generates long/short signals
# when |z| > entry_z and exits when |z| < exit_z, then backtests a simple
# dollar-neutral equity curve.
#
# Inputs
# ------
# --prices FILE  (CSV, required)
#   date,TICKER1,TICKER2,...
#   One row per trading day; date column + one column per ticker (adjusted close).
#
# --pairs FILE  (CSV, optional)
#   leg1,leg2
#   If omitted, all n*(n-1)/2 unique pairs are tested (warning: slow for n>50).
#
# Outputs
# -------
# outdir/
#   run_params.json
#   cointegrated_pairs.csv       — pair, p_value, hedge_ratio, half_life
#   zscore_series.csv            — date, pair, z_score (long format)
#   signal_log.csv               — date, pair, signal (+1/-1/0)
#   equity_curve.csv             — date, portfolio_value, daily_return
#
# Usage
# -----
# python mean_reversion_pairs_universe.py \
#   --prices prices.csv \
#   --pairs pairs.csv \
#   --lookback 252 \
#   --entry-z 2.0 \
#   --exit-z 0.5 \
#   --pvalue-thresh 0.05 \
#   --zscore-window 60 \
#   --capital 1000000 \
#   --outdir ./artifacts
#
# Dependencies: pip install pandas numpy scipy statsmodels

import argparse
import json
import os
from dataclasses import asdict, dataclass
from datetime import datetime
from itertools import combinations
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from scipy import stats

try:
    from statsmodels.tsa.stattools import adfuller
except ImportError:
    raise SystemExit("statsmodels required: pip install statsmodels")


# ----------------------------- Config -----------------------------

@dataclass
class Config:
    prices: str
    pairs: Optional[str]
    lookback: int
    entry_z: float
    exit_z: float
    pvalue_thresh: float
    zscore_window: int
    capital: float
    outdir: str


# ----------------------------- IO helpers -----------------------------

def ensure_outdir(base: str, tag: str) -> str:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    outdir = os.path.join(base, f"{tag}_{ts}")
    os.makedirs(outdir, exist_ok=True)
    return outdir


def load_prices(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"], index_col="date")
    df = df.apply(pd.to_numeric, errors="coerce")
    df = df.dropna(how="all").sort_index()
    return df


def load_candidate_pairs(path: Optional[str], tickers: List[str]) -> List[Tuple[str, str]]:
    if path and os.path.exists(path):
        df = pd.read_csv(path)
        if "leg1" not in df.columns or "leg2" not in df.columns:
            raise SystemExit("pairs CSV must have columns: leg1, leg2")
        return list(zip(df["leg1"].tolist(), df["leg2"].tolist()))
    return list(combinations(tickers, 2))


# ----------------------------- Cointegration -----------------------------

def compute_half_life(spread: pd.Series) -> float:
    """Ornstein-Uhlenbeck half-life of mean reversion from AR(1) fit."""
    s = spread.dropna()
    if len(s) < 10:
        return np.nan
    lag = s.shift(1).dropna()
    delta = s.diff().dropna()
    lag = lag.iloc[: len(delta)]
    if lag.std() < 1e-10:
        return np.nan
    slope, _, _, _, _ = stats.linregress(lag.values, delta.values)
    if slope >= 0:
        return np.nan
    return float(-np.log(2) / slope)


def test_pair_cointegration(
    prices: pd.DataFrame, leg1: str, leg2: str, pvalue_thresh: float
) -> Optional[Dict]:
    """
    Engle-Granger two-step test.
    Returns dict with hedge_ratio, p_value, half_life if cointegrated, else None.
    """
    s1 = prices[leg1].dropna()
    s2 = prices[leg2].dropna()
    common = s1.index.intersection(s2.index)
    if len(common) < 60:
        return None
    s1 = s1.loc[common]
    s2 = s2.loc[common]

    # OLS hedge ratio: s1 ~ beta * s2
    slope, intercept, _, _, _ = stats.linregress(s2.values, s1.values)
    spread = s1 - slope * s2 - intercept

    # ADF on residuals
    try:
        adf_result = adfuller(spread.dropna(), maxlag=1, autolag=None)
        pval = float(adf_result[1])
    except Exception:
        return None

    if pval > pvalue_thresh:
        return None

    hl = compute_half_life(spread)
    return {
        "leg1": leg1,
        "leg2": leg2,
        "p_value": round(pval, 6),
        "hedge_ratio": round(float(slope), 6),
        "intercept": round(float(intercept), 6),
        "half_life_days": round(hl, 2) if np.isfinite(hl) else None,
    }


# ----------------------------- Z-score computation -----------------------------

def compute_rolling_zscore(
    prices: pd.DataFrame,
    pair_info: Dict,
    window: int,
) -> pd.Series:
    """Rolling z-score of the spread for one pair."""
    leg1, leg2 = pair_info["leg1"], pair_info["leg2"]
    beta = pair_info["hedge_ratio"]
    intercept = pair_info["intercept"]

    s1 = prices[leg1]
    s2 = prices[leg2]
    spread = s1 - beta * s2 - intercept

    roll_mean = spread.rolling(window, min_periods=window // 2).mean()
    roll_std = spread.rolling(window, min_periods=window // 2).std()
    z = (spread - roll_mean) / roll_std.replace(0, np.nan)
    return z


# ----------------------------- Signal generation -----------------------------

def generate_signals(
    z: pd.Series, entry_z: float, exit_z: float
) -> pd.Series:
    """
    State-machine: enter long spread (leg1 cheap) when z < -entry_z,
    enter short spread when z > entry_z, exit when |z| < exit_z.
    Returns signal series: +1 (long spread), -1 (short spread), 0 (flat).
    """
    signal = pd.Series(0, index=z.index, dtype=int)
    position = 0
    for i, (idx, zval) in enumerate(z.items()):
        if np.isnan(zval):
            signal.iloc[i] = 0
            continue
        if position == 0:
            if zval < -entry_z:
                position = 1
            elif zval > entry_z:
                position = -1
        elif position == 1:
            if zval > -exit_z:
                position = 0
        elif position == -1:
            if zval < exit_z:
                position = 0
        signal.iloc[i] = position
    return signal


# ----------------------------- Backtest -----------------------------

def backtest_pairs(
    prices: pd.DataFrame,
    coint_pairs: List[Dict],
    zscore_window: int,
    entry_z: float,
    exit_z: float,
    capital: float,
) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """
    Dollar-neutral backtest across all cointegrated pairs.
    Each pair is equally allocated. Returns (zscore_df, signal_df, equity_df).
    """
    zscore_records = []
    signal_records = []
    all_pair_returns: Dict[str, pd.Series] = {}

    n_pairs = max(len(coint_pairs), 1)
    alloc_per_pair = capital / n_pairs

    for pair_info in coint_pairs:
        leg1, leg2 = pair_info["leg1"], pair_info["leg2"]
        pair_label = f"{leg1}/{leg2}"
        beta = pair_info["hedge_ratio"]

        z = compute_rolling_zscore(prices, pair_info, zscore_window)
        sig = generate_signals(z, entry_z, exit_z)

        for date, zval in z.items():
            zscore_records.append({"date": date, "pair": pair_label, "z_score": zval})
        for date, sval in sig.items():
            signal_records.append({"date": date, "pair": pair_label, "signal": sval})

        # Daily PnL: long leg1 + short beta*leg2 when signal=+1, reverse when -1
        ret1 = prices[leg1].pct_change()
        ret2 = prices[leg2].pct_change()
        # Pair return for +1 signal: long leg1 short beta*leg2 (dollar-neutral)
        pair_ret = sig.shift(1) * (ret1 - beta * ret2) / (1 + abs(beta))
        pair_ret = pair_ret * alloc_per_pair
        all_pair_returns[pair_label] = pair_ret

    if all_pair_returns:
        combined = pd.DataFrame(all_pair_returns).fillna(0.0).sum(axis=1)
    else:
        combined = pd.Series(0.0, index=prices.index)

    equity = (capital + combined.cumsum()).rename("portfolio_value")
    daily_ret = (combined / capital).rename("daily_return")
    equity_df = pd.DataFrame({"date": equity.index, "portfolio_value": equity.values,
                               "daily_return": daily_ret.values})

    zscore_df = pd.DataFrame(zscore_records)
    signal_df = pd.DataFrame(signal_records)
    return zscore_df, signal_df, equity_df


# ----------------------------- Main -----------------------------

def main():
    ap = argparse.ArgumentParser(description="Mean-reversion pairs universe — Engle-Granger cointegration")
    ap.add_argument("--prices", required=True, help="CSV: date + ticker columns (adjusted close)")
    ap.add_argument("--pairs", default=None, help="CSV with leg1,leg2 columns (optional)")
    ap.add_argument("--lookback", type=int, default=252, help="Days of history for cointegration test (default 252)")
    ap.add_argument("--entry-z", type=float, default=2.0, dest="entry_z", help="Z-score entry threshold (default 2.0)")
    ap.add_argument("--exit-z", type=float, default=0.5, dest="exit_z", help="Z-score exit threshold (default 0.5)")
    ap.add_argument("--pvalue-thresh", type=float, default=0.05, dest="pvalue_thresh",
                    help="Max p-value for cointegration (default 0.05)")
    ap.add_argument("--zscore-window", type=int, default=60, dest="zscore_window",
                    help="Rolling window for z-score (default 60)")
    ap.add_argument("--capital", type=float, default=1_000_000, help="Starting capital in USD (default 1000000)")
    ap.add_argument("--outdir", default="./artifacts")
    args = ap.parse_args()

    cfg = Config(
        prices=args.prices,
        pairs=args.pairs,
        lookback=args.lookback,
        entry_z=args.entry_z,
        exit_z=args.exit_z,
        pvalue_thresh=args.pvalue_thresh,
        zscore_window=args.zscore_window,
        capital=args.capital,
        outdir=args.outdir,
    )

    outdir = ensure_outdir(cfg.outdir, "mean_reversion_pairs_universe")
    print(f"[INFO] Output directory: {outdir}")

    prices = load_prices(cfg.prices)
    prices = prices.tail(cfg.lookback)
    tickers = list(prices.columns)
    print(f"[INFO] Loaded {len(tickers)} tickers, {len(prices)} rows")

    candidate_pairs = load_candidate_pairs(cfg.pairs, tickers)
    print(f"[INFO] Testing {len(candidate_pairs)} candidate pairs...")

    coint_pairs = []
    for leg1, leg2 in candidate_pairs:
        if leg1 not in prices.columns or leg2 not in prices.columns:
            continue
        result = test_pair_cointegration(prices, leg1, leg2, cfg.pvalue_thresh)
        if result:
            coint_pairs.append(result)

    print(f"[INFO] Found {len(coint_pairs)} cointegrated pairs (p < {cfg.pvalue_thresh})")

    coint_df = pd.DataFrame(coint_pairs)
    coint_df.to_csv(os.path.join(outdir, "cointegrated_pairs.csv"), index=False)

    if not coint_pairs:
        print("[WARN] No cointegrated pairs found. Exiting.")
        return

    zscore_df, signal_df, equity_df = backtest_pairs(
        prices, coint_pairs, cfg.zscore_window, cfg.entry_z, cfg.exit_z, cfg.capital
    )

    zscore_df.to_csv(os.path.join(outdir, "zscore_series.csv"), index=False)
    signal_df.to_csv(os.path.join(outdir, "signal_log.csv"), index=False)
    equity_df.to_csv(os.path.join(outdir, "equity_curve.csv"), index=False)

    with open(os.path.join(outdir, "run_params.json"), "w") as f:
        json.dump(asdict(cfg), f, indent=2)

    final_val = equity_df["portfolio_value"].iloc[-1]
    total_ret = (final_val / cfg.capital - 1) * 100
    n_signals = int((signal_df["signal"] != 0).sum())
    print("\n=== Summary ===")
    print(f"Cointegrated pairs: {len(coint_pairs)}")
    print(f"Total signal bars: {n_signals}")
    print(f"Final portfolio value: ${final_val:,.0f}")
    print(f"Total return: {total_ret:.2f}%")
    print(f"Artifacts written to: {outdir}")


if __name__ == "__main__":
    main()
