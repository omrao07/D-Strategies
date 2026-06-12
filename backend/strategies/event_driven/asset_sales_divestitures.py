#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
asset_sales_divestitures.py — Non-core asset sales → focus + cash → re-rate higher
=====================================================================================
Tracks corporate divestitures. Large asset sales (>5% of market cap) signal
strategic focus and return of capital — typically positive for the stock.

Inputs (CSV)
------------
--divestitures  divestitures.csv
    Columns: announce_date, ticker, asset_sold, proceeds_mn, buyer, [market_cap_mn]

--returns  returns.csv  OPTIONAL: date, ticker, return

Outputs
-------
outdir/divestiture_analysis.csv    proceeds_pct_mktcap, signal, forward returns
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    div = pd.read_csv(cfg.divestitures_file, parse_dates=["announce_date"])
    div.columns = [c.lower().strip() for c in div.columns]

    records = []
    wide = None
    if cfg.returns_file:
        rets = pd.read_csv(cfg.returns_file, parse_dates=["date"])
        rets.columns = [c.lower().strip() for c in rets.columns]
        wide = rets.pivot(index="date", columns="ticker", values="return").sort_index()

    for _, row in div.iterrows():
        t, ann = row["ticker"], row["announce_date"]
        proceeds = row["proceeds_mn"]
        mktcap = row.get("market_cap_mn", np.nan)
        proceeds_pct = (proceeds / mktcap * 100) if not np.isnan(mktcap) and mktcap > 0 else np.nan
        signal = "buy" if (not np.isnan(proceeds_pct) and proceeds_pct > cfg.min_pct) else \
                 ("weak_buy" if proceeds > cfg.min_abs_mn else "neutral")

        fwd20, fwd60 = np.nan, np.nan
        if wide is not None and t in wide.columns:
            fut = wide.loc[wide.index >= ann, t].dropna()
            fwd20 = float((1 + fut.iloc[:20]).prod() - 1) if len(fut) >= 20 else np.nan
            fwd60 = float((1 + fut.iloc[:60]).prod() - 1) if len(fut) >= 60 else np.nan

        records.append({"ticker": t, "announce_date": ann, "asset_sold": row.get("asset_sold", ""),
                        "proceeds_mn": proceeds, "proceeds_pct_mktcap": proceeds_pct,
                        "signal": signal, "fwd_20d": fwd20, "fwd_60d": fwd60})

    df = pd.DataFrame(records)
    df.to_csv(os.path.join(cfg.outdir, "divestiture_analysis.csv"), index=False)

    buy = df[df["signal"] == "buy"]
    summary = {"n_events": len(df), "n_buy_signals": len(buy),
               "avg_proceeds_mn": float(df["proceeds_mn"].mean()),
               "avg_proceeds_pct": float(df["proceeds_pct_mktcap"].dropna().mean()),
               "avg_fwd20_buy": float(buy["fwd_20d"].mean()) if len(buy) > 0 else None,
               "avg_fwd60_buy": float(buy["fwd_60d"].mean()) if len(buy) > 0 else None}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Divestitures: {len(df)} events | Buy signals: {len(buy)} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--divestitures", required=True, dest="divestitures_file")
    ap.add_argument("--returns", default=None, dest="returns_file")
    ap.add_argument("--min-pct", type=float, default=5.0)
    ap.add_argument("--min-abs-mn", type=float, default=100.0)
    ap.add_argument("--outdir", default="./artifacts/divestitures")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
