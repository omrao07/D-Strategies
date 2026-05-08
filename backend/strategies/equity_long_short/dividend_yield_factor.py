#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dividend_yield_factor.py — High dividend yield factor — defensive income factor
"""
import argparse, json, os
import numpy as np
import pandas as pd


def quintile_rank(s): return pd.qcut(s.rank(method="first"), 5, labels=False) + 1


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    fund = pd.read_csv(cfg.fundamentals_file, parse_dates=["date"])
    fund.columns = [c.lower().strip() for c in fund.columns]
    latest = fund.sort_values("date").groupby("ticker").last().reset_index()
    latest = latest.dropna(subset=["dividend_yield"])
    latest = latest[latest.get("payout_ratio", pd.Series(1.0, index=latest.index)) < 0.9]
    latest["composite"] = latest["dividend_yield"].fillna(0)
    if "dividend_growth_yoy" in latest.columns:
        latest["composite"] += latest["dividend_growth_yoy"].fillna(0) * 0.3
    latest["quintile"] = quintile_rank(latest["composite"])
    latest.sort_values("composite", ascending=False).to_csv(os.path.join(cfg.outdir, "dividend_ranks.csv"), index=False)
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
            records.append({"date": date, "long_return": lr, "short_return": sr, "ls_return": lr - sr})
        port = pd.DataFrame(records).set_index("date")
        port.to_csv(os.path.join(cfg.outdir, "portfolio.csv"))
        ls = port["ls_return"].dropna()
        perf = {"sharpe": float(ls.mean() / ls.std() * np.sqrt(252)) if ls.std() > 0 else None}
    else:
        perf = {}
    summary = {"n_tickers": len(latest), "avg_yield_top": float(latest[latest["quintile"] == 5]["dividend_yield"].mean()), **perf}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Dividend yield factor | Top avg yield: {summary['avg_yield_top']:.2%} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fundamentals", required=True, dest="fundamentals_file")
    ap.add_argument("--returns", default=None, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/dividend_yield_factor")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
