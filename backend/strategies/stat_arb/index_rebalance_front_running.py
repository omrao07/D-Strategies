#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
index_rebalance_front_running.py — S&P 500 additions announced → buy before inclusion
=======================================================================================
When a stock is announced for index inclusion, index funds must buy it on the effective
date. Front-running this forced buying generates consistent alpha. This script measures
the announcement-to-effective-date return and the post-inclusion reversal.

Inputs (CSV)
------------
--changes  index_changes.csv
    Columns: announce_date, effective_date, ticker, action (add/remove), index_name

--returns  returns.csv  OPTIONAL: date, ticker, return

Outputs
-------
outdir/rebalance_trades.csv     announce-to-effective return, post-effective reversal
outdir/summary.csv              by action type
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    changes = pd.read_csv(cfg.changes_file, parse_dates=["announce_date", "effective_date"])
    changes.columns = [c.lower().strip() for c in changes.columns]

    if cfg.action != "all":
        changes = changes[changes["action"].str.lower() == cfg.action]

    records = []
    if cfg.returns_file:
        rets = pd.read_csv(cfg.returns_file, parse_dates=["date"])
        rets.columns = [c.lower().strip() for c in rets.columns]
        wide = rets.pivot(index="date", columns="ticker", values="return").sort_index()

        for _, row in changes.iterrows():
            t = row["ticker"]
            ann, eff = row["announce_date"], row["effective_date"]
            if t not in wide.columns:
                continue

            # Announcement to effective (front-run window)
            window = wide.loc[(wide.index >= ann) & (wide.index < eff), t].dropna()
            ann_to_eff = float((1 + window).prod() - 1) if len(window) > 0 else np.nan

            # Day of effective
            eff_day = wide.loc[eff, t] if eff in wide.index else np.nan

            # Post-effective reversal (5 and 20 days)
            post = wide.loc[wide.index > eff, t].dropna()
            post5 = float((1 + post.iloc[:5]).prod() - 1) if len(post) >= 5 else np.nan
            post20 = float((1 + post.iloc[:20]).prod() - 1) if len(post) >= 20 else np.nan

            records.append({"ticker": t, "announce_date": ann, "effective_date": eff,
                            "action": row.get("action", ""), "index": row.get("index_name", ""),
                            "ann_to_eff_return": ann_to_eff, "eff_day_return": eff_day,
                            "post_5d_reversal": post5, "post_20d_reversal": post20})
    else:
        for _, row in changes.iterrows():
            records.append({"ticker": row["ticker"], "announce_date": row["announce_date"],
                            "effective_date": row["effective_date"], "action": row.get("action", "")})

    df = pd.DataFrame(records)
    df.to_csv(os.path.join(cfg.outdir, "rebalance_trades.csv"), index=False)

    if "action" in df.columns and "ann_to_eff_return" in df.columns:
        by_action = df.groupby("action")[["ann_to_eff_return", "post_5d_reversal", "post_20d_reversal"]].mean()
        by_action.to_csv(os.path.join(cfg.outdir, "summary.csv"))

    adds = df[df.get("action", pd.Series("add", index=df.index)).str.lower() == "add"] if "action" in df.columns else df
    summary = {"n_events": len(df), "n_adds": len(adds),
               "avg_ann_to_eff_add": float(adds["ann_to_eff_return"].mean()) if "ann_to_eff_return" in adds.columns and len(adds) > 0 else None,
               "avg_post5d_reversal_add": float(adds["post_5d_reversal"].mean()) if "post_5d_reversal" in adds.columns and len(adds) > 0 else None,
               "win_rate_front_run": float((adds["ann_to_eff_return"] > 0).mean()) if "ann_to_eff_return" in adds.columns and len(adds) > 0 else None}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Index rebalance: {len(df)} events | Avg add return: {summary['avg_ann_to_eff_add']} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--changes", required=True, dest="changes_file")
    ap.add_argument("--returns", default=None, dest="returns_file")
    ap.add_argument("--action", default="all", choices=["add", "remove", "all"])
    ap.add_argument("--outdir", default="./artifacts/index_rebalance")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
