#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
holiday_effect.py — Pre-holiday drift — documented 30-year anomaly
====================================================================
The pre-holiday effect: stocks earn significantly higher returns on the last trading
day before a market holiday. This script identifies pre-holiday days, computes the
anomaly, and backtests a long pre-holiday strategy.

Inputs (CSV)
------------
--prices    prices.csv    Columns: date, close, [ticker]
--holidays  holidays.csv  OPTIONAL: date (holiday dates). If not provided, uses US NYSE holidays.

Outputs
-------
outdir/preholiday_returns.csv   tagged daily returns
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


US_HOLIDAYS = [
    "2019-01-01","2019-01-21","2019-02-18","2019-04-19","2019-05-27","2019-07-04",
    "2019-09-02","2019-11-28","2019-12-25",
    "2020-01-01","2020-01-20","2020-02-17","2020-04-10","2020-05-25","2020-07-03",
    "2020-09-07","2020-11-26","2020-12-25",
    "2021-01-01","2021-01-18","2021-02-15","2021-04-02","2021-05-31","2021-07-05",
    "2021-09-06","2021-11-25","2021-12-24",
    "2022-01-17","2022-02-21","2022-04-15","2022-05-30","2022-06-20","2022-07-04",
    "2022-09-05","2022-11-24","2022-12-26",
    "2023-01-02","2023-01-16","2023-02-20","2023-04-07","2023-05-29","2023-06-19",
    "2023-07-04","2023-09-04","2023-11-23","2023-12-25",
    "2024-01-01","2024-01-15","2024-02-19","2024-03-29","2024-05-27","2024-06-19",
    "2024-07-04","2024-09-02","2024-11-28","2024-12-25",
]


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

    if cfg.holidays_file:
        hols = pd.to_datetime(pd.read_csv(cfg.holidays_file)["date"])
    else:
        hols = pd.to_datetime(US_HOLIDAYS)

    hol_set = set(hols)
    trading_dates = sorted(returns.index)
    preholiday = set()
    for i, d in enumerate(trading_dates[:-1]):
        next_d = trading_dates[i + 1]
        # If there's a gap (holiday or weekend between), next trading day is post-holiday
        # Pre-holiday = last trading day before a holiday
        skip = pd.date_range(d + pd.Timedelta(days=1), next_d - pd.Timedelta(days=1), freq="B")
        if any(s in hol_set for s in skip):
            preholiday.add(d)

    ret_df = returns.to_frame("return").dropna()
    ret_df["is_preholiday"] = ret_df.index.isin(preholiday)

    pre = ret_df[ret_df["is_preholiday"]]["return"]
    normal = ret_df[~ret_df["is_preholiday"]]["return"]
    t_stat, p_val = stats.ttest_ind(pre, normal)

    ret_df.to_csv(os.path.join(cfg.outdir, "preholiday_returns.csv"))

    ret_df["strategy_return"] = ret_df["is_preholiday"].astype(int) * ret_df["return"]
    ret_df["cumulative"] = (1 + ret_df["strategy_return"]).cumprod()
    ret_df[["strategy_return", "cumulative"]].to_csv(os.path.join(cfg.outdir, "backtest.csv"))

    strat = ret_df["strategy_return"].dropna()
    summary = {"n_preholiday_days": int(pre.count()), "n_normal_days": int(normal.count()),
               "avg_preholiday_return": float(pre.mean()), "avg_normal_return": float(normal.mean()),
               "premium_bps": float((pre.mean() - normal.mean()) * 10000),
               "t_stat": float(t_stat), "p_value": float(p_val),
               "strategy_ann_return": float(strat.mean() * 252),
               "strategy_sharpe": float(strat.mean() / strat.std() * np.sqrt(252)) if strat.std() > 0 else None}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Holiday effect | Pre-holiday avg: {summary['avg_preholiday_return']:.4f} | Normal avg: {summary['avg_normal_return']:.4f} | p={summary['p_value']:.3f} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--holidays", default=None, dest="holidays_file")
    ap.add_argument("--outdir", default="./artifacts/holiday_effect")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
