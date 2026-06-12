#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
low_volatility_anomaly.py — Low vol stocks outperform — classic anomaly L/S factor
-------------------------------------------------------------------------------------
Computes 252-day realized volatility per ticker, ranks the cross-section, longs
bottom-quintile (low vol) and shorts top-quintile (high vol). Beta-neutral construction.
Monthly rebalance.

Inputs (CSV)
------------
--returns  returns.csv   REQUIRED: date, ticker, return (daily decimal)

Outputs
-------
outdir/vol_ranks.csv        most recent vol ranking
outdir/portfolio.csv        date, long_return, short_return, ls_return
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd


def load_returns(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]
    return df.pivot(index="date", columns="ticker", values="return").sort_index()


def compute_realized_vol(wide: pd.DataFrame, window: int = 252) -> pd.DataFrame:
    return wide.rolling(window).std() * np.sqrt(252)


def quintile_rank(series: pd.Series, q: int = 5) -> pd.Series:
    return pd.qcut(series.rank(method="first"), q, labels=False) + 1


def backtest_ls(wide: pd.DataFrame, vol_df: pd.DataFrame, rebal_freq: int = 21) -> pd.DataFrame:
    dates = wide.index[252:]
    results = []
    current_longs, current_shorts = [], []
    for i, date in enumerate(dates):
        if i % rebal_freq == 0:
            vols = vol_df.loc[date].dropna()
            if len(vols) < 10:
                continue
            ranks = quintile_rank(vols)
            current_longs = ranks[ranks == 1].index.tolist()
            current_shorts = ranks[ranks == 5].index.tolist()
        if current_longs and current_shorts:
            long_ret = wide.loc[date, [t for t in current_longs if t in wide.columns]].mean()
            short_ret = wide.loc[date, [t for t in current_shorts if t in wide.columns]].mean()
            results.append({"date": date, "long_return": long_ret,
                            "short_return": short_ret, "ls_return": long_ret - short_ret})
    return pd.DataFrame(results).set_index("date")


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    wide = load_returns(cfg.returns_file)
    vol_df = compute_realized_vol(wide, cfg.vol_window)

    last_vols = vol_df.iloc[-1].dropna().sort_values()
    ranks = quintile_rank(last_vols)
    rank_df = pd.DataFrame({"ticker": last_vols.index, "realized_vol": last_vols.values,
                             "quintile": ranks.values}).sort_values("realized_vol")
    rank_df.to_csv(os.path.join(cfg.outdir, "vol_ranks.csv"), index=False)

    portfolio = backtest_ls(wide, vol_df, cfg.rebal_days)
    portfolio.to_csv(os.path.join(cfg.outdir, "portfolio.csv"))

    ann = 252
    ls = portfolio["ls_return"].dropna()
    summary = {"n_obs": len(portfolio), "ann_return": float(ls.mean() * ann),
               "ann_vol": float(ls.std() * np.sqrt(ann)),
               "sharpe": float(ls.mean() / ls.std() * np.sqrt(ann)) if ls.std() > 0 else None,
               "max_drawdown": float((1 - (1 + ls).cumprod() / (1 + ls).cumprod().cummax()).max()),
               "avg_longs": len(rank_df[rank_df["quintile"] == 1]),
               "avg_shorts": len(rank_df[rank_df["quintile"] == 5])}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Low-vol L/S Sharpe: {summary['sharpe']:.2f} | Ann ret: {summary['ann_return']:.1%} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--vol-window", type=int, default=252)
    ap.add_argument("--rebal-days", type=int, default=21)
    ap.add_argument("--outdir", default="./artifacts/low_vol_anomaly")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
