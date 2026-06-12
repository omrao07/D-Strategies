#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
term_structure_arbitrage.py — VIX vs VXX vs UVXY discrepancies — time spread
------------------------------------------------------------------------------
Computes the theoretical price of VXX (rolling front/second-month VIX futures) and
compares to the actual VXX price. Detects premium/discount that represents arb.

Inputs (CSV)
------------
--data  vix_data.csv    REQUIRED: date, vix_spot, vx1 (front-month), vx2 (2nd-month),
                                   vxx_price, [uvxy_price]

Outputs
-------
outdir/term_structure.csv    date, vix_spot, vx1, vx2, contango_ratio, roll_yield_ann
outdir/arb_signals.csv       date, theoretical_vxx, actual_vxx, spread_pct, signal
outdir/summary.json
"""

import argparse
import json
import os

import pandas as pd


def load_data(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"]).set_index("date").sort_index()
    df.columns = [c.lower().strip() for c in df.columns]
    return df.dropna(subset=["vx1", "vx2"])


def compute_theoretical_vxx(df: pd.DataFrame, roll_day: int = 15) -> pd.Series:
    # VXX holds a blend of front (vx1) and 2nd-month (vx2) futures that rolls daily
    # Weight in front month = (days_to_roll) / 21 on a ~21-day roll cycle
    # Simplified: assume equal blend with daily roll
    theoretical = []
    days_in_roll = 21
    for i, (date, row) in enumerate(df.iterrows()):
        day_of_month = date.day
        w2 = min(day_of_month / days_in_roll, 1.0)
        w1 = 1 - w2
        theo = w1 * row["vx1"] + w2 * row["vx2"]
        theoretical.append(theo)
    return pd.Series(theoretical, index=df.index)


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    df = load_data(cfg.data_file)

    df["contango_ratio"] = df["vx2"] / df["vx1"] - 1
    df["roll_yield_ann"] = -df["contango_ratio"] * (252 / 21)  # approximate annualized roll cost

    theo_vxx = compute_theoretical_vxx(df)
    df["theoretical_vxx"] = theo_vxx

    ts_out = df[["vix_spot", "vx1", "vx2", "contango_ratio", "roll_yield_ann"]].copy()
    ts_out.to_csv(os.path.join(cfg.outdir, "term_structure.csv"))

    if "vxx_price" in df.columns:
        arb = df[["vxx_price", "theoretical_vxx"]].copy()
        arb["spread_pct"] = (arb["vxx_price"] - arb["theoretical_vxx"]) / arb["theoretical_vxx"]
        arb["signal"] = arb["spread_pct"].apply(
            lambda x: "sell_vxx" if x > cfg.threshold else ("buy_vxx" if x < -cfg.threshold else "neutral"))
        arb.to_csv(os.path.join(cfg.outdir, "arb_signals.csv"))

        signal_counts = arb["signal"].value_counts().to_dict()
        avg_spread = float(arb["spread_pct"].mean())
        avg_premium = float(arb.loc[arb["signal"] == "sell_vxx", "spread_pct"].mean()) if "sell_vxx" in signal_counts else None
    else:
        signal_counts, avg_spread, avg_premium = {}, None, None

    summary = {"n_obs": len(df), "avg_contango_ratio": float(df["contango_ratio"].mean()),
               "avg_roll_yield_ann": float(df["roll_yield_ann"].mean()),
               "pct_in_contango": float((df["contango_ratio"] > 0).mean()),
               "arb_signal_counts": signal_counts, "avg_spread_pct": avg_spread,
               "avg_sell_premium": avg_premium, "threshold_used": cfg.threshold}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Contango {summary['pct_in_contango']:.1%} of days | Avg roll yield: {summary['avg_roll_yield_ann']:.1%} ann | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, dest="data_file")
    ap.add_argument("--threshold", type=float, default=0.005)
    ap.add_argument("--outdir", default="./artifacts/term_structure_arb")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
