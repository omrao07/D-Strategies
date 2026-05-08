#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
proxy_fight_outcomes.py — Board changes → operational improvements priced in
=============================================================================
Tracks proxy fights from filing to outcome. Signals buy on filing (announcement alpha)
and analyzes returns by outcome type (activist won/lost/settled).

Inputs (CSV)
------------
--proxy  proxy_fights.csv
    Columns: filing_date, ticker, activist, seats_demanded,
             outcome (won/lost/settled), [settle_date]

--returns  returns.csv  OPTIONAL: date, ticker, return

Outputs
-------
outdir/proxy_analysis.csv     CAR by filing to outcome, by outcome type
outdir/outcome_summary.csv    avg returns by won/lost/settled
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    proxy = pd.read_csv(cfg.proxy_file, parse_dates=["filing_date"])
    proxy.columns = [c.lower().strip() for c in proxy.columns]
    if "settle_date" in proxy.columns:
        proxy["settle_date"] = pd.to_datetime(proxy["settle_date"], errors="coerce")

    records = []
    if cfg.returns_file:
        rets = pd.read_csv(cfg.returns_file, parse_dates=["date"])
        rets.columns = [c.lower().strip() for c in rets.columns]
        wide = rets.pivot(index="date", columns="ticker", values="return").sort_index()

        for _, row in proxy.iterrows():
            t, filing = row["ticker"], row["filing_date"]
            if t not in wide.columns:
                continue
            fut = wide.loc[wide.index >= filing, t].dropna()
            fwd5 = float((1 + fut.iloc[:5]).prod() - 1) if len(fut) >= 5 else np.nan
            fwd20 = float((1 + fut.iloc[:20]).prod() - 1) if len(fut) >= 20 else np.nan
            fwd60 = float((1 + fut.iloc[:60]).prod() - 1) if len(fut) >= 60 else np.nan
            records.append({"ticker": t, "filing_date": filing, "activist": row.get("activist", ""),
                            "seats_demanded": row.get("seats_demanded", np.nan),
                            "outcome": row.get("outcome", "unknown"),
                            "fwd_5d": fwd5, "fwd_20d": fwd20, "fwd_60d": fwd60})
    else:
        for _, row in proxy.iterrows():
            records.append({"ticker": row["ticker"], "filing_date": row["filing_date"],
                            "outcome": row.get("outcome", "unknown")})

    df = pd.DataFrame(records)
    df.to_csv(os.path.join(cfg.outdir, "proxy_analysis.csv"), index=False)

    if "outcome" in df.columns and "fwd_60d" in df.columns:
        out_summary = df.groupby("outcome")[["fwd_5d", "fwd_20d", "fwd_60d"]].mean().reset_index()
        out_summary.to_csv(os.path.join(cfg.outdir, "outcome_summary.csv"), index=False)

    summary = {"n_events": len(df),
               "avg_fwd_5d": float(df["fwd_5d"].mean()) if "fwd_5d" in df.columns else None,
               "avg_fwd_60d": float(df["fwd_60d"].mean()) if "fwd_60d" in df.columns else None,
               "win_rate_60d": float((df["fwd_60d"] > 0).mean()) if "fwd_60d" in df.columns else None,
               "outcome_counts": df["outcome"].value_counts().to_dict() if "outcome" in df.columns else {}}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Proxy fights: {len(df)} events | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--proxy", required=True, dest="proxy_file")
    ap.add_argument("--returns", default=None, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/proxy_fights")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
