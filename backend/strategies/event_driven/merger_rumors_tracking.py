#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
merger_rumors_tracking.py — M&A rumors → pre-announcement drift analysis
"""
import argparse, json, os
import numpy as np
import pandas as pd


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    rumors = pd.read_csv(cfg.rumors_file, parse_dates=["rumor_date"])
    rumors.columns = [c.lower().strip() for c in rumors.columns]

    records = []
    if cfg.returns_file:
        rets = pd.read_csv(cfg.returns_file, parse_dates=["date"])
        rets.columns = [c.lower().strip() for c in rets.columns]
        wide = rets.pivot(index="date", columns="ticker", values="return").sort_index()
        for _, row in rumors.iterrows():
            t = row["target_ticker"]
            d = row["rumor_date"]
            if t not in wide.columns:
                continue
            fut = wide.loc[wide.index >= d, t].dropna().iloc[:cfg.hold_days]
            ret = float((1 + fut).prod() - 1) if len(fut) > 0 else np.nan
            confirmed = str(row.get("confirmed", "")).lower() in ("yes", "true", "1")
            records.append({"rumor_date": d, "target": t, "acquirer": row.get("acquirer_ticker", ""),
                            "source": row.get("source", ""), "confirmed": confirmed,
                            f"return_{cfg.hold_days}d": ret})
        df = pd.DataFrame(records)
        df.to_csv(os.path.join(cfg.outdir, "rumor_returns.csv"), index=False)
        col = f"return_{cfg.hold_days}d"
        summary = {"n_rumors": len(df), "n_confirmed": int(df["confirmed"].sum()),
                   "avg_return_all": float(df[col].mean()), "avg_return_confirmed": float(df.loc[df["confirmed"], col].mean()) if df["confirmed"].any() else None,
                   "win_rate": float((df[col] > 0).mean())}
    else:
        rumors.to_csv(os.path.join(cfg.outdir, "rumors.csv"), index=False)
        summary = {"n_rumors": len(rumors)}

    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"M&A rumors | Events: {summary['n_rumors']} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rumors", required=True, dest="rumors_file")
    ap.add_argument("--returns", default=None, dest="returns_file")
    ap.add_argument("--hold-days", type=int, default=30)
    ap.add_argument("--outdir", default="./artifacts/merger_rumors")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
