#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
etf_creation_redemption_flows.py — Large ETF creates/redeems → temporary price pressure → fade
================================================================================================
Large ETF creations (AP creates new shares, buys basket) put upward pressure on the
underlying basket. Large redemptions do the opposite. Both effects typically mean-revert
within 5 days. This script detects large flows and measures the reversion.

Inputs (CSV)
------------
--shares  etf_shares.csv
    Columns: date, etf, shares_outstanding

--prices  prices.csv  OPTIONAL: date, etf, price

Outputs
-------
outdir/flow_signals.csv     date, etf, shares_change, change_pct, signal, fwd_5d_return
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    shares = pd.read_csv(cfg.shares_file, parse_dates=["date"])
    shares.columns = [c.lower().strip() for c in shares.columns]

    wide_shares = shares.pivot(index="date", columns="etf", values="shares_outstanding").sort_index()
    daily_change = wide_shares.pct_change()

    prices_wide = None
    if cfg.prices_file:
        prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
        prices.columns = [c.lower().strip() for c in prices.columns]
        prices_wide = prices.pivot(index="date", columns="etf", values="price").sort_index()

    records = []
    for etf in daily_change.columns:
        changes = daily_change[etf].dropna()
        for date, chg in changes.items():
            if abs(chg) < cfg.threshold:
                continue
            signal = "short_etf" if chg > 0 else "long_etf"  # creation=sell, redemption=buy
            fwd5 = np.nan
            if prices_wide is not None and etf in prices_wide.columns:
                fut = prices_wide.loc[prices_wide.index > date, etf].dropna()
                if len(fut) >= 5:
                    # Return from fade perspective
                    mult = -1 if signal == "short_etf" else 1
                    fwd5 = float((fut.iloc[4] / fut.iloc[0] - 1) * mult)
            records.append({"date": date, "etf": etf, "shares_change_pct": chg * 100,
                            "direction": "creation" if chg > 0 else "redemption",
                            "signal": signal, "fwd_5d_fade_return": fwd5})

    df = pd.DataFrame(records).sort_values("date")
    df.to_csv(os.path.join(cfg.outdir, "flow_signals.csv"), index=False)

    summary = {"n_signals": len(df), "n_creations": int((df["direction"] == "creation").sum()),
               "n_redemptions": int((df["direction"] == "redemption").sum()),
               "avg_fwd5_fade": float(df["fwd_5d_fade_return"].mean()) if "fwd_5d_fade_return" in df.columns else None,
               "win_rate": float((df["fwd_5d_fade_return"] > 0).mean()) if "fwd_5d_fade_return" in df.columns else None,
               "threshold_pct": cfg.threshold * 100}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"ETF flows: {len(df)} signals | Win rate: {summary['win_rate']} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shares", required=True, dest="shares_file")
    ap.add_argument("--prices", default=None, dest="prices_file")
    ap.add_argument("--threshold", type=float, default=0.02, help="Min daily shares change as decimal (0.02 = 2%%)")
    ap.add_argument("--outdir", default="./artifacts/etf_flows")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
