#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
weekend_effect.py — Friday close → Monday open systematic day-of-week patterns
================================================================================
Tests for the weekend effect: stocks tend to have lower returns on Mondays and
higher returns on Fridays. Backtests a systematic strategy exploiting this pattern.

Inputs (CSV)
------------
--prices  prices.csv
    Columns: date, [ticker], close, [open]

Outputs
-------
outdir/dow_returns.csv      avg return and t-stat per day of week
outdir/backtest.csv         cumulative P&L from long-Friday/short-Monday strategy
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd
from scipy import stats


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    df = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]
    df = df.sort_values("date")

    if "ticker" in df.columns:
        close = df.pivot(index="date", columns="ticker", values="close").sort_index()
        returns = close.pct_change().mean(axis=1)  # equal-weight universe
    else:
        returns = df.set_index("date")["close"].pct_change()

    returns.name = "return"
    ret_df = returns.to_frame()
    ret_df["dow"] = ret_df.index.dayofweek  # 0=Mon, 4=Fri
    ret_df["dow_name"] = ret_df.index.day_name()
    ret_df = ret_df.dropna()

    # Day-of-week stats
    dow_stats = []
    for dow in range(5):
        subset = ret_df[ret_df["dow"] == dow]["return"].dropna()
        if len(subset) < 10:
            continue
        t_stat, p_val = stats.ttest_1samp(subset, 0)
        dow_stats.append({"day": subset.index[0].day_name(), "dow": dow, "n": len(subset),
                           "mean_return": float(subset.mean()), "std_return": float(subset.std()),
                           "t_stat": float(t_stat), "p_value": float(p_val),
                           "annualized_return": float(subset.mean() * 252)})
    dow_df = pd.DataFrame(dow_stats).sort_values("dow")
    dow_df.to_csv(os.path.join(cfg.outdir, "dow_returns.csv"), index=False)

    # Backtest: long on Friday, short on Monday
    bt = ret_df.copy()
    bt["position"] = 0
    bt.loc[bt["dow"] == 4, "position"] = 1   # long Friday
    bt.loc[bt["dow"] == 0, "position"] = -1  # short Monday
    bt["strategy_return"] = bt["position"].shift(1) * bt["return"]
    bt["cumulative"] = (1 + bt["strategy_return"].fillna(0)).cumprod()
    bt[["strategy_return", "cumulative"]].to_csv(os.path.join(cfg.outdir, "backtest.csv"))

    strat = bt["strategy_return"].dropna()
    mon = ret_df[ret_df["dow"] == 0]["return"]
    fri = ret_df[ret_df["dow"] == 4]["return"]
    summary = {"n_obs": len(ret_df), "monday_avg": float(mon.mean()), "friday_avg": float(fri.mean()),
               "weekend_effect_bps": float((fri.mean() - mon.mean()) * 10000),
               "strategy_sharpe": float(strat.mean() / strat.std() * np.sqrt(252)) if strat.std() > 0 else None,
               "strategy_ann_return": float(strat.mean() * 252),
               "dow_stats": dow_df.to_dict(orient="records")}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Weekend effect | Friday avg: {summary['friday_avg']:.4f} | Monday avg: {summary['monday_avg']:.4f} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--outdir", default="./artifacts/weekend_effect")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
