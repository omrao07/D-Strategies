#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
correlation_breakdown_trading.py — High-corr pairs diverge → reversion trade
==============================================================================
Identifies historically highly-correlated pairs where the correlation has recently
broken down AND the price spread has diverged beyond 2 standard deviations.
Signals a reversion trade.

Inputs (CSV)
------------
--returns  returns.csv   Columns: date, ticker, return

Outputs
-------
outdir/correlation_pairs.csv     pair, long_term_corr, recent_corr, corr_breakdown
outdir/spread_signals.csv        date, pair, spread_zscore, signal
outdir/summary.json
"""

import argparse
import json
import os
from itertools import combinations

import numpy as np
import pandas as pd


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    rets = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    rets.columns = [c.lower().strip() for c in rets.columns]
    wide = rets.pivot(index="date", columns="ticker", values="return").sort_index()

    tickers = wide.columns.tolist()
    pair_records = []
    signal_records = []

    for t1, t2 in combinations(tickers, 2):
        pair = wide[[t1, t2]].dropna()
        if len(pair) < cfg.long_window + cfg.short_window:
            continue

        long_corr = pair[t1].rolling(cfg.long_window).corr(pair[t2]).iloc[-1]
        short_corr = pair[t1].rolling(cfg.short_window).corr(pair[t2]).iloc[-1]

        if np.isnan(long_corr) or np.isnan(short_corr):
            continue
        if long_corr < cfg.min_long_corr:
            continue

        corr_breakdown = long_corr - short_corr > cfg.corr_drop

        # Compute spread and z-score
        spread = pair[t1] - pair[t2]
        spread_mean = spread.rolling(cfg.long_window).mean()
        spread_std = spread.rolling(cfg.long_window).std()
        zscore = (spread - spread_mean) / spread_std.replace(0, np.nan)

        pair_records.append({"pair": f"{t1}-{t2}", "t1": t1, "t2": t2,
                              "long_corr": float(long_corr), "recent_corr": float(short_corr),
                              "corr_breakdown": corr_breakdown, "current_zscore": float(zscore.iloc[-1])})

        if corr_breakdown:
            for date, z in zscore.items():
                if abs(z) > cfg.zscore_threshold:
                    signal_records.append({"date": date, "pair": f"{t1}-{t2}",
                                           "spread_zscore": float(z),
                                           "signal": "long_t1_short_t2" if z < -cfg.zscore_threshold else "short_t1_long_t2"})

    pair_df = pd.DataFrame(pair_records).sort_values("corr_breakdown", ascending=False)
    pair_df.to_csv(os.path.join(cfg.outdir, "correlation_pairs.csv"), index=False)

    sig_df = pd.DataFrame(signal_records).sort_values("date") if signal_records else pd.DataFrame()
    if not sig_df.empty:
        sig_df.to_csv(os.path.join(cfg.outdir, "spread_signals.csv"), index=False)

    summary = {"n_pairs_analyzed": len(pair_df),
               "n_breakdown_pairs": int(pair_df["corr_breakdown"].sum()),
               "n_signals": len(sig_df),
               "avg_long_corr_breakdown_pairs": float(pair_df[pair_df["corr_breakdown"]]["long_corr"].mean()) if pair_df["corr_breakdown"].any() else None,
               "params": {"long_window": cfg.long_window, "short_window": cfg.short_window,
                          "min_long_corr": cfg.min_long_corr, "corr_drop": cfg.corr_drop}}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Corr breakdown: {summary['n_breakdown_pairs']} pairs | Signals: {summary['n_signals']} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--long-window", type=int, default=60)
    ap.add_argument("--short-window", type=int, default=20)
    ap.add_argument("--min-long-corr", type=float, default=0.7)
    ap.add_argument("--corr-drop", type=float, default=0.3)
    ap.add_argument("--zscore-threshold", type=float, default=2.0)
    ap.add_argument("--outdir", default="./artifacts/corr_breakdown")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
