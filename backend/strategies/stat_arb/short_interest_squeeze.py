#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
short_interest_squeeze.py — High short interest + positive catalyst = squeeze signal
======================================================================================
Detects potential short squeeze setups: stocks with >20% short interest that show
a price ignition signal (>5% one-day move up). Tracks the subsequent 10-day return.

Inputs (CSV)
------------
--short-interest  short_interest.csv
    Columns: date, ticker, si_ratio (%), si_days_to_cover

--prices  prices.csv
    Columns: date, ticker, open, high, low, close, volume

Outputs
-------
outdir/squeeze_candidates.csv     ticker, date, si_ratio, ignition_return, fwd_10d
outdir/signal_log.csv             all ignition signals detected
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd


def load_prices(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]
    return df.pivot(index="date", columns="ticker", values="close").sort_index()


def load_si(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]
    return df


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    prices = load_prices(cfg.prices_file)
    returns = prices.pct_change()
    si = load_si(cfg.si_file)

    # Build SI lookup: ticker → most recent si_ratio per date
    si_wide = si.pivot_table(index="date", columns="ticker", values="si_ratio", aggfunc="last")
    si_wide = si_wide.reindex(prices.index, method="ffill")

    signals = []
    for date in returns.index[1:]:
        day_rets = returns.loc[date].dropna()
        # Ignition: price up > threshold
        ignitions = day_rets[day_rets > cfg.ignition_pct / 100]
        for ticker in ignitions.index:
            if ticker not in si_wide.columns:
                continue
            si_val = si_wide.loc[date, ticker] if date in si_wide.index else np.nan
            if np.isnan(si_val) or si_val < cfg.min_si:
                continue
            # Forward 10-day return
            fut = returns.loc[returns.index > date, ticker].dropna().iloc[:cfg.hold_days]
            fwd = float((1 + fut).prod() - 1) if len(fut) >= cfg.hold_days // 2 else np.nan
            signals.append({"date": date, "ticker": ticker, "si_ratio": si_val,
                            "ignition_return": float(ignitions[ticker]),
                            f"fwd_{cfg.hold_days}d": fwd,
                            "squeeze_confirmed": fwd > cfg.ignition_pct / 100 if not np.isnan(fwd) else None})

    df = pd.DataFrame(signals)
    if df.empty:
        print("No squeeze signals found with current thresholds.")
        return

    df.to_csv(os.path.join(cfg.outdir, "signal_log.csv"), index=False)

    # Best candidates = highest SI + strongest ignition
    candidates = df.sort_values("si_ratio", ascending=False).head(50)
    candidates.to_csv(os.path.join(cfg.outdir, "squeeze_candidates.csv"), index=False)

    fwd_col = f"fwd_{cfg.hold_days}d"
    summary = {
        "n_signals": len(df), "n_unique_tickers": df["ticker"].nunique(),
        "avg_si_ratio": float(df["si_ratio"].mean()),
        "avg_ignition_return": float(df["ignition_return"].mean()),
        f"avg_{fwd_col}": float(df[fwd_col].mean()) if fwd_col in df.columns else None,
        "squeeze_confirmed_rate": float(df["squeeze_confirmed"].mean()) if "squeeze_confirmed" in df.columns else None,
        "params": {"min_si": cfg.min_si, "ignition_pct": cfg.ignition_pct, "hold_days": cfg.hold_days}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Squeeze signals: {len(df)} | Avg SI: {summary['avg_si_ratio']:.1f}% | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--short-interest", required=True, dest="si_file")
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--min-si", type=float, default=20.0, help="Min short interest %% to qualify")
    ap.add_argument("--ignition-pct", type=float, default=5.0, help="Min daily return %% for ignition signal")
    ap.add_argument("--hold-days", type=int, default=10)
    ap.add_argument("--outdir", default="./artifacts/squeeze")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
