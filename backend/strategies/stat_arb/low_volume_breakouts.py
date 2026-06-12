#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
low_volume_breakouts.py — Low volume = weak move → fade the breakout
======================================================================
Breakouts on below-average volume lack conviction and tend to revert.
Detects price breakouts (close > N-day high) occurring on volume below
the 20-day average volume, and signals a short fade.

Inputs (CSV)
------------
--prices  prices.csv   Columns: date, [ticker], close, high, volume

Outputs
-------
outdir/low_vol_breakouts.csv    date, ticker, breakout_level, volume_ratio, fwd_returns
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd


def analyze_ticker(sub: pd.DataFrame, window: int, vol_threshold: float, hold: int) -> list:
    sub = sub.sort_index()
    close = sub["close"].astype(float)
    volume = sub["volume"].astype(float) if "volume" in sub.columns else pd.Series(np.nan, index=sub.index)
    n_high = close.rolling(window).max().shift(1)
    avg_vol = volume.rolling(window).mean().shift(1)
    vol_ratio = volume / avg_vol
    records = []
    for i in range(window + 1, len(close) - hold):
        date = close.index[i]
        if close.iloc[i] <= n_high.iloc[i]:
            continue
        if vol_ratio.iloc[i] >= vol_threshold:
            continue
        fwd = close.iloc[i + hold] / close.iloc[i] - 1
        records.append({"date": date, "close": float(close.iloc[i]),
                        "breakout_level": float(n_high.iloc[i]),
                        "volume_ratio": float(vol_ratio.iloc[i]),
                        "fwd_return_short": -float(fwd)})  # short = neg of fwd
    return records


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    df = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]
    all_records = []

    if "ticker" in df.columns:
        for ticker, sub in df.groupby("ticker"):
            sub = sub.set_index("date")
            recs = analyze_ticker(sub, cfg.window, cfg.vol_threshold, cfg.hold_days)
            for r in recs:
                r["ticker"] = ticker
            all_records.extend(recs)
    else:
        sub = df.set_index("date")
        all_records = analyze_ticker(sub, cfg.window, cfg.vol_threshold, cfg.hold_days)

    if not all_records:
        print("No low-volume breakouts found.")
        return

    out = pd.DataFrame(all_records).sort_values("date")
    out.to_csv(os.path.join(cfg.outdir, "low_vol_breakouts.csv"), index=False)

    summary = {"n_signals": len(out), "avg_volume_ratio": float(out["volume_ratio"].mean()),
               "avg_fwd_return_short": float(out["fwd_return_short"].mean()),
               "win_rate": float((out["fwd_return_short"] > 0).mean()),
               "params": {"window": cfg.window, "vol_threshold": cfg.vol_threshold, "hold_days": cfg.hold_days}}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Low-vol breakouts: {len(out)} signals | Win rate: {summary['win_rate']:.1%} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--window", type=int, default=20)
    ap.add_argument("--vol-threshold", type=float, default=0.8, help="Volume ratio below this = low volume")
    ap.add_argument("--hold-days", type=int, default=5)
    ap.add_argument("--outdir", default="./artifacts/low_vol_breakout")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
