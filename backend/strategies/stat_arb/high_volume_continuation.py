#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
high_volume_continuation.py — High volume breakout = strong move → momentum follow
=====================================================================================
Breakouts accompanied by >2x average volume signal genuine institutional participation.
These moves tend to continue. This strategy follows high-volume breakouts with a
momentum position.

Inputs (CSV)
------------
--prices  prices.csv   Columns: date, [ticker], close, high, volume

Outputs
-------
outdir/high_vol_breakouts.csv    signals with forward returns
outdir/backtest.csv              cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd


def analyze_ticker(sub: pd.DataFrame, window: int, vol_mult: float, hold: int) -> list:
    sub = sub.sort_index()
    close = sub["close"].astype(float)
    volume = sub["volume"].astype(float) if "volume" in sub.columns else pd.Series(np.nan, index=sub.index)
    n_high = close.rolling(window).max().shift(1)
    avg_vol = volume.rolling(window).mean().shift(1)
    vol_ratio = volume / avg_vol
    records = []
    for i in range(window + 1, len(close) - hold):
        if close.iloc[i] <= n_high.iloc[i]:
            continue
        if vol_ratio.iloc[i] < vol_mult:
            continue
        fwd = close.iloc[i + hold] / close.iloc[i] - 1
        records.append({"date": close.index[i], "close": float(close.iloc[i]),
                        "breakout_level": float(n_high.iloc[i]),
                        "volume_ratio": float(vol_ratio.iloc[i]),
                        "fwd_return_long": float(fwd)})
    return records


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    df = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]
    all_records = []

    if "ticker" in df.columns:
        for ticker, sub in df.groupby("ticker"):
            recs = analyze_ticker(sub.set_index("date"), cfg.window, cfg.vol_multiplier, cfg.hold_days)
            for r in recs:
                r["ticker"] = ticker
            all_records.extend(recs)
    else:
        all_records = analyze_ticker(df.set_index("date"), cfg.window, cfg.vol_multiplier, cfg.hold_days)

    if not all_records:
        print("No high-volume breakouts found.")
        return

    out = pd.DataFrame(all_records).sort_values("date")
    out.to_csv(os.path.join(cfg.outdir, "high_vol_breakouts.csv"), index=False)

    bt = out.set_index("date")["fwd_return_long"]
    cum = (1 + bt).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))

    summary = {"n_signals": len(out), "avg_volume_ratio": float(out["volume_ratio"].mean()),
               "avg_fwd_return": float(out["fwd_return_long"].mean()),
               "win_rate": float((out["fwd_return_long"] > 0).mean()),
               "params": {"window": cfg.window, "vol_multiplier": cfg.vol_multiplier, "hold_days": cfg.hold_days}}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"High-vol breakouts: {len(out)} signals | Win rate: {summary['win_rate']:.1%} | Avg return: {summary['avg_fwd_return']:.2%} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--window", type=int, default=20)
    ap.add_argument("--vol-multiplier", type=float, default=2.0)
    ap.add_argument("--hold-days", type=int, default=10)
    ap.add_argument("--outdir", default="./artifacts/high_vol_breakout")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
