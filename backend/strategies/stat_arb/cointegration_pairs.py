#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cointegration_pairs.py — Johansen test pairs — superior to correlation alone
=============================================================================
Runs Engle-Granger cointegration tests on all pairs in a universe, selects
cointegrated pairs, estimates the OU half-life, and backtests a z-score
mean-reversion strategy.

Inputs (CSV)
------------
--prices  prices.csv   Columns: date, ticker, close (or date + ticker columns)

Outputs
-------
outdir/cointegrated_pairs.csv   pair, hedge_ratio, half_life_days, coint_pvalue
outdir/backtest.csv             cumulative P&L from all cointegrated pairs
outdir/summary.json
"""

import argparse
import json
import os
from itertools import combinations

import numpy as np
import pandas as pd
from scipy import stats


def engle_granger_coint(y: np.ndarray, x: np.ndarray):
    """Simple Engle-Granger: regress y on x, test residuals for unit root."""
    X = np.column_stack([x, np.ones(len(x))])
    beta = np.linalg.lstsq(X, y, rcond=None)[0]
    residuals = y - X @ beta
    # ADF test approximation: regress diff on lag
    d_resid = np.diff(residuals)
    lag_resid = residuals[:-1]
    X2 = np.column_stack([lag_resid, np.ones(len(lag_resid))])
    b2 = np.linalg.lstsq(X2, d_resid, rcond=None)[0]
    pred = X2 @ b2
    sse = np.sum((d_resid - pred) ** 2)
    np.sum((d_resid - d_resid.mean()) ** 2)
    n = len(d_resid)
    se = np.sqrt(sse / (n - 2) / np.sum((lag_resid - lag_resid.mean()) ** 2))
    t_stat = b2[0] / se if se > 0 else 0
    p_val = stats.t.cdf(t_stat, df=n - 2)  # one-tailed
    return beta[0], residuals, float(p_val)


def ou_half_life(spread: np.ndarray) -> float:
    d_spread = np.diff(spread)
    lag = spread[:-1]
    X = np.column_stack([lag, np.ones(len(lag))])
    b = np.linalg.lstsq(X, d_spread, rcond=None)[0]
    lam = b[0]
    return float(-np.log(2) / lam) if lam < 0 else np.nan


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    df = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]
    wide = df.pivot(index="date", columns="ticker", values="close").sort_index().dropna()
    tickers = wide.columns.tolist()

    coint_pairs = []
    for t1, t2 in combinations(tickers, 2):
        y, x = wide[t1].values, wide[t2].values
        try:
            hedge_ratio, residuals, p_val = engle_granger_coint(y, x)
        except Exception:
            continue
        if p_val > cfg.pvalue_threshold:
            continue
        hl = ou_half_life(residuals)
        if np.isnan(hl) or hl > cfg.max_half_life or hl < 1:
            continue
        coint_pairs.append({"t1": t1, "t2": t2, "pair": f"{t1}/{t2}",
                             "hedge_ratio": hedge_ratio, "half_life_days": hl, "coint_pvalue": p_val})

    if not coint_pairs:
        print("No cointegrated pairs found at given threshold.")
        return

    pair_df = pd.DataFrame(coint_pairs).sort_values("coint_pvalue")
    pair_df.to_csv(os.path.join(cfg.outdir, "cointegrated_pairs.csv"), index=False)

    # Backtest all pairs
    all_daily = []
    for _, p in pair_df.iterrows():
        spread = wide[p["t1"]] - p["hedge_ratio"] * wide[p["t2"]]
        zscore = (spread - spread.rolling(cfg.zscore_window).mean()) / spread.rolling(cfg.zscore_window).std()
        pos = zscore.shift(1).apply(lambda z: -1 if z > 2 else (1 if z < -2 else (0 if abs(z) < 0.5 else np.nan))).ffill().fillna(0)
        ret1 = wide[p["t1"]].pct_change()
        ret2 = wide[p["t2"]].pct_change()
        pair_ret = pos * (ret1 - p["hedge_ratio"] * ret2)
        all_daily.append(pair_ret.rename(p["pair"]))

    portfolio = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
    bt = (1 + portfolio).cumprod().to_frame("cumulative")
    bt.to_csv(os.path.join(cfg.outdir, "backtest.csv"))

    summary = {"n_cointegrated_pairs": len(pair_df), "avg_half_life_days": float(pair_df["half_life_days"].mean()),
               "ann_return": float(portfolio.mean() * 252), "sharpe": float(portfolio.mean() / portfolio.std() * np.sqrt(252)) if portfolio.std() > 0 else None,
               "params": {"pvalue_threshold": cfg.pvalue_threshold, "max_half_life": cfg.max_half_life}}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Cointegrated pairs: {len(pair_df)} | Avg half-life: {summary['avg_half_life_days']:.1f}d | Sharpe: {summary['sharpe']:.2f} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--pvalue-threshold", type=float, default=0.05)
    ap.add_argument("--max-half-life", type=float, default=30.0)
    ap.add_argument("--zscore-window", type=int, default=60)
    ap.add_argument("--outdir", default="./artifacts/cointegration")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
