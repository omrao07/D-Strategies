#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
class_action_settlements.py — Settlement removes overhang → re-rate higher
============================================================================
Class action settlements remove legal uncertainty. Stocks typically bottom before
the settlement announcement and re-rate higher after. This script measures the
pre-settlement drawdown and post-settlement recovery.

Inputs (CSV)
------------
--settlements  settlements.csv
    Columns: announce_date, ticker, settlement_amount_mn, case_type,
             [filing_date] (when lawsuit was first filed)

--returns  returns.csv  OPTIONAL: date, ticker, return

Outputs
-------
outdir/settlement_analysis.csv    CAR from filing to settlement, post-settlement returns
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    sett = pd.read_csv(cfg.settlements_file, parse_dates=["announce_date"])
    sett.columns = [c.lower().strip() for c in sett.columns]
    if "filing_date" in sett.columns:
        sett["filing_date"] = pd.to_datetime(sett["filing_date"], errors="coerce")

    records = []
    if cfg.returns_file:
        rets = pd.read_csv(cfg.returns_file, parse_dates=["date"])
        rets.columns = [c.lower().strip() for c in rets.columns]
        wide = rets.pivot(index="date", columns="ticker", values="return").sort_index()

        for _, row in sett.iterrows():
            t, ann = row["ticker"], row["announce_date"]
            if t not in wide.columns:
                continue

            # Post-settlement returns
            fut = wide.loc[wide.index >= ann, t].dropna()
            fwd5 = float((1 + fut.iloc[:5]).prod() - 1) if len(fut) >= 5 else np.nan
            fwd20 = float((1 + fut.iloc[:20]).prod() - 1) if len(fut) >= 20 else np.nan
            fwd60 = float((1 + fut.iloc[:60]).prod() - 1) if len(fut) >= 60 else np.nan

            # Pre-settlement drawdown (filing → announcement)
            drawdown = np.nan
            if "filing_date" in row and pd.notna(row["filing_date"]):
                pre = wide.loc[(wide.index >= row["filing_date"]) & (wide.index < ann), t].dropna()
                if len(pre) > 0:
                    cum = (1 + pre).cumprod()
                    drawdown = float((cum / cum.cummax() - 1).min())

            records.append({"ticker": t, "announce_date": ann, "settlement_mn": row["settlement_amount_mn"],
                            "case_type": row.get("case_type", ""), "pre_drawdown": drawdown,
                            "fwd_5d": fwd5, "fwd_20d": fwd20, "fwd_60d": fwd60})
    else:
        for _, row in sett.iterrows():
            records.append({"ticker": row["ticker"], "announce_date": row["announce_date"],
                            "settlement_mn": row["settlement_amount_mn"]})

    df = pd.DataFrame(records)
    df.to_csv(os.path.join(cfg.outdir, "settlement_analysis.csv"), index=False)

    summary = {"n_events": len(df),
               "avg_settlement_mn": float(sett["settlement_amount_mn"].mean()),
               "avg_pre_drawdown": float(df["pre_drawdown"].mean()) if "pre_drawdown" in df.columns else None,
               "avg_fwd_20d": float(df["fwd_20d"].mean()) if "fwd_20d" in df.columns else None,
               "avg_fwd_60d": float(df["fwd_60d"].mean()) if "fwd_60d" in df.columns else None,
               "win_rate_20d": float((df["fwd_20d"] > 0).mean()) if "fwd_20d" in df.columns else None}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Settlements: {len(df)} events | Avg fwd 20d: {summary['avg_fwd_20d']} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--settlements", required=True, dest="settlements_file")
    ap.add_argument("--returns", default=None, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/class_action")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
