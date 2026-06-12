#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
thirteenf_fund_mimicry.py — Copy top hedge fund 13F filings with 45-day lag
"""
import argparse
import json
import os

import pandas as pd


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    df = pd.read_csv(cfg.data_file, parse_dates=["filing_date"])
    df.columns = [c.lower().strip() for c in df.columns]
    df["entry_date"] = df["filing_date"] + pd.Timedelta(days=45)

    funds = cfg.funds.split(",") if cfg.funds else df["fund_name"].unique().tolist()
    df = df[df["fund_name"].isin(funds)]
    buys = df[df["action"].str.lower() == "buy"].copy()

    portfolio = buys.groupby(["entry_date", "ticker"]).agg(
        total_value=("value_usd", "sum"), fund_count=("fund_name", "nunique")
    ).reset_index()
    portfolio = portfolio[portfolio["fund_count"] >= cfg.min_funds]
    portfolio.sort_values("entry_date").to_csv(os.path.join(cfg.outdir, "portfolio_positions.csv"), index=False)

    if cfg.returns_file:
        rets = pd.read_csv(cfg.returns_file, parse_dates=["date"])
        rets.columns = [c.lower().strip() for c in rets.columns]
        wide = rets.pivot(index="date", columns="ticker", values="return").sort_index()
        trades = []
        for _, pos in portfolio.iterrows():
            t = pos["ticker"]
            entry = pos["entry_date"]
            if t not in wide.columns:
                continue
            future = wide.loc[wide.index >= entry, t].dropna().iloc[:cfg.hold_days]
            if len(future) == 0:
                continue
            total_ret = (1 + future).prod() - 1
            trades.append({"entry_date": entry, "ticker": t, "hold_return": total_ret, "fund_count": pos["fund_count"]})
        trade_df = pd.DataFrame(trades)
        trade_df.to_csv(os.path.join(cfg.outdir, "trade_returns.csv"), index=False)
        summary_perf = {"avg_return": float(trade_df["hold_return"].mean()), "win_rate": float((trade_df["hold_return"] > 0).mean()), "n_trades": len(trade_df)}
    else:
        summary_perf = {}

    summary = {"n_filings": len(df), "n_portfolio_positions": len(portfolio), "funds_tracked": funds, **summary_perf}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"13F mimicry | Positions: {len(portfolio)} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, dest="data_file")
    ap.add_argument("--returns", default=None, dest="returns_file")
    ap.add_argument("--funds", default=None, help="Comma-separated fund names to track")
    ap.add_argument("--min-funds", type=int, default=2)
    ap.add_argument("--hold-days", type=int, default=90)
    ap.add_argument("--outdir", default="./artifacts/thirteenf")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
