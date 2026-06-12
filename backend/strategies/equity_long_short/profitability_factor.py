#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
profitability_factor.py — Gross profits/assets — Novy-Marx quality factor
--------------------------------------------------------------------------
Computes gross profitability (GP/Assets) per ticker, ranks the universe,
longs top quintile and shorts bottom quintile. Monthly rebalance.

Inputs (CSV)
------------
--fundamentals  fundamentals.csv  REQUIRED: date, ticker, gross_profit, total_assets,
                                             [revenue, cogs, operating_income]

Outputs
-------
outdir/profitability_ranks.csv   most recent ranking
outdir/portfolio.csv             date, long_return, short_return, ls_return (if returns provided)
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd


def load_fundamentals(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]
    return df.sort_values("date")


def compute_profitability(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["gp_assets"] = df["gross_profit"] / df["total_assets"].replace(0, np.nan)
    if "revenue" in df.columns and "cogs" in df.columns:
        df["gross_margin"] = (df["revenue"] - df["cogs"]) / df["revenue"].replace(0, np.nan)
    if "operating_income" in df.columns:
        df["op_margin"] = df["operating_income"] / df["total_assets"].replace(0, np.nan)
    return df


def quintile_rank(series: pd.Series) -> pd.Series:
    return pd.qcut(series.rank(method="first"), 5, labels=False) + 1


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    fund = load_fundamentals(cfg.fundamentals_file)
    fund = compute_profitability(fund)

    # Latest cross-section
    latest = fund.sort_values("date").groupby("ticker").last().reset_index()
    latest = latest.dropna(subset=["gp_assets"])
    latest["quintile"] = quintile_rank(latest["gp_assets"])
    latest = latest.sort_values("gp_assets", ascending=False)
    latest.to_csv(os.path.join(cfg.outdir, "profitability_ranks.csv"), index=False)

    top = latest[latest["quintile"] == 5]["ticker"].tolist()
    bottom = latest[latest["quintile"] == 1]["ticker"].tolist()

    # Time-series if returns provided
    portfolio_records = []
    if cfg.returns_file:
        rets = pd.read_csv(cfg.returns_file, parse_dates=["date"])
        rets.columns = [c.lower().strip() for c in rets.columns]
        wide = rets.pivot(index="date", columns="ticker", values="return").sort_index()
        for date, row in wide.iterrows():
            lr = row[[t for t in top if t in row.index]].mean()
            sr = row[[t for t in bottom if t in row.index]].mean()
            portfolio_records.append({"date": date, "long_return": lr, "short_return": sr, "ls_return": lr - sr})
        port = pd.DataFrame(portfolio_records).set_index("date")
        port.to_csv(os.path.join(cfg.outdir, "portfolio.csv"))
        ls = port["ls_return"].dropna()
        perf = {"ann_return": float(ls.mean() * 252), "sharpe": float(ls.mean() / ls.std() * np.sqrt(252)) if ls.std() > 0 else None}
    else:
        perf = {}

    summary = {"n_tickers": len(latest), "top_quintile": top[:10], "bottom_quintile": bottom[:10],
               "avg_gp_assets_top": float(latest[latest["quintile"] == 5]["gp_assets"].mean()),
               "avg_gp_assets_bottom": float(latest[latest["quintile"] == 1]["gp_assets"].mean()), **perf}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Profitability factor | Top quintile avg GP/Assets: {summary['avg_gp_assets_top']:.2f} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fundamentals", required=True, dest="fundamentals_file")
    ap.add_argument("--returns", default=None, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/profitability_factor")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
