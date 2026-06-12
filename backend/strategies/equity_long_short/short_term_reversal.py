#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
short_term_reversal.py — 1-month losers bounce — microstructure reversal
--------------------------------------------------------------------------
Cross-sectional short-term reversal: the previous month's biggest losers
outperform over the next week. Weekly rebalance.

Inputs (CSV)
------------
--returns  returns.csv   REQUIRED: date, ticker, return (daily decimal)

Outputs
-------
outdir/reversal_portfolio.csv   date, long_return, short_return, reversal_return
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


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    wide = load_returns(cfg.returns_file)

    # Monthly return (21-day)
    monthly = wide.rolling(21).sum()
    records = []
    for i in range(21, len(wide)):
        if i % cfg.rebal_days != 0:
            continue
        prev_month = monthly.iloc[i - 1].dropna()
        if len(prev_month) < 10:
            continue
        ranks = prev_month.rank()
        n = len(ranks)
        longs = ranks[ranks <= max(1, n // 10)].index.tolist()   # bottom decile
        shorts = ranks[ranks > 9 * n // 10].index.tolist()        # top decile
        # Hold for rebal_days
        hold = wide.iloc[i:i + cfg.rebal_days]
        lr = hold[[t for t in longs if t in hold.columns]].mean(axis=1).mean()
        sr = hold[[t for t in shorts if t in hold.columns]].mean(axis=1).mean()
        records.append({"date": wide.index[i], "long_return": lr, "short_return": sr,
                        "reversal_return": lr - sr})

    df = pd.DataFrame(records).set_index("date")
    df.to_csv(os.path.join(cfg.outdir, "reversal_portfolio.csv"))
    ls = df["reversal_return"].dropna()
    summary = {"n_periods": len(df), "ann_return": float(ls.mean() * (252 / cfg.rebal_days)),
               "sharpe": float(ls.mean() / ls.std() * np.sqrt(252 / cfg.rebal_days)) if ls.std() > 0 else None,
               "win_rate": float((ls > 0).mean())}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"STR Sharpe: {summary['sharpe']:.2f} | Win rate: {summary['win_rate']:.1%} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--rebal-days", type=int, default=5)
    ap.add_argument("--outdir", default="./artifacts/short_term_reversal")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
