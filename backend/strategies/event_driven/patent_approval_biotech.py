#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patent_approval_biotech.py — FDA PDUFA calendar → pre-approval drift + day-of move
=====================================================================================
Tracks FDA PDUFA dates, measures the pre-date drift (buy 10 days before) and the
day-of reaction (approval vs rejection). Computes win rates and average moves by
phase and indication.

Inputs (CSV)
------------
--fda  fda_calendar.csv
    Columns: pdufa_date, ticker, drug_name, indication, phase, [outcome=approved/rejected/complete_response]

--returns  returns.csv  OPTIONAL: date, ticker, return

Outputs
-------
outdir/pdufa_analysis.csv     per-event metrics
outdir/outcome_stats.csv      approval vs rejection average returns
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    fda = pd.read_csv(cfg.fda_file, parse_dates=["pdufa_date"])
    fda.columns = [c.lower().strip() for c in fda.columns]

    records = []
    if cfg.returns_file:
        rets = pd.read_csv(cfg.returns_file, parse_dates=["date"])
        rets.columns = [c.lower().strip() for c in rets.columns]
        wide = rets.pivot(index="date", columns="ticker", values="return").sort_index()

        for _, row in fda.iterrows():
            t, pdufa = row["ticker"], row["pdufa_date"]
            if t not in wide.columns:
                continue

            # Pre-PDUFA drift: buy 10 days before, hold to PDUFA date
            pre_start = pdufa - pd.Timedelta(days=cfg.days_before)
            pre_window = wide.loc[(wide.index >= pre_start) & (wide.index < pdufa), t].dropna()
            pre_drift = float((1 + pre_window).prod() - 1) if len(pre_window) > 0 else np.nan

            # Day-of move
            day_of = wide.loc[pdufa, t] if pdufa in wide.index else np.nan

            # Post-PDUFA 5-day return
            post = wide.loc[wide.index > pdufa, t].dropna().iloc[:5]
            post_5d = float((1 + post).prod() - 1) if len(post) >= 5 else np.nan

            outcome = str(row.get("outcome", "unknown")).lower()
            records.append({
                "ticker": t, "pdufa_date": pdufa, "drug_name": row.get("drug_name", ""),
                "indication": row.get("indication", ""), "phase": row.get("phase", ""),
                "outcome": outcome, "pre_drift": pre_drift,
                "day_of_return": day_of, "post_5d_return": post_5d,
                "approved": outcome == "approved"
            })
    else:
        for _, row in fda.iterrows():
            records.append({"ticker": row["ticker"], "pdufa_date": row["pdufa_date"],
                            "drug_name": row.get("drug_name", ""), "phase": row.get("phase", "")})

    df = pd.DataFrame(records)
    df.to_csv(os.path.join(cfg.outdir, "pdufa_analysis.csv"), index=False)

    # Outcome stats
    if "outcome" in df.columns and "day_of_return" in df.columns:
        outcome_stats = df.groupby("outcome").agg(
            count=("ticker", "count"),
            avg_pre_drift=("pre_drift", "mean"),
            avg_day_of=("day_of_return", "mean"),
            avg_post_5d=("post_5d_return", "mean")
        ).reset_index()
        outcome_stats.to_csv(os.path.join(cfg.outdir, "outcome_stats.csv"), index=False)

        approved = df[df.get("approved", pd.Series(False))]
        rejected = df[~df.get("approved", pd.Series(False))]
        approval_rate = float(df["approved"].mean()) if "approved" in df.columns else None
    else:
        approval_rate = None

    summary = {"n_events": len(df), "approval_rate": approval_rate,
               "avg_pre_drift": float(df["pre_drift"].mean()) if "pre_drift" in df.columns else None,
               "avg_day_of_approved": float(df.loc[df.get("approved", pd.Series(False)), "day_of_return"].mean()) if "day_of_return" in df.columns and approval_rate else None,
               "avg_day_of_rejected": float(df.loc[~df.get("approved", pd.Series(True)), "day_of_return"].mean()) if "day_of_return" in df.columns else None}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"FDA PDUFA: {len(df)} events | Approval rate: {approval_rate} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fda", required=True, dest="fda_file")
    ap.add_argument("--returns", default=None, dest="returns_file")
    ap.add_argument("--days-before", type=int, default=10)
    ap.add_argument("--outdir", default="./artifacts/fda_pdufa")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
