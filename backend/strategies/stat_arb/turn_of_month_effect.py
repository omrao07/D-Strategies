#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
turn_of_month_effect.py — Last day + first 3 trading days of month = positive return bias
===========================================================================================
The turn-of-month (TOM) effect: stocks systematically outperform in the last trading
day of the month and first 3 trading days of the next month due to institutional
rebalancing and pension fund inflows.

Inputs (CSV)
------------
--prices  prices.csv   Columns: date, close, [ticker]

Outputs
-------
outdir/tom_returns.csv     daily returns tagged TOM vs non-TOM
outdir/backtest.csv        cumulative P&L: long TOM, flat otherwise
outdir/summary.json        avg TOM return, t-stat, Sharpe
"""

import argparse
import json
import os

import numpy as np
import pandas as pd
from scipy import stats


def is_tom(date: pd.Timestamp, window_end: int = 3) -> bool:
    """True if date is last day of month or first N trading days of next month."""
    if date.month != (date + pd.offsets.BDay(1)).month:
        return True
    if date.day <= window_end + 2:
        return True
    return False


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    df = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]
    df = df.sort_values("date")

    if "ticker" in df.columns:
        close = df.pivot(index="date", columns="ticker", values="close").sort_index()
        returns = close.pct_change().mean(axis=1)
    else:
        returns = df.set_index("date")["close"].pct_change()

    ret_df = returns.to_frame("return").dropna()
    ret_df["is_tom"] = [is_tom(d, cfg.window) for d in ret_df.index]

    tom = ret_df[ret_df["is_tom"]]["return"]
    non_tom = ret_df[~ret_df["is_tom"]]["return"]

    t_stat, p_val = stats.ttest_ind(tom, non_tom)

    ret_df.to_csv(os.path.join(cfg.outdir, "tom_returns.csv"))

    # Backtest: long on TOM days, flat otherwise
    ret_df["position"] = ret_df["is_tom"].astype(int)
    ret_df["strategy_return"] = ret_df["position"] * ret_df["return"]
    ret_df["cumulative"] = (1 + ret_df["strategy_return"]).cumprod()
    ret_df[["strategy_return", "cumulative"]].to_csv(os.path.join(cfg.outdir, "backtest.csv"))

    strat = ret_df["strategy_return"].dropna()
    summary = {"n_tom_days": int(tom.count()), "n_non_tom_days": int(non_tom.count()),
               "avg_tom_return": float(tom.mean()), "avg_non_tom_return": float(non_tom.mean()),
               "tom_premium_bps": float((tom.mean() - non_tom.mean()) * 10000),
               "t_stat": float(t_stat), "p_value": float(p_val),
               "strategy_ann_return": float(strat.mean() * 252),
               "strategy_sharpe": float(strat.mean() / strat.std() * np.sqrt(252)) if strat.std() > 0 else None,
               "tom_window_days": cfg.window}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"TOM effect | TOM avg: {summary['avg_tom_return']:.4f} | Non-TOM avg: {summary['avg_non_tom_return']:.4f} | p={summary['p_value']:.3f} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--window", type=int, default=3, help="Number of first trading days to include as TOM")
    ap.add_argument("--outdir", default="./artifacts/turn_of_month")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
