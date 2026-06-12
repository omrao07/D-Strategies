#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
debt_refinancing_announcements.py — Lower interest cost = margin expansion → buy signal
=========================================================================================
When companies refinance debt at lower rates, the interest savings improve net income
margins. This script quantifies annual savings and signals buy when savings exceed
a threshold relative to revenue.

Inputs (CSV)
------------
--refinancing  refinancing.csv
    Columns: announce_date, ticker, old_rate, new_rate, debt_amount_mn, maturity_years,
             [revenue_ttm_mn]

--returns  returns.csv  OPTIONAL: date, ticker, return

Outputs
-------
outdir/refinancing_analysis.csv   ticker, date, annual_savings_mn, savings_pct_revenue, signal
outdir/trade_returns.csv          30/60-day forward returns (if --returns provided)
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd


def compute_savings(row: pd.Series) -> dict:
    rate_reduction = row["old_rate"] - row["new_rate"]
    annual_savings = row["debt_amount_mn"] * rate_reduction / 100
    savings_pct_rev = (annual_savings / row["revenue_ttm_mn"] * 100) if "revenue_ttm_mn" in row and row["revenue_ttm_mn"] > 0 else None
    npv_savings = annual_savings * row.get("maturity_years", 5) / (1 + 0.08) ** 2.5  # rough PV
    return {"rate_reduction_bps": rate_reduction * 100, "annual_savings_mn": annual_savings,
            "savings_pct_revenue": savings_pct_rev, "npv_savings_mn": npv_savings}


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    ref = pd.read_csv(cfg.refinancing_file, parse_dates=["announce_date"])
    ref.columns = [c.lower().strip() for c in ref.columns]

    records = []
    for _, row in ref.iterrows():
        savings = compute_savings(row)
        signal = "buy" if savings["savings_pct_revenue"] is not None and savings["savings_pct_revenue"] > cfg.min_savings_pct else \
                 ("weak_buy" if savings["annual_savings_mn"] > cfg.min_savings_abs else "neutral")
        records.append({"ticker": row["ticker"], "announce_date": row["announce_date"],
                        "old_rate": row["old_rate"], "new_rate": row["new_rate"],
                        "debt_amount_mn": row["debt_amount_mn"], "signal": signal, **savings})

    df = pd.DataFrame(records)
    df.to_csv(os.path.join(cfg.outdir, "refinancing_analysis.csv"), index=False)

    trade_records = []
    if cfg.returns_file:
        rets = pd.read_csv(cfg.returns_file, parse_dates=["date"])
        rets.columns = [c.lower().strip() for c in rets.columns]
        wide = rets.pivot(index="date", columns="ticker", values="return").sort_index()
        for _, row in df.iterrows():
            t, d = row["ticker"], row["announce_date"]
            if t not in wide.columns:
                continue
            fut = wide.loc[wide.index >= d, t].dropna()
            fwd30 = float((1 + fut.iloc[:30]).prod() - 1) if len(fut) >= 30 else np.nan
            fwd60 = float((1 + fut.iloc[:60]).prod() - 1) if len(fut) >= 60 else np.nan
            trade_records.append({"ticker": t, "announce_date": d, "signal": row["signal"],
                                   "savings_pct_rev": row["savings_pct_revenue"],
                                   "fwd_30d": fwd30, "fwd_60d": fwd60})
        tdf = pd.DataFrame(trade_records)
        tdf.to_csv(os.path.join(cfg.outdir, "trade_returns.csv"), index=False)
        buy_mask = tdf["signal"] == "buy"
        perf = {"avg_fwd30_buy": float(tdf.loc[buy_mask, "fwd_30d"].mean()) if buy_mask.any() else None,
                "avg_fwd60_buy": float(tdf.loc[buy_mask, "fwd_60d"].mean()) if buy_mask.any() else None}
    else:
        perf = {}

    summary = {"n_events": len(df), "n_buy_signals": int((df["signal"] == "buy").sum()),
               "avg_annual_savings_mn": float(df["annual_savings_mn"].mean()),
               "avg_rate_reduction_bps": float(df["rate_reduction_bps"].mean()), **perf}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Refinancing: {summary['n_events']} events | Buy signals: {summary['n_buy_signals']} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refinancing", required=True, dest="refinancing_file")
    ap.add_argument("--returns", default=None, dest="returns_file")
    ap.add_argument("--min-savings-pct", type=float, default=0.5, help="Min savings as %% of revenue to trigger buy")
    ap.add_argument("--min-savings-abs", type=float, default=10.0, help="Min annual savings in $mn for weak_buy")
    ap.add_argument("--outdir", default="./artifacts/debt_refinancing")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
