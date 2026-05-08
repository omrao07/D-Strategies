#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
regulatory_approval_delays.py — Regulatory delays → oversold → buy on resolution
==================================================================================
When regulators delay a product approval, stocks typically overreact to the downside.
This script measures the drop on delay, tracks recovery on resolution, and signals
buy on resolution day.

Inputs (CSV)
------------
--events  regulatory_events.csv
    Columns: delay_date, ticker, regulator, product, [resolution_date], [resolution_outcome]

--returns  returns.csv  OPTIONAL: date, ticker, return

Outputs
-------
outdir/delay_analysis.csv       drop on delay, recovery on resolution
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd


def window_return(wide: pd.DataFrame, ticker: str, start: pd.Timestamp, days: int) -> float:
    if ticker not in wide.columns:
        return np.nan
    fut = wide.loc[wide.index >= start, ticker].dropna().iloc[:days]
    return float((1 + fut).prod() - 1) if len(fut) > 0 else np.nan


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    events = pd.read_csv(cfg.events_file, parse_dates=["delay_date"])
    events.columns = [c.lower().strip() for c in events.columns]
    if "resolution_date" in events.columns:
        events["resolution_date"] = pd.to_datetime(events["resolution_date"], errors="coerce")

    records = []
    if cfg.returns_file:
        rets = pd.read_csv(cfg.returns_file, parse_dates=["date"])
        rets.columns = [c.lower().strip() for c in rets.columns]
        wide = rets.pivot(index="date", columns="ticker", values="return").sort_index()

        for _, row in events.iterrows():
            t, delay = row["ticker"], row["delay_date"]
            drop_1d = window_return(wide, t, delay, 1)
            drop_5d = window_return(wide, t, delay, 5)
            resolution = row.get("resolution_date")
            res_fwd5, res_fwd20 = np.nan, np.nan
            if pd.notna(resolution):
                res_fwd5 = window_return(wide, t, resolution, 5)
                res_fwd20 = window_return(wide, t, resolution, 20)
            records.append({"ticker": t, "delay_date": delay, "regulator": row.get("regulator", ""),
                            "product": row.get("product", ""), "drop_1d": drop_1d, "drop_5d": drop_5d,
                            "resolution_date": resolution, "resolution_fwd5d": res_fwd5,
                            "resolution_fwd20d": res_fwd20,
                            "signal": "buy_on_resolution" if pd.notna(resolution) else "monitor"})
    else:
        for _, row in events.iterrows():
            records.append({"ticker": row["ticker"], "delay_date": row["delay_date"]})

    df = pd.DataFrame(records)
    df.to_csv(os.path.join(cfg.outdir, "delay_analysis.csv"), index=False)

    summary = {"n_events": len(df),
               "avg_drop_1d": float(df["drop_1d"].mean()) if "drop_1d" in df.columns else None,
               "avg_drop_5d": float(df["drop_5d"].mean()) if "drop_5d" in df.columns else None,
               "avg_resolution_fwd5d": float(df["resolution_fwd5d"].mean()) if "resolution_fwd5d" in df.columns else None,
               "avg_resolution_fwd20d": float(df["resolution_fwd20d"].mean()) if "resolution_fwd20d" in df.columns else None}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Regulatory delays: {len(df)} events | Avg drop 5d: {summary['avg_drop_5d']} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--events", required=True, dest="events_file")
    ap.add_argument("--returns", default=None, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/regulatory_delays")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
