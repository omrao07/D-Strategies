#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
options_pin_risk_gamma.py — Max pain theory + dealer gamma near expiry
========================================================================
Computes the max pain strike (where option holders lose the most) and measures
the distance of current price from max pain. Signals price reversion to max pain
in the final week before expiry.

Inputs (CSV)
------------
--options  options.csv
    Columns: date, ticker, strike, expiry, type (call/put), open_interest, [underlying_price]

Outputs
-------
outdir/max_pain.csv      date, ticker, expiry, max_pain_strike, current_price, distance_pct
outdir/signals.csv       dates where price is far from max pain (signal to revert)
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd


def compute_max_pain(opts: pd.DataFrame, underlying: float) -> float:
    """Max pain: strike where total dollar value of expiring options is minimized."""
    strikes = sorted(opts["strike"].unique())
    min_pain, max_pain_strike = float("inf"), strikes[0]
    for s in strikes:
        calls = opts[(opts["type"].str.lower() == "call") & (opts["strike"] <= s)]
        puts = opts[(opts["type"].str.lower() == "put") & (opts["strike"] >= s)]
        call_loss = float(((s - calls["strike"]) * calls["open_interest"]).sum())
        put_loss = float(((puts["strike"] - s) * puts["open_interest"]).sum())
        total = call_loss + put_loss
        if total < min_pain:
            min_pain = total
            max_pain_strike = s
    return max_pain_strike


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    opts = pd.read_csv(cfg.options_file, parse_dates=["date", "expiry"])
    opts.columns = [c.lower().strip() for c in opts.columns]

    max_pain_records = []
    for (date, ticker, expiry), group in opts.groupby(["date", "ticker", "expiry"]):
        if group.empty:
            continue
        underlying = group["underlying_price"].iloc[0] if "underlying_price" in group.columns else np.nan
        if np.isnan(underlying):
            continue
        dte = (expiry - date).days
        mp = compute_max_pain(group, underlying)
        distance_pct = (underlying - mp) / mp * 100
        signal = abs(distance_pct) > cfg.signal_threshold and dte <= cfg.days_to_expiry
        max_pain_records.append({"date": date, "ticker": ticker, "expiry": expiry, "dte": dte,
                                  "max_pain_strike": mp, "underlying_price": underlying,
                                  "distance_pct": distance_pct,
                                  "signal": "revert_down" if distance_pct > cfg.signal_threshold and signal else
                                            ("revert_up" if distance_pct < -cfg.signal_threshold and signal else "neutral")})

    df = pd.DataFrame(max_pain_records)
    df.to_csv(os.path.join(cfg.outdir, "max_pain.csv"), index=False)

    signals = df[df["signal"] != "neutral"]
    signals.to_csv(os.path.join(cfg.outdir, "signals.csv"), index=False)

    summary = {"n_observations": len(df), "n_signals": len(signals),
               "avg_distance_pct": float(df["distance_pct"].mean()),
               "pct_above_max_pain": float((df["distance_pct"] > 0).mean()),
               "params": {"signal_threshold_pct": cfg.signal_threshold, "days_to_expiry": cfg.days_to_expiry}}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Max pain: {len(df)} obs | Signals: {len(signals)} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--options", required=True, dest="options_file")
    ap.add_argument("--signal-threshold", type=float, default=2.0, help="Min distance %% from max pain to signal")
    ap.add_argument("--days-to-expiry", type=int, default=7)
    ap.add_argument("--outdir", default="./artifacts/max_pain")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
