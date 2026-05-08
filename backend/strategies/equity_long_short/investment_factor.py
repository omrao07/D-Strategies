#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
investment_factor.py — Low capex growth = higher future returns (Fama-French CMA)
-----------------------------------------------------------------------------------
Replicates the Fama-French Conservative-Minus-Aggressive (CMA) investment factor.
Low asset-growth firms outperform high asset-growth firms. Longs conservative
(low-investment) and shorts aggressive (high-investment).

Inputs (CSV)
------------
--fundamentals  fundamentals.csv  REQUIRED: date, ticker, total_assets, [capex, asset_growth_yoy]

Outputs
-------
outdir/investment_ranks.csv   cross-sectional ranking
outdir/portfolio.csv          L/S returns if --returns provided
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd


def load_fundamentals(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]
    return df.sort_values(["ticker", "date"])


def compute_asset_growth(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    if "asset_growth_yoy" not in df.columns:
        df["asset_growth_yoy"] = df.groupby("ticker")["total_assets"].pct_change(periods=4)
    if "capex" in df.columns and "total_assets" in df.columns:
        df["capex_intensity"] = df["capex"] / df["total_assets"].replace(0, np.nan)
    return df


def quintile_rank(series: pd.Series) -> pd.Series:
    return pd.qcut(series.rank(method="first"), 5, labels=False) + 1


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    fund = load_fundamentals(cfg.fundamentals_file)
    fund = compute_asset_growth(fund)

    latest = fund.sort_values("date").groupby("ticker").last().reset_index()
    latest = latest.dropna(subset=["asset_growth_yoy"])
    latest["quintile"] = quintile_rank(latest["asset_growth_yoy"])
    # Conservative = low investment (Q1), Aggressive = high investment (Q5)
    latest["label"] = latest["quintile"].map({1: "conservative", 2: "q2", 3: "q3", 4: "q4", 5: "aggressive"})
    latest.sort_values("asset_growth_yoy").to_csv(os.path.join(cfg.outdir, "investment_ranks.csv"), index=False)

    conservative = latest[latest["quintile"] == 1]["ticker"].tolist()
    aggressive = latest[latest["quintile"] == 5]["ticker"].tolist()

    portfolio_records = []
    if cfg.returns_file:
        rets = pd.read_csv(cfg.returns_file, parse_dates=["date"])
        rets.columns = [c.lower().strip() for c in rets.columns]
        wide = rets.pivot(index="date", columns="ticker", values="return").sort_index()
        for date, row in wide.iterrows():
            lr = row[[t for t in conservative if t in row.index]].mean()
            sr = row[[t for t in aggressive if t in row.index]].mean()
            portfolio_records.append({"date": date, "conservative_ret": lr, "aggressive_ret": sr, "cma_return": lr - sr})
        port = pd.DataFrame(portfolio_records).set_index("date")
        port.to_csv(os.path.join(cfg.outdir, "portfolio.csv"))
        ls = port["cma_return"].dropna()
        perf = {"ann_return": float(ls.mean() * 252), "sharpe": float(ls.mean() / ls.std() * np.sqrt(252)) if ls.std() > 0 else None}
    else:
        perf = {}

    summary = {"n_tickers": len(latest), "avg_growth_conservative": float(latest[latest["quintile"] == 1]["asset_growth_yoy"].mean()),
               "avg_growth_aggressive": float(latest[latest["quintile"] == 5]["asset_growth_yoy"].mean()),
               "conservative_tickers": conservative[:10], "aggressive_tickers": aggressive[:10], **perf}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"CMA factor | Conservative avg growth: {summary['avg_growth_conservative']:.1%} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fundamentals", required=True, dest="fundamentals_file")
    ap.add_argument("--returns", default=None, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/investment_factor")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
