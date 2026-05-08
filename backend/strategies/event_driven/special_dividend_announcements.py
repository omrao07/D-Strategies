#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
special_dividend_announcements.py — One-time dividends → ex-date drop vs over-reaction
========================================================================================
Stocks drop by approximately the dividend amount on ex-date. This script measures
whether the market over- or under-reacts and signals a buy when the drop exceeds
the dividend (over-reaction = value opportunity).

Inputs (CSV)
------------
--dividends  special_divs.csv
    Columns: announce_date, ticker, dividend_amount, ex_date,
             dividend_type (special/regular), [share_price]

--returns    returns.csv   OPTIONAL
    Columns: date, ticker, return

Outputs
-------
outdir/ex_date_reactions.csv   ticker, ex_date, expected_drop_pct, actual_drop_pct, over_reaction
outdir/forward_returns.csv     ticker, ex_date, fwd_5d, fwd_20d (if returns provided)
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd


def load_dividends(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["announce_date", "ex_date"])
    df.columns = [c.lower().strip() for c in df.columns]
    return df.sort_values("ex_date")


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    divs = load_dividends(cfg.dividends_file)
    if cfg.div_type != "all":
        divs = divs[divs.get("dividend_type", pd.Series("special", index=divs.index)).str.lower() == cfg.div_type]

    records = []
    fwd_records = []

    if cfg.returns_file:
        rets = pd.read_csv(cfg.returns_file, parse_dates=["date"])
        rets.columns = [c.lower().strip() for c in rets.columns]
        wide = rets.pivot(index="date", columns="ticker", values="return").sort_index()

        for _, row in divs.iterrows():
            t = row["ticker"]
            ex = row["ex_date"]
            if t not in wide.columns:
                continue

            # Ex-date return
            ex_ret = wide.loc[ex, t] if ex in wide.index else np.nan

            # Expected drop as % of share price
            if "share_price" in row and not pd.isna(row["share_price"]) and row["share_price"] > 0:
                expected_drop = -row["dividend_amount"] / row["share_price"]
            else:
                expected_drop = np.nan

            over_reaction = (ex_ret < expected_drop) if not np.isnan(expected_drop) and not np.isnan(ex_ret) else None

            records.append({
                "ticker": t, "ex_date": ex,
                "dividend_amount": row["dividend_amount"],
                "expected_drop_pct": expected_drop,
                "actual_ex_return": ex_ret,
                "over_reaction": over_reaction,
                "signal": "buy" if over_reaction else ("hold" if over_reaction is None else "neutral")
            })

            # Forward returns for over-reaction buys
            future = wide.loc[wide.index > ex, t].dropna()
            fwd5 = float((1 + future.iloc[:5]).prod() - 1) if len(future) >= 5 else np.nan
            fwd20 = float((1 + future.iloc[:20]).prod() - 1) if len(future) >= 20 else np.nan
            fwd_records.append({"ticker": t, "ex_date": ex, "over_reaction": over_reaction,
                                 "fwd_5d": fwd5, "fwd_20d": fwd20})
    else:
        for _, row in divs.iterrows():
            records.append({"ticker": row["ticker"], "ex_date": row["ex_date"],
                            "dividend_amount": row["dividend_amount"]})

    df = pd.DataFrame(records)
    df.to_csv(os.path.join(cfg.outdir, "ex_date_reactions.csv"), index=False)

    if fwd_records:
        fdf = pd.DataFrame(fwd_records)
        fdf.to_csv(os.path.join(cfg.outdir, "forward_returns.csv"), index=False)
        over = fdf[fdf["over_reaction"] == True]
        avg_fwd5_overreact = float(over["fwd_5d"].mean()) if len(over) > 0 else None
    else:
        avg_fwd5_overreact = None

    summary = {
        "n_events": len(df),
        "n_over_reactions": int(df["over_reaction"].sum()) if "over_reaction" in df.columns else None,
        "over_reaction_rate": float(df["over_reaction"].mean()) if "over_reaction" in df.columns else None,
        "avg_fwd_5d_on_over_reaction": avg_fwd5_overreact,
        "avg_dividend_amount": float(divs["dividend_amount"].mean())
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Special dividends: {summary['n_events']} events | Over-reaction rate: {summary['over_reaction_rate']} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dividends", required=True, dest="dividends_file")
    ap.add_argument("--returns", default=None, dest="returns_file")
    ap.add_argument("--div-type", default="all", choices=["special", "regular", "all"])
    ap.add_argument("--outdir", default="./artifacts/special_dividends")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
