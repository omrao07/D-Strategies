#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
buyback_yield_factor.py — Buyback yield + total shareholder yield factor
"""
import argparse
import json
import os

import numpy as np
import pandas as pd


def quintile_rank(s): return pd.qcut(s.rank(method="first"), 5, labels=False) + 1


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    fund = pd.read_csv(cfg.fundamentals_file, parse_dates=["date"])
    fund.columns = [c.lower().strip() for c in fund.columns]
    latest = fund.sort_values("date").groupby("ticker").last().reset_index()
    latest = latest.dropna(subset=["market_cap"])
    if "share_repurchases_ttm" in latest.columns:
        latest["buyback_yield"] = latest["share_repurchases_ttm"] / latest["market_cap"].replace(0, np.nan)
    else:
        latest["buyback_yield"] = 0.0
    if "dividend_yield" in latest.columns:
        latest["total_shareholder_yield"] = latest["buyback_yield"] + latest["dividend_yield"].fillna(0)
    else:
        latest["total_shareholder_yield"] = latest["buyback_yield"]
    latest = latest.dropna(subset=["buyback_yield"])
    latest["quintile"] = quintile_rank(latest["total_shareholder_yield"])
    latest.sort_values("total_shareholder_yield", ascending=False).to_csv(os.path.join(cfg.outdir, "buyback_ranks.csv"), index=False)
    top = latest[latest["quintile"] == 5]["ticker"].tolist()
    records = []
    if cfg.returns_file:
        rets = pd.read_csv(cfg.returns_file, parse_dates=["date"])
        rets.columns = [c.lower().strip() for c in rets.columns]
        wide = rets.pivot(index="date", columns="ticker", values="return").sort_index()
        bottom = latest[latest["quintile"] == 1]["ticker"].tolist()
        for date, row in wide.iterrows():
            lr = row[[t for t in top if t in row.index]].mean()
            sr = row[[t for t in bottom if t in row.index]].mean()
            records.append({"date": date, "ls_return": lr - sr})
        port = pd.DataFrame(records).set_index("date")
        port.to_csv(os.path.join(cfg.outdir, "portfolio.csv"))
        ls = port["ls_return"].dropna()
        perf = {"sharpe": float(ls.mean() / ls.std() * np.sqrt(252)) if ls.std() > 0 else None, "ann_return": float(ls.mean() * 252)}
    else:
        perf = {}
    summary = {"n_tickers": len(latest), "avg_buyback_yield_top": float(latest[latest["quintile"] == 5]["buyback_yield"].mean()),
               "avg_tsy_top": float(latest[latest["quintile"] == 5]["total_shareholder_yield"].mean()), **perf}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Buyback yield factor | Avg buyback yield top: {summary['avg_buyback_yield_top']:.2%} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fundamentals", required=True, dest="fundamentals_file")
    ap.add_argument("--returns", default=None, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/buyback_yield_factor")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
