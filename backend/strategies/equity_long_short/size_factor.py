#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
size_factor.py — Small cap premium — Russell 2000 vs S&P 500 size factor
--------------------------------------------------------------------------
Computes the SMB (Small-Minus-Big) factor: longs small-cap (bottom market-cap
quintile) and shorts large-cap (top quintile). Monthly rebalance.

Inputs (CSV)
------------
--fundamentals  fundamentals.csv  REQUIRED: date, ticker, market_cap (USD millions)
--returns       returns.csv       OPTIONAL: date, ticker, return

Outputs
-------
outdir/size_ranks.csv    ticker, market_cap, quintile
outdir/smb_returns.csv   date, small_return, large_return, smb_return (if returns provided)
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd


def quintile_rank(series: pd.Series) -> pd.Series:
    return pd.qcut(series.rank(method="first"), 5, labels=False) + 1


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    fund = pd.read_csv(cfg.fundamentals_file, parse_dates=["date"])
    fund.columns = [c.lower().strip() for c in fund.columns]

    latest = fund.sort_values("date").groupby("ticker").last().reset_index()
    latest = latest.dropna(subset=["market_cap"])
    latest["quintile"] = quintile_rank(latest["market_cap"])
    latest["label"] = latest["quintile"].map({1: "micro", 2: "small", 3: "mid", 4: "large", 5: "mega"})
    latest.sort_values("market_cap").to_csv(os.path.join(cfg.outdir, "size_ranks.csv"), index=False)

    small = latest[latest["quintile"] == 1]["ticker"].tolist()
    large = latest[latest["quintile"] == 5]["ticker"].tolist()

    records = []
    if cfg.returns_file:
        rets = pd.read_csv(cfg.returns_file, parse_dates=["date"])
        rets.columns = [c.lower().strip() for c in rets.columns]
        wide = rets.pivot(index="date", columns="ticker", values="return").sort_index()
        for date, row in wide.iterrows():
            sr = row[[t for t in small if t in row.index]].mean()
            lr = row[[t for t in large if t in row.index]].mean()
            records.append({"date": date, "small_return": sr, "large_return": lr, "smb_return": sr - lr})
        port = pd.DataFrame(records).set_index("date")
        port.to_csv(os.path.join(cfg.outdir, "smb_returns.csv"))
        smb = port["smb_return"].dropna()
        perf = {"ann_return": float(smb.mean() * 252), "sharpe": float(smb.mean() / smb.std() * np.sqrt(252)) if smb.std() > 0 else None}
    else:
        perf = {}

    summary = {"n_tickers": len(latest), "avg_mcap_small": float(latest[latest["quintile"] == 1]["market_cap"].mean()),
               "avg_mcap_large": float(latest[latest["quintile"] == 5]["market_cap"].mean()),
               "small_tickers": small[:10], "large_tickers": large[:10], **perf}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Size factor | Small avg mktcap: ${summary['avg_mcap_small']:.0f}M | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fundamentals", required=True, dest="fundamentals_file")
    ap.add_argument("--returns", default=None, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/size_factor")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
